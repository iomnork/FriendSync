/**
 * FindTime schema bootstrap (v2 — multi-granularity).
 *
 * Connects via Unix socket + peer auth when DATABASE_URL is unset, so no
 * password is needed when running on the Pi as the `nickspi` user.
 *
 * Run:  node db-migrate.js
 *       node db-migrate.js --reset    (drops and recreates everything)
 */

const { Pool } = require('pg');

// No DATABASE_URL => local Unix socket, peer auth, no password, no SSL.
// `host` must be the socket DIRECTORY: pg treats a leading "/" as a socket
// path, whereas the default ("localhost") would open a TCP connection and be
// rejected by scram auth.
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : new Pool({
      host: process.env.PGHOST || '/var/run/postgresql',
      database: process.env.PGDATABASE || 'findtime'
    });

const RESET = process.argv.includes('--reset');

const dropSql = `
DROP TABLE IF EXISTS availability CASCADE;
DROP TABLE IF EXISTS participants CASCADE;
DROP TABLE IF EXISTS rooms CASCADE;
`;

const schemaSql = `
CREATE TABLE IF NOT EXISTS rooms (
  id              SERIAL PRIMARY KEY,
  code            VARCHAR(6) UNIQUE NOT NULL,
  name            VARCHAR(255) NOT NULL,
  emoji           VARCHAR(10),

  -- What unit each availability slot represents.
  granularity     VARCHAR(10) NOT NULL DEFAULT 'hours'
                    CHECK (granularity IN ('hours','days','weeks','months')),

  -- The date the first slot (slot_index 0) begins.
  range_start     DATE NOT NULL,

  -- How many slots the grid covers. Bounded to keep payloads sane.
  slot_count      INTEGER NOT NULL CHECK (slot_count > 0 AND slot_count <= 2000),

  -- How many consecutive slots the meeting/stay needs.
  duration_slots  INTEGER NOT NULL DEFAULT 2 CHECK (duration_slots > 0),

  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at      TIMESTAMP NOT NULL,

  CONSTRAINT duration_fits_range CHECK (duration_slots <= slot_count)
);

CREATE TABLE IF NOT EXISTS participants (
  id                     SERIAL PRIMARY KEY,
  room_id                INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name                   VARCHAR(255) NOT NULL,
  travel_buffer_minutes  INTEGER NOT NULL DEFAULT 0
                           CHECK (travel_buffer_minutes >= 0 AND travel_buffer_minutes <= 120),
  created_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (room_id, name)
);

CREATE TABLE IF NOT EXISTS availability (
  participant_id  INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  slot_index      INTEGER NOT NULL CHECK (slot_index >= 0),
  is_available    BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (participant_id, slot_index)
);

CREATE INDEX IF NOT EXISTS idx_rooms_code        ON rooms(code);
CREATE INDEX IF NOT EXISTS idx_rooms_expires     ON rooms(expires_at);
CREATE INDEX IF NOT EXISTS idx_participants_room ON participants(room_id);
`;

async function run() {
  try {
    const who = await pool.query('SELECT current_database() db, current_user usr');
    console.log(`Connected to "${who.rows[0].db}" as "${who.rows[0].usr}"`);

    if (RESET) {
      console.log('--reset given: dropping existing tables...');
      await pool.query(dropSql);
    }

    await pool.query(schemaSql);

    const tables = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `);
    console.log('Schema ready. Tables:', tables.rows.map(r => r.table_name).join(', '));
    await pool.end();
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
}

run();
