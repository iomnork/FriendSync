/**
 * Runs the REAL client script from index.html inside a vm sandbox with DOM
 * stubs, then exercises the pure logic. Tests the shipped code, not a copy.
 */
import fs from 'fs';
import vm from 'vm';

const HTML = fs.readFileSync(process.argv[2], 'utf8');
let src = HTML.match(/<script>([\s\S]*)<\/script>/)[1];

src += `
globalThis.__T = {
  parseISO, toISO, addDays, addMonths, mondayOf, nextMonday,
  slotDate, slotSegment, windowLabel, durationSummary, findBestWindows,
  esc, renderParticipants, updatePersonSelect, computeAndShow,
  heat, heatOf, paintCell, renderAvailGrid, applySlot,
  setAvailability: a => { availability = a; },
  setRoom: r => { room = r; },
  setPeople: (p, meId) => { participants = p; currentParticipantId = meId; },
  setHostView: v => { isHostView = v; },
  resetAvailability: () => { availability = {}; },
  SLOTS_PER_DAY, HOURS_DAYS
};`;

// ── Minimal DOM stub ────────────────────────────────────────────────────────
const mkEl = () => {
  const el = {
    style: {}, dataset: {}, value: '', textContent: '', innerHTML: '',
    classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    addEventListener(){}, appendChild(){}, removeChild(){}, setAttribute(){},
    select(){}, focus(){}, closest: () => mkEl(), querySelectorAll: () => [],
  };
  return el;
};
// Cache elements by id so the test can read back what the code wrote.
const byId = new Map();
const documentStub = {
  querySelectorAll: () => [], querySelector: () => null,
  getElementById: id => { if (!byId.has(id)) byId.set(id, mkEl()); return byId.get(id); },
  createElement: () => mkEl(),
  addEventListener(){}, body: mkEl(), createRange: () => ({ selectNodeContents(){} }),
};
const ctx = {
  document: documentStub,
  window: { location: { pathname: '/', origin: 'http://test' }, scrollTo(){}, getSelection: () => ({ removeAllRanges(){}, addRange(){} }), history: { replaceState(){} }, isSecureContext: false },
  localStorage: { getItem: () => null, setItem(){} },
  navigator: {},
  // Programmable via ctx.__fx: participantId -> [{ slot_index, is_available }]
  fetch: async (url) => {
    const m = String(url).match(/\/api\/participants\/(\d+)\/availability/);
    if (m) return { ok: true, status: 200, json: async () => ctx.__fx[m[1]] || [] };
    return { ok: true, status: 200, json: async () => ({}) };
  },
  setInterval: () => 0, clearInterval(){}, setTimeout: () => 0,
  console,
};
ctx.globalThis = ctx;
ctx.__fx = {};
vm.createContext(ctx);
vm.runInContext(src, ctx);
const T = ctx.__T;

// ── Tiny assert framework ───────────────────────────────────────────────────
let pass = 0; const fails = [];
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else fails.push(`${name}\n      got:  ${g}\n      want: ${w}`);
};
const section = s => console.log(`\n── ${s}`);

