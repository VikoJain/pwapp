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
  const now = new Date();
  const date = now.toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short' });
  const time = now.toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  state.log = state.log || [];
  state.log.unshift('[' + date + ' ' + time + '] ' + msg);
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

async function getImportRateAtHour(store, deviceId, hour) {
  try {
    const settings = JSON.parse(await store.get('oct_settings_' + deviceId) || 'null');
    if (!settings || !settings.octKey || !settings.octImportTariff || !settings.octImportProduct) return null;
    const t = new Date(); t.setHours(hour, 0, 0, 0);
    const tEnd = new Date(t.getTime() + 30 * 60 * 1000);
    const fmt = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const path = '/v1/products/' + settings.octImportProduct + '/electricity-tariffs/' + settings.octImportTariff +
      '/standard-unit-rates/?period_from=' + fmt(t) + '&period_to=' + fmt(tEnd) + '&page_size=2';
    const authHeader = 'Basic ' + Buffer.from(settings.octKey + ':').toString('base64');
    const res = await makeRequest({ hostname: 'api.octopus.energy', path, method: 'GET', headers: { 'Authorization': authHeader } }, null);
    const data = JSON.parse(res.body);
    if (data.results && data.results.length > 0) return parseFloat(parseFloat(data.results[0].value_inc_vat).toFixed(2));
  } catch (e) {}
  return null;
}

async function getImportDayRate(store, deviceId) {
  return getImportRateAtHour(store, deviceId, 12); // noon = Go standard/daytime rate
}

