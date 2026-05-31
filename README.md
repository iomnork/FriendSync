# FindTime

A browser-based group scheduling application that helps multiple people find the perfect time to meet by identifying overlapping availability windows.

**Live URL:** https://friendsync-q4q0.onrender.com/  
**GitHub Repo:** https://github.com/iomnork/FriendSync (private)  
**Local Path:** `C:\Users\Nick\Documents\Programming\FriendSync\`

---

## Key Features

- **Room Creation**: Host creates a room with emoji, meeting title, and duration (30min – 4hrs)
- **Guest Invitations**: Unique room codes and shareable URLs for easy guest access
- **Flexible Participation**: Named participation and anonymous aliases for privacy
- **Availability Grid**: Interactive 7-day grid with 30-minute time slots (8am–11pm)
- **Smart Time Slots**: Algorithm identifies overlapping availability windows
- **Real-Time Sync**: Automatic participant and availability updates every 2–3 seconds
- **Travel Buffer**: Optional buffer time (0–60 mins) shown in UI (not yet applied to algorithm)
- **Quick Fill**: Preset buttons (9–5, Evening, All day) for fast availability entry

---

## Database Schema

### PostgreSQL Tables

**rooms**
```sql
CREATE TABLE rooms (
  id SERIAL PRIMARY KEY,
  code VARCHAR(6) UNIQUE NOT NULL,
  name VARCHAR(255),
  emoji VARCHAR(10),
  duration_minutes INTEGER DEFAULT 60,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '7 days')
);
```

**participants**
```sql
CREATE TABLE participants (
  id SERIAL PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(room_id, name)
);
```

**availability**
```sql
CREATE TABLE availability (
  id SERIAL PRIMARY KEY,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  day INTEGER NOT NULL CHECK (day >= 0 AND day <= 6),
  time_slot INTEGER NOT NULL CHECK (time_slot >= 0 AND time_slot <= 29),
  is_available BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(participant_id, day, time_slot)
);
```

**Database Notes:**
- Days: 0 (Mon) – 6 (Sun)
- Time slots: 0–29 (30-min intervals, 8am–11pm = 15 hours × 2 slots/hour)
- Room codes: Randomly generated 6-character strings (unambiguous charset: no 0/O/1/I)
- Auto-expiry: Rooms expire 7 days after creation (expiry not yet enforced server-side)

---

## API Endpoints

All endpoints expect `Content-Type: application/json` and return JSON.

### Room Management

**POST /api/rooms** — Create a new room
```
Request:  { name, emoji, durationMinutes }
Response: { id, code, name, emoji, duration_minutes, created_at }
```

**GET /api/rooms/:code** — Get room details + participant list
```
Response: { id, code, name, emoji, duration_minutes, participants: [{ id, name, created_at }] }
```

### Participant Management

**POST /api/rooms/:code/join** — Add a participant
```
Request:  { name }
Response: { id, name, created_at }
Errors:   400 if name already taken in this room
```

**GET /api/participants/:id/availability** — Get all slots for a participant
```
Response: [{ day, time_slot, is_available }]
```

### Availability Management

**POST /api/availability** — Upsert a single time slot
```
Request:  { participantId, day, timeSlot, isAvailable }
Response: { success: true }
```

**POST /api/participants/:id/travel-buffer** — Placeholder (not persisted)
```
Request:  { travelBuffer }
Response: { success: true, participantId, travelBuffer }
```

---

## Frontend Architecture

### File Structure
```
/client
└── index.html          (complete SPA — HTML, CSS, JS in one file)

/server
└── server.js           (Express API server)

