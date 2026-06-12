const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};

const DEFAULT_STATE = '{"phase":0,"enabled":false,"log":[],"stats":{"kwh":0,"rate":0,"earned":0}}';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore({ name: 'arb', siteID: process.env.SITE_ID, token: process.env.NETLIFY_API_TOKEN });

    // Extract device_id from query string (GET) or body (POST)
    const qp = event.queryStringParameters || {};
    const body = event.httpMethod === 'POST' ? JSON.parse(event.body || '{}') : {};
    const device_id = qp.device_id || body.device_id;

    if (!device_id) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing device_id' }) };
    }

    const k = s => s + '_' + device_id; // key scoper helper

    if (event.httpMethod === 'GET') {
      if (qp.type === 'actions') {
        const actionLog = JSON.parse(await store.get(k('action_log')) || '[]');
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ actionLog }) };
      }
      if (qp.type === 'settings') {
        const settings = JSON.parse(await store.get(k('oct_settings')) || 'null');
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ settings }) };
      }
      if (qp.type === 'soe_history') {
        const soeHistory = JSON.parse(await store.get(k('soe_history')) || '[]');
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ soeHistory }) };
      }
      const state = JSON.parse(await store.get(k('state')) || DEFAULT_STATE);
      const arbSettings = JSON.parse(await store.get(k('arb_settings')) || 'null');
      const holidaySettings = JSON.parse(await store.get(k('holiday_settings')) || 'null');
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ...state, arbSettings, holidaySettings }) };
    }

    if (event.httpMethod === 'POST') {
      const state = JSON.parse(await store.get(k('state')) || DEFAULT_STATE);

      if (body.action === 'toggle') {
        state.enabled = body.enabled;
        state.log = state.log || [];
        const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        state.log.unshift('[' + time + '] Arbitrage ' + (body.enabled ? 'enabled — server-side, starts at 23:30' : 'disabled by user'));
        if (!body.enabled) state.phase = 0;
        await store.set(k('state'), JSON.stringify(state));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'save_settings') {
        await store.set(k('oct_settings'), JSON.stringify({
          octKey: body.octKey,
          octTariff: body.octTariff,
          octProduct: body.octProduct,
          octAccount: body.octAccount
        }));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'save_arb_settings') {
        await store.set(k('arb_settings'), JSON.stringify({
          chargeTargetPct: parseInt(body.chargeTargetPct) || 50,
          startHour: body.startHour !== undefined ? parseInt(body.startHour) : 23,
          startMinute: body.startMinute !== undefined ? parseInt(body.startMinute) : 30,
          endHour: body.endHour !== undefined ? parseInt(body.endHour) : 5,
          endMinute: body.endMinute !== undefined ? parseInt(body.endMinute) : 30,
          carControlEnabled: !!body.carControlEnabled,
          carChargeLimit: Math.min(100, Math.max(50, parseInt(body.carChargeLimit) || 80)),
          carChargeLimitPhase2: Math.min(100, Math.max(50, parseInt(body.carChargeLimitPhase2) || 50))
        }));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'toggle_holiday') {
        state.holidayEnabled = !!body.enabled;
        if (body.enabled) {
          state.holidayStats = { kwh: 0, earned: 0, avgRate: 0, rateSum: 0, rateSamples: 0 };
          state.holidayConsumptionSamples = [];
          state.holidayNonExportStart = null;
          state.holidayExportStart = null;
          state.holidayExporting = false;
        } else {
          state.holidayExporting = false;
        }
        await store.set(k('state'), JSON.stringify(state));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'save_holiday_settings') {
        await store.set(k('holiday_settings'), JSON.stringify({
          stopHour: body.stopHour !== undefined ? parseInt(body.stopHour) : 23,
          stopMinute: body.stopMinute !== undefined ? parseInt(body.stopMinute) : 0
        }));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'save_timed_export') {
        await store.set(k('timed_export'), JSON.stringify({ endTime: body.endTime }));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'clear_timed_export') {
        await store.delete(k('timed_export'));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'save_pct_export') {
        await store.set(k('pct_export'), JSON.stringify({ targetPct: parseInt(body.targetPct) }));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'clear_pct_export') {
        await store.delete(k('pct_export'));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'log_action') {
        const actionLog = JSON.parse(await store.get(k('action_log')) || '[]');
        const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        actionLog.unshift({ ts: Date.now(), time, msg: body.msg });
        if (actionLog.length > 100) actionLog.length = 100;
        await store.set(k('action_log'), JSON.stringify(actionLog));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown request' }) };
  } catch (e) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: e.message, type: e.constructor.name }) };
  }
};
