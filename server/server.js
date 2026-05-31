const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://findtime_user:ElfjKRhYMA4two9OHd6PYiGPB8yqMGDs@dpg-d8bgic3eo5us73aolab0-a.frankfurt-postgres.render.com/findtime',
  ssl: { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "client")));

// Create a new room
app.post("/api/rooms", async (req, res) => {
  try {
    const { name, emoji, durationMinutes } = req.body;
    if (!name || !emoji) {
      return res.status(400).json({ error: 'Room name and emoji are required' });
    }
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from({length: 6}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const result = await pool.query(
      'INSERT INTO rooms (code, name, emoji, duration_minutes) VALUES ($1, $2, $3, $4) RETURNING id, code, name, emoji, duration_minutes, created_at',
      [code, name, emoji, durationMinutes || 60]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating room:', error);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// Get room details (Fix 7: enforce expiry)
app.get("/api/rooms/:code", async (req, res) => {
  try {
    const { code } = req.params;
    const roomResult = await pool.query(
      'SELECT id, code, name, emoji, duration_minutes, created_at FROM rooms WHERE code = $1 AND expires_at > CURRENT_TIMESTAMP',
      [code]
    );
    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: 'Room not found or has expired' });
    }
    const room = roomResult.rows[0];
    const participantsResult = await pool.query(
      'SELECT id, name, created_at FROM participants WHERE room_id = $1 ORDER BY created_at',
      [room.id]
    );
    res.json({ ...room, participants: participantsResult.rows });
  } catch (error) {
    console.error('Error fetching room:', error);
    res.status(500).json({ error: 'Failed to fetch room' });
  }
});

// Join a room (Fix 7: enforce expiry)
app.post("/api/rooms/:code/join", async (req, res) => {
  try {
    const { code } = req.params;
    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const roomResult = await pool.query(
      'SELECT id FROM rooms WHERE code = $1 AND expires_at > CURRENT_TIMESTAMP',
      [code]
    );
    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: 'Room not found or has expired' });
    }
    const roomId = roomResult.rows[0].id;
    const participantResult = await pool.query(
      'INSERT INTO participants (room_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id, name, created_at',
      [roomId, name.trim()]
    );
    if (participantResult.rows.length === 0) {
      return res.status(400).json({ error: 'That name is already taken in this room' });
    }
    res.json(participantResult.rows[0]);
  } catch (error) {
    console.error('Error joining room:', error);
    res.status(500).json({ error: 'Failed to join room' });
  }
});

// Save availability (Fix 10: input validation)
app.post("/api/availability", async (req, res) => {
  try {
    const { participantId, day, timeSlot, isAvailable } = req.body;
    if (
      !Number.isInteger(participantId) ||
      !Number.isInteger(day) || day < 0 || day > 6 ||
      !Number.isInteger(timeSlot) || timeSlot < 0 || timeSlot > 29 ||
      typeof isAvailable !== 'boolean'
    ) {
      return res.status(400).json({ error: 'Invalid availability data' });
    }
    await pool.query(
      'INSERT INTO availability (participant_id, day, time_slot, is_available) VALUES ($1, $2, $3, $4) ON CONFLICT (participant_id, day, time_slot) DO UPDATE SET is_available = $4',
      [participantId, day, timeSlot, isAvailable]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving availability:', error);
    res.status(500).json({ error: 'Failed to save availability' });
  }
});

// Travel buffer placeholder (not yet persisted — needs DB column)
app.post("/api/participants/:id/travel-buffer", async (req, res) => {
  try {
    const { travelBuffer } = req.body;
    if (typeof travelBuffer !== 'number' || travelBuffer < 0 || travelBuffer > 120) {
      return res.status(400).json({ error: 'Travel buffer must be a number between 0 and 120' });
    }
    res.json({ success: true, participantId: parseInt(req.params.id), travelBuffer, note: 'Not yet persisted' });
  } catch (error) {
    console.error('Error saving travel buffer:', error);
    res.status(500).json({ error: 'Failed to save travel buffer' });
  }
});

// Get availability for a participant
app.get("/api/participants/:id/availability", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT day, time_slot, is_available FROM availability WHERE participant_id = $1',
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching availability:', error);
    res.status(500).json({ error: 'Failed to fetch availability' });
  }
});

// Serve SPA
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "client", "index.html"));
});

app.listen(PORT, () => {
  console.log(`FindTime running on http://localhost:${PORT}`);
});
