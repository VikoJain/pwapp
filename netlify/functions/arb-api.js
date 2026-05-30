const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore({ name: 'arb', siteID: process.env.SITE_ID, token: process.env.NETLIFY_API_TOKEN });
    const state = JSON.parse(await store.get('state') || '{"phase":0,"enabled":false,"log":[],"stats":{"kwh":0,"rate":0,"earned":0}}');

    if (event.httpMethod === 'GET') {
      return { statusCode: 200, headers: CORS, body: JSON.stringify(state) };
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');

      if (body.action === 'save_token') {
        await store.set('token', JSON.stringify({
          access: body.access, refresh: body.refresh, expiry: body.expiry,
          clientId: body.clientId, clientSecret: body.clientSecret,
          apiBase: body.apiBase, energySiteId: body.energySiteId
        }));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'toggle') {
        state.enabled = body.enabled;
        state.log = state.log || [];
        const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        state.log.unshift('[' + time + '] Arbitrage ' + (body.enabled ? 'enabled — server-side, starts at 23:30' : 'disabled by user'));
        if (!body.enabled) state.phase = 0;
        await store.set('state', JSON.stringify(state));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown request' }) };
  } catch (e) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ error: e.message, type: e.constructor.name })
    };
  }
};
