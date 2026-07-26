const express = require("express");
const path = require("path");
const { Pool, types } = require("pg");

// Return DATE (oid 1082) as a plain 'YYYY-MM-DD' string. By default pg parses
// it into a JS Date at local midnight, so under BST a range_start of
// 2027-06-01 serialises to "2027-05-31T23:00:00Z" and the client renders the
// whole calendar a day early. A DATE has no timezone; don't give it one.
types.setTypeParser(1082, v => v);

const app = express();
const PORT = process.env.PORT || 3000;

// On the Pi there is no DATABASE_URL: connect over the local Unix socket using
// peer auth, so no password or SSL config is needed anywhere. `host` must be
// the socket DIRECTORY — pg treats a leading "/" as a socket path, whereas the
// default ("localhost") would open a TCP connection and be rejected by scram.
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : new Pool({
      host: process.env.PGHOST || '/var/run/postgresql',
      database: process.env.PGDATABASE || 'findtime'
    });

// Don't advertise the stack. "x-powered-by: Express" tells a scanner exactly
// what to look up CVEs for, and buys nothing in return.
app.disable('x-powered-by');

// Modest hardening for a public origin. Cloudflare terminates TLS in front of
// this, but these travel through to the browser.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');          // no clickjacking via iframe
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, "..", "client")));

const holidays = require('./holidays');

const GRANULARITIES = ['hours', 'days', 'weeks', 'months'];
const VALID_REGIONS = [...holidays.REGIONS, 'all'];
const ROOM_COLS = 'id, code, name, emoji, granularity, range_start, slot_count, duration_slots, region, expires_at, created_at';

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

// Look up the room a participant belongs to — used to bound-check slot indices.
async function roomForParticipant(participantId) {
  const { rows } = await pool.query(
    `SELECT r.id, r.slot_count
       FROM participants p
       JOIN rooms r ON r.id = p.room_id
      WHERE p.id = $1 AND r.expires_at > CURRENT_TIMESTAMP`,
    [participantId]
  );
  return rows[0] || null;
}

// ── Rooms ────────────────────────────────────────────────────────────────────

