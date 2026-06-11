const https = require('https');
const crypto = require('crypto');

const DEFAULT_STATE = { phase: 0, enabled: false, log: [], stats: { kwh: 0, rate: 0, earned: 0 } };
const DEFAULT_SETTINGS = { chargeTargetPct: 50, startHour: 23, startMinute: 30, endHour: 5, endMinute: 30 };

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

function log(state, msg) {
  const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  state.log = state.log || [];
  state.log.unshift('[' + time + '] ' + msg);
  if (state.log.length > 50) state.log = state.log.slice(0, 50);
}

async function setMode(token, apiBase, siteId, mode, reserve) {
  await teslaPost(token, apiBase, `/api/1/energy_sites/${siteId}/operation`, { default_real_mode: mode, backup_reserve_percent: reserve });
  await teslaPost(token, apiBase, `/api/1/energy_sites/${siteId}/backup`, { backup_reserve_percent: reserve });
}

async function setExport(token, apiBase, siteId, enable) {
  return teslaPost(token, apiBase, `/api/1/energy_sites/${siteId}/grid_import_export`, {
    disallow_charge_from_grid_with_solar_installed: false,
    customer_preferred_export_rule: enable ? 'battery_ok' : 'never'
  });
}

async function getOctopusRate(store, deviceId) {
  try {
    const settings = JSON.parse(await store.get('oct_settings_' + deviceId) || 'null');
    if (!settings || !settings.octKey || !settings.octTariff || !settings.octProduct) return 0;
    const now = new Date();
    const slotStart = new Date(now);
    slotStart.setMinutes(now.getMinutes() >= 30 ? 30 : 0, 0, 0);
    const slotEnd = new Date(slotStart.getTime() + 30 * 60 * 1000);
    const fmt = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const path = '/v1/products/' + settings.octProduct + '/electricity-tariffs/' + settings.octTariff +
      '/standard-unit-rates/?period_from=' + fmt(slotStart) + '&period_to=' + fmt(slotEnd) + '&page_size=2';
    const authHeader = 'Basic ' + Buffer.from(settings.octKey + ':').toString('base64');
    const res = await makeRequest({ hostname: 'api.octopus.energy', path, method: 'GET', headers: { 'Authorization': authHeader } }, null);
    const data = JSON.parse(res.body);
    if (data.results && data.results.length > 0) return parseFloat(parseFloat(data.results[0].value_inc_vat).toFixed(2));
  } catch (e) {}
  return 0;
}

async function getOctopusRatesForWindow(store, periodFrom, periodTo, deviceId) {
  try {
    const settings = JSON.parse(await store.get('oct_settings_' + deviceId) || 'null');
    if (!settings || !settings.octKey || !settings.octTariff || !settings.octProduct) return [];
    const fmt = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const path = '/v1/products/' + settings.octProduct + '/electricity-tariffs/' + settings.octTariff +
      '/standard-unit-rates/?period_from=' + fmt(periodFrom) + '&period_to=' + fmt(periodTo) + '&page_size=50';
    const authHeader = 'Basic ' + Buffer.from(settings.octKey + ':').toString('base64');
    const res = await makeRequest({ hostname: 'api.octopus.energy', path, method: 'GET', headers: { 'Authorization': authHeader } }, null);
    const data = JSON.parse(res.body);
    if (data.results && data.results.length) return data.results.map(r => parseFloat(parseFloat(r.value_inc_vat).toFixed(2)));
  } catch (e) {}
  return [];
}

async function wakeVehicle(token, apiBase, vehicleId) { return teslaPost(token, apiBase, `/api/1/vehicles/${vehicleId}/wake_up`, {}); }
async function getVehicleState(token, apiBase, vehicleId) { const d = await teslaGet(token, apiBase, `/api/1/vehicles/${vehicleId}`); return d.response?.state || 'unknown'; }
async function vehicleChargeStop(token, apiBase, vehicleId) { return teslaPost(token, apiBase, `/api/1/vehicles/${vehicleId}/command/charge_stop`, {}); }
async function vehicleSetChargeLimit(token, apiBase, vehicleId, percent) { return teslaPost(token, apiBase, `/api/1/vehicles/${vehicleId}/command/set_charge_limit`, { percent }); }
async function vehicleChargeStart(token, apiBase, vehicleId) { return teslaPost(token, apiBase, `/api/1/vehicles/${vehicleId}/command/charge_start`, {}); }

function fmt2(n) { return String(n).padStart(2, '0'); }

