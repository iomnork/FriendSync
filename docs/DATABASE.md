# Getting into the FindTime database

PostgreSQL 17.10 on the Pi (`homeserver`, 192.168.1.143). Database `findtime`,
owned by role `nickspi`.

Two important facts about how it's set up:

- Postgres listens on **127.0.0.1 only** — it is not reachable from your LAN.
  Anything connecting from your PC must come through an SSH tunnel.
- The app authenticates by **peer auth over a Unix socket**, so the `nickspi`
  role has **no password**. That works for anything running on the Pi itself,
  but a TCP connection (even a tunnelled one) uses `scram-sha-256` and needs a
  password. Option B below covers that.

---

## Option A — psql over SSH (nothing to install, works right now)

```bash
ssh nickspi@192.168.1.143
```

then:

```bash
psql findtime
```

You're in. The prompt becomes `findtime=>`. Type `\q` to quit.

To run a single query without opening a session:

```bash
ssh nickspi@192.168.1.143 "psql findtime -c 'SELECT code, granularity FROM rooms;'"
```

### psql cheat sheet

Backslash commands are psql's, not SQL — they don't need a semicolon.

| Command | Does |
|---|---|
| `\dt` | List tables |
| `\d rooms` | Describe the `rooms` table (columns, types, indexes, constraints) |
| `\d+ rooms` | Same, plus storage and comments |
| `\l` | List databases |
| `\du` | List roles |
| `\x` | Toggle expanded output — makes wide rows readable |
| `\timing` | Show how long each query takes |
| `\e` | Open the last query in an editor |
| `\q` | Quit |

If output is wider than the terminal it wraps badly. `\x` fixes that — it
prints one field per line instead.

---

## Option B — a GUI on Windows (DBeaver, pgAdmin, TablePlus)

You need two things: a password on the role, and a tunnel.

### 1. Set a password (run on the Pi, once)

```bash
psql findtime -c "ALTER ROLE nickspi WITH PASSWORD 'choose-a-password-here';"
```

Pick your own and keep it in your password manager. This does **not** affect
the app — it keeps using the passwordless socket path, so nothing needs
restarting and no password enters the repo.

### 2. Connect through an SSH tunnel

**DBeaver** (recommended — it tunnels for you, no separate step):

- New Connection → PostgreSQL
- *Main* tab: Host `localhost`, Port `5432`, Database `findtime`,
  Username `nickspi`, Password as set above
- *SSH* tab: tick **Use SSH Tunnel**, Host `192.168.1.143`, User `nickspi`,
  Auth Method **Public Key**, Private Key `C:\Users\Nick\.ssh\id_ed25519`
- Test Connection → Finish

**Manual tunnel** (for tools without built-in SSH). Leave this running:

```bash
ssh -N -L 5432:localhost:5432 nickspi@192.168.1.143
```

Then point any client at `localhost:5432`, database `findtime`, user `nickspi`.

> If you already run Postgres on Windows, port 5432 is taken — use
> `-L 5433:localhost:5432` and connect to port 5433 instead.

---

## The schema

Three tables. See [README](../README.md) for the full definitions.

```
rooms          one scheduling session
  └─ participants    people in that room          (FK room_id, ON DELETE CASCADE)
       └─ availability   one row per marked slot   (FK participant_id, CASCADE)
```

`availability` is deliberately generic: a single `slot_index` rather than
separate day/time columns. What a slot *means* comes from the room's
`granularity` — slot 5 is a half-hour in `hours` mode, a date in `days` mode,
a week in `weeks` mode, a month in `months` mode. `range_start` anchors slot 0.

Deleting a room cascades to its participants and their availability, so
`DELETE FROM rooms WHERE code = 'ABC123';` cleans up completely.

---

## Useful queries

**Every room at a glance**

```sql
SELECT r.code, r.name, r.granularity, r.range_start, r.slot_count,
       r.duration_slots, r.expires_at,
       COUNT(DISTINCT p.id) AS people,
       COUNT(a.slot_index) FILTER (WHERE a.is_available) AS slots_marked
FROM rooms r
LEFT JOIN participants p ON p.room_id = r.id
LEFT JOIN availability a ON a.participant_id = p.id
GROUP BY r.id
ORDER BY r.created_at DESC;
```

**Who has responded in a room**

