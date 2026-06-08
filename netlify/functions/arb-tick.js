const https = require('https');
const crypto = require('crypto');

const DEFAULT_STATE = { phase: 0, enabled: false, log: [], stats: { kwh: 0, rate: 0, earned: 0 } };

const DEFAULT_SETTINGS = {
  chargeTargetPct: 50,
  startHour: 23, startMinute: 30,
  endHour: 5, endMinute: 30
};

function makeRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function signCommand(body) {
  const pem = process.env.TESLA_PRIVATE_KEY;
  if (!pem) return null;
  try {
    const privateKey = crypto.createPrivateKey(pem);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    const bodyStr = body ? JSON.stringify(body) : '';
    const sign = crypto.createSign('SHA256');
    sign.update(timestamp + nonce + bodyStr);
    return { timestamp, nonce, signature: sign.sign(privateKey, 'base64') };
  } catch (e) { return null; }
}

async function teslaGet(token, apiBase, path) {
  const url = new URL(apiBase + path);
  const res = await makeRequest({
    hostname: url.hostname, path: url.pathname, method: 'GET',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
  }, null);
  return JSON.parse(res.body);
}

async function teslaPost(token, apiBase, path, body) {
  const url = new URL(apiBase + path);
  const postData = JSON.stringify(body);
  const signed = signCommand(body);
  const headers = {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData),
    ...(signed ? { 'X-Tesla-Timestamp': signed.timestamp, 'X-Tesla-Nonce': signed.nonce, 'X-Tesla-Signature': signed.signature } : {})
  };
  const res = await makeRequest({ hostname: url.hostname, path: url.pathname, method: 'POST', headers }, postData);
  return JSON.parse(res.body);
}

async function refreshTeslaToken(tokenData) {
  const postData = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: tokenData.clientId,
    refresh_token: tokenData.refresh
  }).toString();
  const res = await makeRequest({
    hostname: 'fleet-auth.prd.vn.cloud.tesla.com',
    path: '/oauth2/v3/token', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
  }, postData);
  return JSON.parse(res.body);
}

// Includes seconds so phase transition times are precise
function log(state, msg) {
  const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  state.log = state.log || [];
  state.log.unshift('[' + time + '] ' + msg);
  if (state.log.length > 50) state.log = state.log.slice(0, 50);
}

async function setMode(token, apiBase, siteId, mode, reserve) {
  await teslaPost(token, apiBase, `/api/1/energy_sites/${siteId}/operation`, {
    default_real_mode: mode, backup_reserve_percent: reserve
  });
  await teslaPost(token, apiBase, `/api/1/energy_sites/${siteId}/backup`, {
    backup_reserve_percent: reserve
  });
}

async function setExport(token, apiBase, siteId, enable) {
  return teslaPost(token, apiBase, `/api/1/energy_sites/${siteId}/grid_import_export`, {
    disallow_charge_from_grid_with_solar_installed: false,
    customer_preferred_export_rule: enable ? 'battery_ok' : 'never'
  });
}

// Fetches the current Agile export rate from Octopus using settings stored in the blob store
async function getOctopusRate(store) {
  try {
    const settings = JSON.parse(await store.get('oct_settings') || 'null');
    if (!settings || !settings.octKey || !settings.octTariff || !settings.octProduct) return 0;
    const now = new Date();
    const slotStart = new Date(now);
    slotStart.setMinutes(now.getMinutes() >= 30 ? 30 : 0, 0, 0);
    const slotEnd = new Date(slotStart.getTime() + 30 * 60 * 1000);
    const fmt = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const path = '/v1/products/' + settings.octProduct + '/electricity-tariffs/' + settings.octTariff +
      '/standard-unit-rates/?period_from=' + fmt(slotStart) + '&period_to=' + fmt(slotEnd) + '&page_size=2';
    const authHeader = 'Basic ' + Buffer.from(settings.octKey + ':').toString('base64');
    const res = await makeRequest({
      hostname: 'api.octopus.energy', path, method: 'GET',
      headers: { 'Authorization': authHeader }
    }, null);
    const data = JSON.parse(res.body);
    if (data.results && data.results.length > 0) {
      return parseFloat(parseFloat(data.results[0].value_inc_vat).toFixed(2));
    }
  } catch (e) {}
  return 0;
}

async function wakeVehicle(token, apiBase, vehicleId) {
  return teslaPost(token, apiBase, `/api/1/vehicles/${vehicleId}/wake_up`, {});
}
async function getVehicleState(token, apiBase, vehicleId) {
  const data = await teslaGet(token, apiBase, `/api/1/vehicles/${vehicleId}`);
  return data.response?.state || 'unknown';
}
async function vehicleChargeStop(token, apiBase, vehicleId) {
  return teslaPost(token, apiBase, `/api/1/vehicles/${vehicleId}/command/charge_stop`, {});
}
async function vehicleSetChargeLimit(token, apiBase, vehicleId, percent) {
  return teslaPost(token, apiBase, `/api/1/vehicles/${vehicleId}/command/set_charge_limit`, { percent });
}
async function vehicleChargeStart(token, apiBase, vehicleId) {
  return teslaPost(token, apiBase, `/api/1/vehicles/${vehicleId}/command/charge_start`, {});
}