async function getGoOffPeakRate(store, deviceId) {
  try {
    const settings = JSON.parse(await store.get('oct_settings_' + deviceId) || 'null');
    // Prefer the stored off-peak rate detected from the tariff at setup time
    if (settings && settings.offPeakRate) return parseFloat(settings.offPeakRate);
    // Fallback: fetch the current slot — safe because this is only called during 23:30–05:30 BST
    if (!settings || !settings.octKey || !settings.octImportTariff || !settings.octImportProduct) return null;
    const now = new Date();
    const slotStart = new Date(now);
    slotStart.setMinutes(now.getMinutes() >= 30 ? 30 : 0, 0, 0);
    const slotEnd = new Date(slotStart.getTime() + 30 * 60 * 1000);
    const fmt = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const path = '/v1/products/' + settings.octImportProduct + '/electricity-tariffs/' + settings.octImportTariff +
      '/standard-unit-rates/?period_from=' + fmt(slotStart) + '&period_to=' + fmt(slotEnd) + '&page_size=2';
    const authHeader = 'Basic ' + Buffer.from(settings.octKey + ':').toString('base64');
    const res = await makeRequest({ hostname: 'api.octopus.energy', path, method: 'GET', headers: { 'Authorization': authHeader } }, null);
    const data = JSON.parse(res.body);
    if (data.results && data.results.length > 0) return parseFloat(parseFloat(data.results[0].value_inc_vat).toFixed(2));
  } catch(e) {}
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

function findBestConsecutiveWindow(slots, maxSlots) {
  if (!slots.length || maxSlots < 1) return [];
  const blocks = [], SLOT_KWH = EXPORT_KWH_PER_SLOT, EFF = 0.9;
  let blk = [];
  for (const s of slots) {
    if (!blk.length) { blk.push(s); continue; }
    const gap = new Date(s.validFrom) - new Date(blk[blk.length - 1].validFrom);
    if (gap <= 31 * 60 * 1000) { blk.push(s); } else { blocks.push(blk); blk = [s]; }
  }
  if (blk.length) blocks.push(blk);
  let best = [], bestRev = 0;
  for (const block of blocks) {
    const w = Math.min(maxSlots, block.length);
    for (let i = 0; i <= block.length - w; i++) {
      const win = block.slice(i, i + w);
      const rev = win.reduce((sum, s) => sum + s.value * EFF * SLOT_KWH, 0);
      if (rev > bestRev) { bestRev = rev; best = win; }
    }
  }
  return best;
}

// Day-mode stop time = when the tariff's off-peak (cheap overnight) period begins, read from
// the Tariff tab. This mirrors how the window OPEN time is derived from offPeakEnd, so there's
// a single source of truth. Falls back to the legacy manual stop setting, then 23:00.
function deriveDayStopTime(octSettings, ds) {
  if (octSettings && octSettings.offPeakStart) {
    const [h, m] = octSettings.offPeakStart.split(':').map(Number);
    if (Number.isFinite(h) && Number.isFinite(m)) return { stopHour: h, stopMinute: m };
  }
  return {
    stopHour: ds && ds.stopHour !== undefined ? ds.stopHour : 23,
    stopMinute: ds && ds.stopMinute !== undefined ? ds.stopMinute : 0
  };
}

// Reserve floor: the minimum battery % to hold back so the house can run until the tariff
// off-peak start (when the cheap overnight charge takes over). Away/adaptive mode reserves
// (hours until off-peak × measured house load × safety headroom); manual mode uses the user's
// fixed floor. FLOOR_HEADROOM guards against the measured load under-estimating the evening.
const FLOOR_HEADROOM = 1.25;

// Powerwall grid-export (discharge) power. A PW3 / 2×PW2 install dumps to grid at ~10 kW, i.e.
// ~5 kWh per 30-min slot — NOT the 5 kW / 2.5 kWh a single PW2 does. Getting this right matters:
// the sell planner uses it to work out how many slots the battery can fill. Underestimate it and
// it over-books slots and opens export too early (draining before the highest-priced slot); the
// battery empties in ~1 slot, so with the correct figure the greedy naturally concentrates on the
// single best-priced slot (or the top 2 if there's charge for it). Could become a per-user setting.
const EXPORT_KW = 10;
const EXPORT_KWH_PER_SLOT = EXPORT_KW * 0.5;
function computeReserveFloorPct({ minuteOfDay, stopMinuteOfDay, measuredRate, isManualFloor, manualFloorPct, headroom = FLOOR_HEADROOM }) {
  if (isManualFloor) return Math.min(95, Math.max(0, parseInt(manualFloorPct)));
  const hoursToStop = Math.max(0, (stopMinuteOfDay - minuteOfDay) / 60);
  const requiredKwh = hoursToStop * measuredRate * headroom;
  return Math.min(95, Math.ceil((requiredKwh / 13.5) * 100));
}

// Tesla data-call gate (PURE — unit-tested). Decides whether a cron tick fetches live_status, which
// is ~99% of Tesla API cost. Full 2-min cadence only when something is happening or imminent (active
// export/charge/command, in/near an export slot or the just-in-time charge, or the overnight cycle
// window); a ~15-min heartbeat while merely holding a reserve (keeps the load average + SOE chart
// alive); nothing when fully idle or when Night mode alone is waiting through the daytime dead zone.
// ltMins = minutes past midnight (London). Returns { poll, needFine, reason }.
function shouldFetchLive({ enabled, phase, dayEnabled, holidayEnabled, carSyncEnabled, hasPctExport,
  pendingCmd, timedExportActive, dayExporting, dayCharging, dayExportSlots, dayNeedsCharge,
  dayChargeStartMins, ltMins, lastLivePoll, nowMs, holdPollMs = 15 * 60 * 1000, slotBuffer = 6 }) {
  const armed = enabled || dayEnabled || holidayEnabled || carSyncEnabled || hasPctExport || pendingCmd || phase !== 0;
  if (!armed) return { poll: false, needFine: false, reason: 'idle' };
  const nightOnlyWaiting = enabled && phase === 0 && !dayEnabled && !holidayEnabled && !carSyncEnabled
    && !hasPctExport && !pendingCmd && (ltMins >= 360 && ltMins < 1320); // 06:00–22:00 London
  if (nightOnlyWaiting) return { poll: false, needFine: false, reason: 'night-waiting' };
  const activeNow = phase !== 0 || dayExporting || dayCharging || hasPctExport || pendingCmd || !!timedExportActive;
  let dayImminent = false;
  if (dayEnabled) {
    for (const s of (dayExportSlots || [])) {
      const [sh, sm] = String(s.time).split(':').map(Number);
      const st = sh * 60 + sm;
      if (ltMins >= st - slotBuffer && ltMins < st + 30) { dayImminent = true; break; }
    }
    if (!dayImminent && dayNeedsCharge && dayChargeStartMins != null && ltMins >= dayChargeStartMins - slotBuffer) dayImminent = true;
  }
  const nightImminent = enabled && phase === 0 && (ltMins >= 1400 || ltMins < 360); // 23:20→06:00
  const needFine = activeNow || dayImminent || nightImminent;
  if (needFine) return { poll: true, needFine: true, reason: 'active' };
  if (lastLivePoll && (nowMs - lastLivePoll < holdPollMs)) return { poll: false, needFine: false, reason: 'hold-throttled' };
  return { poll: true, needFine: false, reason: 'heartbeat' };
}

// Sell-slot selection — sell the battery's genuine excess at the HIGHEST export price(s), with
// partial-slot precision. rates need a numeric timeMin (minutes past midnight). Each returned slot
// carries an `exportKwh` estimate; the last one usually runs partial (the runtime stops mid-slot the
// moment the battery reaches the floor, so a 2kWh excess exports for ~12 min, not the full 30).
//
// Two modes, differing only in where the floor sits:
//  • At-home (isManualFloor): export straight down to the user's fixed manual floor. The house runs
//    off the grid below the floor afterwards — the user's explicit choice.
//  • Away/adaptive: the floor is the battery estimated to still be needed to reach the tariff
//    off-peak start (23:30), so it never drains to empty before the cheap overnight charge.
function planSellSlots({ rates, pctForPlan, planFloorPct, minuteOfDay, cRateForSell = 0.5, offPeakStartMins = null, isManualFloor = false, headroom = FLOOR_HEADROOM, exportKwhPerSlot = EXPORT_KWH_PER_SLOT, windowStartMins = null, minSellRate = null }) {
  if (!rates || !rates.length) return [];
  const exportPctPerSlot = exportKwhPerSlot / 13.5 * 100;
  const MIN_EXPORT_KWH = 0.25;
  // House drain is only counted from when the day window opens (the overnight cycle holds the
  // battery ~full until then), so a strategy built just after midnight doesn't phantom-drain the
  // battery for the pre-window hours. Falls back to minuteOfDay when no window start is given.
  const drainStartMin = windowStartMins != null ? Math.max(minuteOfDay, windowStartMins) : minuteOfDay;
  // The floor is an EXPORT limit, never a hold: the runtime never keeps the battery AT the floor, it
  // simply never SELLS below it, so the capacity down to the floor stays for the user's evening use.
  // reservePctAt is the level a slot must leave behind when it ends — the flat manual floor for
  // At-home; for Away, enough to coast to the off-peak start, with the floor as a hard minimum.
  const reservePctAt = (slotEndMin) => (isManualFloor || offPeakStartMins == null)
    ? planFloorPct
    : Math.max(planFloorPct, (offPeakStartMins - slotEndMin) / 60 * cRateForSell * headroom / 13.5 * 100);

  const battAt = (mins) => pctForPlan - Math.max(0, (mins - drainStartMin) / 60 * cRateForSell / 13.5 * 100);

  // Never sell energy for less than it costs to REPLACE it. With no solar the battery is refilled
  // overnight at the cheap off-peak rate, so the true cost of exported energy is that off-peak rate,
  // NOT the daytime import rate. The caller passes minSellRate derived from the off-peak rate (plus a
  // round-trip margin); we only consider slots at or above it. With no rate given, sell at the best
  // slots regardless. (The daytime import rate only governs the separate arbitrage path.)
  const candidates = minSellRate ? rates.filter(s => s.value >= minSellRate) : rates.slice();
  if (!candidates.length) return [];

  // Best-priced slots first (tie-break LATER first — same revenue, but the house runs off the battery
  // through the day first rather than being pushed onto the grid by an early-morning drain). "Viable"
  // = a slot that still holds genuine surplus above its floor at its own time, after the day's house
  // drain. Anchor on the dearest VIABLE slot, NOT simply the dearest one: a late price spike the house
  // has already drained the battery past no longer makes us bail to zero — we fall back to the best
  // earlier slot that actually has surplus to sell.
  const byPrice = candidates.sort((a, b) => (b.value - a.value) || (b.timeMin - a.timeMin));
  const viable = byPrice.filter(s => battAt(s.timeMin) - reservePctAt(s.timeMin + 30) > 0);
  if (!viable.length) return [];
  const excessPct = battAt(viable[0].timeMin) - reservePctAt(viable[0].timeMin + 30);
  // The Powerwall exports at ~10kW, so one 30-min slot shifts up to `exportKwhPerSlot`. Book as many
  // of the dearest viable slots as it takes to move that surplus; the last one runs partial.
  const slotsNeeded = Math.min(viable.length, Math.max(1, Math.ceil(excessPct / exportPctPerSlot)));
  const chosen = viable.slice(0, slotsNeeded).sort((a, b) => a.timeMin - b.timeMin);

  // Walk the chosen slots chronologically to estimate each one's actual export (partial allowed),
  // selling down to its floor and dropping any negligible tail below MIN_EXPORT_KWH.
  let batt = pctForPlan, prevMin = drainStartMin;
  const out = [];
  for (const slot of chosen) {
    batt -= Math.max(0, (slot.timeMin - prevMin) / 60 * cRateForSell / 13.5 * 100);
    const exportPct = Math.max(0, Math.min(exportPctPerSlot, batt - reservePctAt(slot.timeMin + 30)));
    batt -= exportPct;
    prevMin = slot.timeMin + 30;
    const exportKwh = parseFloat((exportPct / 100 * 13.5).toFixed(2));
    if (exportKwh >= MIN_EXPORT_KWH) out.push({ ...slot, exportKwh });
  }
  return out;
}

async function runDayMode(state, store, tokenData, currentPctRaw, h, m, deviceId, loadPowerKw) {
  const ds = JSON.parse(await store.get('day_settings_' + deviceId) || 'null') ||
             JSON.parse(await store.get('holiday_settings_' + deviceId) || 'null') || {};
  const octSettings = JSON.parse(await store.get('oct_settings_' + deviceId) || 'null') || {};
  // Day window opens when the off-peak overnight rate ends — read from tariff tab settings
  const _offPeakEnd = octSettings.offPeakEnd || '05:30';
  const [_opEndH, _opEndM] = _offPeakEnd.split(':').map(Number);
  const windowStartMins = (_opEndH || 5) * 60 + (_opEndM || 30);
  // Window closes at the tariff off-peak start (single source of truth with the Tariff tab).
  const { stopHour, stopMinute } = deriveDayStopTime(octSettings, ds);
  const minMargin = ds.minMargin !== undefined ? parseFloat(ds.minMargin) : 2.0;
  const { access, apiBase, energySiteId: siteId } = tokenData;
  const minuteOfDay = h * 60 + m;
  const stopMinuteOfDay = stopHour * 60 + stopMinute;
  const inWindow = minuteOfDay >= windowStartMins && minuteOfDay < stopMinuteOfDay;

  // Build day strategy once per calendar day (before window guard so UI shows it at any time)
  const currentDateKey = new Date().toLocaleDateString('en-GB', { timeZone: 'Europe/London' });
  if (state.dayRatesCacheDay !== currentDateKey) {
    // Reset operational state for the new day — clears any stale charging/exporting
    // state left over from yesterday (e.g. dayCharging=true when overnight arb ran overnight)
    state.dayCharging = false;
    state.dayChargeStart = null;
    state.dayExporting = false;
    state.dayExportStart = null;
    state.dayLoadSum = 0;   // running total of today's live house-load readings (kWh/hr)
    state.dayLoadCount = 0;  // reading count for today's average; dayLoadAvgPersisted carries across days
    state.dayConsumptionKwhPerHr = 0; // repopulated from live load_power during today's ticks
    state.dayChargeStartMins = null;
    state.dayStats = { kwh: 0, earned: 0, avgRate: 0, importCost: 0, rateSum: 0, rateSamples: 0 };
    state.dayExportSlots = [];
    state.dayFloorApplied = false;
    state.dayChargeHold = false;

    const _londonDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
    const _londonTz = new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/London', timeZoneName: 'short' }).includes('BST') ? '+01:00' : '+00:00';
    const windowStart = new Date(`${_londonDate}T${String(_opEndH || 5).padStart(2,'0')}:${String(_opEndM || 30).padStart(2,'0')}:00${_londonTz}`);
    const stopTimeDate = new Date(`${_londonDate}T${String(stopHour).padStart(2,'0')}:${String(stopMinute).padStart(2,'0')}:00${_londonTz}`);
    const [exportRates, importRate] = await Promise.all([
      getOctopusRatesForWindow(store, windowStart, stopTimeDate, deviceId),
      getImportDayRate(store, deviceId)
    ]);
    state.dayImportRate = importRate;
    if (!importRate) log(state, 'Day: import rate unavailable — day costs will not be tracked. Check Settings and press Re-detect tariff.');
    // Cache off-peak rate for sell-export cost attribution
    if (octSettings.offPeakRate) state.dayOffPeakRate = parseFloat(octSettings.offPeakRate);
    const EFFICIENCY = 0.9;
    const SLOT_KWH = EXPORT_KWH_PER_SLOT; // ~10kW export discharge × 0.5hr (see EXPORT_KW)
    const CHARGE_RATE_KW = 3.68;
    const pctForPlan = currentPctRaw >= 0 ? currentPctRaw : 0;
    const isManualFloor = ds.awayMode === false && ds.manualFloorPct !== undefined;
    const planFloorPct = isManualFloor ? ds.manualFloorPct : 10;
    // House load for planning: the average measured on previous days (persists across days, so a
    // sunny full-battery day doesn't blind us). Falls back to 0.5 kWh/hr — a realistic always-on
    // standby base load (fridge, freezer, networking, gateway) — because the old 0.3 default was
    // too low for real homes and drained the house before the overnight cheap rate.
    const planConsumption = state.dayLoadAvgPersisted > 0 ? state.dayLoadAvgPersisted : 0.5;
    const offPeakStartMins = stopMinuteOfDay; // window closes at the tariff off-peak start
    const usableKwh = Math.max(0, (100 - planFloorPct) / 100 * 13.5);
    const cRateAtBuild = planConsumption;
    const maxSlotsFullBattery = Math.max(1, Math.floor(usableKwh / (SLOT_KWH + cRateAtBuild * 0.5)));
    const sellEnabled = ds.sellEnabled !== false; // default true
    const arbEnabled = ds.arbEnabled !== false;   // default true

    const sortedRates = exportRates.slice().sort((a, b) => new Date(a.validFrom) - new Date(b.validFrom));
    let arbWindow = [], sellWindow = [];
    let dayExportSlots = [], dayNeedsCharge = false, dayChargeTargetPct = 100, dayChargeSlot = null;
    let dayEstimatedRevenue = 0, dayEstimatedImportCost = 0;

    state.dayRatesCacheDay = currentDateKey; // always set to prevent retry storm if rates are empty
    if (exportRates.length > 0) {
      // Arb strategy: spread-profitable slots, will import from grid
      if (arbEnabled && importRate) {
        const profitable = sortedRates.filter(r => (r.value * EFFICIENCY) - importRate >= minMargin);
        arbWindow = findBestConsecutiveWindow(profitable, maxSlotsFullBattery);
      }

      // Sell strategy: pick highest-rate slots the battery can actually sustain.
      // Greedy by rate: try best slots first, simulate forward chronologically to verify
      // the battery stays above the floor after each export and house drain gap.
      if (sellEnabled) {
        const arbTimes = new Set(arbWindow.map(s => s.validFrom));
        const forSell = sortedRates.filter(s => !arbTimes.has(s.validFrom));
        const cRateForSell = planConsumption;
        const sellCandidates = forSell.map(s => {
          const _tsStr = new Date(s.validFrom).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });
          const [_tsh, _tsm] = _tsStr.split(':').map(Number);
          return { ...s, timeMin: _tsh * 60 + _tsm };
        });
        // Sell floor = the overnight recharge cost (off-peak rate) plus the round-trip margin, since
        // exported energy is refilled overnight at off-peak, not at the daytime import rate.
        const offPeakForSell = state.dayOffPeakRate || (octSettings.offPeakRate ? parseFloat(octSettings.offPeakRate) : 0);
        const minSellRate = offPeakForSell > 0 ? (offPeakForSell + minMargin) / EFFICIENCY : null;
        sellWindow = planSellSlots({
          rates: sellCandidates, pctForPlan, planFloorPct, minuteOfDay,
          cRateForSell, offPeakStartMins, isManualFloor, windowStartMins, minSellRate
        });
      }

      // Combine all slots chronologically, tagged by type
      const combined = [
        ...sellWindow.map(s => ({ ...s, slotType: 'sell' })),
        ...arbWindow.map(s => ({ ...s, slotType: 'arb' }))
      ].sort((a, b) => new Date(a.validFrom) - new Date(b.validFrom));

      dayExportSlots = combined.map(s => {
        const _lsStr = new Date(s.validFrom).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });
        const [_lsh, _lsm] = _lsStr.split(':').map(Number);
        // Estimated export for this slot: sell slots carry a partial exportKwh; arb runs a full slot.
        const estKwh = s.slotType === 'arb' ? SLOT_KWH : (s.exportKwh || 0);
        return {
          time: fmt2(_lsh) + ':' + fmt2(_lsm),
          rate: s.value,
          profit: s.slotType === 'arb' && importRate ? parseFloat(((s.value * EFFICIENCY) - importRate).toFixed(1)) : null,
          type: s.slotType,
          estKwh: parseFloat(estKwh.toFixed(2)),
          estMins: Math.min(30, Math.max(1, Math.round(estKwh / EXPORT_KW * 60)))
        };
      });

      // Charge planning: only for arb window, accounts for sell depletion
      const futureArb = arbWindow.filter(s => {
        const _lsStr = new Date(s.validFrom).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });
        const [_lsh, _lsm] = _lsStr.split(':').map(Number);
        return _lsh * 60 + _lsm > minuteOfDay;
      });

      if (futureArb.length > 0 && importRate) {
        const _faStr = new Date(futureArb[0].validFrom).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });
        const [_fah, _fam] = _faStr.split(':').map(Number);
        const firstArbMins = _fah * 60 + _fam;
        const consumptionRate = planConsumption;
        // After sell, battery is at floor; if no sell, estimate drain from now to arb
        const battAfterSell = sellWindow.length > 0 ? planFloorPct
          : Math.max(0, pctForPlan - ((firstArbMins - minuteOfDay) / 60 * consumptionRate / 13.5 * 100));
        const chargeNeededKwh = Math.max(0, (100 - battAfterSell) / 100 * 13.5);
        dayNeedsCharge = chargeNeededKwh > 0.5;
        dayChargeTargetPct = 100;
        const chargeTimeMins = Math.ceil(chargeNeededKwh / CHARGE_RATE_KW * 60) + 15;
        const chargeStartMins = Math.max(minuteOfDay, firstArbMins - chargeTimeMins);
        state.dayChargeStartMins = chargeStartMins;
        if (dayNeedsCharge) {
          dayChargeSlot = {
            startTime: fmt2(Math.floor(chargeStartMins / 60)) + ':' + fmt2(chargeStartMins % 60),
            endTime: fmt2(_fah) + ':' + fmt2(_fam),
            targetPct: 100,
            estimatedCostGbp: parseFloat((chargeNeededKwh * importRate / 100).toFixed(2))
          };
          dayEstimatedImportCost = dayChargeSlot.estimatedCostGbp;
        }
      }

      // Sell revenue uses each slot's estimated partial export (exportKwh); arb still assumes a full
      // slot (it force-charges to 100% first so a full 5kWh discharge is available).
      const sellRevenue = sellWindow.reduce((sum, s) => sum + s.value * EFFICIENCY * (s.exportKwh || 0), 0) / 100;
      const arbRevenue = arbWindow.reduce((sum, s) => sum + s.value * EFFICIENCY * SLOT_KWH, 0) / 100;
      dayEstimatedRevenue = parseFloat((sellRevenue + arbRevenue).toFixed(2));

      state.dayExportSlots = dayExportSlots;
      state.dayNeedsCharge = dayNeedsCharge;
      state.dayChargeTargetPct = dayChargeTargetPct;
      state.dayChargeSlot = dayChargeSlot;
      state.dayEstimatedRevenue = dayEstimatedRevenue;
      state.dayEstimatedImportCost = dayEstimatedImportCost;
      state.dayEstimatedProfit = parseFloat((dayEstimatedRevenue - dayEstimatedImportCost).toFixed(2));
      const sellCount = sellWindow.length, arbCount = arbWindow.length;
      const floorLabel = ds.awayMode === false && ds.manualFloorPct !== undefined ? 'manual floor ' + planFloorPct + '%' : 'adaptive floor';
      // Show each slot with its estimated partial export, e.g. "18:30 (~2.3kWh/14m)".
      const slotTimeList = dayExportSlots.map(s => s.time + ' (~' + s.estKwh + 'kWh/' + s.estMins + 'm)').join(', ');
      log(state, 'Day: strategy — ' + (sellCount ? sellCount + ' sell' : '') + (sellCount && arbCount ? ' + ' : '') + (arbCount ? arbCount + ' arb' : '') + ' slot(s)' +
        (slotTimeList ? ' [' + slotTimeList + ']' : '') +
        (dayNeedsCharge && dayChargeSlot ? ', charge ' + dayChargeSlot.startTime + '→' + dayChargeSlot.endTime : '') +
        (importRate ? ' · import ' + importRate.toFixed(1) + 'p' : ' · no import tariff') +
        ' · ' + floorLabel +
        ' · house ' + planConsumption.toFixed(2) + 'kWh/hr');
    }
  }

  if (!inWindow) {
    if (state.dayExporting) {
      try { await setExport(access, apiBase, siteId, false); await setMode(access, apiBase, siteId, 'self_consumption', 0); } catch(e) {}
      state.dayExporting = false;
      state.dayWindowEndReset = false;
      log(state, 'Day: window ended at ' + fmt2(h) + ':' + fmt2(m) + ' — export off, ready for overnight cycle');
    }
    if (state.dayCharging) {
      try { await setMode(access, apiBase, siteId, 'self_consumption', 0); } catch(e) {}
      state.dayCharging = false;
      state.dayWindowEndReset = false;
      log(state, 'Day: window ended — charge off');
    }
    // Restore to self-powered mode once per window-end so Tesla doesn't auto-charge before the overnight cycle
    if (!state.dayWindowEndReset) {
      try { await setMode(access, apiBase, siteId, 'self_consumption', 0); } catch(e) {}
      state.dayWindowEndReset = true;
    }
    return;
  }
  state.dayWindowEndReset = false; // clear flag when window is active so it fires again next window-end

  const pct = currentPctRaw >= 0 ? currentPctRaw : 0;
  const pctInt = Math.round(pct);
  const now = Date.now();

  // Adaptive house-load tracking — measured directly from Tesla's live load_power, which is
  // already in the live_status response we fetch each tick (so zero extra Tesla calls). This
  // replaces the old battery-%-drop inference, which saw nothing on sunny days when the battery
  // stayed full and so fell back to an over-optimistic 0.3 kWh/hr default and drained the house.
  // Accumulate a running average of TODAY's readings, from window-open (05:30) onwards, so by
  // export time the reserve floor reflects the house's actual measured passive load across the
  // whole day rather than any hardcoded guess.
  if (loadPowerKw != null && loadPowerKw >= 0) {
    // Clamp a single reading so a transient spike or glitch can't skew the day's average.
    const sample = Math.max(0.05, Math.min(3.0, loadPowerKw));
    state.dayLoadSum = (state.dayLoadSum || 0) + sample;
    state.dayLoadCount = (state.dayLoadCount || 0) + 1;
  }
  const loadCount = state.dayLoadCount || 0;
  // Seed from the persisted cross-day average until today has a few readings; only a brand-new
  // install with no history at all ever falls through to the 0.5 kWh/hr cold-start default.
  const persistedAvg = state.dayLoadAvgPersisted > 0 ? state.dayLoadAvgPersisted : 0.5;
  const measuredRate = loadCount >= 3 ? state.dayLoadSum / loadCount : persistedAvg;
  state.dayConsumptionKwhPerHr = parseFloat(measuredRate.toFixed(3));
  // Slow-moving average that persists across days so tomorrow's plan starts from a real number
  // even if tomorrow is sunny and the battery never drops.
  if (loadCount >= 3) {
    state.dayLoadAvgPersisted = parseFloat(
      (state.dayLoadAvgPersisted > 0
        ? state.dayLoadAvgPersisted * 0.8 + measuredRate * 0.2
        : measuredRate).toFixed(3));
  }

  const reserveFloorPct = computeReserveFloorPct({
    minuteOfDay, stopMinuteOfDay, measuredRate,
    isManualFloor: ds.awayMode === false && ds.manualFloorPct !== undefined,
    manualFloorPct: ds.manualFloorPct
  });
  state.dayReserveFloorPct = reserveFloorPct;

  // The floor is an EXPORT limit, NOT a level to hold the battery at. We deliberately do NOT set a
  // Powerwall backup reserve to the floor: the house keeps running off the battery normally all day
  // and discharges below the floor in the evening for the user's own use (washing etc). Holding the
  // floor as a reserve would instead pin the battery there and import from the grid to keep it — the
  // exact behaviour we are avoiding. The floor is honoured only in the export logic below
  // (pctInt > reserveFloorPct), so exports never eat into the evening reserve.

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

  // Just-in-time charge: only fire when the next upcoming slot is an arb slot (not sell)
  const nextFutureSlot = futureSlots[0];
  const nextIsArb = nextFutureSlot && nextFutureSlot.type === 'arb';
  const chargeStartMins = state.dayChargeStartMins || 0;
  // dayChargeHold latch: once the battery has reached the charge target before the export
  // slot, do NOT re-enter charging when it dips a percent or two. Without this the battery
  // flaps charge→100%→stop→99%→charge every few minutes until the slot, thrashing the
  // Powerwall mode and importing repeatedly from the grid. The hold mode keeps it ~full.
  const shouldCharge = !!(state.dayNeedsCharge &&
    !state.dayChargeHold &&
    nextIsArb &&
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
      // If the export slot has begun, the export block below will enable export this same tick.
      // If charging finished EARLY (battery hit target before the slot), we must NOT leave the
      // Powerwall in autonomous+0% during the gap — Tesla's own Time-Based Control would then
      // self-export at what IT considers peak, up to an hour before our intended slot. Hold the
      // battery in self_consumption at 100% reserve (never exports) until the real slot starts.
      if (inExportSlot) {
        await setMode(access, apiBase, siteId, 'autonomous', 0);
      } else {
        // Target reached before the slot — hold full and latch so we don't re-charge on a dip.
        await setMode(access, apiBase, siteId, 'self_consumption', 100);
        state.dayChargeHold = true;
      }
      state.dayCharging = false;
      if (state.dayChargeStart) {
        const kwhCharged = parseFloat((Math.max(0, pct - state.dayChargeStart.pct) / 100 * 13.5).toFixed(2));
        const importCostActual = parseFloat((kwhCharged * (state.dayImportRate || 0) / 100).toFixed(2));
        state.dayStats = state.dayStats || { kwh: 0, earned: 0, avgRate: 0, importCost: 0, rateSum: 0, rateSamples: 0 };
        state.dayStats.importCost = parseFloat(((state.dayStats.importCost || 0) + importCostActual).toFixed(2));
        const reason = inExportSlot ? 'export window starting' : 'target reached — holding full until slot';
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
      // Tag the export with its slot type so cost can be attributed correctly on stop
      const currentExportSlot = exportSlots.find(s => {
        const [sh, sm] = s.time.split(':').map(Number);
        const slotMins = sh * 60 + sm;
        return minuteOfDay >= slotMins && minuteOfDay < slotMins + 30;
      });
      state.dayExportStart = { pct, time: now, rate, type: currentExportSlot ? currentExportSlot.type : (state.dayNeedsCharge ? 'arb' : 'sell') };
      log(state, 'Day: export on — ' + (rate > 0 ? rate.toFixed(1) + 'p' : 'rate unavailable') + ' (battery ' + pctInt + '%, floor ' + reserveFloorPct + '%)');
      await sendPush(store, deviceId, 'Day export started', (rate > 0 ? rate.toFixed(1) + 'p/kWh · ' : '') + 'Battery at ' + pctInt + '%');
    } catch(e) { log(state, 'Day: export start error: ' + e.message); }
  } else if (!shouldExport && state.dayExporting && !state.carSyncPausedExport) {
    try {
      await setExport(access, apiBase, siteId, false);
      // Restore normal self-powered mode at 0% reserve — never hold the floor. After an export the
      // house resumes running off the battery freely, including down through the floor in the evening
      // for the user's own use. The floor was already honoured while exporting (we stopped at it), so
      // there is nothing to protect by pinning a reserve here.
      await setMode(access, apiBase, siteId, 'self_consumption', 0);
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
        // Attribute cost for sell exports: the kWh came from the overnight charge at off-peak rate
        if (netExportedKwh > 0 && (state.dayExportStart.type || 'sell') === 'sell') {
          const sellChargeRate = state.dayOffPeakRate || (state.stats && state.stats.offPeakRate) || 0;
          if (sellChargeRate > 0) {
            const sellCost = parseFloat((netExportedKwh * sellChargeRate / 100).toFixed(2));
            state.dayStats.importCost = parseFloat(((state.dayStats.importCost || 0) + sellCost).toFixed(2));
          }
        }
        // (Arb export cost was already added to dayStats.importCost when the charge phase ended)
        state.dayExportStart = null;
        const floorMode = ds.awayMode === false && ds.manualFloorPct !== undefined ? 'manual' : 'adaptive';
        const reason = pctInt <= reserveFloorPct ? 'reserve floor (' + pctInt + '% ≤ ' + reserveFloorPct + '% ' + floorMode + ')' : 'slot ended';
        log(state, 'Day: export off — ' + reason + ' · ~' + netExportedKwh + ' kWh · £' + periodEarned);
        await sendPush(store, deviceId, 'Day export ended', '~' + netExportedKwh + ' kWh · Est. £' + periodEarned);
      }
    } catch(e) { log(state, 'Day: export stop error: ' + e.message); }
  }

  // No periodic reserve refresh — the adaptive floor only controls when to stop exporting
  // (via shouldExport condition). After export stops, self_consumption mode lets the house
  // drain the battery naturally to 0% by stop time without locking in a reserve.
}

