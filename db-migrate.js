const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://findtime_user:ElfjKRhYMA4two9OHd6PYiGPB8yqMGDs@dpg-d8bgic3eo5us73aolab0-a.frankfurt-postgres.render.com/findtime',
  ssl: {
    rejectUnauthorized: false
  }
});

const migration = `
ALTER TABLE rooms
ADD COLUMN IF NOT EXISTS name VARCHAR(255),
ADD COLUMN IF NOT EXISTS emoji VARCHAR(10),
ADD COLUMN IF NOT EXISTS duration_minutes INTEGER DEFAULT 60;

CREATE INDEX IF NOT EXISTS idx_rooms_name ON rooms(name);
`;

async function runMigration() {
  try {
    console.log('Running database migration...');
    await pool.query(migration);
    console.log('✅ Migration completed successfully!');
    console.log('   - Added "name" column to rooms');
    console.log('   - Added "emoji" column to rooms');
    console.log('   - Added "duration_minutes" column to rooms (default 60)');
    await pool.end();
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

runMigration();