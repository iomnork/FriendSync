# FindTime – Session Progress Log

**Live URL:** https://friendsync-q4q0.onrender.com/  
**GitHub:** https://github.com/iomnork/FriendSync (private, branch: master)

---

## Session 1 — May 26, 2026 · Git, Deployment, URL Routing

### Accomplished
- Initialised Git repository; resolved nested `.git` issue (removed old FriendSync/.git)
- Pushed to GitHub (`iomnork/FriendSync`); changed default branch from `main` to `master`
- Renamed project from "FriendSync" to "FindTime" (name conflict with existing app)
- Deployed to Render.com as a Web Service (Node.js, free tier, auto-deploy on push)
- Implemented URL-based room sharing: `/room/[CODE]` routes; frontend reads code from URL

### Key Fixes
- Express 5 catch-all route: changed `app.get("*", ...)` to `app.get(/.*/, ...)` (Express 5 requires regex)

### State at End of Session
- Frontend-only app: data stored in JS variables, lost on page refresh
- No real-time sync between browsers

---

## Session 2 — May 27, 2026 · PostgreSQL + Server API

### Accomplished
- Created `findtime-db` on Render PostgreSQL (free tier, Frankfurt, expires June 26 2026)
- Deployed 3-table schema: `rooms`, `participants`, `availability`
- Wired Express server to PostgreSQL via `pg` connection pool with SSL
- Built 5 API endpoints: create room, get room, join room, save availability, get availability

### Key Fixes
- Added `rejectUnauthorized: false` for SSL connection to Render PostgreSQL

### State at End of Session
- Backend fully wired; frontend still using local state (not yet calling the API)

---

## Session 3 — May 2026 · Frontend API Integration + Real-Time Sync

### Accomplished
- Rewired frontend to call all API endpoints instead of using local state
- `loadRoom()` fetches room + participant list from server
- `setCell()` posts each availability change to `/api/availability`
- `loadAllParticipantAvailability()` fetches all participants' availability on demand
- Added polling loops: participant list refreshes every 2s, best times recomputes every 3s
- `loadRoomFromURL()` detects `/room/CODE` path and loads join screen automatically

### State at End of Session
- Multi-user collaboration working; different browsers see each other's data
- Host/guest role separation partially implemented

---

## Session 4 — May 2026 · UI Redesign + Bug Fixes

### Accomplished
- Full UI redesign: room creation screen, emoji picker, duration slider (30min–4hr)
- Host/guest separation: hosts see Room tab; guests see Join tab; join flow via alias chips
- Travel buffer UI added (not yet wired into algorithm)
- Deployed and tested on Render

### Bugs Fixed

| # | Bug | Fix |
|---|-----|-----|
| 1 | Algorithm broke runs when `freeCount` changed | Removed `freeCount` equality check from merge loop — only split on non-consecutive slots |
| 2 | Room/Join tabs visible to all users | Hid tabs by default; show conditionally based on `isHostView`/`isGuestView` |
| 3 | Guests could select other participants' availability | `updatePersonSelect()` now locks guests to their own ID; hosts see all |
| 4 | Results showed 15-hour windows instead of meeting-length blocks | Break merged runs into individual `minSlots`-sized blocks |
| 5 | Availability count showed only first slot's value | Use `Math.min(...block.map(b => b.freeCount))` across the whole block |

### Known Issues Identified (not yet fixed)
See README.md — Known Issues & Backlog for the full list.

---

## Deployment Notes

- Build command: `npm install`
- Start command: `node server/server.js`
- Node version: 24.14.1
- Typical deploy time after push: 60–90 seconds
- Database connection: `process.env.DATABASE_URL` on Render; fallback public URL in `server.js` for local dev
