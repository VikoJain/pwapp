'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// test-arb.js  —  run with:  node test-arb.js
//
// Tests every critical feature before deployment. Covers:
//   1. findBestConsecutiveWindow  — arb slot selection
//   2. Sell slot selection         — greedy simulation, floor, consumption
//   3. Night cycle window          — midnight-spanning trigger
//   4. Phase 3/4 end detection     — midnight-spanning maths
//   5. arb-api.js handlers         — input validation, blob merging
//   6. tesla-proxy.js              — hostname allowlist security
// ─────────────────────────────────────────────────────────────────────────────

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const queue = [];

function test(name, fn) {
  queue.push({ name, fn });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

async function runAll() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch(e) {
      console.log(`  ✗ ${name}`);
      console.log(`    ${e.message}`);
      failed++;
    }
  }
}

// ── Load arb-tick.js test exports ─────────────────────────────────────────────
process.env.TEST_MODE = '1';
const { findBestConsecutiveWindow, planSellSlots, isNightWindowActive, isPhase3PastEnd, dayChargeStopMode, dayShouldCharge,
        deriveDayStopTime, computeReserveFloorPct, shouldFetchLive, EXPORT_KWH_PER_SLOT }
  = require('./netlify/functions/arb-tick')._test;

// ── Mock @netlify/blobs for arb-api.js ────────────────────────────────────────
const Module = require('module');
const BLOBS_MOCK_ID = '__netlify_blobs_mock__';
let mockStoreData = {};
const mockStore = {
  get:    async k      => mockStoreData[k] || null,
  set:    async (k, v) => { mockStoreData[k] = v; },
  delete: async k      => { delete mockStoreData[k]; },
  list:   async ()     => ({ blobs: [] })
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(req, ...args) {
  if (req === '@netlify/blobs') return BLOBS_MOCK_ID;
  return origResolve.call(this, req, ...args);
};
require.cache[BLOBS_MOCK_ID] = {
  id: BLOBS_MOCK_ID, filename: BLOBS_MOCK_ID, loaded: true,
  exports: { getStore: () => mockStore }
};
process.env.SITE_ID            = 'test-site';
process.env.NETLIFY_API_TOKEN  = 'test-token';
process.env.VAPID_PUBLIC_KEY   = 'test-vapid-key';
const arbApi = require('./netlify/functions/arb-api');

// ── Mock https.request so tesla-proxy tests don't make real connections ───────
const https = require('https');
const originalHttpsRequest = https.request;
let mockHttpsResponse = { statusCode: 200, body: '{"response":{}}' };
https.request = function(options, callback) {
  const res = {
    statusCode: mockHttpsResponse.statusCode,
    on: (evt, cb) => {
      if (evt === 'data') cb(mockHttpsResponse.body);
      if (evt === 'end')  cb();
      return res;
    }
  };
  if (callback) callback(res);
  return { on: () => {}, write: () => {}, end: () => {} };
};
const teslaProxy = require('./netlify/functions/tesla-proxy');

// ── Helpers ───────────────────────────────────────────────────────────────────
function resetStore(initial = {}) { mockStoreData = { ...initial }; }

async function apiPost(body) {
  return arbApi.handler({
    httpMethod: 'POST',
    queryStringParameters: {},
    body: JSON.stringify(body)
  });
}

async function apiGet(params) {
  return arbApi.handler({
    httpMethod: 'GET',
    queryStringParameters: params || {},
    body: null
  });
}

async function proxyCall(body) {
  return teslaProxy.handler({
    httpMethod: 'POST',
    body: JSON.stringify(body)
  });
}

// Rate slot with London minutes-of-day (timezone-independent for testing)
function slot(londonHour, londonMin, value) {
  return { value, timeMin: londonHour * 60 + londonMin };
}

// Consecutive UTC slots for findBestConsecutiveWindow (uses validFrom)
function makeSlots(startUTCHour, count, value) {
  return Array.from({ length: count }, (_, i) => ({
    value,
    validFrom: new Date(Date.UTC(2026, 7, 4, startUTCHour, i * 30)).toISOString()
  }));
}

const DEV = 'device_test001';

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 1. findBestConsecutiveWindow ────────────────────────────────────────────');

test('returns empty for empty input', () => {
  assertEqual(findBestConsecutiveWindow([], 5).length, 0);
});

test('returns empty when maxSlots is 0', () => {
  assertEqual(findBestConsecutiveWindow(makeSlots(4, 3, 20), 0).length, 0);
});

test('picks a single available slot', () => {
  const win = findBestConsecutiveWindow(makeSlots(4, 1, 20), 3);
  assertEqual(win.length, 1);
  assertEqual(win[0].value, 20);
});

test('respects maxSlots limit', () => {
  // 6 consecutive slots, limit to 3
  assertEqual(findBestConsecutiveWindow(makeSlots(4, 6, 20), 3).length, 3);
});

test('slides to pick highest-revenue sub-window within a block', () => {
  // Rates: 10 10 20 20 10 10 — best 2-slot window is the two 20p slots
  const slots = [10, 10, 20, 20, 10, 10].map((v, i) => ({
    value: v,
    validFrom: new Date(Date.UTC(2026, 7, 4, 4, i * 30)).toISOString()
  }));
  const win = findBestConsecutiveWindow(slots, 2);
  assertEqual(win.length, 2);
  assert(win[0].value === 20 && win[1].value === 20, 'should pick the two 20p slots');
});

test('picks best block across non-adjacent blocks', () => {
  // Block A: 3 slots at 15p (04:00 UTC) — revenue 3 × 15 × 2.5 × 0.9 = 101.25
  // Block B: 2 slots at 22p (17:00 UTC) — revenue 2 × 22 × 2.5 × 0.9 = 99
  const slots = [...makeSlots(4, 3, 15), ...makeSlots(17, 2, 22)];
  const win = findBestConsecutiveWindow(slots, 3);
  assert(win.every(s => s.value === 15), 'block A has higher total revenue so should be picked');
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 2. Sell slot selection ────────────────────────────────────────────────────');

test('picks evening high-rate slots over morning low-rate slots [REGRESSION: 4 Aug bug]', () => {
  // Morning 05:30-14:00 all at 12p, evening 16:00-19:00 at 19-21p
  const morning = Array.from({ length: 18 }, (_, i) => slot(5, 30 + i * 30, 12));
  const evening = [slot(16, 0, 19.1), slot(17, 0, 19.6), slot(17, 30, 20.1), slot(18, 0, 20.9), slot(18, 30, 21.6)];
  const result = planSellSlots({
    rates: [...morning, ...evening],
    pctForPlan: 100, planFloorPct: 30,
    minuteOfDay: 330, cRateForSell: 0.3
  });
  assert(result.length > 0, 'should select at least one slot');
  assert(result.every(s => s.timeMin >= 960), 'should pick afternoon/evening only, not 12p morning slots');
  assert(result.every(s => s.value >= 19), 'all picked slots should be high rate');
});

test('high house consumption leaves no surplus (never dumps in the cheap morning)', () => {
  const morning = [slot(6, 0, 12), slot(6, 30, 11), slot(7, 0, 12)];
  const evening = [slot(18, 0, 20.9), slot(18, 30, 21.6)];
  const rates = [...morning, ...evening];
  // Import 18p: the 11-12p morning slots are below it, so selling there would just force a pricier
  // import later — the import-price guard filters them out, which is what stops any morning dump.
  const importRate = 18;
  // Heavy drain (0.8 kWh/hr): the battery is below the floor by the evening peak, so there is
  // genuinely no surplus — it sells nothing, and crucially NOT the cheap morning slots.
  const heavy = planSellSlots({ rates, pctForPlan: 100, planFloorPct: 30, minuteOfDay: 330, cRateForSell: 0.8, importRate });
  // Normal drain (0.3): a real surplus survives to the evening → sold at the top evening slots.
  const normal = planSellSlots({ rates, pctForPlan: 100, planFloorPct: 30, minuteOfDay: 330, cRateForSell: 0.3, importRate });
  assertEqual(heavy.length, 0, 'no surplus under heavy load — sells nothing, never the morning');
  assert(normal.length > 0 && normal.every(s => s.timeMin >= 1080), 'normal load: sells the evening surplus');
});

test('respects 30% manual floor — stops selecting when battery would breach it', () => {
  // Battery 50%, floor 30% = 20% headroom. Tests the floor mechanic at fine (2.5 kWh) granularity,
  // so exportKwhPerSlot is pinned to 2.5 regardless of the production ~10kW default.
  // Slot 1 at 05:30: 50% → 31.5% — passes. Slot 2 at 06:00: 31.5% → 13% — below floor, fails.
  const rates = [slot(5, 30, 20), slot(6, 0, 20), slot(6, 30, 20)];
  const result = planSellSlots({ rates, pctForPlan: 50, planFloorPct: 30, minuteOfDay: 330, cRateForSell: 0.3, exportKwhPerSlot: 2.5 });
  assertEqual(result.length, 1, 'only 1 slot fits with 20% headroom above floor');
});

test('returns empty when battery is already at the floor', () => {
  const result = planSellSlots({
    rates: [slot(10, 0, 20)],
    pctForPlan: 30, planFloorPct: 30,
    minuteOfDay: 330, cRateForSell: 0.3
  });
  assertEqual(result.length, 0, 'no slots when battery at floor already');
});

test('combines non-consecutive slots across the day when battery allows', () => {
  // With 10% floor and full battery there is room for both morning and evening.
  // Pinned to 2.5 kWh/slot to test the non-consecutive combining mechanic at fine granularity.
  const result = planSellSlots({
    rates: [slot(7, 0, 15), slot(18, 0, 15)],
    pctForPlan: 100, planFloorPct: 10,
    minuteOfDay: 330, cRateForSell: 0.3, exportKwhPerSlot: 2.5
  });
  assertEqual(result.length, 2, 'should pick both non-consecutive slots');
});

test('very high house consumption prevents reaching evening slots', () => {
  // 1.0 kWh/hr means ~13 hrs × 7.4% = ~96% gone by 18:00 — no battery left
  const result = planSellSlots({
    rates: [slot(18, 0, 20), slot(18, 30, 21)],
    pctForPlan: 100, planFloorPct: 30,
    minuteOfDay: 330, cRateForSell: 1.0
  });
  assertEqual(result.length, 0, 'high consumption drains battery before evening');
});

test('returns empty with no rates', () => {
  const result = planSellSlots({ rates: [], pctForPlan: 100, planFloorPct: 30, minuteOfDay: 330 });
  assertEqual(result.length, 0);
});

test('results are always sorted chronologically', () => {
  const rates = [slot(18, 0, 20), slot(7, 0, 18), slot(14, 0, 15), slot(18, 30, 21)];
  const result = planSellSlots({ rates, pctForPlan: 100, planFloorPct: 10, minuteOfDay: 330, cRateForSell: 0.3 });
  for (let i = 1; i < result.length; i++) {
    assert(result[i].timeMin > result[i - 1].timeMin, 'result must be in time order');
  }
});

test('on a flat/tied-price day it sells the LATER slots, not the early-morning drain', () => {
  // Every slot the same price. Selling later is strictly better for At-home (the house runs off the
  // battery through the day first), so the plan must not dump in the morning.
  const rates = Array.from({ length: 20 }, (_, i) => slot(6 + Math.floor(i / 2), (i % 2) * 30, 15));
  const result = planSellSlots({ rates, pctForPlan: 100, planFloorPct: 30, minuteOfDay: 330, cRateForSell: 0.3, isManualFloor: true });
  assert(result.length >= 1, 'still sells the excess');
  assert(result.every(s => s.timeMin >= 12 * 60), 'sells afternoon/evening, never the 06:00 slots: ' + result.map(s => s.timeMin));
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 2b. Reserve floor targets tariff off-peak start [REGRESSION: 17 Aug drain] ─');

test('day stop time derives from tariff offPeakStart', () => {
  const r = deriveDayStopTime({ offPeakStart: '23:30' }, { stopHour: 23, stopMinute: 0 });
  assertEqual(r.stopHour, 23, 'stop hour from tariff');
  assertEqual(r.stopMinute, 30, 'stop minute from tariff — not the legacy 23:00');
});

test('day stop time falls back to legacy manual setting when tariff has no offPeakStart', () => {
  const r = deriveDayStopTime({}, { stopHour: 22, stopMinute: 0 });
  assertEqual(r.stopHour, 22);
  assertEqual(r.stopMinute, 0);
});

test('day stop time falls back to 23:00 when nothing is set', () => {
  const r = deriveDayStopTime({}, {});
  assertEqual(r.stopHour, 23);
  assertEqual(r.stopMinute, 0);
});

test('reserve floor reserves enough to reach off-peak start with headroom [REGRESSION: 17 Aug]', () => {
  // 17 Aug: exports ended ~19:00, real load ~0.48 kWh/hr, off-peak start 23:30.
  // Old code targeted 23:00 with no headroom → floor ~9% → battery died at 21:50.
  // Need: (23:30-19:00)=4.5h × 0.48 × 1.25 ÷ 13.5 ≈ 20%.
  const floor = computeReserveFloorPct({
    minuteOfDay: 19 * 60, stopMinuteOfDay: 23 * 60 + 30, measuredRate: 0.48,
    isManualFloor: false
  });
  assert(floor >= 18, 'floor should reserve ~20% to survive to 23:30, not the old ~9%: got ' + floor);
});

test('reserve floor shrinks toward off-peak start as time passes', () => {
  const early = computeReserveFloorPct({ minuteOfDay: 19 * 60, stopMinuteOfDay: 23 * 60 + 30, measuredRate: 0.4, isManualFloor: false });
  const late  = computeReserveFloorPct({ minuteOfDay: 22 * 60, stopMinuteOfDay: 23 * 60 + 30, measuredRate: 0.4, isManualFloor: false });
  assert(late < early, 'less time to off-peak start means a lower floor');
});

test('reserve floor honours manual floor unchanged', () => {
  const floor = computeReserveFloorPct({ minuteOfDay: 19 * 60, stopMinuteOfDay: 23 * 60 + 30, measuredRate: 0.48, isManualFloor: true, manualFloorPct: 30 });
  assertEqual(floor, 30, 'manual mode uses the user floor verbatim');
});

test('sell plan stops exporting early enough to survive to off-peak start [REGRESSION: 17 Aug]', () => {
  // Full battery, high evening rates every slot 17:30-21:00, load 0.48, off-peak start 23:30.
  // The plan must NOT sell so many slots that the post-export battery can't cover 19:00→23:30.
  const rates = [slot(17,30,25), slot(18,0,25), slot(18,30,25), slot(19,0,24), slot(19,30,24), slot(20,0,23), slot(20,30,23)];
  const result = planSellSlots({
    rates, pctForPlan: 100, planFloorPct: 10, minuteOfDay: 17 * 60,
    cRateForSell: 0.48, offPeakStartMins: 23 * 60 + 30, isManualFloor: false
  });
  // Simulate the plan forward using each slot's ACTUAL (partial) export and confirm the battery
  // reaches off-peak start above zero — the planner sizes the last slot to respect the reserve.
  let batt = 100, prev = 17 * 60;
  for (const s of result) {
    batt -= (s.timeMin - prev) / 60 * 0.48 / 13.5 * 100;
    batt -= (s.exportKwh / 13.5) * 100;
    prev = s.timeMin + 30;
  }
  batt -= ((23 * 60 + 30) - prev) / 60 * 0.48 / 13.5 * 100; // house drain from last slot to off-peak
  assert(batt > 0, 'battery must survive to off-peak start (23:30), got ' + batt.toFixed(1) + '%');
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 2c. ~10kW export power concentrates on best slots [REGRESSION: 18 Aug] ─────');

// 18 Aug: app exported from 17:30 and emptied the battery by 18:06 (Powerwall discharges at
// ~10kW, not the 5kW assumed), so it missed the 24.3p peak at 18:30. With the real export power
// the greedy books far fewer slots and, because it picks highest-rate first, lands on the peak.
test('at ~10kW the sell plan skips 17:30 and lands on the 18:30 peak [REGRESSION: 18 Aug]', () => {
  // The three profitable evening slots from that day, plus some lower daytime rates.
  const rates = [
    slot(12, 0, 14), slot(12, 30, 14.5), slot(16, 0, 20),
    slot(17, 30, 23.2), slot(18, 0, 23.9), slot(18, 30, 24.3)
  ];
  const result = planSellSlots({
    rates, pctForPlan: 90, planFloorPct: 10, minuteOfDay: 330,
    cRateForSell: 0.25, offPeakStartMins: 23 * 60 + 30, isManualFloor: false,
    windowStartMins: 330
  });
  assert(result.length >= 1, 'should still export something');
  assert(result.some(s => s.timeMin === 18 * 60 + 30), 'must include the 24.3p peak slot (18:30)');
  assert(!result.some(s => s.timeMin === 17 * 60 + 30), 'must NOT include the 17:30 slot that drained before the peak');
  assert(result.every(s => s.value >= 23.9), 'every picked slot is one of the top-priced evening slots');
});

test('~10kW moves ~5kWh/slot, so a big surplus books only the top few slots (last partial)', () => {
  // Full battery, 10% floor ≈ 12 kWh usable. At ≤5 kWh/slot that is up to 3 slots (the last partial),
  // and always the highest-priced ones — never the cheaper 21/22p slots.
  const rates = [slot(17, 30, 22), slot(18, 0, 23), slot(18, 30, 24), slot(19, 0, 25), slot(19, 30, 21)];
  const result = planSellSlots({
    rates, pctForPlan: 100, planFloorPct: 10, minuteOfDay: 330,
    cRateForSell: 0.15, offPeakStartMins: 23 * 60 + 30, isManualFloor: false, windowStartMins: 330
  });
  assert(result.length <= 3, 'concentrates on the top few slots, got ' + result.length);
  assert(result.every(s => s.value >= 23), 'only the highest-priced slots, got ' + result.map(s => s.value));
});

test('house drain is counted from window open, not from a just-after-midnight build time', () => {
  // Strategy built at 00:01 (minuteOfDay=1) for an 18:00 slot. Without windowStartMins the sim would
  // subtract ~18h of house drain (phantom — the overnight cycle holds the battery full until 05:30)
  // and wrongly reject the slot. With windowStartMins=330 only ~12.5h of real drain is counted.
  const rates = [slot(18, 0, 24)];
  const withoutWindow = planSellSlots({
    rates, pctForPlan: 100, planFloorPct: 10, minuteOfDay: 1, cRateForSell: 0.6, exportKwhPerSlot: 2.5
  });
  const withWindow = planSellSlots({
    rates, pctForPlan: 100, planFloorPct: 10, minuteOfDay: 1, cRateForSell: 0.6, exportKwhPerSlot: 2.5,
    windowStartMins: 330
  });
  // Counting ~18h of phantom drain (from midnight) leaves far less to export than the real ~12.5h
  // from window-open, so the with-window plan exports meaningfully more of the same slot.
  assert(withWindow[0].exportKwh > withoutWindow[0].exportKwh + 0.5,
    'window-open drain start leaves more to export: ' + withoutWindow[0].exportKwh + ' vs ' + withWindow[0].exportKwh);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 2d. At-home: sell excess down to the manual floor, at the best price [21 Aug] ─');

// 21 Aug: At-home mode sold at 06:30 @16.5p (the earliest slot) instead of the evening peak. The
// planner insisted a full 5kWh fit above the floor before booking a slot, so a ~2-3kWh surplus
// failed everywhere and it fell back to the cheap morning. The fix books the single highest-priced
// slot and exports the partial excess straight down to the user's manual floor.
test('at-home sells the evening peak, not the cheap morning, as a partial export [REGRESSION: 21 Aug]', () => {
  const morning = [slot(6, 0, 15.5), slot(6, 30, 16.5), slot(7, 0, 16.0)];
  const evening = [slot(18, 0, 22.8), slot(18, 30, 23.3), slot(19, 0, 22.5)];
  const result = planSellSlots({
    rates: [...morning, ...evening],
    pctForPlan: 100, planFloorPct: 30, minuteOfDay: 330,
    cRateForSell: 0.55, isManualFloor: true, offPeakStartMins: 23 * 60 + 30, windowStartMins: 330
  });
  assert(result.length >= 1, 'should sell the genuine evening excess');
  assert(!result.some(s => s.timeMin < 12 * 60), 'never the cheap morning slots');
  assert(result.some(s => s.timeMin === 18 * 60 + 30), 'includes the 23.3p peak');
  // ~0.55kWh/hr from 05:30→18:30 drains ~53% (100→47%); exporting down to the 30% floor ≈ 2.3kWh.
  const peak = result.find(s => s.timeMin === 18 * 60 + 30);
  assert(peak.exportKwh > 1 && peak.exportKwh < 4, 'partial export ~2-3kWh, got ' + peak.exportKwh);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 2e. Dearest slot drained past → sell the best EARLIER slot, never bail [27 Aug] ─');

// 27 Aug: the single dearest export slot fell late in the day, by which time the house had drained
// the battery to the floor, so the old planner anchored on that one slot, found no surplus and
// booked NOTHING for the whole day — never exporting. The fix anchors on the dearest slot that still
// has genuine surplus, so it falls back to the best earlier slot instead of exporting nothing.
test('sells the best earlier slot when the single dearest slot is drained past [REGRESSION: 27 Aug]', () => {
  // At-home, manual 30% floor. Midday 13:00 @28p still has surplus above the floor; the dearest
  // 21:30 @32p spike lands after the house has drained the battery below the floor. The old planner
  // anchored on the dearest slot only, found no surplus there and booked nothing all day.
  const rates = [slot(13, 0, 28), slot(18, 0, 26), slot(21, 30, 32)];
  const result = planSellSlots({
    rates, pctForPlan: 100, planFloorPct: 30, minuteOfDay: 330,
    cRateForSell: 0.9, isManualFloor: true, windowStartMins: 330, importRate: 20
  });
  assert(result.length >= 1, 'must NOT bail to zero just because the dearest slot is late/drained');
  assert(result.some(s => s.timeMin === 13 * 60), 'sells the earlier 28p slot that genuinely has surplus');
  assert(!result.some(s => s.timeMin === 21 * 60 + 30), 'skips the 32p spike the battery cannot reach');
});

test('never sells below the import rate — a cheap-but-only slot is not dumped', () => {
  // Only export slot of note is 15p, but importing costs 27p: selling now then buying back later loses
  // money, so the import-price guard books nothing.
  const result = planSellSlots({
    rates: [slot(14, 0, 15), slot(18, 0, 14)], pctForPlan: 100, planFloorPct: 30,
    minuteOfDay: 330, cRateForSell: 0.3, importRate: 27
  });
  assertEqual(result.length, 0, 'nothing sells below the import rate');
});

// At-home export stops AT the manual floor — never plans below it, whatever the surplus.
test('at-home never plans the battery below the manual floor', () => {
  const evening = [slot(18, 0, 22.8), slot(18, 30, 23.3), slot(19, 0, 22.5)];
  const result = planSellSlots({
    rates: evening, pctForPlan: 100, planFloorPct: 30, minuteOfDay: 330,
    cRateForSell: 0.15, isManualFloor: true, windowStartMins: 330
  });
  let batt = 100, prev = 330;
  for (const s of result) {
    batt -= (s.timeMin - prev) / 60 * 0.15 / 13.5 * 100; // house drain to the slot
    batt -= (s.exportKwh / 13.5) * 100;                  // the slot's partial export
    prev = s.timeMin + 30;
    assert(batt >= 30 - 0.5, 'battery held at/above the 30% manual floor, got ' + batt.toFixed(1) + '%');
  }
  assert(result.every(s => s.value >= 22.5), 'only the highest-priced evening slots');
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 3. Night cycle window detection ───────────────────────────────────────');

// Midnight-spanning: start=23:30, end=05:30
test('midnight-spanning: active at start time (23:30)', () => {
  assert(isNightWindowActive(23 * 60 + 30, 23, 30, 5, 30));
});
test('midnight-spanning: active at midnight (00:00)', () => {
  assert(isNightWindowActive(0, 23, 30, 5, 30));
});
test('midnight-spanning: active just before end (05:29)', () => {
  assert(isNightWindowActive(5 * 60 + 29, 23, 30, 5, 30));
});
test('midnight-spanning: NOT active at end time (05:30)', () => {
  assert(!isNightWindowActive(5 * 60 + 30, 23, 30, 5, 30));
});
test('midnight-spanning: NOT active in the afternoon (15:00)', () => {
  assert(!isNightWindowActive(15 * 60, 23, 30, 5, 30));
});
test('midnight-spanning: NOT active one minute before start (23:29)', () => {
  assert(!isNightWindowActive(23 * 60 + 29, 23, 30, 5, 30));
});

// Non-spanning: start=22:00, end=23:00
test('non-spanning: active inside window (22:30)', () => {
  assert(isNightWindowActive(22 * 60 + 30, 22, 0, 23, 0));
});
test('non-spanning: active at start (22:00)', () => {
  assert(isNightWindowActive(22 * 60, 22, 0, 23, 0));
});
test('non-spanning: NOT active at end (23:00)', () => {
  assert(!isNightWindowActive(23 * 60, 22, 0, 23, 0));
});
test('non-spanning: NOT active outside window (20:00)', () => {
  assert(!isNightWindowActive(20 * 60, 22, 0, 23, 0));
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 4. Phase 3/4 end detection (midnight-spanning) ─────────────────────────');

// Overnight cycle: start=23:30, end=05:30
test('phase ends when past end time during daytime (10:00)', () => {
  assert(isPhase3PastEnd(10 * 60, 5, 30, 23, 30));
});
test('phase ends at exactly the end time (05:30)', () => {
  assert(isPhase3PastEnd(5 * 60 + 30, 5, 30, 23, 30));
});
test('phase does NOT end during overnight window (03:00)', () => {
  assert(!isPhase3PastEnd(3 * 60, 5, 30, 23, 30));
});
test('phase does NOT end at midnight (00:00)', () => {
  assert(!isPhase3PastEnd(0, 5, 30, 23, 30));
});
test('phase does NOT end one minute before end (05:29)', () => {
  assert(!isPhase3PastEnd(5 * 60 + 29, 5, 30, 23, 30));
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 4b. Day charge-stop hold mode ──────────────────────────────────────────────────');

// REGRESSION: on arb days the just-in-time charge could finish BEFORE the export slot.
// The old code left the Powerwall in autonomous+0% during the gap, so Tesla's own
// Time-Based Control self-exported up to an hour before our intended slot.
test('charge finishes early (not yet in slot) → held in self_consumption 100% [REGRESSION: early export]', () => {
  const r = dayChargeStopMode(false);
  assertEqual(r.mode, 'self_consumption', 'must NOT be autonomous during the pre-slot gap');
  assertEqual(r.reserve, 100, 'reserve must be 100% so the battery cannot discharge/export early');
});
test('charge stops because export slot has started → autonomous 0% ready to export', () => {
  const r = dayChargeStopMode(true);
  assertEqual(r.mode, 'autonomous');
  assertEqual(r.reserve, 0);
});

// REGRESSION (13 Aug): battery reached 100% ~44 min before the 18:00 slot, then flapped
// charge→100%→99%→charge every few minutes, thrashing the Powerwall mode until the slot and
// leaving it in a state where the 18:00 export never triggered (needed manual intervention).
const CHARGE_CTX = {
  dayNeedsCharge: true, nextIsArb: true,
  minuteOfDay: 17 * 60 + 20,           // 17:20, before the 18:00 slot
  chargeStartMins: 15 * 60 + 10,        // 15:10
  firstFutureExportMins: 18 * 60,       // 18:00
  chargeTargetPct: 100, inExportSlot: false,
};
test('charges while below target and not yet held (17:20, 96%)', () => {
  assert(dayShouldCharge({ ...CHARGE_CTX, dayChargeHold: false, pctInt: 96 }));
});
test('does NOT charge at exactly target (17:20, 100%)', () => {
  assert(!dayShouldCharge({ ...CHARGE_CTX, dayChargeHold: false, pctInt: 100 }));
});
test('does NOT re-charge after a 1% dip once hold latched [REGRESSION: charge oscillation]', () => {
  assert(!dayShouldCharge({ ...CHARGE_CTX, dayChargeHold: true, pctInt: 99 }),
    'latch must suppress re-charge so the Powerwall does not flap until the slot');
});
test('does NOT charge once the export slot has started (18:00)', () => {
  assert(!dayShouldCharge({ ...CHARGE_CTX, dayChargeHold: true, minuteOfDay: 18 * 60, inExportSlot: true, pctInt: 100 }));
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 5. arb-api.js handlers ─────────────────────────────────────────────────────────');

test('missing device_id returns 400', async () => {
  resetStore();
  const resp = await apiPost({ action: 'toggle_day', enabled: true });
  assertEqual(resp.statusCode, 400);
});

test('save_settings preserves import tariff when incoming value is null [REGRESSION]', async () => {
  resetStore();
  // First call — establishes import tariff from device A
  await apiPost({ action: 'save_settings', device_id: DEV,
    octKey: 'sk_live_abc', octTariff: 'E-1R-AGILE-OUT-24-04-03-C',
    octProduct: 'AGILE-OUT-24-04-03', octAccount: 'A-12345',
    octImportTariff: 'E-1R-GO-24-02-01-C', octImportProduct: 'GO-24-02-01',
    offPeakStart: '23:30', offPeakEnd: '05:30', offPeakRate: 7.5 });
  // Second call from different device — no import tariff in payload (null)
  await apiPost({ action: 'save_settings', device_id: DEV,
    octKey: 'sk_live_abc', octTariff: 'E-1R-AGILE-OUT-24-04-03-C',
    octProduct: 'AGILE-OUT-24-04-03', octAccount: 'A-12345',
    octImportTariff: null, octImportProduct: null,
    offPeakStart: null, offPeakEnd: null, offPeakRate: null });
  const saved = JSON.parse(mockStoreData['oct_settings_' + DEV]);
  assertEqual(saved.octImportTariff, 'E-1R-GO-24-02-01-C', 'import tariff must be preserved');
  assertEqual(saved.octImportProduct, 'GO-24-02-01', 'import product must be preserved');
  assertEqual(saved.offPeakEnd, '05:30', 'off-peak end must be preserved');
  assertEqual(saved.offPeakRate, 7.5, 'off-peak rate must be preserved');
});

test('save_tariff_window updates tariff fields and preserves API key', async () => {
  resetStore({ ['oct_settings_' + DEV]: JSON.stringify({
    octKey: 'sk_live_abc', octTariff: 'AGILE', octProduct: 'AGILE-P',
    offPeakStart: '23:00', offPeakEnd: '05:00', offPeakRate: 7.0
  })});
  await apiPost({ action: 'save_tariff_window', device_id: DEV,
    offPeakStart: '23:30', offPeakEnd: '05:30', offPeakRate: 7.5 });
  const saved = JSON.parse(mockStoreData['oct_settings_' + DEV]);
  assertEqual(saved.offPeakStart, '23:30', 'start time should update');
  assertEqual(saved.offPeakEnd, '05:30', 'end time should update');
  assertEqual(saved.offPeakRate, 7.5, 'rate should update');
  assertEqual(saved.octKey, 'sk_live_abc', 'API key must be preserved');
  assertEqual(saved.octTariff, 'AGILE', 'tariff code must be preserved');
});

test('save_day_settings resets dayRatesCacheDay to force strategy rebuild', async () => {
  resetStore({ ['state_' + DEV]: JSON.stringify({
    phase: 0, enabled: false, dayEnabled: true,
    dayRatesCacheDay: '04/08/2026', log: []
  })});
  await apiPost({ action: 'save_day_settings', device_id: DEV,
    stopHour: 23, stopMinute: 0, minMargin: 2.0,
    awayMode: false, manualFloorPct: 30, sellEnabled: true, arbEnabled: true });
  const state = JSON.parse(mockStoreData['state_' + DEV]);
  assert(state.dayRatesCacheDay === null, 'dayRatesCacheDay must be null after settings change');
});

test('toggle_day on resets stats and dayRatesCacheDay', async () => {
  resetStore({ ['state_' + DEV]: JSON.stringify({
    phase: 0, enabled: false, dayEnabled: false,
    dayRatesCacheDay: '04/08/2026',
    dayStats: { kwh: 5, earned: 1.20 }, log: []
  })});
  await apiPost({ action: 'toggle_day', enabled: true, device_id: DEV });
  const state = JSON.parse(mockStoreData['state_' + DEV]);
  assert(state.dayEnabled === true, 'dayEnabled should be true');
  assert(state.dayRatesCacheDay === null, 'cache key must reset so strategy rebuilds');
  assertEqual(state.dayStats.kwh, 0, 'daily stats must reset to zero');
  assertEqual(state.dayStats.earned, 0, 'daily earnings must reset');
});

test('save_pct_export rejects NaN target', async () => {
  resetStore();
  const resp = await apiPost({ action: 'save_pct_export', device_id: DEV, targetPct: 'not-a-number' });
  assertEqual(resp.statusCode, 400, 'should return 400 for non-numeric target');
});

test('save_pct_export accepts valid integer target', async () => {
  resetStore();
  const resp = await apiPost({ action: 'save_pct_export', device_id: DEV, targetPct: 25 });
  assertEqual(resp.statusCode, 200);
  const saved = JSON.parse(mockStoreData['pct_export_' + DEV]);
  assertEqual(saved.targetPct, 25);
});

test('save_arb_settings stores correct values', async () => {
  resetStore();
  await apiPost({ action: 'save_arb_settings', device_id: DEV,
    chargeTargetPct: 80, startHour: 23, startMinute: 30,
    endHour: 5, endMinute: 30,
    carControlEnabled: true, carChargeLimit: 80, carChargeLimitPhase2: 50 });
  const saved = JSON.parse(mockStoreData['arb_settings_' + DEV]);
  assertEqual(saved.chargeTargetPct, 80);
  assertEqual(saved.startHour, 23);
  assertEqual(saved.endHour, 5);
  assertEqual(saved.carControlEnabled, true);
});

test('GET state returns phase, arbSettings and daySettings', async () => {
  resetStore({
    ['state_'       + DEV]: JSON.stringify({ phase: 2, enabled: true, log: [], stats: {} }),
    ['arb_settings_'+ DEV]: JSON.stringify({ chargeTargetPct: 80, startHour: 23, startMinute: 30, endHour: 5, endMinute: 30 }),
    ['day_settings_'+ DEV]: JSON.stringify({ stopHour: 23, stopMinute: 0, minMargin: 2.0 })
  });
  const resp = await apiGet({ device_id: DEV });
  const data = JSON.parse(resp.body);
  assertEqual(data.phase, 2);
  assertEqual(data.arbSettings.chargeTargetPct, 80);
  assertEqual(data.daySettings.stopHour, 23);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 6. tesla-proxy.js — hostname allowlist ─────────────────────────────────');

test('blocks AWS metadata endpoint (SSRF protection)', async () => {
  const resp = await proxyCall({
    path: 'http://169.254.169.254/latest/meta-data', method: 'GET', token: 'tok'
  });
  assertEqual(resp.statusCode, 403, 'AWS metadata must be blocked');
});

test('blocks arbitrary external URL', async () => {
  const resp = await proxyCall({
    path: 'https://evil.example.com/steal', method: 'GET', token: 'tok'
  });
  assertEqual(resp.statusCode, 403);
});

test('allows Tesla EU Fleet API', async () => {
  const resp = await proxyCall({
    path: 'https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/products',
    method: 'GET', token: 'tok'
  });
  assert(resp.statusCode !== 403, 'Tesla EU hostname should be allowed');
});

test('allows Tesla NA Fleet API', async () => {
  const resp = await proxyCall({
    path: 'https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/products',
    method: 'GET', token: 'tok'
  });
  assert(resp.statusCode !== 403, 'Tesla NA hostname should be allowed');
});

test('allows Tesla auth endpoint', async () => {
  const resp = await proxyCall({
    path: 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
    method: 'POST', token: 'tok'
  });
  assert(resp.statusCode !== 403, 'Tesla auth hostname should be allowed');
});

test('returns 400 for missing path', async () => {
  const resp = await proxyCall({ token: 'tok' });
  assertEqual(resp.statusCode, 400);
});

test('returns 400 for missing token', async () => {
  const resp = await proxyCall({ path: 'https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/products' });
  assertEqual(resp.statusCode, 400);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n── 7. Tesla live_status poll gate (API cost reduction) ────────────────────────');

// Base "armed but idle, holding a reserve" case: Day mode on, mid-afternoon, no slot nearby.
const gateBase = {
  enabled: false, phase: 0, dayEnabled: true, holidayEnabled: false, carSyncEnabled: false,
  hasPctExport: false, pendingCmd: null, timedExportActive: false, dayExporting: false, dayCharging: false,
  dayExportSlots: [{ time: '18:30' }], dayNeedsCharge: false, dayChargeStartMins: null,
  ltMins: 14 * 60, lastLivePoll: null, nowMs: 1000000
};
const gate = (o) => shouldFetchLive(Object.assign({}, gateBase, o));

test('fully idle (nothing armed) → never polls', () => {
  const r = gate({ dayEnabled: false });
  assert(!r.poll && r.reason === 'idle', 'idle must not poll');
});

test('night-only waiting in the daytime dead zone → skips entirely', () => {
  const r = gate({ dayEnabled: false, enabled: true, ltMins: 14 * 60 });
  assert(!r.poll && r.reason === 'night-waiting', 'night-only daytime must skip');
});

test('actively exporting → fine poll every tick', () => {
  assert(gate({ dayExporting: true }).poll === true, 'must poll while exporting');
  assert(gate({ dayCharging: true }).needFine === true, 'must fine-poll while charging');
  assert(gate({ phase: 2 }).needFine === true, 'night phase 2 export must fine-poll');
});

test('within 6 min of an export slot → fine poll', () => {
  assert(gate({ ltMins: 18 * 60 + 25 }).needFine === true, '18:25 is within 6 min of 18:30 slot');
  assert(gate({ ltMins: 18 * 60 + 15, lastLivePoll: 1000000 - 2 * 60000 }).poll === false, '18:15 is >6 min away → held (throttled)');
});

test('during an export slot → fine poll', () => {
  assert(gate({ ltMins: 18 * 60 + 40 }).needFine === true, '18:40 is inside the 18:30–19:00 slot');
});

test('near the just-in-time charge start → fine poll', () => {
  assert(gate({ dayNeedsCharge: true, dayChargeStartMins: 17 * 60, ltMins: 16 * 60 + 55 }).needFine === true, 'within 6 min of charge start');
});

test('overnight cycle window (Night armed) → fine poll', () => {
  assert(gate({ enabled: true, dayEnabled: false, ltMins: 23 * 60 + 25 }).needFine === true, '23:25 is in the cycle window');
  assert(gate({ enabled: true, dayEnabled: false, ltMins: 2 * 60 }).needFine === true, '02:00 is in the cycle window');
});

test('holding a reserve between slots → ~15-min heartbeat, not every tick', () => {
  // Just polled 2 min ago → throttled (skip). Polled 16 min ago → heartbeat fires.
  assert(gate({ lastLivePoll: 1000000 - 2 * 60000 }).poll === false, 'throttled 2 min after last poll');
  assert(gate({ lastLivePoll: 1000000 - 16 * 60000 }).poll === true, 'heartbeat fires after 15 min');
  assert(gate({ lastLivePoll: null }).poll === true, 'first-ever tick polls to seed lastLivePoll');
});

// ─────────────────────────────────────────────────────────────────────────────
// Run all tests and print summary
// ─────────────────────────────────────────────────────────────────────────────
runAll().then(() => {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('  Fix failing tests before deploying.\n');
    process.exit(1);
  } else {
    console.log('  All tests passed — safe to deploy.\n');
  }
});