app.post("/api/rooms", async (req, res) => {
  try {
    const { name, emoji, granularity, rangeStart, slotCount, durationSlots, expiryDays, region } = req.body;

    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Room name is required' });
    // Emoji is decorative and optional — the client falls back to a default.
    if (emoji != null && String(emoji).length > 10) {
      return res.status(400).json({ error: 'Emoji is too long' });
    }
    if (!GRANULARITIES.includes(granularity)) {
      return res.status(400).json({ error: `granularity must be one of: ${GRANULARITIES.join(', ')}` });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(rangeStart || ''))) {
      return res.status(400).json({ error: 'rangeStart must be a YYYY-MM-DD date' });
    }
    if (!isInt(slotCount, 1, 2000)) return res.status(400).json({ error: 'slotCount must be 1-2000' });
    if (!isInt(durationSlots, 1, slotCount)) {
      return res.status(400).json({ error: 'durationSlots must be between 1 and slotCount' });
    }

    if (region != null && !VALID_REGIONS.includes(region)) {
      return res.status(400).json({ error: `region must be one of: ${VALID_REGIONS.join(', ')}` });
    }

    const days = isInt(expiryDays, 1, 365) ? expiryDays : 1;
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

    // Retry on the astronomically unlikely code collision rather than 500.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      try {
        const { rows } = await pool.query(
          `INSERT INTO rooms (code, name, emoji, granularity, range_start, slot_count, duration_slots, region, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CURRENT_TIMESTAMP + ($9 || ' days')::interval)
           RETURNING ${ROOM_COLS}`,
          [code, String(name).trim(), emoji || null, granularity, rangeStart, slotCount, durationSlots, region || null, days]
        );
        return res.json(rows[0]);
      } catch (e) {
        if (e.code !== '23505') throw e; // 23505 = unique_violation on code
      }
    }
    res.status(500).json({ error: 'Could not allocate a unique room code' });
  } catch (error) {
    console.error('Error creating room:', error);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

app.get("/api/rooms/:code", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${ROOM_COLS} FROM rooms WHERE code = $1 AND expires_at > CURRENT_TIMESTAMP`,
      [String(req.params.code).toUpperCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'Room not found or has expired' });

    const room = rows[0];
    const participants = await pool.query(
      'SELECT id, name, travel_buffer_minutes, created_at FROM participants WHERE room_id = $1 ORDER BY created_at',
      [room.id]
    );
    res.json({ ...room, participants: participants.rows });
  } catch (error) {
    console.error('Error fetching room:', error);
    res.status(500).json({ error: 'Failed to fetch room' });
  }
});

// ── Participants ─────────────────────────────────────────────────────────────

app.post("/api/rooms/:code/join", async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (name.length > 255) return res.status(400).json({ error: 'Name is too long' });

    const { rows } = await pool.query(
      'SELECT id FROM rooms WHERE code = $1 AND expires_at > CURRENT_TIMESTAMP',
      [String(req.params.code).toUpperCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'Room not found or has expired' });

    const inserted = await pool.query(
      `INSERT INTO participants (room_id, name) VALUES ($1, $2)
       ON CONFLICT (room_id, name) DO NOTHING
       RETURNING id, name, travel_buffer_minutes, created_at`,
      [rows[0].id, name]
    );
    if (!inserted.rows.length) return res.status(409).json({ error: 'That name is already taken in this room' });

    res.json(inserted.rows[0]);
  } catch (error) {
    console.error('Error joining room:', error);
    res.status(500).json({ error: 'Failed to join room' });
  }
});

app.post("/api/participants/:id/travel-buffer", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { travelBuffer } = req.body;
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid participant id' });
    if (!isInt(travelBuffer, 0, 120)) {
      return res.status(400).json({ error: 'travelBuffer must be an integer between 0 and 120' });
    }
    const { rowCount } = await pool.query(
      'UPDATE participants SET travel_buffer_minutes = $1 WHERE id = $2',
      [travelBuffer, id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Participant not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving travel buffer:', error);
    res.status(500).json({ error: 'Failed to save travel buffer' });
  }
});

app.get("/api/participants/:id/availability", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid participant id' });
    const { rows } = await pool.query(
      'SELECT slot_index, is_available FROM availability WHERE participant_id = $1 AND is_available = TRUE',
      [id]
    );
    res.json(rows);
  } catch (error) {
    console.error('Error fetching availability:', error);
    res.status(500).json({ error: 'Failed to fetch availability' });
  }
});

// ── Availability ─────────────────────────────────────────────────────────────

app.post("/api/availability", async (req, res) => {
  try {
    const { participantId, slotIndex, isAvailable } = req.body;
    if (!Number.isInteger(participantId)) return res.status(400).json({ error: 'Invalid participantId' });
    if (typeof isAvailable !== 'boolean') return res.status(400).json({ error: 'isAvailable must be a boolean' });

    const room = await roomForParticipant(participantId);
    if (!room) return res.status(404).json({ error: 'Participant or room not found' });
    if (!isInt(slotIndex, 0, room.slot_count - 1)) {
      return res.status(400).json({ error: `slotIndex must be 0-${room.slot_count - 1}` });
    }

    await pool.query(
      `INSERT INTO availability (participant_id, slot_index, is_available) VALUES ($1,$2,$3)
       ON CONFLICT (participant_id, slot_index) DO UPDATE SET is_available = EXCLUDED.is_available`,
      [participantId, slotIndex, isAvailable]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving availability:', error);
    res.status(500).json({ error: 'Failed to save availability' });
  }
});

/**
 * Bulk upsert — replaces the old pattern of firing one request per cell, which
 * meant a single "all day" quick-fill sent 210 concurrent requests.
 * Body: { participantId, slots: [{ slotIndex, isAvailable }, ...] }
 */
app.post("/api/availability/bulk", async (req, res) => {
  const client = await pool.connect();
  try {
    const { participantId, slots } = req.body;
    if (!Number.isInteger(participantId)) return res.status(400).json({ error: 'Invalid participantId' });
    if (!Array.isArray(slots)) return res.status(400).json({ error: 'slots must be an array' });
    if (slots.length > 2000) return res.status(400).json({ error: 'Too many slots in one request' });
    if (!slots.length) return res.json({ success: true, updated: 0 });

    const room = await roomForParticipant(participantId);
    if (!room) return res.status(404).json({ error: 'Participant or room not found' });

    for (const s of slots) {
      if (!isInt(s?.slotIndex, 0, room.slot_count - 1) || typeof s?.isAvailable !== 'boolean') {
        return res.status(400).json({ error: 'Every slot needs a valid slotIndex and boolean isAvailable' });
      }
    }

    // unnest() lets the whole batch go over as one statement.
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO availability (participant_id, slot_index, is_available)
       SELECT $1, * FROM unnest($2::int[], $3::boolean[])
       ON CONFLICT (participant_id, slot_index) DO UPDATE SET is_available = EXCLUDED.is_available`,
      [participantId, slots.map(s => s.slotIndex), slots.map(s => s.isAvailable)]
    );
    await client.query('COMMIT');

    res.json({ success: true, updated: slots.length });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error bulk-saving availability:', error);
    res.status(500).json({ error: 'Failed to save availability' });
  } finally {
    client.release();
  }
});

// ── Holidays ─────────────────────────────────────────────────────────────────

/**
 * Public holidays for a region over a date range. The server owns the gov.uk
 * fetch and caches it, so the user's browser never talks to a third party and
 * the app keeps working if gov.uk is unreachable.
 */
app.get("/api/holidays", async (req, res) => {
  try {
    const { region, from, to } = req.query;
    if (!VALID_REGIONS.includes(region)) {
      return res.status(400).json({ error: `region must be one of: ${VALID_REGIONS.join(', ')}` });
    }
    const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
    if (!isDate(from) || !isDate(to)) {
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD dates' });
    }
    if (from > to) return res.status(400).json({ error: 'from must not be after to' });

    res.set('Cache-Control', 'public, max-age=3600');
    res.json(await holidays.getHolidays(region, from, to));
  } catch (error) {
    console.error('Error fetching holidays:', error);
    res.status(500).json({ error: 'Failed to fetch holidays' });
  }
});

// ── Housekeeping ─────────────────────────────────────────────────────────────

app.get("/api/health", async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, uptime: Math.round(process.uptime()) });
  } catch {
    res.status(503).json({ ok: false, error: 'Database unreachable' });
  }
});

// Delete rooms past their expiry (and cascade to participants/availability).
async function purgeExpiredRooms() {
  try {
    const { rowCount } = await pool.query('DELETE FROM rooms WHERE expires_at <= CURRENT_TIMESTAMP');
    if (rowCount) console.log(`Purged ${rowCount} expired room(s)`);
  } catch (e) {
    console.error('Purge failed:', e.message);
  }
}
setInterval(purgeExpiredRooms, 60 * 60 * 1000).unref();
purgeExpiredRooms();

// Warm the holiday cache at startup so the first room to need it isn't waiting
// on gov.uk. Failures are non-fatal — holidays.js falls back to disk cache.
holidays.refresh().catch(() => {});

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "client", "index.html"));
});

app.listen(PORT, () => {
  console.log(`When Can We Meet running on http://localhost:${PORT}`);
});
