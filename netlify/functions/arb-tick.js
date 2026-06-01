const https = require('https');
const crypto = require('crypto');

const DEFAULT_STATE = { phase: 0, enabled: false, log: [], stats: { kwh: 0, rate: 0, earned: 0 } };

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
  const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  state.log = state.log || [];
  state.log.unshift('[' + time + '] ' + msg);
  if (state.log.length > 50) state.log = state.log.slice(0, 50);
}

async function setMode(token, apiBase, siteId, mode, reserve) {
  return teslaPost(token, apiBase, `/api/1/energy_sites/${siteId}/operation`, {
    default_real_mode: mode, backup_reserve_percent: reserve
  });
}

async function setExport(token, apiBase, siteId, enable) {
  return teslaPost(token, apiBase, `/api/1/energy_sites/${siteId}/grid_import_export`, {
    disallow_charge_from_grid_with_solar_installed: false,
    customer_preferred_export_rule: enable ? 'battery_ok' : 'never'
  });
}

exports.handler = async () => {
  const { getStore } = require('@netlify/blobs');
  const store = getStore({ name: 'arb', siteID: process.env.SITE_ID, token: process.env.NETLIFY_API_TOKEN });
  const state = JSON.parse(await store.get('state') || JSON.stringify(DEFAULT_STATE));

  // Nothing to do if not enabled and not mid-cycle
  if (!state.enabled && state.phase === 0) return { statusCode: 200, body: 'Idle' };

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

  const { access, apiBase, energySiteId: siteId } = tokenData;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/London' }));
  const h = now.getHours(), m = now.getMinutes();

  try {
    // Phase 0 — wait for 23:30 to start cycle
    if (state.phase === 0 && state.enabled && h === 23 && m >= 30) {
      state.phase = 1;
      state.stats = { kwh: 0, rate: 0, earned: 0 };
      log(state, '=== Arbitrage cycle started ===');
      await setMode(access, apiBase, siteId, 'autonomous', 70);
      log(state, 'Phase 1: Reserve set to 70% — charging from grid');
    }

    // Phase 1 — wait for 70%
    else if (state.phase === 1) {
      const live = await teslaGet(access, apiBase, `/api/1/energy_sites/${siteId}/live_status`);
      const pct = Math.round(live.response?.percentage_charged || 0);
      if (pct >= 70) {
        log(state, 'Phase 1 complete — battery at ' + pct + '%');
        state.phase = 2;
        await setMode(access, apiBase, siteId, 'autonomous', 0);
        await setExport(access, apiBase, siteId, true);
        log(state, 'Phase 2: Autonomous + export enabled');
      }
    }

    // Phase 2 — wait for empty
    else if (state.phase === 2) {
      const live = await teslaGet(access, apiBase, `/api/1/energy_sites/${siteId}/live_status`);
      const pct = Math.round(live.response?.percentage_charged || 0);
      if (pct <= 2) {
        log(state, 'Phase 2 complete — battery at ' + pct + '%');
        const earned = (13.5 * (state.stats.rate || 0)) / 100;
        state.stats = { kwh: 13.5, rate: state.stats.rate || 0, earned };
        log(state, 'Est. £' + earned.toFixed(2) + ' earned');
        state.phase = 3;
        await setExport(access, apiBase, siteId, false);
        await setMode(access, apiBase, siteId, 'autonomous', 100);
        log(state, 'Phase 3: Reserve set to 100% — recharging from grid');
      }
    }

    // Phase 3 — wait for recharged to 100%
    else if (state.phase === 3) {
      const live = await teslaGet(access, apiBase, `/api/1/energy_sites/${siteId}/live_status`);
      const pct = Math.round(live.response?.percentage_charged || 0);
      if (pct >= 98) {
        log(state, 'Phase 3 complete — battery at ' + pct + '%');
        state.phase = 4;
        log(state, 'Phase 4: Fully charged — standby until 5:30am');
      }
    }

    // Phase 4 — wait for 5:30am
    else if (state.phase === 4 && h === 5 && m >= 30) {
      state.phase = 0;
      await setExport(access, apiBase, siteId, false);
      await setMode(access, apiBase, siteId, 'autonomous', 0);
      log(state, '=== Cycle complete — autonomous mode restored, 0% reserve ===');
    }

    // Safety fallback — if still running after 6am
    else if (state.phase > 0 && h >= 6) {
      log(state, 'Safety fallback at ' + h + ':' + String(m).padStart(2,'0') + ' — restoring normal mode');
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
