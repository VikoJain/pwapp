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
    const state = JSON.parse(await store.get('state') || '{"phase":0,"enabled":false,"log":[],"stats":{"kwh":0,"rate":0,"earned":0,"importCost":0,"netProfit":0}}');

    if (event.httpMethod === 'GET') {
      if (event.queryStringParameters && event.queryStringParameters.type === 'actions') {
        const actionLog = JSON.parse(await store.get('action_log') || '[]');
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ actionLog }) };
      }
      if (event.queryStringParameters && event.queryStringParameters.type === 'settings') {
        const settings = JSON.parse(await store.get('oct_settings') || 'null');
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ settings }) };
      }
      const arbSettings = JSON.parse(await store.get('arb_settings') || 'null');
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ...state, arbSettings }) };
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

      if (body.action === 'save_settings') {
        await store.set('oct_settings', JSON.stringify({
          octKey: body.octKey,
          octTariff: body.octTariff,
          octProduct: body.octProduct,
          octAccount: body.octAccount,
          importTariff: body.importTariff,
          importProduct: body.importProduct,
          cheapRate: body.cheapRate
        }));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'save_arb_settings') {
        await store.set('arb_settings', JSON.stringify({
          chargeTargetPct: parseInt(body.chargeTargetPct) || 50,
          startHour: body.startHour !== undefined ? parseInt(body.startHour) : 23,
          startMinute: body.startMinute !== undefined ? parseInt(body.startMinute) : 30,
          endHour: body.endHour !== undefined ? parseInt(body.endHour) : 5,
          endMinute: body.endMinute !== undefined ? parseInt(body.endMinute) : 30,
          carControlEnabled: !!body.carControlEnabled,
          carChargeLimit: Math.min(100, Math.max(50, parseInt(body.carChargeLimit) || 80))
        }));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'log_action') {
        const actionLog = JSON.parse(await store.get('action_log') || '[]');
        const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        actionLog.unshift({ ts: Date.now(), time, msg: body.msg });
        if (actionLog.length > 100) actionLog.length = 100;
        await store.set('action_log', JSON.stringify(actionLog));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'save_timed_export') {
        await store.set('timed_export', JSON.stringify({ endTime: body.endTime }));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'clear_timed_export') {
        await store.delete('timed_export');
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