async function runHolidayMode(state, store, tokenData, currentPctRaw, h, m, deviceId) {
  const hs = JSON.parse(await store.get('holiday_settings_' + deviceId) || 'null') || {};
  const stopHour = hs.stopHour !== undefined ? hs.stopHour : 23;
  const stopMinute = hs.stopMinute !== undefined ? hs.stopMinute : 0;
  const { access, apiBase, energySiteId: siteId } = tokenData;
  const minuteOfDay = h * 60 + m;
  const stopMinuteOfDay = stopHour * 60 + stopMinute;
  const inWindow = minuteOfDay >= (5 * 60 + 30) && minuteOfDay < stopMinuteOfDay;

  if (!inWindow) {
    if (state.holidayExporting) {
      try { await setExport(access, apiBase, siteId, false); await setMode(access, apiBase, siteId, 'autonomous', 0); } catch(e) {}
      state.holidayExporting = false;
      log(state, 'Holiday: window ended at ' + fmt2(h) + ':' + fmt2(m) + ' — export off, ready for overnight cycle');
    }
    return;
  }

  const pct = currentPctRaw >= 0 ? currentPctRaw : 0;
  const pctInt = Math.round(pct);
  const now = Date.now();

  state.holidayConsumptionSamples = state.holidayConsumptionSamples || [];
  if (!state.holidayExporting) {
    if (state.holidayNonExportStart) {
      const elapsed = (now - state.holidayNonExportStart.time) / 3600000;
      if (elapsed >= 0.25) {
        const dropPct = state.holidayNonExportStart.pct - pct;
        if (dropPct > 0 && dropPct < 30) {
          const r = Math.max(0.02, Math.min(2.0, (dropPct / 100 * 13.5) / elapsed));
          state.holidayConsumptionSamples.push(parseFloat(r.toFixed(3)));
          if (state.holidayConsumptionSamples.length > 20) state.holidayConsumptionSamples.shift();
        }
        state.holidayNonExportStart = { pct, time: now };
      }
    } else {
      state.holidayNonExportStart = { pct, time: now };
    }
  } else {
    state.holidayNonExportStart = null;
  }

  const samples = state.holidayConsumptionSamples;
  const measuredRate = samples.length >= 3 ? samples.reduce((s, v) => s + v, 0) / samples.length : 0.3;
  state.holidayConsumptionKwhPerHr = parseFloat(measuredRate.toFixed(3));

  const hoursToStop = Math.max(0, (stopMinuteOfDay - minuteOfDay) / 60);
  const requiredKwh = hoursToStop * measuredRate;
  const reserveFloorPct = Math.min(95, Math.ceil((requiredKwh / 13.5) * 100));
  state.holidayReserveFloorPct = reserveFloorPct;

  const rate = await getOctopusRate(store, deviceId);
  state.holidayCurrentRate = rate;

  const currentSlot30 = Math.floor(minuteOfDay / 30);
  if (state.holidayRatesCacheSlot !== currentSlot30) {
    const stopTimeDate = new Date(); stopTimeDate.setHours(stopHour, stopMinute, 0, 0);
    const remainingRates = await getOctopusRatesForWindow(store, new Date(), stopTimeDate, deviceId);
    state.holidayRatesCache = remainingRates;
    state.holidayRatesCacheSlot = currentSlot30;
  }
  const remainingRates = state.holidayRatesCache || [];

  let topThirdThreshold = 0;
  if (remainingRates.length > 0) {
    const sorted = [...remainingRates].sort((a, b) => b - a);
    topThirdThreshold = sorted[Math.max(1, Math.ceil(sorted.length / 3)) - 1];
  }
  state.holidayRateThreshold = parseFloat(topThirdThreshold.toFixed(1));
  state.holidayTotalSlots = remainingRates.length;

  const inTopThird = rate > 0 && remainingRates.length > 0 && rate >= topThirdThreshold;
  const shouldExport = pctInt > reserveFloorPct && inTopThird;

  if (shouldExport && !state.holidayExporting) {
    try {
      await setMode(access, apiBase, siteId, 'autonomous', 0);
      await setExport(access, apiBase, siteId, true);
      state.holidayExporting = true;
      state.holidayExportStart = { pct, time: now, rate };
      log(state, 'Holiday: export on — ' + rate.toFixed(1) + 'p (top third, threshold ' + topThirdThreshold.toFixed(1) + 'p), battery ' + pctInt + '%, floor ' + reserveFloorPct + '%');
    } catch(e) { log(state, 'Holiday: export start error: ' + e.message); }
  } else if (!shouldExport && state.holidayExporting) {
    try {
      await setExport(access, apiBase, siteId, false);
      await setMode(access, apiBase, siteId, 'autonomous', 0);
      state.holidayExporting = false;
      if (state.holidayExportStart) {
        const durationHrs = (now - state.holidayExportStart.time) / 3600000;
        const totalDropPct = state.holidayExportStart.pct - pct;
        const houseUsedPct = durationHrs * measuredRate / 13.5 * 100;
        const netExportedKwh = parseFloat((Math.max(0, totalDropPct - houseUsedPct) / 100 * 13.5).toFixed(2));
        const avgPeriodRate = (state.holidayExportStart.rate + rate) / 2;
        const periodEarned = parseFloat((netExportedKwh * avgPeriodRate / 100).toFixed(2));
        state.holidayStats = state.holidayStats || { kwh: 0, earned: 0, avgRate: 0, rateSum: 0, rateSamples: 0 };
        state.holidayStats.kwh = parseFloat((state.holidayStats.kwh + netExportedKwh).toFixed(2));
        state.holidayStats.earned = parseFloat((state.holidayStats.earned + periodEarned).toFixed(2));
        state.holidayStats.rateSum = (state.holidayStats.rateSum || 0) + avgPeriodRate;
        state.holidayStats.rateSamples = (state.holidayStats.rateSamples || 0) + 1;
        state.holidayStats.avgRate = parseFloat((state.holidayStats.rateSum / state.holidayStats.rateSamples).toFixed(1));
        state.holidayExportStart = null;
        const reason = pctInt <= reserveFloorPct
          ? 'reserve floor reached (' + pctInt + '% ≤ ' + reserveFloorPct + '%)'
          : 'rate ' + rate.toFixed(1) + 'p below top-third threshold (' + topThirdThreshold.toFixed(1) + 'p)';
        log(state, 'Holiday: export off — ' + reason + ' · ~' + netExportedKwh + ' kWh · £' + periodEarned);
      }
    } catch(e) { log(state, 'Holiday: export stop error: ' + e.message); }
  }
}

