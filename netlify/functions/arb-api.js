const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};

const DEFAULT_STATE = '{"phase":0,"enabled":false,"log":[],"stats":{"kwh":0,"rate":0,"earned":0}}';

// Every per-device blob key ends with "_<device_id>" (state_, token_, day_settings_, soe_history_,
// device_<id> itself, etc.). Returns all keys belonging to one device so delete_device can remove
// an orphaned record completely. Exported for unit testing so the matcher can't drift.
function keysForDevice(allKeys, id) {
  const suffix = '_' + id;
  return allKeys.filter(key => key.endsWith(suffix));
}
module.exports.keysForDevice = keysForDevice;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore({ name: 'arb', siteID: process.env.SITE_ID, token: process.env.NETLIFY_API_TOKEN });

    const qp = event.queryStringParameters || {};

    // Endpoints that don't require device_id
    if (event.httpMethod === 'GET' && qp.type === 'vapid_public_key') {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ publicKey: process.env.VAPID_PUBLIC_KEY || '' }) };
    }

    // Diagnostic: list every device record arb-tick is still driving. An ORPHANED record — left
    // behind when the PWA was reinstalled and the localStorage device_id regenerated — keeps running
    // with its old settings and its own auto-refreshed Tesla token, silently controlling the same
    // Powerwall (e.g. a Day/Sell export at the evening peak that never appears in the current UI's
    // activity log). This surfaces them so the orphan can be identified and removed. device_id is
    // optional and only used to flag which record is the caller's current one.
    if (event.httpMethod === 'GET' && qp.type === 'devices') {
      const currentId = qp.device_id || null;
      const result = await store.list({ prefix: 'device_' });
      const blobs = result.blobs || [];
      const devices = [];
      for (const b of blobs) {
        const id = b.key.replace('device_', '');
        const st = JSON.parse(await store.get('state_' + id) || DEFAULT_STATE);
        const ds = JSON.parse((await store.get('day_settings_' + id)) || (await store.get('holiday_settings_' + id)) || 'null');
        const cs = JSON.parse(await store.get('car_sync_settings_' + id) || 'null');
        const tok = JSON.parse(await store.get('token_' + id) || 'null');
        devices.push({
          deviceId: id,
          isCurrent: id === currentId,
          nightEnabled: !!st.enabled,
          phase: st.phase || 0,
          dayEnabled: !!(st.dayEnabled || st.holidayEnabled),
          dayExporting: !!st.dayExporting,
          dayCharging: !!st.dayCharging,
          sellEnabled: ds ? ds.sellEnabled !== false : null,
          arbEnabled: ds ? ds.arbEnabled !== false : null,
          carSyncEnabled: !!(cs && cs.enabled),
          hasToken: !!(tok && tok.access),
          energySiteId: (tok && tok.energySiteId) || null,
          lastClientSeen: st.lastClientSeen || null,
          lastLog: (st.log && st.log.length) ? st.log[0] : null
        });
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ devices, currentDeviceId: currentId }) };
    }

    // All other requests require device_id
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
      // Stamp last-seen so arb-tick's staleness guard can retire orphaned records (a real device's
      // UI polls this constantly; an orphan never does). Throttled to ~1/hr to avoid a write per poll.
      const nowMs = Date.now();
      if (!state.lastClientSeen || nowMs - state.lastClientSeen > 60 * 60 * 1000) {
        state.lastClientSeen = nowMs;
        try { await store.set(k('state'), JSON.stringify(state)); } catch(_) {}
      }
      const arbSettings = JSON.parse(await store.get(k('arb_settings')) || 'null');
      const daySettings = JSON.parse(await store.get(k('day_settings')) || await store.get(k('holiday_settings')) || 'null');
      const carSyncSettings = JSON.parse(await store.get(k('car_sync_settings')) || 'null');
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ...state, arbSettings, daySettings, carSyncSettings }) };
    }

    if (event.httpMethod === 'POST') {
      const state = JSON.parse(await store.get(k('state')) || DEFAULT_STATE);

      if (body.action === 'toggle') {
        state.enabled = !!body.enabled;
        state.log = state.log || [];
        const _now = new Date();
        const _date = _now.toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short' });
        const _time = _now.toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
        state.log.unshift('[' + _date + ' ' + _time + '] Arbitrage ' + (body.enabled ? 'enabled — server-side, starts at 23:30' : 'disabled by user'));
        // Do not reset phase here — arb-tick handles clean shutdown if disabled mid-cycle
        await store.set(k('state'), JSON.stringify(state));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'delete_device') {
        // Remove every blob belonging to a device record so arb-tick stops processing it. Used to
        // evict an orphaned record that is still driving the Powerwall from a stale PWA install.
        const target = body.target_device_id;
        if (!target) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing target_device_id' }) };
        if (target === device_id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Refusing to delete the current device' }) };
        const all = await store.list();
        const keys = keysForDevice((all.blobs || []).map(x => x.key), target);
        for (const key of keys) { try { await store.delete(key); } catch(_) {} }
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, deleted: keys }) };
      }

      if (body.action === 'save_settings') {
        const existing = JSON.parse(await store.get(k('oct_settings')) || 'null') || {};
        await store.set(k('oct_settings'), JSON.stringify({
          octKey: body.octKey,
          octTariff: body.octTariff,
          octProduct: body.octProduct,
          octAccount: body.octAccount,
          octImportTariff: body.octImportTariff || existing.octImportTariff || null,
          octImportProduct: body.octImportProduct || existing.octImportProduct || null,
          offPeakStart: body.offPeakStart ?? existing.offPeakStart ?? null,
          offPeakEnd: body.offPeakEnd ?? existing.offPeakEnd ?? null,
          offPeakRate: body.offPeakRate ?? existing.offPeakRate ?? null
        }));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'save_tariff_window') {
        const existing = JSON.parse(await store.get(k('oct_settings')) || 'null') || {};
        await store.set(k('oct_settings'), JSON.stringify({
          ...existing,
          offPeakStart: body.offPeakStart ?? null,
          offPeakEnd: body.offPeakEnd ?? null,
          offPeakRate: body.offPeakRate ?? existing.offPeakRate ?? null
        }));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'save_arb_settings') {
        const _sh = parseInt(body.startHour), _sm = parseInt(body.startMinute);
        const _eh = parseInt(body.endHour), _em = parseInt(body.endMinute);
        await store.set(k('arb_settings'), JSON.stringify({
          chargeTargetPct: parseInt(body.chargeTargetPct) || 50,
          startHour: !isNaN(_sh) ? _sh : 23,
          startMinute: !isNaN(_sm) ? _sm : 30,
          endHour: !isNaN(_eh) ? _eh : 5,
          endMinute: !isNaN(_em) ? _em : 30,
          carControlEnabled: !!body.carControlEnabled,
          carChargeLimit: Math.min(100, Math.max(50, parseInt(body.carChargeLimit) || 80)),
          carChargeLimitPhase2: Math.min(100, Math.max(50, parseInt(body.carChargeLimitPhase2) || 50))
        }));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'toggle_day' || body.action === 'toggle_holiday') {
        state.dayEnabled = !!body.enabled;
        state.holidayEnabled = false;
        if (body.enabled) {
          state.dayStats = { kwh: 0, earned: 0, avgRate: 0, importCost: 0, rateSum: 0, rateSamples: 0 };
          state.dayConsumptionSamples = [];
          state.dayNonExportStart = null;
          state.dayExportStart = null;
          state.dayExporting = false;
          state.dayCharging = false;
          state.dayChargeStart = null;
          state.dayRatesCacheDay = null;
          state.dayExportSlots = [];
          state.dayChargeSlot = null;
          state.dayNeedsCharge = false;
          state.dayChargeStartMins = null;
          state.dayFloorApplied = false;
          state.dayChargeHold = false;
        } else {
          // Leave dayCharging/dayExporting flags as-is so arb-tick can detect and clean up
          // the Powerwall state on the next tick (sends API commands to restore normal mode)
        }
        await store.set(k('state'), JSON.stringify(state));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'save_day_settings' || body.action === 'save_holiday_settings') {
        await store.set(k('day_settings'), JSON.stringify({
          stopHour: body.stopHour !== undefined ? parseInt(body.stopHour) : 23,
          stopMinute: body.stopMinute !== undefined ? parseInt(body.stopMinute) : 0,
          minMargin: body.minMargin !== undefined ? parseFloat(body.minMargin) : 2.0,
          awayMode: body.awayMode !== false,
          manualFloorPct: body.manualFloorPct !== undefined ? parseInt(body.manualFloorPct) : 20,
          sellEnabled: body.sellEnabled !== false,
          arbEnabled: body.arbEnabled !== false
        }));
        // Force strategy recalculation on next tick when settings change
        const freshState = JSON.parse(await store.get(k('state')) || DEFAULT_STATE);
        freshState.dayRatesCacheDay = null;
        freshState.dayFloorApplied = false;
        freshState.dayChargeHold = false;
        await store.set(k('state'), JSON.stringify(freshState));
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
        const t = parseInt(body.targetPct);
        if (isNaN(t) || t < 0 || t > 100) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid targetPct' }) };
        await store.set(k('pct_export'), JSON.stringify({ targetPct: t }));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'clear_pct_export') {
        await store.delete(k('pct_export'));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'save_car_sync_settings') {
        await store.set(k('car_sync_settings'), JSON.stringify({
          enabled: !!body.enabled,
          priority: body.priority === 'car' ? 'car' : 'export'
        }));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'save_push_subscription') {
        await store.set(k('push_subscription'), JSON.stringify(body.subscription));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'delete_push_subscription') {
        await store.delete(k('push_subscription'));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      }

      if (body.action === 'log_action') {
        const actionLog = JSON.parse(await store.get(k('action_log')) || '[]');
        const _n = new Date();
        const _d = _n.toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short' });
        const _t = _n.toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
        const time = _d + ' ' + _t;
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