// ── Date primitives ─────────────────────────────────────────────────────────
section('Date primitives');
eq('parseISO/toISO round-trip', T.toISO(T.parseISO('2027-06-01')), '2027-06-01');
eq('parseISO ignores time suffix', T.toISO(T.parseISO('2027-06-01T23:00:00.000Z')), '2027-06-01');
eq('addDays across month end', T.toISO(T.addDays(T.parseISO('2027-01-31'), 1)), '2027-02-01');
eq('addDays across year end', T.toISO(T.addDays(T.parseISO('2027-12-31'), 1)), '2028-01-01');
eq('addDays leap year Feb 29', T.toISO(T.addDays(T.parseISO('2028-02-28'), 1)), '2028-02-29');
eq('addDays non-leap Feb', T.toISO(T.addDays(T.parseISO('2027-02-28'), 1)), '2027-03-01');
// UK DST: BST begins 2027-03-28, ends 2027-10-31. Calendar arithmetic must not drift.
eq('addDays over BST start', T.toISO(T.addDays(T.parseISO('2027-03-27'), 2)), '2027-03-29');
eq('addDays over BST end', T.toISO(T.addDays(T.parseISO('2027-10-30'), 2)), '2027-11-01');
eq('addDays 90 spanning DST', T.toISO(T.addDays(T.parseISO('2027-02-01'), 90)), '2027-05-02');
// addMonths must not overflow (Jan 31 + 1 month should be Feb, not Mar 3).
eq('addMonths from month-end', T.toISO(T.addMonths(T.parseISO('2027-01-31'), 1)), '2027-02-01');
eq('addMonths across year', T.toISO(T.addMonths(T.parseISO('2027-11-15'), 3)), '2028-02-01');
eq('addMonths 12', T.toISO(T.addMonths(T.parseISO('2027-01-01'), 12)), '2028-01-01');

section('Week alignment');
for (const [input, want] of [
  ['2027-06-07','2027-06-07'], // Mon -> itself
  ['2027-06-08','2027-06-07'], // Tue
  ['2027-06-13','2027-06-07'], // Sun -> previous Mon
  ['2027-06-14','2027-06-14'],
]) eq(`mondayOf(${input})`, T.toISO(T.mondayOf(T.parseISO(input))), want);

// ── slotDate per granularity ────────────────────────────────────────────────
section('slotDate');
T.setRoom({ granularity:'hours', range_start:'2027-06-07', slot_count:210, duration_slots:2 });
eq('hours slot 0', T.toISO(T.slotDate(0)), '2027-06-07');
eq('hours slot 29 (same day)', T.toISO(T.slotDate(29)), '2027-06-07');
eq('hours slot 30 (next day)', T.toISO(T.slotDate(30)), '2027-06-08');
eq('hours last slot', T.toISO(T.slotDate(209)), '2027-06-13');
eq('segment differs across days', T.slotSegment(29) !== T.slotSegment(30), true);
eq('segment same within day', T.slotSegment(0) === T.slotSegment(29), true);

T.setRoom({ granularity:'days', range_start:'2027-06-01', slot_count:122, duration_slots:10 });
eq('days slot 0', T.toISO(T.slotDate(0)), '2027-06-01');
eq('days slot 30', T.toISO(T.slotDate(30)), '2027-07-01');
eq('days last slot', T.toISO(T.slotDate(121)), '2027-09-30');
eq('days unsegmented', T.slotSegment(0) === T.slotSegment(121), true);

T.setRoom({ granularity:'weeks', range_start:'2027-06-07', slot_count:26, duration_slots:2 });
eq('weeks slot 0', T.toISO(T.slotDate(0)), '2027-06-07');
eq('weeks slot 1', T.toISO(T.slotDate(1)), '2027-06-14');
eq('weeks slot 25', T.toISO(T.slotDate(25)), '2027-11-29');

T.setRoom({ granularity:'months', range_start:'2027-01-01', slot_count:12, duration_slots:1 });
eq('months slot 0', T.toISO(T.slotDate(0)), '2027-01-01');
eq('months slot 11', T.toISO(T.slotDate(11)), '2027-12-01');

// ── Labels ──────────────────────────────────────────────────────────────────
section('Window labels');
T.setRoom({ granularity:'hours', range_start:'2027-06-07', slot_count:210, duration_slots:2 });
eq('hours 9-10am Mon', T.windowLabel(2, 2), { primary:'Mon', secondary:'9:00am – 10:00am' });
eq('hours noon boundary', T.windowLabel(8, 2), { primary:'Mon', secondary:'12:00pm – 1:00pm' });
eq('hours 8am start', T.windowLabel(0, 1), { primary:'Mon', secondary:'8:00am – 8:30am' });
eq('hours on Tue', T.windowLabel(32, 2), { primary:'Tue', secondary:'9:00am – 10:00am' });

