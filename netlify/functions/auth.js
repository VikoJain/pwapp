const https = require('https');

const CLIENT_ID = process.env.TESLA_CLIENT_ID;
const CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET;
const REDIRECT_URI = process.env.TESLA_REDIRECT_URI;
const AUTH_HOST = 'fleet-auth.prd.vn.cloud.tesla.com';
const AUTH_PATH = '/oauth2/v3/token';
const API_BASE = 'https://fleet-api.prd.eu.vn.cloud.tesla.com';
const SCOPE = 'openid offline_access user_data energy_device_data energy_cmds';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};

function makeRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function teslaTokenRequest(params) {
  const postData = new URLSearchParams(params).toString();
  const res = await makeRequest({
    hostname: AUTH_HOST, path: AUTH_PATH, method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, postData);
  return JSON.parse(res.body);
}

// Keep the shared arb 'token' blob in sync so arb-tick.js always has current credentials
async function updateArbToken(store, tok) {
  try {
    await store.set('token', JSON.stringify({
      access: tok.access,
      refresh: tok.refresh,
      expiry: tok.expiry,
      clientId: CLIENT_ID,
      apiBase: tok.apiBase || API_BASE,
      energySiteId: tok.energySiteId || null
    }));
  } catch (e) {}
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const { getStore } = require('@netlify/blobs');
  const store = getStore({ name: 'arb', siteID: process.env.SITE_ID, token: process.env.NETLIFY_API_TOKEN });

  try {

    // ── GET ───────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
      const p = event.queryStringParameters || {};

      // Return the Tesla OAuth URL for the client to redirect to
      if (p.action === 'url') {
        if (!CLIENT_ID || !REDIRECT_URI) {
          return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'App not configured — contact support' }) };
        }
        if (!p.device_id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing device_id' }) };
        // Encode the device_id in the state parameter so we can retrieve it in the callback
        const state = Buffer.from(JSON.stringify({ d: p.device_id })).toString('base64');
        const authUrl = 'https://' + AUTH_HOST + '/oauth2/v3/authorize' +
          '?client_id=' + encodeURIComponent(CLIENT_ID) +
          '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
          '&response_type=code' +
          '&scope=' + encodeURIComponent(SCOPE) +
          '&state=' + encodeURIComponent(state) +
          '&audience=' + encodeURIComponent(API_BASE);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ authUrl }) };
      }

      // Restore a stored token by device ID — called on app load after reinstall
      if (p.action === 'restore') {
        if (!p.device_id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing device_id' }) };
        const raw = await store.get('device_' + p.device_id);
        if (!raw) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'No credentials found for this device' }) };
        let tok = JSON.parse(raw);
        // Proactively refresh if expiring within 5 minutes
        if (tok.expiry && Date.now() > tok.expiry - 300000) {
          try {
            const refreshed = await teslaTokenRequest({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: tok.refresh });
            if (refreshed.access_token) {
              tok.access = refreshed.access_token;
              tok.refresh = refreshed.refresh_token;
              tok.expiry = Date.now() + refreshed.expires_in * 1000;
              await store.set('device_' + p.device_id, JSON.stringify(tok));
              await updateArbToken(store, tok);
            }
          } catch (e) {}
        }
        return { statusCode: 200, headers: CORS, body: JSON.stringify({
          access_token: tok.access,
          refresh_token: tok.refresh,
          expiry: tok.expiry,
          energy_site_id: tok.energySiteId || null,
          api_base: tok.apiBase || API_BASE
        })};
      }
    }

    // ── POST ──────────────────────────────────────────────────
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');

      // Exchange OAuth authorisation code for tokens
      if (body.action === 'exchange') {
        const { code, device_id } = body;
        if (!code || !device_id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing code or device_id' }) };
        const tok = await teslaTokenRequest({
          grant_type: 'authorization_code',
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code,
          redirect_uri: REDIRECT_URI,
          audience: API_BASE
        });
        if (!tok.access_token) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: tok.error || 'Token exchange failed' }) };
        const expiry = Date.now() + tok.expires_in * 1000;
        const stored = { access: tok.access_token, refresh: tok.refresh_token, expiry, clientId: CLIENT_ID, apiBase: API_BASE };
        await store.set('device_' + device_id, JSON.stringify(stored));
        await updateArbToken(store, stored);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ access_token: tok.access_token, refresh_token: tok.refresh_token, expiry }) };
      }

      // Refresh an expired token using the stored refresh token
      if (body.action === 'refresh') {
        const { device_id } = body;
        if (!device_id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing device_id' }) };
        const raw = await store.get('device_' + device_id);
        if (!raw) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'No credentials found' }) };
        let tok = JSON.parse(raw);
        const refreshed = await teslaTokenRequest({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: tok.refresh });
        if (!refreshed.access_token) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Refresh failed' }) };
        tok.access = refreshed.access_token;
        tok.refresh = refreshed.refresh_token;
        tok.expiry = Date.now() + refreshed.expires_in * 1000;
        await store.set('device_' + device_id, JSON.stringify(tok));
        await updateArbToken(store, tok);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ access_token: tok.access, refresh_token: tok.refresh, expiry: tok.expiry }) };
      }

      // Save energy site ID after client-side discovery
      if (body.action === 'save_site') {
        const { device_id, energy_site_id, api_base } = body;
        if (!device_id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing device_id' }) };
        const raw = await store.get('device_' + device_id);
        if (raw) {
          const tok = JSON.parse(raw);
          tok.energySiteId = energy_site_id;
          if (api_base) tok.apiBase = api_base;
          await store.set('device_' + device_id, JSON.stringify(tok));
          await updateArbToken(store, tok);
        }
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