/db-migrate.js          (schema migration script)
package.json
.gitignore
```

### Technology

- **HTML5 / CSS3**: Responsive, CSS custom properties for automatic dark mode via `prefers-color-scheme`
- **Vanilla JavaScript**: No frameworks; event-driven state management
- **Interactive Grid**: Drag-to-select availability with touch support (single-tap only on touch)

### State Management (global variables)

| Variable | Purpose |
|---|---|
| `currentRoomCode` | Active room code |
| `currentRoomName/Emoji/Duration` | Room metadata |
| `currentParticipantId` | This user's participant ID |
| `isHostView` / `isGuestView` | Role-based UI flags |
| `participants` | Array of participant objects |
| `availability` | Flat key-value store: `{participantId}-{day}-{timeSlot}` → boolean |
| `travelBuffer` | Selected travel time in minutes (UI only, not applied to algorithm) |

### User Flows

**Host Flow:** Create room → share invite URL → view participant list → mark own availability → see best times

**Guest Flow:** Visit invite URL → enter name or alias → mark availability → see best times

---

## Algorithm: Finding Best Times (`computeAndShow`)

1. Count how many participants are free for each (day, slot) combination
2. Collect all slots where at least one person is free
3. Identify consecutive runs within the same day
4. Slide a window of `minSlots` (= duration ÷ 30) across each run to generate candidate blocks
5. For each block, use the *minimum* free count across all constituent slots
6. Sort by free count descending; show top 10

**Note:** Overlapping windows are intentional — a 4-slot run with a 2-slot meeting produces 3 results (9–10, 9:30–10:30, 10–11).

---

## Known Issues & Backlog

### Bugs / Missing Behaviour

1. **Travel buffer not applied** — Buffer is shown in UI and stored locally but never used in `computeAndShow`. Needs to subtract buffer slots from the edges of each participant's availability before counting.

2. **`setCell` hammers the API during drag** — Every cell toggled during a drag calls `renderParticipants()`, which calls `loadAllParticipantAvailability()` (one fetch per participant). This fires on every `mousemove` event during drag. Needs debouncing or batching.

3. **`quickFill` fires hundreds of simultaneous API requests** — "All day" = 7 days × 30 slots = 210 individual `POST /api/availability` calls at once. Needs batching endpoint or client-side queuing.

4. **No `res.ok` check on fetch calls** — `createRoom()` and `joinRoom()` call `.json()` on failed responses without checking HTTP status, so API errors silently produce undefined values (e.g. `currentParticipantId = undefined`).

5. **Room expiry not enforced server-side** — `expires_at` is stored but never checked. Expired rooms remain joinable.

6. **Guest can re-join after joining** — `isGuestView` stays `true` and the Join tab stays visible, letting a guest submit the join form a second time.

7. **`loadAllParticipantAvailability` fetches sequentially** — Uses `for...of` + `await` instead of `Promise.all`, so N participants = N sequential round-trips.

8. **Results tab doesn't refresh immediately on tab switch** — `showTab('results')` starts the 3s poll but doesn't call `computeAndShow()` immediately, so there's up to a 3s delay before results appear.

9. **Touch drag not supported** — `handleTouch` only toggles a single cell; multi-cell drag requires mouse. UX hint says "drag to select" which is misleading on mobile.

10. **No server-side input validation on `/api/availability`** — `day` and `timeSlot` values are not validated against their allowed ranges (0–6 and 0–29).

### Future Enhancements

- Real-time sync via WebSockets (currently polling every 2–3s)
- Batch availability endpoint to replace per-cell POST requests
- Authentication / user accounts
- Calendar integration (Google Calendar, Outlook)
- Timezone support
- Export to iCal format
- Notification system

---

## Deployment & DevOps

### Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML/CSS/JS (single file) |
| Backend | Node.js 24.14.1 + Express.js v5 |
| Database | PostgreSQL (Render managed, free tier) |
| Hosting | Render.com (auto-deploy on git push to master) |

### Deployment Process

```bash
# Edit client/index.html or server/server.js
git add .
git commit -m "descriptive message"
git push
# Render auto-deploys ~60 seconds later
# Status: https://dashboard.render.com/
```

### Environment

- `DATABASE_URL` env var set automatically by Render in production
- Fallback in `server.js` uses the public Render PostgreSQL URL (for local dev)
- SSL required: `rejectUnauthorized: false` (Render free tier)

### Database Credentials (Render Free Tier)

- **Expires:** June 26, 2026
- **Action required:** Upgrade to paid tier or export and migrate before expiry

---

## Debugging Tips

**Frontend console:**
```javascript
console.log({ currentRoomCode, participants, availability });
```

**Check a participant's Tuesday slots:**
```javascript
const pid = 29;
Object.keys(availability).filter(k => k.startsWith(`${pid}-1-`)).length;
```

**Network:** DevTools → Network → filter to `/api/` to verify request payloads and status codes.

---

## Testing Checklist

- [ ] Create room with different durations (30min, 1hr, 2hr, 4hr)
- [ ] Join as guest with alias and with custom name
- [ ] Fill availability via drag-select and quick-fill buttons
- [ ] Verify best times show correct duration blocks
- [ ] Confirm availability counts (2/2 when both free, 1/2 when one free)
- [ ] Test on mobile (touch tap to toggle cells)
- [ ] Check dark mode rendering
- [ ] Verify invite URL loads join screen correctly