T.setRoom({ granularity:'days', range_start:'2027-06-01', slot_count:122, duration_slots:10 });
eq('days 10-day window', T.windowLabel(9, 10), { primary:'10d', secondary:'Thu 10 Jun – Sat 19 Jun' });
eq('days single day', T.windowLabel(0, 1), { primary:'1d', secondary:'Tue 1 Jun' });
eq('days across months', T.windowLabel(25, 10), { primary:'10d', secondary:'Sat 26 Jun – Mon 5 Jul' });

T.setRoom({ granularity:'weeks', range_start:'2027-06-07', slot_count:26, duration_slots:2 });
eq('weeks 2-week window', T.windowLabel(0, 2), { primary:'2w', secondary:'w/c Mon 7 Jun – w/c Mon 14 Jun' });

T.setRoom({ granularity:'months', range_start:'2027-01-01', slot_count:12, duration_slots:1 });
eq('months single', T.windowLabel(6, 1), { primary:'1m', secondary:'Jul 2027' });
eq('months span', T.windowLabel(6, 2), { primary:'2m', secondary:'Jul 2027 – Aug 2027' });

section('Duration summary');
for (const [g, n, want] of [
  ['hours', 2, 'Looking for 60-minute slots'],
  ['hours', 1, 'Looking for 30-minute slots'],
  ['days', 10, 'Looking for 10 consecutive days'],
  ['days', 1, 'Looking for 1 consecutive day'],
  ['weeks', 2, 'Looking for 2 consecutive weeks'],
  ['months', 1, 'Looking for 1 consecutive month'],
]) { T.setRoom({ granularity:g, range_start:'2027-01-01', slot_count:400, duration_slots:n }); eq(`${g} x${n}`, T.durationSummary(), want); }

// ── Algorithm ───────────────────────────────────────────────────────────────
section('findBestWindows');
const mkFree = map => (id, i) => !!map[id]?.has(i);
const range = (a, b) => new Set(Array.from({ length: b - a + 1 }, (_, k) => a + k));

// Three people, 3-day window; only 7,8,9 shared (mirrors the live DB test).
{
  const rm = { granularity:'days', slot_count:30, duration_slots:3 };
  const people = [{id:1},{id:2},{id:3}];
  const free = mkFree({ 1: range(0,9), 2: range(5,14), 3: range(7,20) });
  const w = T.findBestWindows(rm, people, free);
  eq('best window starts at 7', w[0].startIdx, 7);
  eq('best window is unanimous', [w[0].free, w[0].total], [3, 3]);
}

// Non-overlap: a long free run must not fill the list with shifted duplicates.
{
  const rm = { granularity:'days', slot_count:30, duration_slots:3 };
  const people = [{id:1}];
  const w = T.findBestWindows(rm, people, mkFree({ 1: range(0,11) }));
  eq('non-overlapping starts', w.map(x => x.startIdx), [0, 3, 6, 9]);
}

// A run shorter than the duration yields nothing.
{
  const rm = { granularity:'days', slot_count:30, duration_slots:5 };
  const w = T.findBestWindows(rm, [{id:1}], mkFree({ 1: range(0,3) }));
  eq('too-short run rejected', w.length, 0);
}

// Hours mode must not span the overnight gap between days.
{
  const rm = { granularity:'hours', slot_count:210, duration_slots:4 };
  // Free the last 2 slots of Mon and first 2 of Tue — contiguous by index only.
  const w = T.findBestWindows(rm, [{id:1}], mkFree({ 1: range(28, 31) }));
  eq('no window across the 11pm->8am gap', w.length, 0);
}

// Days mode SHOULD span a month boundary (no segmentation).
{
  const rm = { granularity:'days', slot_count:60, duration_slots:4 };
  const w = T.findBestWindows(rm, [{id:1}], mkFree({ 1: range(28, 31) }));
  eq('days window spans month boundary', w[0]?.startIdx, 28);
}

