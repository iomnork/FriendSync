/**
 * Validates the holiday maths against the official gov.uk feed.
 *
 * The Isle of Man has no machine-readable source, so its dates are computed.
 * Those same rules (Easter, nth-weekday, weekend substitution) also drive the
 * UK nations in the gov.uk feed — so the feed is a free oracle: if our
 * calculations reproduce gov.uk's published dates for 2019-2028, they can be
 * trusted for the Isle of Man too.
 *
 * Needs network access. Run: node test/holidays.test.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const H = require('../server/holidays.js');

let pass = 0; const fails = [];
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else fails.push(`${name}\n      got:  ${g}\n      want: ${w}`);
};
const section = s => console.log(`\n-- ${s}`);

const iso = d => d.toISOString().slice(0, 10);

console.log('Fetching gov.uk feed...');
const feed = await (await fetch('https://www.gov.uk/bank-holidays.json')).json();
const ew = feed['england-and-wales'].events;
const years = [...new Set(ew.map(e => e.date.slice(0, 4)))].map(Number).sort();
console.log(`Validating against ${ew.length} official events, ${years[0]}-${years.at(-1)}`);

const official = (year, title) => ew.find(e => e.date.startsWith(String(year)) && e.title === title)?.date;

// ── Easter ──────────────────────────────────────────────────────────────────
// Good Friday is Easter - 2, Easter Monday is Easter + 1. If our Easter is
// right, both must line up with gov.uk for every year in the feed.
section('Easter (vs gov.uk Good Friday / Easter Monday)');
for (const y of years) {
  const easter = H.easterSunday(y);
  const gf = official(y, 'Good Friday');
  const em = official(y, 'Easter Monday');
  if (gf) eq(`${y} Good Friday`, iso(new Date(easter.getTime() - 2 * 86400000)), gf);
  if (em) eq(`${y} Easter Monday`, iso(new Date(easter.getTime() + 1 * 86400000)), em);
}

// ── nth weekday ─────────────────────────────────────────────────────────────
// Legislated one-offs, where Parliament moved or added a day. These are not
// calendar rules and no algorithm can derive them — the rule is right and the
// year is the exception.
//   2022: Spring bank holiday moved 30 May -> 2 June for the Platinum Jubilee
//         (with an extra day on 3 June).
const LEGISLATED_EXCEPTIONS = { 2022: ['Spring bank holiday'] };
const isException = (y, title) => (LEGISLATED_EXCEPTIONS[y] || []).includes(title);

section('nth-weekday rules (vs gov.uk)');
let skipped = 0;
for (const y of years) {
  const checks = [
    ['Early May bank holiday', () => H.nthWeekday(y, 5, 1, 1), 'first Monday in May'],
    ['Spring bank holiday', () => H.nthWeekday(y, 5, 1, -1), 'last Monday in May'],
    ['Summer bank holiday', () => H.nthWeekday(y, 8, 1, -1), 'last Monday in August'],
  ];
  for (const [title, calc, label] of checks) {
    const actual = official(y, title);
    if (!actual) continue;
    if (isException(y, title)) { skipped++; continue; }
    eq(`${y} ${label}`, iso(calc()), actual);
  }
}
if (skipped) console.log(`   (${skipped} legislated exception(s) skipped — see LEGISLATED_EXCEPTIONS)`);

// ── Weekend substitution ────────────────────────────────────────────────────
// The interesting years are those where 25/26 Dec land on a weekend and both
// substitute forward — gov.uk pushes Boxing Day on so the pair never collide.
section('Weekend substitution (vs gov.uk Christmas / Boxing Day)');
for (const y of years) {
  const iom = H.isleOfManHolidays(y);
  const mine = t => iom.find(h => h.title === t)?.date;
  const xmas = official(y, 'Christmas Day');
  const boxing = official(y, 'Boxing Day');
  if (xmas) eq(`${y} Christmas Day`, mine('Christmas Day'), xmas);
  if (boxing) eq(`${y} Boxing Day`, mine('Boxing Day'), boxing);
}

section('Substitution rules in isolation');
const d = (y, m, day) => new Date(Date.UTC(y, m - 1, day));
eq('Saturday rolls to Monday', iso(H.substitute(d(2027, 12, 25))), '2027-12-27'); // Sat
eq('Sunday rolls to Monday', iso(H.substitute(d(2027, 12, 26))), '2027-12-27');   // Sun
eq('Weekday is untouched', iso(H.substitute(d(2026, 12, 25))), '2026-12-25');     // Fri

// ── Isle of Man ─────────────────────────────────────────────────────────────
section('Isle of Man');
{
  const h2027 = H.isleOfManHolidays(2027);
  const titles = h2027.map(x => x.title);

  eq('has 10 holidays', h2027.length, 10);
  eq('includes Tynwald Day', titles.includes('Tynwald Day'), true);
  eq('includes TT Senior Race Day', titles.includes('TT Senior Race Day'), true);

  // Tynwald Day is 5 July; 2027-07-05 is a Monday so it should not move.
  eq('Tynwald Day 2027', h2027.find(x => x.title === 'Tynwald Day').date, '2027-07-05');
  // 2026-07-05 is a Sunday, so it substitutes to the Monday.
  eq('Tynwald Day 2026 substitutes',
     H.isleOfManHolidays(2026).find(x => x.title === 'Tynwald Day').date, '2026-07-06');

  // TT is schedule-dependent and must be flagged, not asserted as fact.
  eq('TT is marked approximate',
     h2027.find(x => x.title === 'TT Senior Race Day').approximate, true);
  eq('nothing else is marked approximate',
     h2027.filter(x => x.approximate).length, 1);

  eq('dates are sorted', h2027.map(x => x.date), [...h2027.map(x => x.date)].sort());
  eq('no duplicate dates', new Set(h2027.map(x => x.date)).size, 10);

  // Shared holidays must use gov.uk's exact wording, or the "all" view renders
  // the same day off twice — once per naming convention.
  eq('shared August holiday matches gov.uk wording',
     titles.includes('Summer bank holiday'), true);
  eq('shared May holidays match gov.uk wording',
     titles.filter(t => t === 'Early May bank holiday' || t === 'Spring bank holiday').length, 2);
  eq('New Year uses gov.uk’s curly apostrophe',
     titles.includes('New Year’s Day'), true);
}

section('Cross-region merging');
{
  // 30 Aug 2027 is the last Monday in August: a holiday in E&W, NI and IoM.
  // It must appear ONCE, credited to all three, not once per naming style.
  const aug = await H.getHolidays('all', '2027-08-30', '2027-08-30');
  eq('last Monday in August is a single entry', aug.length, 1);
  eq('credited to E&W, NI and IoM',
     aug[0].regions.slice().sort(), ['england-and-wales', 'isle-of-man', 'northern-ireland']);
  eq('Scotland excluded (its summer holiday is in early August)',
     aug[0].regions.includes('scotland'), false);

  // Scotland's really is a different date.
  const scotAug = await H.getHolidays('scotland', '2027-08-01', '2027-08-31');
  eq('Scotland summer holiday is early August', scotAug[0].date, '2027-08-02');

  // No date in a whole year should carry duplicate titles once normalised.
  const all2027 = await H.getHolidays('all', '2027-01-01', '2027-12-31');
  const seen = new Set();
  const dupes = all2027.filter(h => {
    const k = `${h.date}|${h.title.toLowerCase().replace(/[‘’]/g, "'")}`;
    if (seen.has(k)) return true;
    seen.add(k);
    return false;
  });
  eq('no duplicate date+title across 2027', dupes.map(d => `${d.date} ${d.title}`), []);
}

// ── Range query ─────────────────────────────────────────────────────────────
section('getHolidays()');
{
  const jul = await H.getHolidays('isle-of-man', '2027-07-01', '2027-07-31');
  eq('July 2027 IoM returns Tynwald Day only', jul.map(h => h.title), ['Tynwald Day']);

  const none = await H.getHolidays('isle-of-man', '2027-02-01', '2027-02-28');
  eq('February 2027 has no IoM holidays', none.length, 0);

  const all = await H.getHolidays('all', '2027-12-25', '2027-12-28');
  const xmas = all.find(h => h.title === 'Christmas Day');
  eq('"all" merges shared dates across regions', xmas.regions.length >= 3, true);
  eq('"all" includes Isle of Man', all.some(h => h.regions.includes('isle-of-man')), true);

  const ewOnly = await H.getHolidays('england-and-wales', '2027-01-01', '2027-12-31');
  eq('E&W has no Tynwald Day', ewOnly.some(h => h.title === 'Tynwald Day'), false);
  eq('E&W comes from the live feed', ewOnly.length, 8);

  // Scotland genuinely differs — 2 January and a different summer holiday.
  const scot = await H.getHolidays('scotland', '2027-01-01', '2027-01-05');
  eq('Scotland has 2 January', scot.some(h => h.date === '2027-01-04' || h.date === '2027-01-02'), true);
}

console.log(`\n${'='.repeat(60)}`);
if (fails.length) {
  console.log(`FAILED ${fails.length} | passed ${pass}\n`);
  fails.forEach(f => console.log('  x ' + f));
  // exitCode rather than exit(): lets Node drain the fetch keep-alive socket
  // instead of tearing down mid-flight and tripping a libuv assertion.
  process.exitCode = 1;
} else {
  console.log(`All ${pass} assertions passed.`);
}