async function processUser(store, deviceId) {
  const state = JSON.parse(await store.get('state_' + deviceId) || JSON.stringify(DEFAULT_STATE));
  const pendingCmd = JSON.parse(await store.get('pending_vehicle_cmd_' + deviceId) || 'null');

  let tokenData = JSON.parse(await store.get('token_' + deviceId) || 'null');
  if (!tokenData) return;

  if (tokenData.expiry && Date.now() > tokenData.expiry - 120000) {
    try {
      const refreshed = await refreshTeslaToken(tokenData);
      if (refreshed.access_token) {
        tokenData.access = refreshed.access_token;
        tokenData.refresh = refreshed.refresh_token;
        tokenData.expiry = Date.now() + refreshed.expires_in * 1000;
        await store.set('token_' + deviceId, JSON.stringify(tokenData));
      }
    } catch (e) { log(state, 'Token refresh error: ' + e.message); }
  }

  const timedExport = JSON.parse(await store.get('timed_export_' + deviceId) || 'null');
  if (timedExport && timedExport.endTime && Date.now() >= timedExport.endTime) {
    try { await setExport(tokenData.access, tokenData.apiBase, tokenData.energySiteId, false); } catch (e) {}
    await store.delete('timed_export_' + deviceId);
  }

  // Always fetch live battery % — records SOE history and provides pct for phase logic
  let currentPct = -1;
  try {
    const live = await teslaGet(tokenData.access, tokenData.apiBase, `/api/1/energy_sites/${tokenData.energySiteId}/live_status`);
    currentPct = Math.round(live.response?.percentage_charged ?? -1);
    if (currentPct >= 0) {
      const soeHistory = JSON.parse(await store.get('soe_history_' + deviceId) || '[]');
      soeHistory.push({ t: Date.now(), pct: currentPct });
      const cutoff = Date.now() - 6 * 24 * 3600 * 1000;
      await store.set('soe_history_' + deviceId, JSON.stringify(soeHistory.filter(r => r.t > cutoff)));
    }
  } catch (e) {}

  if (pendingCmd && tokenData.vehicleId) {
    const { access, apiBase } = tokenData;
    const vehicleId = tokenData.vehicleId;
    if (Date.now() - pendingCmd.requestedAt > 5 * 60 * 1000) {
      log(state, 'Vehicle command timed out: ' + pendingCmd.cmd);
      await store.delete('pending_vehicle_cmd_' + deviceId);
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
          await store.delete('pending_vehicle_cmd_' + deviceId);
        } else {
          await wakeVehicle(access, apiBase, vehicleId);
        }
      } catch (e) { log(state, 'Vehicle command error: ' + e.message); }
    }
    await store.set('state_' + deviceId, JSON.stringify(state));
    if (!state.enabled && state.phase === 0) return;
  }

  if (!state.enabled && state.phase === 0 && !state.holidayEnabled) {
    return;
  }

  const rawSettings = await store.get('arb_settings_' + deviceId);
  const s = rawSettings ? { ...DEFAULT_SETTINGS, ...JSON.parse(rawSettings) } : DEFAULT_SETTINGS;
  const { chargeTargetPct, startHour, startMinute, endHour, endMinute } = s;
  const { access, apiBase, energySiteId: siteId } = tokenData;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/London' }));
  const h = now.getHours(), m = now.getMinutes();
  const pct = currentPct >= 0 ? currentPct : 0;

  try {
    if (state.phase === 0 && state.enabled && h === startHour && m >= startMinute) {
      state.phase = 1;
      state.stats = { kwh: 0, rate: 0, earned: 0, phase2StartPct: 0 };
      log(state, '=== Arbitrage cycle started ===');
      await setMode(access, apiBase, siteId, 'autonomous', chargeTargetPct);
      log(state, 'Phase 1: Reserve set to ' + chargeTargetPct + '% — charging from grid');
    }
    else if (state.phase === 1) {
      if (m % 10 === 0) log(state, 'Phase 1 charging — battery at ' + pct + '%');
      if (pct >= chargeTargetPct) {
        log(state, 'Phase 1 complete — battery reached ' + pct + '%');
        state.phase = 2;
        const rate = await getOctopusRate(store, deviceId);
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
            await store.set('pending_vehicle_cmd_' + deviceId, JSON.stringify({ cmd: 'charge_stop', chargeLimit: s.carChargeLimitPhase2 || 50, requestedAt: Date.now() }));
            log(state, 'Vehicle: wake-up sent — charging will stop shortly');
          } catch (e) { log(state, 'Vehicle wake error: ' + e.message); }
        }
      }
    }
    else if (state.phase === 2) {
      const tickRate = await getOctopusRate(store, deviceId);
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
            await store.set('pending_vehicle_cmd_' + deviceId, JSON.stringify({ cmd: 'charge_resume', chargeLimit: limit, requestedAt: Date.now() }));
            log(state, 'Vehicle: wake-up sent — charging will resume to ' + limit + '% shortly');
          } catch (e) { log(state, 'Vehicle wake error: ' + e.message); }
        }
      }
    }
    else if (state.phase === 3) {
      if (m % 10 === 0) log(state, 'Phase 3 recharging — battery at ' + pct + '%');
      if (pct >= 98) {
        log(state, 'Phase 3 complete — battery at ' + pct + '%');
        state.phase = 4;
        log(state, 'Phase 4: Fully charged — standby until ' + fmt2(endHour) + ':' + fmt2(endMinute));
      }
    }
    else if (state.phase === 4 && h === endHour && m >= endMinute) {
      state.phase = 0;
      await setExport(access, apiBase, siteId, false);
      await setMode(access, apiBase, siteId, 'autonomous', 0);
      log(state, '=== Cycle complete — autonomous mode restored, 0% reserve ===');
    }
    else if (state.phase > 0 && h >= endHour + 1) {
      log(state, 'Safety fallback at ' + fmt2(h) + ':' + fmt2(m) + ' — restoring normal mode');
      state.phase = 0;
      await setExport(access, apiBase, siteId, false);
      await setMode(access, apiBase, siteId, 'autonomous', 0);
    }
  } catch (e) {
    log(state, 'Error in phase ' + state.phase + ': ' + e.message);
  }

  if (state.holidayEnabled && state.phase === 0) {
    try { await runHolidayMode(state, store, tokenData, currentPct, h, m, deviceId); }
    catch (e) { log(state, 'Holiday error: ' + e.message); }
  }

  await store.set('state_' + deviceId, JSON.stringify(state));
}

exports.handler = async () => {
  const { getStore } = require('@netlify/blobs');
  const store = getStore({ name: 'arb', siteID: process.env.SITE_ID, token: process.env.NETLIFY_API_TOKEN });
  try {
    const result = await store.list({ prefix: 'device_' });
    const blobs = result.blobs || [];
    await Promise.all(blobs.map(blob =>
      processUser(store, blob.key.replace('device_', '')).catch(() => {})
    ));
  } catch (e) {}
  return { statusCode: 200, body: 'OK' };
};