// Travel buffer: 30 min = 1 slot either side, so a 1h meeting needs 4 free slots.
{
  const rm = { granularity:'hours', slot_count:210, duration_slots:2 };
  const people = [{ id:1, travel_buffer_minutes:30 }];
  eq('buffer: exactly the window is not enough',
     T.findBestWindows(rm, people, mkFree({ 1: range(10, 11) })).length, 0);
  const w = T.findBestWindows(rm, people, mkFree({ 1: range(9, 12) }));
  eq('buffer: window + 1 slot each side works', w[0]?.startIdx, 10);
}

// Buffer must not silently reach past the start of the day.
{
  const rm = { granularity:'hours', slot_count:210, duration_slots:2 };
  const people = [{ id:1, travel_buffer_minutes:30 }];
  eq('buffer cannot run off the start of a day',
     T.findBestWindows(rm, people, mkFree({ 1: range(0, 3) })).map(x => x.startIdx), [1]);
}

// Ranking: a window everyone shares must outrank a longer one fewer people share.
{
  const rm = { granularity:'days', slot_count:40, duration_slots:2 };
  const people = [{id:1},{id:2},{id:3}];
  const free = mkFree({ 1: range(20,21), 2: range(20,21), 3: new Set([...range(0,9), ...range(20,21)]) });
  const w = T.findBestWindows(rm, people, free);
  eq('unanimous window ranked first', [w[0].startIdx, w[0].free], [20, 3]);
}

// Nobody free -> no windows.
eq('empty availability', T.findBestWindows({granularity:'days',slot_count:30,duration_slots:2}, [{id:1}], () => false).length, 0);

// ── XSS regression ──────────────────────────────────────────────────────────
// Participant names are attacker-chosen: anyone with the room link picks their
// own. They must never reach innerHTML unescaped.
section('XSS escaping');
const PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '"><svg onload=alert(1)>',
  "'; alert(1); //",
];
eq('esc neutralises angle brackets', T.esc('<b>'), '&lt;b&gt;');
eq('esc neutralises quotes', T.esc(`"'`), '&quot;&#39;');
eq('esc handles null', T.esc(null), '');
eq('esc escapes ampersand first', T.esc('&lt;'), '&amp;lt;');

for (const payload of PAYLOADS) {
  T.setPeople([{ id: 1, name: payload, travel_buffer_minutes: 0 }], 1);

  T.renderParticipants();
  const list = byId.get('participant-list').innerHTML;
  eq(`participant list escapes ${payload.slice(0, 18)}`, /<img|<script|<svg/i.test(list), false);

  T.setHostView(true);
  T.updatePersonSelect();
  const sel = byId.get('person-select').innerHTML;
  eq(`host dropdown escapes ${payload.slice(0, 18)}`, /<img|<script|<svg/i.test(sel), false);

  T.setHostView(false);
  T.updatePersonSelect();
  const gsel = byId.get('person-select').innerHTML;
  eq(`guest dropdown escapes ${payload.slice(0, 18)}`, /<img|<script|<svg/i.test(gsel), false);
}

// ── computeAndShow integration ──────────────────────────────────────────────
// Unit-testing findBestWindows and windowLabel separately once let a
// ReferenceError in the function that joins them ship undetected: the results
// pane hung on "Finding best windows…" in every granularity. These drive the
// whole render path so that class of bug fails here instead.
section('computeAndShow end-to-end');

const rows = (...idx) => idx.map(i => ({ slot_index: i, is_available: true }));