async function runCarSync(state, store, tokenData, settings, deviceId, phase1Reserve = 50, arbSettings = {}) {
  if (!tokenData.vehicleId) return;
  const { access, apiBase, energySiteId: siteId } = tokenData;
  const priority = settings.priority || 'export';
  const arbExporting = state.phase === 2;
  const isExporting = arbExporting || !!state.dayExporting;

  // Export-first during Phase 2: stay dormant, but if car control enabled send mid-cycle charge_stop
  if (arbExporting && priority === 'export') {
    if (state.carSyncActive) {
      try { await setMode(access, apiBase, siteId, 'autonomous', 0); } catch(e) {}
      state.carSyncActive = false;
      state.carChargingSince = null;
    }
    // Mid-Phase-2 car control: if car starts charging during export, stop it
    if (arbSettings.carControlEnabled && tokenData.vehicleId) {
      const now2 = Date.now();
      if (!state.midPhase2CarCheckTime || (now2 - state.midPhase2CarCheckTime) > 2 * 60 * 1000) {
        state.midPhase2CarCheckTime = now2;
        try {
          const vState = await getVehicleState(access, apiBase, tokenData.vehicleId);
          if (vState === 'online') {
            const cs = await getVehicleChargeState(access, apiBase, tokenData.vehicleId);
            if (cs === 'Charging' && !state.midPhase2CarStopSent) {
              await wakeVehicle(access, apiBase, tokenData.vehicleId);
              const limit = arbSettings.carChargeLimitPhase2 || 50;
              await store.set('pending_vehicle_cmd_' + deviceId, JSON.stringify({ cmd: 'charge_stop', chargeLimit: limit, requestedAt: Date.now() }));
              state.midPhase2CarStopSent = true;
              log(state, 'Car sync: car started charging mid-Phase 2 (export-first) — sending charge stop');
            }
          }
        } catch(e) {}
      }
    }
    return;
  }

  // Day export with export-first: stay dormant
  if (state.dayExporting && priority === 'export') {
    if (state.carSyncActive) {
      try { await setMode(access, apiBase, siteId, 'autonomous', 0); } catch(e) {}
      state.carSyncActive = false;
      state.carChargingSince = null;
    }
    return;
  }

  // Rate-limit vehicle checks: 1 min when active or recently stopped, 2 min when idle
  const now = Date.now();
  const recentlyStopped = state.carSyncRecentStop && (now - state.carSyncRecentStop) < 10 * 60 * 1000;
  const checkInterval = (state.carSyncActive || recentlyStopped) ? 60000 : 2 * 60 * 1000;
  if (state.carSyncLastCheck && (now - state.carSyncLastCheck) < checkInterval) return;
  state.carSyncLastCheck = now;

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
      // Car-first during Phase 2: pause export, charge battery alongside car at cheap Go rate
      if (isExporting && priority === 'car' && !state.carSyncPausedExport) {
        try { await setExport(access, apiBase, siteId, false); } catch(e) {}
        try { await setMode(access, apiBase, siteId, 'autonomous', 100); } catch(e) {}
        state.carSyncPausedExport = true;
        log(state, 'Car sync: pausing export — charging battery with car at cheap rate');
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
        const reserveToRestore = state.phase === 3 ? 100
          : state.phase === 1 ? phase1Reserve
          : state.dayCharging ? 100
          : 0;
        await setMode(access, apiBase, siteId, 'autonomous', reserveToRestore);
        state.carSyncActive = false;

        if (state.carSyncPausedExport) {
          state.carSyncPausedExport = false;

          if (state.phase === 2) {
            // Viability check before resuming Phase 2 export
            const londonNowStr = new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });
            const [_lnh, _lnm] = londonNowStr.split(':').map(Number);
            const nowMins = _lnh * 60 + _lnm;
            const endMins = (arbSettings.endHour || 5) * 60 + (arbSettings.endMinute || 30);
            const minsLeft = endMins >= nowMins ? endMins - nowMins : (24 * 60 - nowMins + endMins);
            const currentPct = state.stats.phase2LastPct || 50;
            const exportMinsNeeded = Math.ceil((currentPct / 100 * 13.5) / 5.0 * 60);
            if (minsLeft >= exportMinsNeeded + 60) {
              try { await setExport(access, apiBase, siteId, true); } catch(e) {}
              log(state, 'Car sync: car stopped — ' + minsLeft + ' min left, resuming Phase 2 export from ' + currentPct + '%');
              await sendPush(store, deviceId, 'Car finished charging', 'Export resumed · ' + minsLeft + ' min remaining');
            } else {
              state.phase = 3;
              state.stats.phase3StartPct = currentPct;
              await setMode(access, apiBase, siteId, 'autonomous', 100);
              log(state, 'Car sync: car stopped — only ' + minsLeft + ' min left, not enough to export + recharge — skipping to Phase 3');
              await sendPush(store, deviceId, 'Car finished charging', 'Not enough time to export before ' + fmt2(arbSettings.endHour || 5) + ':' + fmt2(arbSettings.endMinute || 30) + ' — recharging now');
            }
          } else if (state.dayExporting) {
            try { await setExport(access, apiBase, siteId, true); } catch(e) {}
            log(state, 'Car sync: car stopped — Day export resumed');
            await sendPush(store, deviceId, 'Car finished charging', 'Export resumed');
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
          await sendPush(store, deviceId, 'Car finished charging', 'Normal mode restored');
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

  // ── Tesla data-call gating (see shouldFetchLive) ────────────────────────────────────────────
  const _now = Date.now();
  const _ltStr = new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });
  const [_lth, _ltm] = _ltStr.split(':').map(Number);
  const _ltMins = _lth * 60 + _ltm;
  const _gate = shouldFetchLive({
    enabled: state.enabled, phase: state.phase, dayEnabled: state.dayEnabled, holidayEnabled: state.holidayEnabled,
    carSyncEnabled, hasPctExport, pendingCmd, timedExportActive: !!(timedExport && timedExport.endTime),
    dayExporting: state.dayExporting, dayCharging: state.dayCharging, dayExportSlots: state.dayExportSlots,
    dayNeedsCharge: state.dayNeedsCharge, dayChargeStartMins: state.dayChargeStartMins,
    ltMins: _ltMins, lastLivePoll: state.lastLivePoll, nowMs: _now
  });

  let currentPct = -1;
  let currentLoadKw = -1;
  if (_gate.poll) {
    try {
      const live = await teslaGet(tokenData.access, tokenData.apiBase, `/api/1/energy_sites/${tokenData.energySiteId}/live_status`);
      state.lastLivePoll = _now;
      currentPct = Math.round(live.response?.percentage_charged ?? -1);
      // load_power is the live house load in WATTS — reused for the adaptive reserve floor.
      currentLoadKw = live.response?.load_power != null ? live.response.load_power / 1000 : -1;
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
  const londonTimeStr = new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });
  const [h, m] = londonTimeStr.split(':').map(Number);
  const pct = currentPct >= 0 ? currentPct : 0;

  try {
    if (!state.enabled && state.phase > 0) {
      await setExport(access, apiBase, siteId, false);
      await setMode(access, apiBase, siteId, 'self_consumption', 0);
      log(state, 'Arbitrage disabled mid-cycle — export stopped, normal mode restored');
      state.phase = 0;
    }
    else if (state.phase === 0 && state.enabled && (() => {
      const startMins = startHour * 60 + startMinute;
      const endMins = endHour * 60 + endMinute;
      const nowMins = h * 60 + m;
      return startMins > endMins
        ? (nowMins >= startMins || nowMins < endMins)
        : (nowMins >= startMins && nowMins < endMins);
    })()) {
      state.phase = 1;
      state.stats = { kwh: 0, rate: 0, earned: 0, phase2StartPct: 0, phase1StartPct: pct, offPeakRate: null, importCost: 0, profit: 0 };
      state.phase1CarStopSent = false;
      state.phase1CarCheckTime = null;
      log(state, '=== Arbitrage cycle started ===');
      await setExport(access, apiBase, siteId, false);
      await setMode(access, apiBase, siteId, 'autonomous', chargeTargetPct);
      log(state, 'Phase 1: Reserve set to ' + chargeTargetPct + '% — charging from grid (export disabled)');
      await sendPush(store, deviceId, 'Overnight cycle started', 'Charging battery to ' + chargeTargetPct + '%');
      try { const r = await getGoOffPeakRate(store, deviceId); if (r) { state.stats.offPeakRate = r; } else { log(state, 'Note: import rate unavailable — night costs will not be tracked. Check Settings and press Re-detect tariff.'); } } catch(e) { log(state, 'Note: import rate fetch error — night costs will not be tracked'); }
    }
    else if (state.phase === 1) {
      // Re-apply export-off and autonomous mode every tick to prevent Tesla reverting
      try { await setExport(access, apiBase, siteId, false); await setMode(access, apiBase, siteId, 'autonomous', chargeTargetPct); } catch(e) {}
      if (m % 30 < 2) log(state, 'Phase 1 charging — battery at ' + pct + '%');
      // Stop car charging during Phase 1 if car control is enabled — prevents car competing for grid import
      if (s.carControlEnabled && tokenData.vehicleId && !state.phase1CarStopSent) {
        const now1 = Date.now();
        if (!state.phase1CarCheckTime || (now1 - state.phase1CarCheckTime) > 2 * 60 * 1000) {
          state.phase1CarCheckTime = now1;
          try {
            const vState = await getVehicleState(access, apiBase, tokenData.vehicleId);
            if (vState === 'online') {
              const cs = await getVehicleChargeState(access, apiBase, tokenData.vehicleId);
              if (cs === 'Charging') {
                await wakeVehicle(access, apiBase, tokenData.vehicleId);
                const limit = s.carChargeLimitPhase2 || 50;
                await store.set('pending_vehicle_cmd_' + deviceId, JSON.stringify({ cmd: 'charge_stop', chargeLimit: limit, requestedAt: Date.now() }));
                state.phase1CarStopSent = true;
                log(state, 'Phase 1: car detected charging — sending charge stop to protect grid import');
                await sendPush(store, deviceId, 'Car charging paused', 'Stopped car charging during battery charge phase');
              }
            }
          } catch(e) {}
        }
      }
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
          state.stats.phase3StartPct = pct;
          await setMode(access, apiBase, siteId, 'autonomous', 100);
          log(state, 'Phase 3: Recharging from grid');
          await sendPush(store, deviceId, 'Overnight export skipped', 'Not enough time before ' + fmt2(endHour) + ':' + fmt2(endMinute) + ' — recharging instead');
        } else {
          state.phase = 2;
          const rate = await getOctopusRate(store, deviceId);
          state.stats.phase2StartPct = pct;
          // Retry off-peak rate fetch if it was unavailable at Phase 1 start
          if (!state.stats.offPeakRate) {
            try { const r = await getGoOffPeakRate(store, deviceId); if (r) { state.stats.offPeakRate = r; } } catch(e) {}
          }
          state.stats.rateSum = rate;
          state.stats.rateSamples = rate > 0 ? 1 : 0;
          state.stats.rate = rate;
          state.stats.phase2LastPct = pct;
          state.stats.phase2LastPctTime = Date.now();
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
      // Stuck detection: if battery has risen by >5% over the last 20 min, something
      // has overridden export mode — re-establish it
      const lastPct = state.stats.phase2LastPct;
      const lastPctTime = state.stats.phase2LastPctTime;
      if (lastPct !== undefined && lastPctTime && (Date.now() - lastPctTime) > 20 * 60 * 1000) {
        if (pct > lastPct + 5) {
          log(state, 'Phase 2: battery rising (' + lastPct + '%→' + pct + '%) — re-establishing export mode');
          await sendPush(store, deviceId, 'Phase 2 override detected', 'Re-establishing export — battery was rising');
          try { await setMode(access, apiBase, siteId, 'autonomous', 0); await setExport(access, apiBase, siteId, true); } catch(e) {}
        }
        state.stats.phase2LastPct = pct;
        state.stats.phase2LastPctTime = Date.now();
      } else if (!lastPctTime) {
        state.stats.phase2LastPct = pct;
        state.stats.phase2LastPctTime = Date.now();
      }
      if (m % 30 < 2) log(state, 'Phase 2 exporting — battery at ' + pct + '%' + (state.stats.rate > 0 ? ' @ ' + state.stats.rate.toFixed(1) + 'p avg' : ''));
      if (m % 10 < 2) {
        // Mid-cycle viability check: if not enough time to finish export AND get ≥60 min recharge, skip to Phase 3
        const endTotalMins2 = endHour * 60 + endMinute;
        const nowTotalMins2 = h * 60 + m;
        const minsLeft = endTotalMins2 >= nowTotalMins2 ? endTotalMins2 - nowTotalMins2 : (24 * 60 - nowTotalMins2 + endTotalMins2);
        const exportMinsNeeded = Math.ceil((pct / 100 * 13.5) / 5.0 * 60);
        if (minsLeft < exportMinsNeeded + 60) {
          log(state, 'Phase 2: not enough time (battery ' + pct + '%, ' + minsLeft + ' min left, need ' + (exportMinsNeeded + 60) + ') — skipping to Phase 3');
          state.phase = 3;
          state.stats.phase3StartPct = pct;
          await setExport(access, apiBase, siteId, false);
          await setMode(access, apiBase, siteId, 'autonomous', 100);
          await sendPush(store, deviceId, 'Export shortened — recharging', 'Not enough time to fully export · Recharging now');
        }
      }
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
        state.stats.phase3StartPct = pct;
        state.midPhase2CarStopSent = false;
        state.midPhase2CarCheckTime = null;
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
      const _nowM3 = h * 60 + m, _endM3 = endHour * 60 + endMinute, _startM3 = startHour * 60 + startMinute;
      const phase3PastEnd = _startM3 > _endM3 ? (_nowM3 >= _endM3 && _nowM3 < _startM3) : (_nowM3 >= _endM3);
      if (phase3PastEnd) {
        if (state.stats.offPeakRate && (state.stats.kwh || 0) > 0) {
          state.stats.importCost = parseFloat((state.stats.kwh * state.stats.offPeakRate / 100).toFixed(2));
          state.stats.profit = parseFloat((state.stats.earned - state.stats.importCost).toFixed(2));
        }
        log(state, 'Phase 3 ended at ' + fmt2(endHour) + ':' + fmt2(endMinute) + ' — battery at ' + pct + '% — normal mode restored');
        await sendPush(store, deviceId, 'Overnight cycle ended', 'End time reached · Battery at ' + pct + '% · Normal mode restored');
        state.phase = 0;
        await setExport(access, apiBase, siteId, false);
        await setMode(access, apiBase, siteId, 'self_consumption', 0);
      } else {
        if (m % 30 < 2) log(state, 'Phase 3 recharging — battery at ' + pct + '%');
        if (pct >= 98) {
          log(state, 'Phase 3 complete — battery at ' + pct + '%');
          state.phase = 4;
          log(state, 'Phase 4: Fully charged — standby until ' + fmt2(endHour) + ':' + fmt2(endMinute));
          await sendPush(store, deviceId, 'Battery fully recharged', 'At ' + pct + '% · Standby until ' + fmt2(endHour) + ':' + fmt2(endMinute));
        }
      }
    }
    else if (state.phase === 4 && (() => { const _n = h*60+m, _e = endHour*60+endMinute, _s = startHour*60+startMinute; return _s > _e ? (_n >= _e && _n < _s) : (_n >= _e); })()) {
      if (state.stats.offPeakRate && (state.stats.kwh || 0) > 0) {
        state.stats.importCost = parseFloat((state.stats.kwh * state.stats.offPeakRate / 100).toFixed(2));
        state.stats.profit = parseFloat((state.stats.earned - state.stats.importCost).toFixed(2));
      }
      state.phase = 0;
      await setExport(access, apiBase, siteId, false);
      await setMode(access, apiBase, siteId, 'self_consumption', 0);
      log(state, '=== Cycle complete — self-powered mode restored, 0% reserve ===');
      await sendPush(store, deviceId, 'Overnight cycle complete', 'Normal operation restored · Check Night tab for earnings');
    }
    else if (state.phase === 4) {
      if (m % 30 < 2) log(state, 'Phase 4: standby — battery at ' + pct + '%, waiting until ' + fmt2(endHour) + ':' + fmt2(endMinute));
    }
    else if (state.phase > 0 && h >= endHour + 1) {
      log(state, 'Safety fallback at ' + fmt2(h) + ':' + fmt2(m) + ' — restoring normal mode');
      await sendPush(store, deviceId, 'Safety override triggered', 'Normal mode restored at ' + fmt2(h) + ':' + fmt2(m) + ' — check Night tab');
      state.phase = 0;
      await setExport(access, apiBase, siteId, false);
      await setMode(access, apiBase, siteId, 'self_consumption', 0);
    }
  } catch (e) {
    log(state, 'Error in phase ' + state.phase + ': ' + e.message);
  }

  // If Day mode was disabled while charging or exporting, restore normal mode
  if (!state.dayEnabled && !state.holidayEnabled && state.phase === 0 && (state.dayCharging || state.dayExporting)) {
    try {
      await setExport(access, apiBase, siteId, false);
      await setMode(access, apiBase, siteId, 'self_consumption', 0);
      log(state, 'Day: mode disabled — ' + (state.dayCharging ? 'charge' : 'export') + ' stopped, normal mode restored');
      await sendPush(store, deviceId, 'Day mode disabled', 'Powerwall returned to normal mode');
    } catch(e) {}
    state.dayCharging = false;
    state.dayExporting = false;
  }

  if ((state.dayEnabled || state.holidayEnabled) && state.phase === 0) {
    // Migrate legacy holidayEnabled to dayEnabled
    if (state.holidayEnabled && !state.dayEnabled) { state.dayEnabled = true; state.holidayEnabled = false; }
    try { await runDayMode(state, store, tokenData, currentPct, h, m, deviceId, currentLoadKw); }
    catch (e) { log(state, 'Day error: ' + e.message); }
  }

  // Skip car sync during Phase 1 — battery is already charging from grid and the car
  // drawing power simultaneously can exceed the grid import limit, causing the Powerwall
  // to discharge its own battery to supply the car load, creating an oscillation
  if (carSyncEnabled && state.phase !== 1) {
    try { await runCarSync(state, store, tokenData, carSyncSettings, deviceId, chargeTargetPct, s); }
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

// Test utilities — only active when TEST_MODE=1 (no production impact)
if (process.env.TEST_MODE === '1') {
  module.exports._test = {
    findBestConsecutiveWindow,

    // Real production functions exposed directly so tests can't drift from behaviour.
    planSellSlots,
    deriveDayStopTime,
    computeReserveFloorPct,
    shouldFetchLive,
    EXPORT_KWH_PER_SLOT,

    // Night cycle window trigger logic
    isNightWindowActive: function(nowMins, startHour, startMinute, endHour, endMinute) {
      const startMins = startHour * 60 + startMinute;
      const endMins = endHour * 60 + endMinute;
      return startMins > endMins
        ? (nowMins >= startMins || nowMins < endMins)
        : (nowMins >= startMins && nowMins < endMins);
    },

    // Phase 3/4 end detection (mirrors midnight-spanning logic in processUser)
    isPhase3PastEnd: function(nowMins, endHour, endMinute, startHour, startMinute) {
      const endMins = endHour * 60 + endMinute;
      const startMins = startHour * 60 + startMinute;
      return startMins > endMins ? (nowMins >= endMins && nowMins < startMins) : (nowMins >= endMins);
    },

    // Day charge-stop mode selection (mirrors the charge-stop block in runDayMode).
    // When charging finishes EARLY (target reached before the export slot), the Powerwall
    // must be held in a non-exporting mode so Tesla's autonomous/TOU logic cannot self-export
    // before our intended slot. Returns { mode, reserve }.
    dayChargeStopMode: function(inExportSlot) {
      return inExportSlot
        ? { mode: 'autonomous', reserve: 0 }
        : { mode: 'self_consumption', reserve: 100 };
    },

    // Just-in-time charge trigger (mirrors the shouldCharge condition in runDayMode).
    // The dayChargeHold latch prevents re-charging once the target was reached before the
    // slot — without it the battery flaps charge→100%→99%→charge every few minutes.
    dayShouldCharge: function({ dayNeedsCharge, dayChargeHold, nextIsArb, minuteOfDay,
                                chargeStartMins, firstFutureExportMins, pctInt, chargeTargetPct, inExportSlot }) {
      return !!(dayNeedsCharge &&
        !dayChargeHold &&
        nextIsArb &&
        minuteOfDay >= chargeStartMins &&
        minuteOfDay < firstFutureExportMins &&
        pctInt < (chargeTargetPct || 100) &&
        !inExportSlot);
    }
  };
}