```sql
SELECT p.name,
       COUNT(a.slot_index) FILTER (WHERE a.is_available) AS marked,
       p.travel_buffer_minutes
FROM participants p
LEFT JOIN availability a ON a.participant_id = p.id
JOIN rooms r ON r.id = p.room_id
WHERE r.code = 'ABC123'
GROUP BY p.id
ORDER BY p.created_at;
```

**The heatmap, as data** — how many people are free per slot

```sql
SELECT a.slot_index, COUNT(*) AS people_free
FROM availability a
JOIN participants p ON p.id = a.participant_id
JOIN rooms r ON r.id = p.room_id
WHERE r.code = 'ABC123' AND a.is_available
GROUP BY a.slot_index
ORDER BY people_free DESC, a.slot_index;
```

**Slots where everyone is free** — what the app ranks first

```sql
SELECT a.slot_index
FROM availability a
JOIN participants p ON p.id = a.participant_id
JOIN rooms r ON r.id = p.room_id
WHERE r.code = 'ABC123' AND a.is_available
GROUP BY r.id, a.slot_index
HAVING COUNT(*) = (SELECT COUNT(*) FROM participants WHERE room_id = r.id)
ORDER BY a.slot_index;
```

> `r.id` has to be in the `GROUP BY` because the `HAVING` subquery references
> it. Postgres rejects it otherwise — unlike T-SQL, it will not silently infer
> the grouping for you.

**Turn slot numbers back into real dates** — Postgres does the mapping

```sql
SELECT a.slot_index,
       CASE r.granularity
         WHEN 'days'   THEN r.range_start +  a.slot_index
         WHEN 'weeks'  THEN r.range_start + (a.slot_index * 7)
         WHEN 'months' THEN (r.range_start + (a.slot_index || ' months')::interval)::date
         WHEN 'hours'  THEN r.range_start + (a.slot_index / 30)
       END AS slot_date,
       COUNT(*) AS people_free
FROM availability a
JOIN participants p ON p.id = a.participant_id
JOIN rooms r ON r.id = p.room_id
WHERE r.code = 'ABC123' AND a.is_available
GROUP BY r.granularity, r.range_start, a.slot_index
ORDER BY a.slot_index;
```

**Housekeeping**

```sql
-- Rooms about to expire
SELECT code, name, expires_at - NOW() AS time_left FROM rooms ORDER BY expires_at;

-- Clear test data but keep real rooms
DELETE FROM rooms WHERE name ILIKE '%test%' OR name ILIKE '%qa%';

-- Table sizes
SELECT relname, pg_size_pretty(pg_total_relation_size(relid))
FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC;
```

---

## Coming from SQL Server

Postgres is close to T-SQL but differs in ways that bite early:

| T-SQL | Postgres |
|---|---|
| `SELECT TOP 10 ...` | `SELECT ... LIMIT 10` |
| `'a' + 'b'` | `'a' \|\| 'b'` (`+` is numeric only) |
| `[column name]` | `"column name"` (double quotes) |
| `ISNULL(x, y)` | `COALESCE(x, y)` |
| `GETDATE()` | `NOW()` or `CURRENT_TIMESTAMP` |
| `IDENTITY(1,1)` | `SERIAL` / `GENERATED AS IDENTITY` |
| `sp_help 'rooms'` | `\d rooms` |
| `LEN()` / `CHARINDEX()` | `LENGTH()` / `POSITION(x IN y)` |
| `+` date maths | `date + integer` adds days; otherwise use `INTERVAL` |
| `SELECT` with no `FROM` | Fine in both |

Two gotchas worth knowing:

- **Unquoted identifiers fold to lowercase.** `SELECT MyCol` looks for `mycol`.
  Quote it (`"MyCol"`) or stick to `snake_case` — which this schema does.
- **`COUNT(*) FILTER (WHERE ...)`** is the Postgres idiom for conditional
  counts, cleaner than `SUM(CASE WHEN ... THEN 1 ELSE 0 END)`. Used above.

---

## Backups

```bash
# Dump (run on the Pi)
pg_dump findtime > ~/findtime-$(date +%F).sql

# Copy it to your PC
scp nickspi@192.168.1.143:~/findtime-*.sql .

# Restore
psql findtime < findtime-2026-07-26.sql
```

Worth doing before any `db-migrate.js --reset`, which **drops every table**.