for (const [name, rm, fx] of [
  ['hours',  { granularity:'hours',  range_start:'2026-07-27', slot_count:210, duration_slots:2 },
             { 1: rows(2,3,4,5), 2: rows(2,3,4,5) }],
  ['days',   { granularity:'days',   range_start:'2027-06-01', slot_count:30,  duration_slots:3 },
             { 1: rows(5,6,7,8), 2: rows(6,7,8,9) }],
  ['weeks',  { granularity:'weeks',  range_start:'2026-12-28', slot_count:52,  duration_slots:2 },
             { 1: rows(3,4,5),   2: rows(4,5,6) }],
  ['months', { granularity:'months', range_start:'2027-01-01', slot_count:12,  duration_slots:1 },
             { 1: rows(6,7),     2: rows(6,7) }],
]) {
  T.resetAvailability();
  T.setRoom(rm);
  T.setPeople([{ id:1, name:'A', travel_buffer_minutes:0 }, { id:2, name:'B', travel_buffer_minutes:0 }], 1);
  ctx.__fx = fx;

  let threw = null;
  try { await T.computeAndShow(false); } catch (e) { threw = e.message; }
  const html = byId.get('results-container').innerHTML;

  eq(`${name}: no exception`, threw, null);
  eq(`${name}: spinner cleared`, /Finding best windows/.test(html), false);
  eq(`${name}: rendered a result row`, /result-item/.test(html), true);
  eq(`${name}: label is populated`, /result-time">[^<]+</.test(html), true);
  eq(`${name}: no literal undefined in output`, /undefined/.test(html), false);
}

// Empty-state paths must also clear the spinner.
{
  T.resetAvailability();
  T.setRoom({ granularity:'days', range_start:'2027-06-01', slot_count:30, duration_slots:3 });
  T.setPeople([{ id:1, name:'A', travel_buffer_minutes:0 }], 1);
  ctx.__fx = { 1: [] };
  await T.computeAndShow(false);
  const html = byId.get('results-container').innerHTML;
  eq('no availability: spinner cleared', /Finding best windows/.test(html), false);

  ctx.__fx = { 1: rows(0, 1) };  // only 2 slots, needs 3
  T.resetAvailability();
  await T.computeAndShow(false);
  const html2 = byId.get('results-container').innerHTML;
  eq('no window fits: spinner cleared', /Finding best windows/.test(html2), false);
  eq('no window fits: explains the duration', /3 consecutive days/.test(html2), true);
}

// ── Heatmap ─────────────────────────────────────────────────────────────────
section('Availability heatmap');
{
  const alphaOf = s => { const m = s.match(/rgba\(29,158,117,([\d.]+)\)/); return m ? parseFloat(m[1]) : null; };
  const cellFor = (html, i) => (html.match(new RegExp(`<div[^>]*data-slot="${i}"[^>]*>`)) || [''])[0];

  T.setRoom({ granularity: 'days', range_start: '2027-06-01', slot_count: 10, duration_slots: 1 });
  T.setPeople([{ id:1, name:'Me' }, { id:2, name:'B' }, { id:3, name:'C' }], 1);
  // slot 3: both others free · slot 5: one other · slot 7: only me · slot 0: nobody
  T.setAvailability({ '2-3': true, '3-3': true, '2-5': true, '1-7': true });

  eq('heat: nobody free -> no tint', T.heat(0, 1), '');
  eq('heat: my own slot ignores me', T.heat(7, 1), '');
  // Scale: 2% opacity per 10% of others, capped at 20%.
  const a1 = alphaOf(T.heat(5, 1)), a2 = alphaOf(T.heat(3, 1));
  eq('heat: 1-of-2 others -> 10%', a1, 0.10);
  eq('heat: 2-of-2 others -> 20%', a2, 0.20);
  eq('heat: never exceeds 20%', a2 <= 0.20, true);
  eq('heat: tooltip counts others', /title="1 of 2 others free"/.test(T.heat(5, 1)), true);

  // Quantisation and the floor, across group sizes.
  {
    const people = n => [{ id: 1, name: 'Me' }, ...Array.from({ length: n }, (_, k) => ({ id: k + 2, name: 'P' + k }))];
    const freeFor = n => Object.fromEntries(Array.from({ length: n }, (_, k) => [`${k + 2}-0`, true]));

    T.setPeople(people(10), 1); T.setAvailability(freeFor(5));
    eq('heat: 5 of 10 others -> 10%', alphaOf(T.heat(0, 1)), 0.10);

    T.setPeople(people(10), 1); T.setAvailability(freeFor(10));
    eq('heat: 10 of 10 others -> 20%', alphaOf(T.heat(0, 1)), 0.20);

    T.setPeople(people(10), 1); T.setAvailability(freeFor(1));
    eq('heat: 1 of 10 others -> 2%', alphaOf(T.heat(0, 1)), 0.02);

    // A lone voice in a big group would round to zero; floored so it still shows.
    T.setPeople(people(40), 1); T.setAvailability(freeFor(1));
    eq('heat: 1 of 40 others floors at 2%', alphaOf(T.heat(0, 1)), 0.02);
  }

  T.setPeople([{ id:1, name:'Me' }, { id:2, name:'B' }, { id:3, name:'C' }], 1);
  T.setAvailability({ '2-3': true, '3-3': true, '2-5': true, '1-7': true });

  byId.get('person-select').value = '1';
  T.setHostView(false);
  T.renderAvailGrid();
  const html = byId.get('grid-mount').innerHTML;

  eq('grid: others-free cell is tinted', alphaOf(cellFor(html, 3)) > 0, true);
  eq('grid: empty cell has no tint', alphaOf(cellFor(html, 0)), null);
  // My own picks must stay solid green — an inline tint would override .free.
  eq('grid: my own cell has class free', /\bfree\b/.test(cellFor(html, 7)), true);
  eq('grid: my own cell has no inline tint', alphaOf(cellFor(html, 7)), null);

  // Solo room: nothing to compare against, so no tint anywhere.
  T.setPeople([{ id:1, name:'Me' }], 1);
  eq('heat: solo room has no heat', T.heat(3, 1), '');
}

// The tint is an inline style, so it outranks the .free class rule. If
// selecting a tinted cell does not strip it, your own pick keeps looking like
// someone else's until the next poll rebuilds the grid — which read as a
// multi-second lag before the click registered.
section('Selecting clears the heat tint');
{
  const mkCell = () => ({
    style: {}, _attrs: {},
    classList: { _s: new Set(), add(c){this._s.add(c)}, remove(c){this._s.delete(c)},
                 toggle(c,v){ v ? this._s.add(c) : this._s.delete(c) }, contains(c){return this._s.has(c)} },
    removeAttribute(a){ delete this._attrs[a]; this.title = undefined; },
  });

  T.setRoom({ granularity:'days', range_start:'2027-06-01', slot_count:10, duration_slots:1 });
  T.setPeople([{ id:1, name:'Me' }, { id:2, name:'B' }], 1);
  T.setAvailability({ '2-3': true });   // other person free at slot 3, I am not

  const cell = mkCell();

  // Unselected + someone else free -> tinted.
  T.paintCell(cell, 3, 1);
  eq('tinted before selecting', /rgba\(29,158,117/.test(cell.style.background), true);
  eq('tooltip present before selecting', typeof cell.title === 'string' && cell.title.length > 0, true);

  // Now I select it: the inline tint must go, or .free cannot show through.
  T.setAvailability({ '2-3': true, '1-3': true });
  T.paintCell(cell, 3, 1);
  eq('tint cleared once selected', cell.style.background, '');
  eq('tooltip cleared once selected', cell.title, undefined);

  // Deselecting restores the tint.
  T.setAvailability({ '2-3': true });
  T.paintCell(cell, 3, 1);
  eq('tint restored after deselecting', /rgba\(29,158,117/.test(cell.style.background), true);

  // A slot nobody else wants never gets a tint.
  T.paintCell(cell, 9, 1);
  eq('no tint where nobody is free', cell.style.background, '');
}

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (fails.length) {
  console.log(`FAILED ${fails.length}  |  passed ${pass}\n`);
  fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
} else {
  console.log(`All ${pass} assertions passed.`);
}