function fmt2(n) { return String(n).padStart(2, '0'); }

exports.handler = async () => {
  const { getStore } = require('@netlify/blobs');
  const store = getStore({ name: 'arb', siteID: process.env.SITE_ID, token: process.env.NETLIFY_API_TOKEN });
  const state = JSON.parse(await store.get('state') || JSON.stringify(DEFAULT_STATE));

  // Stop a timed export that expired while the app was backgrounded — runs regardless of arbitrage state
  const timedExport = JSON.parse(await store.get('timed_export') || 'null');
  if (timedExport && timedExport.endTime && Date.now() >= timedExport.endTime) {
    const td = JSON.parse(await store.get('token') || 'null');
    if (td) {
      try { await setExport(td.access, td.apiBase, td.energySiteId, false); } catch (e) {}
    }
    await store.delete('timed_export');
  }

  // Check for a pending vehicle command (retry each minute until car is online, timeout after 5 min)
  const pendingCmd = JSON.parse(await store.get('pending_vehicle_cmd') || 'null');

  // Only idle-exit if there's also no pending vehicle command to handle
  if (!state.enabled && state.phase === 0 && !pendingCmd) return { statusCode: 200, body: 'Idle' };

  let tokenData = JSON.parse(await store.get('token') || 'null');
  if (!tokenData) return { statusCode: 200, body: 'No token stored' };

  // Refresh token if expiring within 2 minutes
  if (tokenData.expiry && Date.now() > tokenData.expiry - 120000) {
    try {
      const refreshed = await refreshTeslaToken(tokenData);
      if (refreshed.access_token) {
        tokenData.access = refreshed.access_token;
        tokenData.refresh = refreshed.refresh_token;
        tokenData.expiry = Date.now() + refreshed.expires_in * 1000;
        await store.set('token', JSON.stringify(tokenData));
      }
    } catch (e) { log(state, 'Token refresh error: ' + e.message); }
  }

  // Deliver any pending vehicle command (car may have been asleep when it was first requested)
  if (pendingCmd && tokenData.vehicleId) {
    const { access, apiBase } = tokenData;
    const vehicleId = tokenData.vehicleId;
    if (Date.now() - pendingCmd.requestedAt > 5 * 60 * 1000) {
      log(state, 'Vehicle command timed out: ' + pendingCmd.cmd);
      await store.delete('pending_vehicle_cmd');
    } else {
      try {
        const vState = await getVehicleState(access, apiBase, vehicleId);
        if (vState === 'online') {
          if (pendingCmd.cmd === 'charge_stop') {
            await vehicleSetChargeLimit(access, apiBase, vehicleId, pendingCmd.chargeLimit || 50);
            await vehicleChargeStop(access, apiBase, vehicleId);
            log(state, 'Vehicle: charge limit set to ' + (pendingCmd.chargeLimit || 50) + '%, charging stopped for Phase 2 export');
          } else if (pendingCmd.cmd === 'charge_resume') {
            await vehicleSetChargeLimit(access, apiBase, vehicleId, pendingCmd.chargeLimit);
            await vehicleChargeStart(access, apiBase, vehicleId);
            log(state, 'Vehicle: charging resumed at ' + pendingCmd.chargeLimit + '% limit');
          }
          await store.delete('pending_vehicle_cmd');
        } else {
          await wakeVehicle(access, apiBase, vehicleId);
        }
      } catch (e) {
        log(state, 'Vehicle command error: ' + e.message);
      }
    }
    await store.set('state', JSON.stringify(state));
    if (!state.enabled && state.phase === 0) return { statusCode: 200, body: 'OK' };
  }

  // Load user-defined strategy settings, fall back to defaults if not set
  const rawSettings = await store.get('arb_settings');
  const s = rawSettings ? { ...DEFAULT_SETTINGS, ...JSON.parse(rawSettings) } : DEFAULT_SETTINGS;
  const { chargeTargetPct, startHour, startMinute, endHour, endMinute } = s;

  const { access, apiBase, energySiteId: siteId } = tokenData;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/London' }));
  const h = now.getHours(), m = now.getMinutes();

  try {
    // Phase 0 — wait for configured start time
    if (state.phase === 0 && state.enabled && h === startHour && m >= startMinute) {
      state.phase = 1;
      state.stats = { kwh: 0, rate: 0, earned: 0, phase2StartPct: 0 };
      log(state, '=== Arbitrage cycle started ===');
      await setMode(access, apiBase, siteId, 'autonomous', chargeTargetPct);
      log(state, 'Phase 1: Reserve set to ' + chargeTargetPct + '% — charging from grid');
    }

    // Phase 1 — charge to target %; log progress every 10 minutes
    else if (state.phase === 1) {
      const live = await teslaGet(access, apiBase, `/api/1/energy_sites/${siteId}/live_status`);
      const pct = Math.round(live.response?.percentage_charged || 0);
      if (m % 10 === 0) log(state, 'Phase 1 charging — battery at ' + pct + '%');
      if (pct >= chargeTargetPct) {
        log(state, 'Phase 1 complete — battery reached ' + pct + '%');
        state.phase = 2;
        const rate = await getOctopusRate(store);
        state.stats.phase2StartPct = pct;
        state.stats.rateSum = rate;
        state.stats.rateSamples = rate > 0 ? 1 : 0;
        state.stats.rate = rate;
        await setMode(access, apiBase, siteId, 'autonomous', 0);
        await setExport(access, apiBase, siteId, true);
        log(state, 'Phase 2: Export enabled' + (rate > 0 ? ' at ' + rate.toFixed(1) + 'p/kWh' : ' (rate unavailable — will retry)'));
        if (s.carControlEnabled && tokenData.vehicleId) {
          try {
            await wakeVehicle(access, apiBase, tokenData.vehicleId);
            await store.set('pending_vehicle_cmd', JSON.stringify({ cmd: 'charge_stop', chargeLimit: s.carChargeLimitPhase2 || 50, requestedAt: Date.now() }));
            log(state, 'Vehicle: wake-up sent — charging will stop shortly');
          } catch (e) { log(state, 'Vehicle wake error: ' + e.message); }
        }
      }
    }

    // Phase 2 — export until empty; log progress every 10 minutes
    else if (state.phase === 2) {
      const live = await teslaGet(access, apiBase, `/api/1/energy_sites/${siteId}/live_status`);
      const pct = Math.round(live.response?.percentage_charged || 0);
      // Update running average rate on every tick to handle multiple 30-min Agile slots
      const tickRate = await getOctopusRate(store);
      if (tickRate > 0) {
        state.stats.rateSum = (state.stats.rateSum || 0) + tickRate;
        state.stats.rateSamples = (state.stats.rateSamples || 0) + 1;
        state.stats.rate = parseFloat((state.stats.rateSum / state.stats.rateSamples).toFixed(2));
      }
      if (m % 10 === 0) log(state, 'Phase 2 exporting — battery at ' + pct + '%' + (state.stats.rate > 0 ? ' @ ' + state.stats.rate.toFixed(1) + 'p avg' : ''));
      if (pct <= 2) {
        log(state, 'Phase 2 complete — battery at ' + pct + '%');
        const startPct = state.stats.phase2StartPct || chargeTargetPct;
        const kwhExported = parseFloat(((startPct - pct) / 100 * 13.5).toFixed(2));
        const avgRate = state.stats.rate || 0;
        const earned = parseFloat((kwhExported * avgRate / 100).toFixed(2));
        state.stats.kwh = kwhExported;
        state.stats.earned = earned;
        log(state, 'Est. £' + earned.toFixed(2) + ' earned (' + kwhExported + ' kWh @ ' + avgRate.toFixed(1) + 'p avg)');
        state.phase = 3;
        await setExport(access, apiBase, siteId, false);
        await setMode(access, apiBase, siteId, 'autonomous', 100);
        log(state, 'Phase 3: Export off — reserve set to 100%, recharging from grid');
        if (s.carControlEnabled && tokenData.vehicleId) {
          try {
            await wakeVehicle(access, apiBase, tokenData.vehicleId);
            const limit = s.carChargeLimit || 80;
            await store.set('pending_vehicle_cmd', JSON.stringify({ cmd: 'charge_resume', chargeLimit: limit, requestedAt: Date.now() }));
            log(state, 'Vehicle: wake-up sent — charging will resume to ' + limit + '% shortly');
          } catch (e) { log(state, 'Vehicle wake error: ' + e.message); }
        }
      }
    }

    // Phase 3 — recharge to 100%; log progress every 10 minutes
    else if (state.phase === 3) {
      const live = await teslaGet(access, apiBase, `/api/1/energy_sites/${siteId}/live_status`);
      const pct = Math.round(live.response?.percentage_charged || 0);
      if (m % 10 === 0) log(state, 'Phase 3 recharging — battery at ' + pct + '%');
      if (pct >= 98) {
        log(state, 'Phase 3 complete — battery at ' + pct + '%');
        state.phase = 4;
        log(state, 'Phase 4: Fully charged — standby until ' + fmt2(endHour) + ':' + fmt2(endMinute));
      }
    }

    // Phase 4 — wait for configured end time
    else if (state.phase === 4 && h === endHour && m >= endMinute) {
      state.phase = 0;
      await setExport(access, apiBase, siteId, false);
      await setMode(access, apiBase, siteId, 'autonomous', 0);
      log(state, '=== Cycle complete — autonomous mode restored, 0% reserve ===');
    }

    // Safety fallback — if still running an hour after the end time, restore normal operation
    else if (state.phase > 0 && h >= endHour + 1) {
      log(state, 'Safety fallback at ' + fmt2(h) + ':' + fmt2(m) + ' — restoring normal mode');
      state.phase = 0;
      await setExport(access, apiBase, siteId, false);
      await setMode(access, apiBase, siteId, 'autonomous', 0);
    }

  } catch (e) {
    log(state, 'Error in phase ' + state.phase + ': ' + e.message);
  }

  await store.set('state', JSON.stringify(state));
  return { statusCode: 200, body: 'OK' };
};
