# FindTime — QA & UX Report

**Date:** 25 July 2026
**Version tested:** v2 (multi-granularity), commit `5182d9e`
**Environment:** Self-hosted on Raspberry Pi (`homeserver`, 192.168.1.143:3000), PostgreSQL 17
**Context:** Pre-launch pass before exposing the app publicly via Cloudflare Tunnel.

---

## Summary

| Severity | Issue | Status |
|---|---|---|
| **Critical** | Stored XSS via participant names | ✅ Fixed |
| **High** | Mobile scroll trap on calendar/list views | ✅ Fixed |
| **Medium** | Name lock-in with no escape hatch | ✅ Fixed |
| **Medium** | Room expiry default outlived by planning horizon | ✅ Fixed |
| **Low** | No visibility of others' availability | ⬜ Open — recommended |
| **Low** | Room start date can be in the past | ⬜ Open |
| **Low** | Sparse quick-fill for weeks/months | ⬜ Open |
| **Low** | Room code alphabet excludes I/O/0/1 silently | ⬜ Open |

Two earlier bugs found during the v2 build are also recorded below, since both
would have produced silently wrong output rather than visible errors.

---

## Fixed

### 1. Stored XSS in participant names — CRITICAL

**What:** Participant names were interpolated raw into `innerHTML` in three
places: the participant list, the host's person dropdown, and the guest's
person dropdown.

**Why it mattered:** Names are attacker-chosen. Anyone with a room link picks
their own, with no authentication. Joining a room as
`<img src=x onerror=...>` executed arbitrary script in the browser of **every
other participant, including the host**. The payload persisted in the database
and re-fired on every poll cycle.

**Fix:** Added an `esc()` helper escaping `& < > " '`, applied at all three
sinks. Escaping is done on output (the correct layer) rather than sanitising on
input, so the stored value stays faithful.

**Verified:** Four payload shapes (`<img onerror>`, `<script>`, `"><svg onload>`,
quote-breaking) asserted against all three render paths. Mutation-tested —
reverting the fix fails the suite.

> Room names and emoji were already safe: they go through `textContent`, not
> `innerHTML`. Only participant names were affected.

### 2. Mobile scroll trap — HIGH

**What:** `.sel { touch-action: none }` applied to every selectable cell in all
four grid renderers.

**Why it mattered:** In `days`, `weeks` and `months` modes the grid is taller
than the viewport. On a phone, swiping to scroll the page **selected dates
instead of scrolling**, with no way to get past the grid. This made the primary
use case — a family marking holiday availability on their phones — close to
unusable.

**Fix:** `touch-action: pan-y` for calendar/list/month views, so vertical page
scrolling belongs to the browser while taps still toggle and horizontal
drag-select still works. The hours grid keeps `touch-action: none` because it
is a bounded widget inside its own scroll container.

### 3. Permanent name lock-in — MEDIUM

**What:** After joining, identity is stored in `localStorage` and the Join tab
is hidden. There was no way to correct a mistyped name.

**Fix:** Added a "Not you?" control that clears the stored identity and returns
to the join screen. Hidden for hosts, who would otherwise silently discard host
view. The old participant is not deleted — the host can see and ignore it.

### 4. Room expiry outlived by planning horizon — MEDIUM

**What:** Room expiry defaulted to 7 days regardless of granularity.

**Why it mattered:** Planning a holiday 12 months out would create a room that
expired in a week — deleting the room and every response with it, silently,
before most people had replied.

**Fix:** Expiry default now scales with granularity: hours 7d, days 30d,
weeks 90d, months 1 year.

### 5. Off-by-one-day from DATE parsing — (found during build)

`pg` parses `DATE` (oid 1082) into a JS `Date` at local midnight. Under BST a
`range_start` of `2027-06-01` serialised as `2027-05-31T23:00:00Z`, and the
client's `slice(0,10)` then read **2027-05-31** — shifting every rendered
calendar back a day. Fixed with `types.setTypeParser(1082, v => v)` so a DATE
stays the string it is. A `DATE` has no timezone; it should never acquire one.

### 6. Copy button threw on plain HTTP — (found during build)

`navigator.clipboard` only exists in a secure context. Served over HTTP on the
LAN it is `undefined`, so the copy button threw. The old code also swallowed the
rejection and displayed "Copied!" regardless, so a failed copy looked
successful. Now: Clipboard API when available → `execCommand` fallback →
select-the-text-and-prompt, and it only claims success when a copy happened.

---

## Open — recommendations

### A. No visibility of others' availability — highest value

You mark your availability **blind**. Nothing shows what anyone else picked
until you switch to the Best Times tab, and even then only as ranked windows.

Most scheduling tools shade each cell by how many people are free, so you can
see consensus forming and place yourself around it. For a six-person family
holiday this is the difference between guessing and "Mum and Dad both want
mid-July, I'll flex."

Suggested: a read-only heatmap layer behind your own selections, with an
opacity ramp by free-count. The data is already loaded client-side by
`loadAllAvailability()` — this is a rendering change, not a data one.

### B. Room start date can be in the past

Nothing validates `rangeStart` against today. A room can be created for a range
that has already happened. Harmless but confusing.

### C. Sparse quick-fill for weeks/months

Only "Select all" and "Clear all". Marking a 52-week range is tedious. Worth
adding season or month-block shortcuts (e.g. "School holidays", "Summer").

### D. Room code alphabet is silently restricted

Codes exclude `I`, `O`, `0`, `1` to avoid ambiguity, but nothing tells the user.
Typing a letter O into the join box always fails with a generic red border.
Worth either a hint or a friendlier error.

---

## Test coverage

Both suites live in `test/` and should be run before shipping.

### `npm test` — 74 assertions, no server required

Runs the **real shipped client script** from `index.html` inside a `vm` sandbox
with DOM stubs, so it tests the deployed code rather than a copy.

- **Date arithmetic** — month ends, year boundaries, leap years, and both UK DST
  transitions (BST starts 2027-03-28, ends 2027-10-31). Relevant because v2
  spans up to a year, where the old app never left a single week.
- **`addMonths` overflow** — Jan 31 + 1 month must land in February, not
  March 3.
- **Slot mapping** per granularity, including that hours mode segments per day
  while days/weeks/months run continuously.
- **Window labels** for all four granularities, including the noon boundary and
  windows crossing a month.
- **Overlap algorithm** — unanimous-window detection, non-overlapping result
  selection, runs shorter than the duration, ranking a unanimous window above a
  longer partial one, and that no window may span the 11pm→8am gap.
- **Travel buffer** — a window that exactly fits is *not* enough with a buffer;
  the buffer may not reach past the start of a day.
- **XSS escaping** across all three render paths.

### `npm run test:api` — 51 checks, needs a running server

Run on the Pi: `node test/api.test.mjs`.

Validation bounds on every endpoint, SQL injection through both room codes and
participant names, oversized payloads, bulk-write atomicity (a rejected batch
must write nothing), lowercase room codes, unicode names, and 8 concurrent
identical joins producing exactly one participant.

---

## Not covered

**Visual rendering was not verified.** Browser automation is gated on this host,
so all testing was at the logic, API and code-review level.

- `days` and `months` — confirmed working by Nick in the real UI.
- **`hours` and `weeks` — not yet visually checked.** The week list is the most
  likely to need layout work.

Also untested: real multi-device concurrency, behaviour on slow/flaky networks,
and screen readers / keyboard-only navigation.
