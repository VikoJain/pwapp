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

async function sendPush(store, deviceId, title, body) {
  try {
    const sub = JSON.parse(await store.get('push_subscription_' + deviceId) || 'null');
    if (!sub) return;
    const webpush = require('web-push');
    webpush.setVapidDetails(
      process.env.VAPID_EMAIL,
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    await webpush.sendNotification(sub, JSON.stringify({ title, body }));
  } catch(e) {
    if (e.statusCode === 410 || e.statusCode === 404) {
      try { await store.delete('push_subscription_' + deviceId); } catch(_) {}
    }
  }
}

function log(state, msg) {
  const time = new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
    if (data.results && data.results.length) return data.results.map(r => ({ value: parseFloat(parseFloat(r.value_inc_vat).toFixed(2)), validFrom: r.valid_from }));
  } catch (e) {}
  return [];
}

async function getImportDayRate(store, deviceId) {
  try {
    const settings = JSON.parse(await store.get('oct_settings_' + deviceId) || 'null');
    if (!settings || !settings.octKey || !settings.octImportTariff || !settings.octImportProduct) return null;
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    const noonEnd = new Date(noon.getTime() + 30 * 60 * 1000);
    const fmt = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const path = '/v1/products/' + settings.octImportProduct + '/electricity-tariffs/' + settings.octImportTariff +
      '/standard-unit-rates/?period_from=' + fmt(noon) + '&period_to=' + fmt(noonEnd) + '&page_size=2';
    const authHeader = 'Basic ' + Buffer.from(settings.octKey + ':').toString('base64');
    const res = await makeRequest({ hostname: 'api.octopus.energy', path, method: 'GET', headers: { 'Authorization': authHeader } }, null);
    const data = JSON.parse(res.body);
    if (data.results && data.results.length > 0) return parseFloat(parseFloat(data.results[0].value_inc_vat).toFixed(2));
  } catch (e) {}
  return null;
}

async function wakeVehicle(token, apiBase, vehicleId) { return teslaPost(token, apiBase, `/api/1/vehicles/${vehicleId}/wake_up`, {}); }
async function getVehicleState(token, apiBase, vehicleId) { const d = await teslaGet(token, apiBase, `/api/1/vehicles/${vehicleId}`); return d.response?.state || 'unknown'; }
async function getVehicleChargeState(token, apiBase, vehicleId) {
  const d = await teslaGet(token, apiBase, `/api/1/vehicles/${vehicleId}/vehicle_data?endpoints=charge_state`);
  return d.response?.charge_state?.charging_state || 'Unknown';
}
async function vehicleChargeStop(token, apiBase, vehicleId) { return teslaPost(token, apiBase, `/api/1/vehicles/${vehicleId}/command/charge_stop`, {}); }
async function vehicleSetChargeLimit(token, apiBase, vehicleId, percent) { return teslaPost(token, apiBase, `/api/1/vehicles/${vehicleId}/command/set_charge_limit`, { percent }); }
async function vehicleChargeStart(token, apiBase, vehicleId) { return teslaPost(token, apiBase, `/api/1/vehicles/${vehicleId}/command/charge_start`, {}); }

function fmt2(n) { return String(n).padStart(2, '0'); }

