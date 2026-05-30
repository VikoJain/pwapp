let getStore;
try {
  getStore = require('@netlify/blobs').getStore;
} catch(e) {
  exports.handler = async () => ({
    statusCode: 500,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'Module load failed: ' + e.message })
  });
  return;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

const DEFAULT_STATE = { phase: 0, enabled: false, log: [], stats: { kwh: 0, rate: 0, earned: 0 } };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  try {
    const store = getStore('arb');

    if (event.httpMethod === 'GET') {
      const state = JSON.parse(await store.get('state') || JSON.stringify(DEFAULT_STATE));
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify(state)
      };
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const state = JSON.parse(await store.get('state') || JSON.stringify(DEFAULT_STATE));

      if (body.action === 'save_token') {
        await store.set('token', JSON.stringify({
          access: body.access,
          refresh: body.refresh,
          expiry: body.expiry,
          clientId: body.clientId,
          clientSecret: body.clientSecret,
          apiBase: body.apiBase,
          energySiteId: body.energySiteId
        }));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'toggle') {
        state.enabled = body.enabled;
        if (!body.enabled) {
          state.phase = 0;
          const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
          state.log = state.log || [];
          state.log.unshift('[' + time + '] Arbitrage disabled by user');
        } else {
          const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
          state.log = state.log || [];
          state.log.unshift('[' + time + '] Arbitrage enabled — server-side, starts at 23:30');
        }
        await store.set('state', JSON.stringify(state));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    return { statusCode: 405, headers: CORS, body: 'Method not allowed' };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
