/**
 * Public holiday data for the UK nations and the Isle of Man.
 *
 * England & Wales, Scotland and Northern Ireland come from the official
 * gov.uk feed, fetched by the server (never by the user's browser) and cached
 * to disk so the app keeps working offline and does not hammer gov.uk.
 *
 * The Isle of Man publishes no machine-readable feed, so its holidays are
 * computed here. Most are reliably derivable; TT Senior Race Day is not — see
 * the note on it below.
 */

const fs = require('fs');
const path = require('path');

const GOV_UK_URL = 'https://www.gov.uk/bank-holidays.json';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'bank-holidays.json');
const REFRESH_MS = 7 * 24 * 60 * 60 * 1000; // weekly

const UK_REGIONS = ['england-and-wales', 'scotland', 'northern-ireland'];
const REGIONS = [...UK_REGIONS, 'isle-of-man'];

const REGION_LABELS = {
  'england-and-wales': 'England & Wales',
  'scotland': 'Scotland',
  'northern-ireland': 'Northern Ireland',
  'isle-of-man': 'Isle of Man',
};

// ── Date helpers (UTC throughout; these are calendar dates, not instants) ────

const iso = d => d.toISOString().slice(0, 10);
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

/**
 * Easter Sunday, Meeus/Jones/Butcher Gregorian algorithm.
 * Cross-checked against gov.uk's Good Friday / Easter Monday for 2019-2028
 * in test/holidays.test.mjs — that feed is the authority, this is only used
 * for the Isle of Man, which has none.
 */
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(year, month, day);
}

/** nth weekday of a month. n = 1 for first, -1 for last. weekday: 0=Sun. */
function nthWeekday(year, month, weekday, n) {
  if (n > 0) {
    const first = utc(year, month, 1);
    const shift = (weekday - first.getUTCDay() + 7) % 7;
    return addDays(first, shift + (n - 1) * 7);
  }
  const last = utc(year, month + 1, 0); // day 0 of next month = last of this
  const shift = (last.getUTCDay() - weekday + 7) % 7;
  return addDays(last, -shift);
}

/** Weekend holidays roll to the next working day (the "substitute day"). */
function substitute(d) {
  const day = d.getUTCDay();
  if (day === 6) return addDays(d, 2); // Sat -> Mon
  if (day === 0) return addDays(d, 1); // Sun -> Mon
  return d;
}

// ── Isle of Man ─────────────────────────────────────────────────────────────

function isleOfManHolidays(year) {
  const easter = easterSunday(year);

  // Already tied to a weekday by their own rule — these never move.
  const pinned = [
    { date: addDays(easter, -2), title: 'Good Friday' },
    { date: addDays(easter, 1), title: 'Easter Monday' },
    { date: nthWeekday(year, 5, 1, 1), title: 'Early May Bank Holiday' },
    { date: nthWeekday(year, 5, 1, -1), title: 'Spring Bank Holiday' },
    // TT Senior Race Day follows the annual TT schedule and is not derivable
    // from the calendar. The first Friday in June is the usual shape, but it
    // moves and can be postponed for weather. Flagged so the UI can show it as
    // provisional rather than assert a date it cannot know.
    { date: nthWeekday(year, 6, 5, 1), title: 'TT Senior Race Day', approximate: true },
    { date: nthWeekday(year, 8, 1, -1), title: 'Late Summer Bank Holiday' },
  ];

  // Fixed calendar dates, which substitute forward if they land on a weekend.
  const fixed = [
    { date: utc(year, 1, 1), title: "New Year's Day" },
    { date: utc(year, 7, 5), title: 'Tynwald Day' },
    { date: utc(year, 12, 25), title: 'Christmas Day' },
    { date: utc(year, 12, 26), title: 'Boxing Day' },
  ];

  const out = [...pinned];
  const taken = new Set(pinned.map(h => iso(h.date)));

  // Two passes, and the order matters. Anything already on a weekday claims its
  // own date first; only then do the weekend ones substitute into the next free
  // working day. Doing it in plain date order gets Christmas wrong whenever it
  // falls on a Sunday: in 2022 Boxing Day keeps Mon 26 and Christmas takes
  // Tue 27, whereas in 2027 (Christmas on a Saturday) Christmas takes Mon 27
  // and Boxing Day is pushed to Tue 28.
  const isWeekend = d => d.getUTCDay() === 0 || d.getUTCDay() === 6;

  for (const h of fixed) {
    if (isWeekend(h.date) || taken.has(iso(h.date))) continue;
    taken.add(iso(h.date));
    out.push({ date: h.date, title: h.title });
  }

  for (const h of fixed.slice().sort((a, b) => a.date - b.date)) {
    if (out.some(o => o.title === h.title)) continue;
    let d = substitute(h.date);
    while (isWeekend(d) || taken.has(iso(d))) d = addDays(d, 1);
    taken.add(iso(d));
    out.push({ date: d, title: h.title });
  }

  return out
    .map(h => ({ date: iso(h.date), title: h.title, ...(h.approximate && { approximate: true }) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── gov.uk feed, cached to disk ─────────────────────────────────────────────

let cache = null;      // { 'england-and-wales': [{date,title}], ... }
let lastFetch = 0;

function readDiskCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeDiskCache(data) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
  } catch (e) {
    console.error('Could not write holiday cache:', e.message);
  }
}

async function fetchGovUk() {
  const res = await fetch(GOV_UK_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`gov.uk returned ${res.status}`);
  const raw = await res.json();

  const out = {};
  for (const region of UK_REGIONS) {
    if (!raw[region]?.events) throw new Error(`gov.uk feed missing "${region}"`);
    out[region] = raw[region].events.map(e => ({ date: e.date, title: e.title }));
  }
  return out;
}

/** Refresh from gov.uk, falling back to whatever we already have. */
async function refresh() {
  if (Date.now() - lastFetch < REFRESH_MS && cache) return cache;
  try {
    cache = await fetchGovUk();
    lastFetch = Date.now();
    writeDiskCache(cache);
    console.log('Holiday data refreshed from gov.uk');
  } catch (e) {
    // Never fail hard: stale data beats no data, and the Isle of Man is
    // computed locally so it works regardless.
    if (!cache) cache = readDiskCache();
    console.error('Holiday refresh failed (using cache):', e.message);
  }
  return cache;
}

/**
 * Holidays for a region within [from, to], inclusive. `region` may be a single
 * region, or 'all' for every region — in which case entries carry a `regions`
 * array, and identical dates shared across regions are merged.
 */
async function getHolidays(region, from, to) {
  await refresh();

  const years = [];
  for (let y = +from.slice(0, 4); y <= +to.slice(0, 4); y++) years.push(y);

  const wanted = region === 'all' ? REGIONS : [region];
  const merged = new Map(); // "date|title" -> entry

  for (const r of wanted) {
    const list = r === 'isle-of-man'
      ? years.flatMap(isleOfManHolidays)
      : (cache?.[r] || []);

    for (const h of list) {
      if (h.date < from || h.date > to) continue;
      const key = `${h.date}|${h.title}`;
      if (merged.has(key)) {
        merged.get(key).regions.push(r);
      } else {
        merged.set(key, {
          date: h.date,
          title: h.title,
          regions: [r],
          ...(h.approximate && { approximate: true }),
        });
      }
    }
  }

  return [...merged.values()].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

module.exports = { getHolidays, isleOfManHolidays, easterSunday, nthWeekday, substitute, refresh, REGIONS, REGION_LABELS };