async function runDayMode(state, store, tokenData, currentPctRaw, h, m, deviceId) {
  const ds = JSON.parse(await store.get('day_settings_' + deviceId) || 'null') ||
             JSON.parse(await store.get('holiday_settings_' + deviceId) || 'null') || {};
  const stopHour = ds.stopHour !== undefined ? ds.stopHour : 23;
  const stopMinute = ds.stopMinute !== undefined ? ds.stopMinute : 0;
  const minMargin = ds.minMargin !== undefined ? parseFloat(ds.minMargin) : 2.0;
  const { access, apiBase, energySiteId: siteId } = tokenData;
  const minuteOfDay = h * 60 + m;
  const stopMinuteOfDay = stopHour * 60 + stopMinute;
  const inWindow = minuteOfDay >= (5 * 60 + 30) && minuteOfDay < stopMinuteOfDay;

  // Build day strategy once per calendar day (before window guard so UI shows it at any time)
  const londonNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/London' }));
  const currentDateKey = `${londonNow.getFullYear()}-${londonNow.getMonth()}-${londonNow.getDate()}`;
  if (state.dayRatesCacheDay !== currentDateKey) {
    const windowStart = new Date(); windowStart.setHours(5, 30, 0, 0);
    const stopTimeDate = new Date(); stopTimeDate.setHours(stopHour, stopMinute, 0, 0);
    const [exportRates, importRate] = await Promise.all([
      getOctopusRatesForWindow(store, windowStart, stopTimeDate, deviceId),
      getImportDayRate(store, deviceId)
    ]);
    state.dayImportRate = importRate;
    const EFFICIENCY = 0.9;
    const pctForPlan = currentPctRaw >= 0 ? currentPctRaw : 0;
    let dayExportSlots = [], dayNeedsCharge = false, dayChargeTargetPct = pctForPlan, dayChargeSlot = null;
    let dayEstimatedRevenue = 0, dayEstimatedImportCost = 0;
    if (exportRates.length > 0 && importRate) {
      const profitable = exportRates
        .filter(r => (r.value * EFFICIENCY) - importRate >= minMargin)
        .sort((a, b) => new Date(a.validFrom) - new Date(b.validFrom));
      // Battery capacity: how many consecutive 30-min slots can we sustain?
      const SLOT_KWH = 5 * 0.5; // 2.5 kWh per slot at 5kW
      const planFloorPct = ds.awayMode === false && ds.manualFloorPct !== undefined ? ds.manualFloorPct : 10;
      const usableKwh = Math.max(0, (100 - planFloorPct) / 100 * 13.5);
      const maxSlots = Math.max(1, Math.floor(usableKwh / SLOT_KWH));

      // Group profitable slots into consecutive blocks (30-min gaps only)
      const blocks = [];
      let blk = [];
      for (const s of profitable) {
        if (!blk.length) { blk.push(s); continue; }
        const gap = new Date(s.validFrom) - new Date(blk[blk.length - 1].validFrom);
        if (gap <= 31 * 60 * 1000) { blk.push(s); } else { blocks.push(blk); blk = [s]; }
      }
      if (blk.length) blocks.push(blk);

      // Find the best consecutive window (sliding window within each block)
      let bestWindow = [], bestRevenue = 0;
      for (const block of blocks) {
        const w = Math.min(maxSlots, block.length);
        for (let i = 0; i <= block.length - w; i++) {
          const win = block.slice(i, i + w);
          const rev = win.reduce((sum, s) => sum + s.value * EFFICIENCY * SLOT_KWH, 0);
          if (rev > bestRevenue) { bestRevenue = rev; bestWindow = win; }
        }
      }

      dayExportSlots = bestWindow.map(s => {
        const ls = new Date(new Date(s.validFrom).toLocaleString('en-US', { timeZone: 'Europe/London' }));
        return { time: fmt2(ls.getHours()) + ':' + fmt2(ls.getMinutes()), rate: s.value, profit: parseFloat(((s.value * EFFICIENCY) - importRate).toFixed(1)) };
      });

      // Future slots within the selected window for charge planning
      const futureProfit = bestWindow.filter(s => {
        const ls = new Date(new Date(s.validFrom).toLocaleString('en-US', { timeZone: 'Europe/London' }));
        return ls.getHours() * 60 + ls.getMinutes() > minuteOfDay;
      });

      if (futureProfit.length > 0) {
        const CHARGE_RATE_KW = 3.68;
        const firstLS = new Date(new Date(futureProfit[0].validFrom).toLocaleString('en-US', { timeZone: 'Europe/London' }));
        const firstExportMins = firstLS.getHours() * 60 + firstLS.getMinutes();

        // Estimate battery % at first export assuming house drains at measured rate
        // Default 0.3 kWh/hr until samples build up
        const consumptionRate = state.dayConsumptionKwhPerHr > 0 ? state.dayConsumptionKwhPerHr : 0.3;
        const hoursUntilExport = Math.max(0, (firstExportMins - minuteOfDay) / 60);
        const estimatedDrainPct = Math.min(pctForPlan, (hoursUntilExport * consumptionRate / 13.5) * 100);
        const estimatedPctAtExport = Math.max(0, pctForPlan - estimatedDrainPct);

        // Charge needed = get from estimated level at export time up to 100%
        const chargeNeededKwh = Math.max(0, (100 - estimatedPctAtExport) / 100 * 13.5);
        dayNeedsCharge = chargeNeededKwh > 0.5;
        dayChargeTargetPct = 100; // Always aim for full battery entering export window

        // Just-in-time: start charging only as late as possible before export
        const chargeTimeMins = Math.ceil(chargeNeededKwh / CHARGE_RATE_KW * 60) + 15; // +15 min buffer
        const chargeStartMins = Math.max(minuteOfDay, firstExportMins - chargeTimeMins);
        state.dayChargeStartMins = chargeStartMins;

        if (dayNeedsCharge) {
          dayChargeSlot = {
            startTime: fmt2(Math.floor(chargeStartMins / 60)) + ':' + fmt2(chargeStartMins % 60),
            endTime: fmt2(firstLS.getHours()) + ':' + fmt2(firstLS.getMinutes()),
            targetPct: 100,
            estimatedCostGbp: parseFloat((chargeNeededKwh * importRate / 100).toFixed(2))
          };
          dayEstimatedImportCost = dayChargeSlot.estimatedCostGbp;
        }
      }
      dayEstimatedRevenue = parseFloat((dayExportSlots.reduce((sum, s) => sum + s.rate * EFFICIENCY * 5 * 0.5, 0) / 100).toFixed(2));
    } else if (exportRates.length > 0 && !importRate) {
      // No import tariff configured — fall back to showing all export slots, no charge logic
      dayExportSlots = exportRates
        .sort((a, b) => b.value - a.value)
        .slice(0, Math.max(1, Math.ceil((pctForPlan / 100 * 13.5) / 5)))
        .map(s => {
          const ls = new Date(new Date(s.validFrom).toLocaleString('en-US', { timeZone: 'Europe/London' }));
          return { time: fmt2(ls.getHours()) + ':' + fmt2(ls.getMinutes()), rate: s.value, profit: null };
        }).sort((a, b) => a.time.localeCompare(b.time));
    }
    if (exportRates.length > 0) {
      state.dayRatesCacheDay = currentDateKey;
      state.dayExportSlots = dayExportSlots;
      state.dayNeedsCharge = dayNeedsCharge;
      state.dayChargeTargetPct = dayChargeTargetPct;
      state.dayChargeSlot = dayChargeSlot;
      state.dayEstimatedRevenue = dayEstimatedRevenue;
      state.dayEstimatedImportCost = dayEstimatedImportCost;
      state.dayEstimatedProfit = parseFloat((dayEstimatedRevenue - dayEstimatedImportCost).toFixed(2));
      const windowEnd = dayExportSlots.length > 0 ? (() => { const last = dayExportSlots[dayExportSlots.length-1]; const [h2,m2] = last.time.split(':').map(Number); const end = h2*60+m2+30; return fmt2(Math.floor(end/60))+':'+fmt2(end%60); })() : '';
      log(state, 'Day: strategy — ' + dayExportSlots.length + '-slot window' +
        (dayExportSlots.length > 0 ? ' ' + dayExportSlots[0].time + '–' + windowEnd : '') +
        (dayNeedsCharge ? ', charging ' + (dayChargeSlot ? dayChargeSlot.startTime + '→' + dayChargeSlot.endTime : '') : '') +
        (importRate ? ' · import ' + importRate.toFixed(1) + 'p' : ' · no import tariff'));
    }
  }

  if (!inWindow) {
    if (state.dayExporting) {
      try { await setExport(access, apiBase, siteId, false); await setMode(access, apiBase, siteId, 'autonomous', 0); } catch(e) {}
      state.dayExporting = false;
      log(state, 'Day: window ended at ' + fmt2(h) + ':' + fmt2(m) + ' — export off, ready for overnight cycle');
    }
    if (state.dayCharging) {
      try { await setMode(access, apiBase, siteId, 'autonomous', 0); } catch(e) {}
      state.dayCharging = false;
      log(state, 'Day: window ended — charge off');
    }
    return;
  }

  const pct = currentPctRaw >= 0 ? currentPctRaw : 0;
  const pctInt = Math.round(pct);
  const now = Date.now();

  // Adaptive standby consumption tracking — used to maintain reserve floor until stop time
  state.dayConsumptionSamples = state.dayConsumptionSamples || [];
  if (!state.dayExporting && !state.dayCharging) {
    if (state.dayNonExportStart) {
      const elapsed = (now - state.dayNonExportStart.time) / 3600000;
      if (elapsed >= 0.25) {
        const dropPct = state.dayNonExportStart.pct - pct;
        if (dropPct > 0 && dropPct < 30) {
          const r = Math.max(0.02, Math.min(2.0, (dropPct / 100 * 13.5) / elapsed));
          state.dayConsumptionSamples.push(parseFloat(r.toFixed(3)));
          if (state.dayConsumptionSamples.length > 20) state.dayConsumptionSamples.shift();
        }
        state.dayNonExportStart = { pct, time: now };
      }
    } else {
      state.dayNonExportStart = { pct, time: now };
    }
  } else {
    state.dayNonExportStart = null;
  }

  const samples = state.dayConsumptionSamples;
  const measuredRate = samples.length >= 3 ? samples.reduce((s, v) => s + v, 0) / samples.length : 0.3;
  state.dayConsumptionKwhPerHr = parseFloat(measuredRate.toFixed(3));

  let reserveFloorPct;
  if (ds.awayMode === false && ds.manualFloorPct !== undefined) {
    reserveFloorPct = Math.min(95, Math.max(0, parseInt(ds.manualFloorPct)));
  } else {
    const hoursToStop = Math.max(0, (stopMinuteOfDay - minuteOfDay) / 60);
    const requiredKwh = hoursToStop * measuredRate;
    reserveFloorPct = Math.min(95, Math.ceil((requiredKwh / 13.5) * 100));
  }
  state.dayReserveFloorPct = reserveFloorPct;

  const exportSlots = state.dayExportSlots || [];

  // Determine if currently in a profitable export slot
  let inExportSlot = false;
  for (const slot of exportSlots) {
    const [sh, sm] = slot.time.split(':').map(Number);
    const slotMins = sh * 60 + sm;
    if (minuteOfDay >= slotMins && minuteOfDay < slotMins + 30) { inExportSlot = true; break; }
  }

  // Only consider FUTURE slots for charge timing — handles mid-day enabling correctly
  const futureSlots = exportSlots.filter(s => {
    const [sh, sm] = s.time.split(':').map(Number);
    return sh * 60 + sm > minuteOfDay;
  });
  const firstFutureExportMins = futureSlots.length > 0
    ? (() => { const [sh, sm] = futureSlots[0].time.split(':').map(Number); return sh * 60 + sm; })()
    : 9999;

  // Just-in-time charge: only start when close enough to first export slot
  const chargeStartMins = state.dayChargeStartMins || 0;
  const shouldCharge = !!(state.dayNeedsCharge &&
    minuteOfDay >= chargeStartMins &&
    minuteOfDay < firstFutureExportMins &&
    pctInt < (state.dayChargeTargetPct || 100) &&
    !inExportSlot);

  if (shouldCharge && !state.dayCharging && !state.dayExporting) {
    try {
      await setMode(access, apiBase, siteId, 'autonomous', 100);
      state.dayCharging = true;
      state.dayChargeStart = { pct, time: now };
      log(state, 'Day: force charge started — battery at ' + pctInt + '%, target ' + state.dayChargeTargetPct + '%');
      await sendPush(store, deviceId, 'Day: charging for export', 'Charging to ' + state.dayChargeTargetPct + '% before export window');
    } catch(e) { log(state, 'Day: charge start error: ' + e.message); }
  }

  if (state.dayCharging && (!shouldCharge || inExportSlot)) {
    try {
      await setMode(access, apiBase, siteId, 'autonomous', 0);
      state.dayCharging = false;
      if (state.dayChargeStart) {
        const kwhCharged = parseFloat((Math.max(0, pct - state.dayChargeStart.pct) / 100 * 13.5).toFixed(2));
        const importCostActual = parseFloat((kwhCharged * (state.dayImportRate || 0) / 100).toFixed(2));
        state.dayStats = state.dayStats || { kwh: 0, earned: 0, avgRate: 0, importCost: 0, rateSum: 0, rateSamples: 0 };
        state.dayStats.importCost = parseFloat(((state.dayStats.importCost || 0) + importCostActual).toFixed(2));
        const reason = pctInt >= (state.dayChargeTargetPct || 100) ? 'target reached' : 'export window starting';
        log(state, 'Day: charge stopped (' + reason + ') — at ' + pctInt + '%, imported ~' + kwhCharged + ' kWh · £' + importCostActual);
        state.dayChargeStart = null;
      }
    } catch(e) { log(state, 'Day: charge stop error: ' + e.message); }
  }

  // Export slot logic
  const rate = await getOctopusRate(store, deviceId);
  state.dayCurrentRate = rate;
  const shouldExport = inExportSlot && pctInt > reserveFloorPct && !state.dayCharging;

  if (shouldExport && !state.dayExporting) {
    try {
      await setMode(access, apiBase, siteId, 'autonomous', 0);
      await setExport(access, apiBase, siteId, true);
      state.dayExporting = true;
      state.dayExportStart = { pct, time: now, rate };
      log(state, 'Day: export on — ' + (rate > 0 ? rate.toFixed(1) + 'p' : 'rate unavailable') + ' (battery ' + pctInt + '%, floor ' + reserveFloorPct + '%)');
      await sendPush(store, deviceId, 'Day export started', (rate > 0 ? rate.toFixed(1) + 'p/kWh · ' : '') + 'Battery at ' + pctInt + '%');
    } catch(e) { log(state, 'Day: export start error: ' + e.message); }
  } else if (!shouldExport && state.dayExporting) {
    try {
      await setExport(access, apiBase, siteId, false);
      await setMode(access, apiBase, siteId, 'autonomous', 0);
      state.dayExporting = false;
      if (state.dayExportStart) {
        const durationHrs = (now - state.dayExportStart.time) / 3600000;
        const totalDropPct = state.dayExportStart.pct - pct;
        const houseUsedPct = durationHrs * measuredRate / 13.5 * 100;
        const netExportedKwh = parseFloat((Math.max(0, totalDropPct - houseUsedPct) / 100 * 13.5).toFixed(2));
        const useRate = state.dayExportStart.rate > 0 ? state.dayExportStart.rate : (rate > 0 ? rate : 0);
        const avgPeriodRate = useRate > 0 && rate > 0 ? (useRate + rate) / 2 : useRate;
        const periodEarned = parseFloat((netExportedKwh * avgPeriodRate / 100).toFixed(2));
        state.dayStats = state.dayStats || { kwh: 0, earned: 0, avgRate: 0, importCost: 0, rateSum: 0, rateSamples: 0 };
        state.dayStats.kwh = parseFloat((state.dayStats.kwh + netExportedKwh).toFixed(2));
        state.dayStats.earned = parseFloat((state.dayStats.earned + periodEarned).toFixed(2));
        if (avgPeriodRate > 0) {
          state.dayStats.rateSum = (state.dayStats.rateSum || 0) + avgPeriodRate;
          state.dayStats.rateSamples = (state.dayStats.rateSamples || 0) + 1;
          state.dayStats.avgRate = parseFloat((state.dayStats.rateSum / state.dayStats.rateSamples).toFixed(1));
        }
        state.dayExportStart = null;
        const reason = pctInt <= reserveFloorPct ? 'reserve floor (' + pctInt + '% ≤ ' + reserveFloorPct + '%)' : 'slot ended';
        log(state, 'Day: export off — ' + reason + ' · ~' + netExportedKwh + ' kWh · £' + periodEarned);
        await sendPush(store, deviceId, 'Day export ended', '~' + netExportedKwh + ' kWh · Est. £' + periodEarned);
      }
    } catch(e) { log(state, 'Day: export stop error: ' + e.message); }
  }
}

