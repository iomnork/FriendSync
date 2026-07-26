const B = 'http://localhost:3000';
let pass = 0; const fails = [];
const check = (name, cond, detail = '') => cond ? pass++ : fails.push(`${name}${detail ? '  [' + detail + ']' : ''}`);

async function req(method, path, body) {
  const r = await fetch(B + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
const S = (n, r, want) => check(n, r.status === want, `got ${r.status}${r.body && r.body.error ? ': ' + r.body.error : ''}`);

const V = { name: 'QA', emoji: '🧪', granularity: 'days', rangeStart: '2027-06-01', slotCount: 30, durationSlots: 3, expiryDays: 1 };

console.log('\n-- Room creation validation');
const good = await req('POST', '/api/rooms', V);
S('valid room -> 200', good, 200);
const CODE = good.body.code;

S('bad granularity -> 400', await req('POST', '/api/rooms', { ...V, granularity: 'fortnights' }), 400);
S('missing granularity -> 400', await req('POST', '/api/rooms', { ...V, granularity: undefined }), 400);
S('bad date format -> 400', await req('POST', '/api/rooms', { ...V, rangeStart: '01/06/2027' }), 400);
S('empty date -> 400', await req('POST', '/api/rooms', { ...V, rangeStart: '' }), 400);
S('slotCount 0 -> 400', await req('POST', '/api/rooms', { ...V, slotCount: 0 }), 400);
S('slotCount negative -> 400', await req('POST', '/api/rooms', { ...V, slotCount: -5 }), 400);
S('slotCount 5000 -> 400', await req('POST', '/api/rooms', { ...V, slotCount: 5000 }), 400);
S('slotCount float -> 400', await req('POST', '/api/rooms', { ...V, slotCount: 30.5 }), 400);
S('duration > range -> 400', await req('POST', '/api/rooms', { ...V, durationSlots: 99 }), 400);
S('duration 0 -> 400', await req('POST', '/api/rooms', { ...V, durationSlots: 0 }), 400);
S('missing name -> 400', await req('POST', '/api/rooms', { ...V, name: '' }), 400);
S('whitespace name -> 400', await req('POST', '/api/rooms', { ...V, name: '   ' }), 400);
// Emoji is decoration, not information — a room without one is valid.
S('missing emoji -> 200', await req('POST', '/api/rooms', { ...V, emoji: undefined }), 200);
S('null emoji -> 200', await req('POST', '/api/rooms', { ...V, emoji: null }), 200);
S('over-long emoji -> 400', await req('POST', '/api/rooms', { ...V, emoji: '🎉'.repeat(20) }), 400);
S('empty body -> 400', await req('POST', '/api/rooms', {}), 400);

console.log('-- Room lookup');
S('lowercase code works', await req('GET', `/api/rooms/${CODE.toLowerCase()}`), 200);
S('nonexistent code -> 404', await req('GET', '/api/rooms/ZZZZZZ'), 404);
S('short code -> 404', await req('GET', '/api/rooms/AB'), 404);
S('SQL injection in code -> 404', await req('GET', '/api/rooms/' + encodeURIComponent("' OR '1'='1")), 404);

console.log('-- Join validation');
S('valid join -> 200', await req('POST', `/api/rooms/${CODE}/join`, { name: 'Alice' }), 200);
S('duplicate name -> 409', await req('POST', `/api/rooms/${CODE}/join`, { name: 'Alice' }), 409);
S('empty name -> 400', await req('POST', `/api/rooms/${CODE}/join`, { name: '' }), 400);
S('whitespace name -> 400', await req('POST', `/api/rooms/${CODE}/join`, { name: '   ' }), 400);
S('missing name -> 400', await req('POST', `/api/rooms/${CODE}/join`, {}), 400);
S('300-char name -> 400', await req('POST', `/api/rooms/${CODE}/join`, { name: 'x'.repeat(300) }), 400);
S('unicode name ok', await req('POST', `/api/rooms/${CODE}/join`, { name: 'Zoe 日本 🎉' }), 200);
S('join nonexistent room -> 404', await req('POST', '/api/rooms/ZZZZZZ/join', { name: 'Bob' }), 404);

S('SQL injection name accepted', await req('POST', `/api/rooms/${CODE}/join`, { name: "Robert'); DROP TABLE participants;--" }), 200);
const survived = await req('GET', `/api/rooms/${CODE}`);
check('participants table survived injection', Array.isArray(survived.body && survived.body.participants));

// XSS probe: does the API accept and store a script payload verbatim?
const XSS = '<img src=x onerror=alert(1)>';
S('XSS payload accepted by API', await req('POST', `/api/rooms/${CODE}/join`, { name: XSS }), 200);
const after = await req('GET', `/api/rooms/${CODE}`);
const stored = after.body.participants.find(p => p.name.includes('<img'));
check('XSS payload stored unescaped', !!stored, stored ? stored.name : 'not found');

const alice = after.body.participants.find(p => p.name === 'Alice');

console.log('-- Availability validation');
S('valid slot -> 200', await req('POST', '/api/availability', { participantId: alice.id, slotIndex: 0, isAvailable: true }), 200);
S('upper bound slot -> 200', await req('POST', '/api/availability', { participantId: alice.id, slotIndex: 29, isAvailable: true }), 200);
S('slot past range -> 400', await req('POST', '/api/availability', { participantId: alice.id, slotIndex: 30, isAvailable: true }), 400);
S('negative slot -> 400', await req('POST', '/api/availability', { participantId: alice.id, slotIndex: -1, isAvailable: true }), 400);
S('float slot -> 400', await req('POST', '/api/availability', { participantId: alice.id, slotIndex: 1.5, isAvailable: true }), 400);
S('string isAvailable -> 400', await req('POST', '/api/availability', { participantId: alice.id, slotIndex: 1, isAvailable: 'yes' }), 400);
S('nonexistent participant -> 404', await req('POST', '/api/availability', { participantId: 999999, slotIndex: 1, isAvailable: true }), 404);

console.log('-- Bulk endpoint');
S('empty array -> 200', await req('POST', '/api/availability/bulk', { participantId: alice.id, slots: [] }), 200);
S('valid batch -> 200', await req('POST', '/api/availability/bulk', { participantId: alice.id, slots: [{ slotIndex: 5, isAvailable: true }, { slotIndex: 6, isAvailable: true }] }), 200);
S('non-array slots -> 400', await req('POST', '/api/availability/bulk', { participantId: alice.id, slots: 'nope' }), 400);
S('>2000 slots -> 400', await req('POST', '/api/availability/bulk', { participantId: alice.id, slots: Array.from({ length: 2001 }, () => ({ slotIndex: 0, isAvailable: true })) }), 400);
S('batch w/ out-of-range -> 400', await req('POST', '/api/availability/bulk', { participantId: alice.id, slots: [{ slotIndex: 1, isAvailable: true }, { slotIndex: 99, isAvailable: true }] }), 400);
const av = await req('GET', `/api/participants/${alice.id}/availability`);
check('rejected batch wrote nothing', !av.body.some(r => r.slot_index === 99));

console.log('-- Travel buffer');
S('valid buffer -> 200', await req('POST', `/api/participants/${alice.id}/travel-buffer`, { travelBuffer: 30 }), 200);
S('buffer 0 -> 200', await req('POST', `/api/participants/${alice.id}/travel-buffer`, { travelBuffer: 0 }), 200);
S('buffer 999 -> 400', await req('POST', `/api/participants/${alice.id}/travel-buffer`, { travelBuffer: 999 }), 400);
S('buffer negative -> 400', await req('POST', `/api/participants/${alice.id}/travel-buffer`, { travelBuffer: -10 }), 400);
S('buffer string -> 400', await req('POST', `/api/participants/${alice.id}/travel-buffer`, { travelBuffer: '30' }), 400);
S('buffer nonexistent -> 404', await req('POST', '/api/participants/999999/travel-buffer', { travelBuffer: 30 }), 404);

console.log('-- Rate limiting');
{
  // Verified by watching the budget decrement rather than by exhausting it:
  // the limits are deliberately set above anything a test run should hit, and
  // burning an hour-long budget here would break every later assertion.
  const r1 = await fetch(`${B}/api/health`);
  const r2 = await fetch(`${B}/api/health`);
  const lim = r1.headers.get('ratelimit-limit');
  const rem1 = Number(r1.headers.get('ratelimit-remaining'));
  const rem2 = Number(r2.headers.get('ratelimit-remaining'));

  check('RateLimit-Limit header present', !!lim, `got ${lim}`);
  check('RateLimit-Remaining decrements', rem2 === rem1 - 1, `${rem1} then ${rem2}`);
  check('RateLimit-Reset present', !!r1.headers.get('ratelimit-reset'));

  // Writes carry their own tighter budget than the blanket /api one.
  const w = await fetch(`${B}/api/availability`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ participantId: 1, slotIndex: 0, isAvailable: true })
  });
  check('write endpoints have a separate budget',
    Number(w.headers.get('ratelimit-limit')) < Number(lim),
    `write=${w.headers.get('ratelimit-limit')} api=${lim}`);

  // Distinct client IPs must not share a bucket, or one busy visitor locks out
  // everyone behind the tunnel.
  const a = await fetch(`${B}/api/health`, { headers: { 'CF-Connecting-IP': '203.0.113.7' } });
  const b = await fetch(`${B}/api/health`, { headers: { 'CF-Connecting-IP': '203.0.113.8' } });
  check('separate IPs get separate buckets',
    a.headers.get('ratelimit-remaining') === b.headers.get('ratelimit-remaining'),
    `${a.headers.get('ratelimit-remaining')} vs ${b.headers.get('ratelimit-remaining')}`);
}

console.log('-- Concurrency');
const raced = await Promise.all(Array.from({ length: 8 }, () => req('POST', `/api/rooms/${CODE}/join`, { name: 'Racer' })));
const oks = raced.filter(r => r.status === 200).length;
check('concurrent identical joins create exactly one', oks === 1, `${oks} succeeded`);

console.log(`\n${'='.repeat(60)}`);
console.log(fails.length ? `FAILED ${fails.length} | passed ${pass}` : `All ${pass} checks passed.`);
fails.forEach(f => console.log('  x ' + f));