async function runCarSync(state, store, tokenData, settings, deviceId, phase1Reserve = 50) {
  if (!tokenData.vehicleId) return;
  const { access, apiBase, energySiteId: siteId } = tokenData;
  const priority = settings.priority || 'export';
  const arbExporting = state.phase === 2;
  const isExporting = arbExporting || !!state.dayExporting;

  // Export priority: stay dormant while actively exporting
  if (isExporting && priority === 'export') {
    if (state.carSyncActive) {
      try { await setMode(access, apiBase, siteId, 'autonomous', 0); } catch(e) {}
      state.carSyncActive = false;
      state.carChargingSince = null;
    }
    return;
  }

  // Rate-limit vehicle checks: 1 min when active or recently stopped (re-arm window), 5 min when idle
  const now = Date.now();
  const recentlyStopped = state.carSyncRecentStop && (now - state.carSyncRecentStop) < 10 * 60 * 1000;
  const checkInterval = (state.carSyncActive || recentlyStopped) ? 60000 : 5 * 60 * 1000;
  if (state.carSyncLastCheck && (now - state.carSyncLastCheck) < checkInterval) return;
  state.carSyncLastCheck = now;

  // Skip charge state check if vehicle is asleep — sleeping cars are never charging
  let vehicleCharging = false;
  try {
    const vState = await getVehicleState(access, apiBase, tokenData.vehicleId);
    if (vState === 'online') {
      const chargeState = await getVehicleChargeState(access, apiBase, tokenData.vehicleId);
      vehicleCharging = chargeState === 'Charging';
    }
  } catch(e) { return; }

  if (vehicleCharging) {
    if (!state.carChargingSince) state.carChargingSince = Date.now();
    const minsCharging = (Date.now() - state.carChargingSince) / 60000;
    if (minsCharging >= 2) {
      // Pause export whenever Phase 2 starts while car sync is already active (e.g. car was
      // charging since Phase 1 start on Octopus Go) — not just on initial activation
      if (isExporting && priority === 'car' && !state.carSyncPausedExport) {
        try { await setExport(access, apiBase, siteId, false); } catch(e) {}
        try { await setMode(access, apiBase, siteId, 'autonomous', 100); } catch(e) {}
        state.carSyncPausedExport = true;
        log(state, 'Car sync: pausing export — charging battery with car');
      }
      if (!state.carSyncActive) {
        try {
          await setMode(access, apiBase, siteId, 'autonomous', 100);
          state.carSyncActive = true;
          log(state, 'Car sync: active — battery charging with car (reserve 100%)');
          await sendPush(store, deviceId, 'Car detected charging', state.carSyncPausedExport ? 'Battery charging with car · Export paused' : 'Battery charging alongside car');
        } catch(e) { log(state, 'Car sync start error: ' + e.message); }
      }
    }
  } else {
    state.carChargingSince = null;
    if (state.carSyncActive) {
      state.carSyncRecentStop = Date.now();
      try {
        // Restore reserve: Phase 3 = 100%, Phase 1 = chargeTargetPct, Day charging = 100%, else 0%
        const reserveToRestore = state.phase === 3 ? 100
          : state.phase === 1 ? phase1Reserve
          : state.dayCharging ? 100
          : 0;
        await setMode(access, apiBase, siteId, 'autonomous', reserveToRestore);
        state.carSyncActive = false;
        if (state.carSyncPausedExport) {
          state.carSyncPausedExport = false;
          if (state.phase === 2 || state.dayExporting) {
            try { await setExport(access, apiBase, siteId, true); } catch(e) {}
            log(state, 'Car sync: car stopped — reserve reset, export resumed');
            await sendPush(store, deviceId, 'Car finished charging', 'Export resumed');
          } else if (state.phase === 3) {
            log(state, 'Car sync: car stopped — Phase 3 active, reserve kept at 100%');
            await sendPush(store, deviceId, 'Car finished charging', 'Battery recharge continuing');
          } else if (state.dayCharging) {
            log(state, 'Car sync: car stopped — Day charge active, reserve kept at 100%');
            await sendPush(store, deviceId, 'Car finished charging', 'Battery continuing to charge for export');
          } else {
            log(state, 'Car sync: car stopped — reserve reset to 0%');
          }
        } else if (state.phase === 3) {
          log(state, 'Car sync: car stopped — Phase 3 active, reserve kept at 100%');
          await sendPush(store, deviceId, 'Car finished charging', 'Battery recharge continuing');
        } else if (state.dayCharging) {
          log(state, 'Car sync: car stopped — Day charge active, reserve kept at 100%');
          await sendPush(store, deviceId, 'Car finished charging', 'Battery continuing to charge for export');
        } else {
          log(state, 'Car sync: car stopped — reserve reset to 0%');
        }
      } catch(e) { log(state, 'Car sync stop error: ' + e.message); }
    }
  }
}

async function processUser(store, deviceId) {
  const state = JSON.parse(await store.get('state_' + deviceId) || JSON.stringify(DEFAULT_STATE));
  const pendingCmd = JSON.parse(await store.get('pending_vehicle_cmd_' + deviceId) || 'null');

  let tokenData = JSON.parse(await store.get('token_' + deviceId) || 'null');
  if (!tokenData) return;
  const carSyncSettings = JSON.parse(await store.get('car_sync_settings_' + deviceId) || 'null');
  const carSyncEnabled = !!(carSyncSettings && carSyncSettings.enabled && tokenData.vehicleId);

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
  if (timedExport && timedExport.endTime) {
    if (Date.now() >= timedExport.endTime) {
      try {
        await setExport(tokenData.access, tokenData.apiBase, tokenData.energySiteId, false);
        await sendPush(store, deviceId, 'Timed export finished', 'Export stopped — timer complete');
        await store.delete('timed_export_' + deviceId);
      } catch (e) {
        // Only give up after 10 minutes of failed retries to avoid retrying forever
        if (Date.now() - timedExport.endTime > 10 * 60 * 1000) {
          await store.delete('timed_export_' + deviceId);
        }
      }
    } else if (!timedExport.startNotified) {
      const minsRemaining = Math.round((timedExport.endTime - Date.now()) / 60000);
      await sendPush(store, deviceId, 'Timed export started', 'Exporting to grid · ~' + minsRemaining + ' min');
      timedExport.startNotified = true;
      await store.set('timed_export_' + deviceId, JSON.stringify(timedExport));
    }
  }

  // Read pctExport before live_status so idle check can account for it
  const pctExport = JSON.parse(await store.get('pct_export_' + deviceId) || 'null');
  const hasPctExport = pctExport && pctExport.targetPct !== undefined;

  // Skip live_status when fully idle — saves Tesla API calls at scale
  const fullyIdle = !state.enabled && state.phase === 0 && !state.dayEnabled && !state.holidayEnabled && !carSyncEnabled && !hasPctExport && !pendingCmd;
  let currentPct = -1;
  if (!fullyIdle) {
    try {
      const live = await teslaGet(tokenData.access, tokenData.apiBase, `/api/1/energy_sites/${tokenData.energySiteId}/live_status`);
      currentPct = Math.round(live.response?.percentage_charged ?? -1);
      if (currentPct >= 0) {
        const soeHistory = JSON.parse(await store.get('soe_history_' + deviceId) || '[]');
        const lastEntry = soeHistory[soeHistory.length - 1];
        const fiveMinAgo = Date.now() - 5 * 60 * 1000;
        if (!lastEntry || lastEntry.t < fiveMinAgo) {
          soeHistory.push({ t: Date.now(), pct: currentPct });
          const cutoff = Date.now() - 6 * 24 * 3600 * 1000;
          await store.set('soe_history_' + deviceId, JSON.stringify(soeHistory.filter(r => r.t > cutoff)));
        }
      }
    } catch (e) {}
  }

  if (hasPctExport) {
    if (currentPct >= 0 && currentPct <= pctExport.targetPct + 4) {
      try {
        await setExport(tokenData.access, tokenData.apiBase, tokenData.energySiteId, false);
        await sendPush(store, deviceId, 'Export target reached', 'Battery at ' + currentPct + '% — export stopped');
        await store.delete('pct_export_' + deviceId);
      } catch (e) {}
    } else if (!pctExport.startNotified) {
      await sendPush(store, deviceId, 'Export to target started', 'Exporting to grid until battery reaches ' + pctExport.targetPct + '%');
      pctExport.startNotified = true;
      await store.set('pct_export_' + deviceId, JSON.stringify(pctExport));
    }
  }

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
            await sendPush(store, deviceId, 'Car charging stopped', 'Charge limit set to ' + (pendingCmd.chargeLimit || 50) + '% — export running');
          } else if (pendingCmd.cmd === 'charge_resume') {
            await vehicleSetChargeLimit(access, apiBase, vehicleId, pendingCmd.chargeLimit);
            await vehicleChargeStart(access, apiBase, vehicleId);
            log(state, 'Vehicle: charging resumed at ' + pendingCmd.chargeLimit + '% limit');
            await sendPush(store, deviceId, 'Car charging resumed', 'Charging to ' + pendingCmd.chargeLimit + '%');
          }
          await store.delete('pending_vehicle_cmd_' + deviceId);
        } else {
          await wakeVehicle(access, apiBase, vehicleId);
        }
      } catch (e) { log(state, 'Vehicle command error: ' + e.message); }
    }
    await store.set('state_' + deviceId, JSON.stringify(state));
    if (!state.enabled && state.phase === 0 && !carSyncEnabled) return;
  }

  if (!state.enabled && state.phase === 0 && !state.dayEnabled && !state.holidayEnabled && !carSyncEnabled) {
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
    if (!state.enabled && state.phase > 0) {
      await setExport(access, apiBase, siteId, false);
      await setMode(access, apiBase, siteId, 'autonomous', 0);
      log(state, 'Arbitrage disabled mid-cycle — export stopped, normal mode restored');
      state.phase = 0;
    }
    else if (state.phase === 0 && state.enabled && h === startHour && m >= startMinute) {
      state.phase = 1;
      state.stats = { kwh: 0, rate: 0, earned: 0, phase2StartPct: 0 };
      log(state, '=== Arbitrage cycle started ===');
      await setMode(access, apiBase, siteId, 'autonomous', chargeTargetPct);
      log(state, 'Phase 1: Reserve set to ' + chargeTargetPct + '% — charging from grid');
      await sendPush(store, deviceId, 'Overnight cycle started', 'Charging battery to ' + chargeTargetPct + '%');
    }
    else if (state.phase === 1) {
      if (m % 10 === 0) log(state, 'Phase 1 charging — battery at ' + pct + '%');
      if (pct >= chargeTargetPct) {
        log(state, 'Phase 1 complete — battery reached ' + pct + '%');
        const endTotalMins = endHour * 60 + endMinute;
        const nowTotalMins = h * 60 + m;
        const minsRemaining = endTotalMins >= nowTotalMins ? endTotalMins - nowTotalMins : (24 * 60 - nowTotalMins + endTotalMins);
        const exportMins = Math.ceil((pct / 100 * 13.5) / 5.0 * 60);
        const minExportWindow = 30;
        if (minsRemaining < exportMins + minExportWindow) {
          log(state, 'Export skipped — only ' + minsRemaining + ' min until ' + fmt2(endHour) + ':' + fmt2(endMinute) + ', need ~' + (exportMins + minExportWindow) + ' min — recharging instead');
          state.phase = 3;
          await setMode(access, apiBase, siteId, 'autonomous', 100);
          log(state, 'Phase 3: Recharging from grid');
          await sendPush(store, deviceId, 'Overnight export skipped', 'Not enough time before ' + fmt2(endHour) + ':' + fmt2(endMinute) + ' — recharging instead');
        } else {
          state.phase = 2;
          const rate = await getOctopusRate(store, deviceId);
          state.stats.phase2StartPct = pct;
          state.stats.rateSum = rate;
          state.stats.rateSamples = rate > 0 ? 1 : 0;
          state.stats.rate = rate;
          await setMode(access, apiBase, siteId, 'autonomous', 0);
          await setExport(access, apiBase, siteId, true);
          log(state, 'Phase 2: Export enabled' + (rate > 0 ? ' at ' + rate.toFixed(1) + 'p/kWh' : ' (rate unavailable — will retry)'));
          await sendPush(store, deviceId, 'Battery charged — exporting now', 'Battery at ' + pct + '%, exporting to grid' + (rate > 0 ? ' at ' + rate.toFixed(1) + 'p/kWh' : ''));
          const carSyncCarFirst = carSyncEnabled && carSyncSettings.priority === 'car';
          if (s.carControlEnabled && tokenData.vehicleId && !carSyncCarFirst) {
            try {
              await wakeVehicle(access, apiBase, tokenData.vehicleId);
              await store.set('pending_vehicle_cmd_' + deviceId, JSON.stringify({ cmd: 'charge_stop', chargeLimit: s.carChargeLimitPhase2 || 50, requestedAt: Date.now() }));
              log(state, 'Vehicle: wake-up sent — charging will stop shortly');
            } catch (e) { log(state, 'Vehicle wake error: ' + e.message); }
          } else if (carSyncCarFirst) {
            log(state, 'Phase 2: car sync priority set to car — skipping charge stop');
          }
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
        await sendPush(store, deviceId, 'Export complete — recharging', '~' + kwhExported + ' kWh · Est. £' + earned.toFixed(2) + ' · Battery recharging now');
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
      const phase3PastEnd = h > endHour || (h === endHour && m >= endMinute);
      if (phase3PastEnd) {
        log(state, 'Phase 3 ended at ' + fmt2(endHour) + ':' + fmt2(endMinute) + ' — battery at ' + pct + '% — normal mode restored');
        await sendPush(store, deviceId, 'Overnight cycle ended', 'End time reached · Battery at ' + pct + '% · Normal mode restored');
        state.phase = 0;
        await setExport(access, apiBase, siteId, false);
        await setMode(access, apiBase, siteId, 'autonomous', 0);
      } else {
        if (m % 10 === 0) log(state, 'Phase 3 recharging — battery at ' + pct + '%');
        if (pct >= 98) {
          log(state, 'Phase 3 complete — battery at ' + pct + '%');
          state.phase = 4;
          log(state, 'Phase 4: Fully charged — standby until ' + fmt2(endHour) + ':' + fmt2(endMinute));
          await sendPush(store, deviceId, 'Battery fully recharged', 'At ' + pct + '% · Standby until ' + fmt2(endHour) + ':' + fmt2(endMinute));
        }
      }
    }
    else if (state.phase === 4 && (h > endHour || (h === endHour && m >= endMinute))) {
      state.phase = 0;
      await setExport(access, apiBase, siteId, false);
      await setMode(access, apiBase, siteId, 'autonomous', 0);
      log(state, '=== Cycle complete — autonomous mode restored, 0% reserve ===');
      await sendPush(store, deviceId, 'Overnight cycle complete', 'Normal operation restored · Check Night tab for earnings');
    }
    else if (state.phase === 4) {
      if (m % 10 === 0) log(state, 'Phase 4: standby — battery at ' + pct + '%, waiting until ' + fmt2(endHour) + ':' + fmt2(endMinute));
    }
    else if (state.phase > 0 && h >= endHour + 1) {
      log(state, 'Safety fallback at ' + fmt2(h) + ':' + fmt2(m) + ' — restoring normal mode');
      await sendPush(store, deviceId, 'Safety override triggered', 'Normal mode restored at ' + fmt2(h) + ':' + fmt2(m) + ' — check Night tab');
      state.phase = 0;
      await setExport(access, apiBase, siteId, false);
      await setMode(access, apiBase, siteId, 'autonomous', 0);
    }
  } catch (e) {
    log(state, 'Error in phase ' + state.phase + ': ' + e.message);
  }

  // If Day mode was disabled while charging or exporting, restore normal mode
  if (!state.dayEnabled && !state.holidayEnabled && state.phase === 0 && (state.dayCharging || state.dayExporting)) {
    try {
      await setExport(access, apiBase, siteId, false);
      await setMode(access, apiBase, siteId, 'autonomous', 0);
      log(state, 'Day: mode disabled — ' + (state.dayCharging ? 'charge' : 'export') + ' stopped, normal mode restored');
      await sendPush(store, deviceId, 'Day mode disabled', 'Powerwall returned to normal mode');
    } catch(e) {}
    state.dayCharging = false;
    state.dayExporting = false;
  }

  if ((state.dayEnabled || state.holidayEnabled) && state.phase === 0) {
    // Migrate legacy holidayEnabled to dayEnabled
    if (state.holidayEnabled && !state.dayEnabled) { state.dayEnabled = true; state.holidayEnabled = false; }
    try { await runDayMode(state, store, tokenData, currentPct, h, m, deviceId); }
    catch (e) { log(state, 'Day error: ' + e.message); }
  }

  if (carSyncEnabled) {
    try { await runCarSync(state, store, tokenData, carSyncSettings, deviceId, chargeTargetPct); }
    catch (e) { log(state, 'Car sync error: ' + e.message); }
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
