# Deploying FindTime to the Raspberry Pi

Target: `nickspi@192.168.1.143` (hostname `homeserver`), Raspberry Pi 4, Debian 13.

The Pi already runs `gamelibrary.service` on port **3001** — FindTime uses **3000**.

---

## 1. PostgreSQL (one-off)

```bash
sudo apt update && sudo apt install -y postgresql
sudo -u postgres createuser --createdb nickspi
sudo -u postgres createdb -O nickspi findtime
```

The app connects over the Unix socket at `/var/run/postgresql` using **peer
authentication** — Postgres trusts the OS user `nickspi` directly. There is no
database password anywhere in the repo, in systemd, or in any env file.

## 2. Application code

```bash
git clone https://github.com/iomnork/FriendSync.git ~/findtime
cd ~/findtime && npm install --omit=dev
node db-migrate.js
```

`db-migrate.js --reset` drops and recreates all tables. It is destructive.

## 3. Run as a service (one-off)

```bash
sudo cp ~/findtime/deploy/findtime.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now findtime
systemctl status findtime --no-pager
```

Check it: `curl localhost:3000/api/health` → `{"ok":true,...}`

## 4. Public access via Cloudflare Tunnel — DONE

**Live at https://whencanwemeet.app**

The Pi dials **out** to Cloudflare and holds the connection open. Nothing is
exposed inbound: no port forwarding, no firewall holes, and the home IP address
never appears in public DNS. TLS terminates at Cloudflare, and `.app` is an
HSTS-preloaded TLD, so browsers refuse plain HTTP for it outright.

Already done, recorded here for rebuilds:

```bash
# Install (arm64)
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb -o /tmp/cf.deb
sudo dpkg -i /tmp/cf.deb

# Authenticate — opens a browser to pick the zone
cloudflared tunnel login

# Create the tunnel and point both hostnames at it
cloudflared tunnel create whencanwemeet
cloudflared tunnel route dns whencanwemeet whencanwemeet.app
cloudflared tunnel route dns whencanwemeet www.whencanwemeet.app

# Promote to a system service
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/config.yml /etc/cloudflared/config.yml
sudo cp ~/.cloudflared/<TUNNEL-UUID>.json /etc/cloudflared/
sudo sed -i 's|/home/nickspi/.cloudflared|/etc/cloudflared|' /etc/cloudflared/config.yml
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

Current tunnel: **`whencanwemeet`**, id `c590e440-17bc-4b7b-b980-3abcc7ff91c8`.
Config lives at `/etc/cloudflared/config.yml` — see
[cloudflared-config.yml](cloudflared-config.yml) for the version-controlled copy.

The credentials JSON is a **secret** and is deliberately not in this repo.
Losing it means deleting and recreating the tunnel.

### Tunnel operations

```bash
cloudflared tunnel list                  # tunnels and their connections
cloudflared tunnel info whencanwemeet    # which edge locations it is connected to
cloudflared tunnel ingress validate      # check config before restarting
journalctl -u cloudflared -f             # live logs
sudo systemctl restart cloudflared       # after editing the config
```

If the site 502s, the tunnel is up but the app is not — check
`systemctl status findtime` first.

> For a throwaway test URL with no domain,
> `cloudflared tunnel --url http://localhost:3000` prints a temporary
> `*.trycloudflare.com` address that dies with the process.

---

## 5. Hardening (done 2026-07-26, when the app went public)

### Rate limiting — in the app

Keyed on `CF-Connecting-IP`, **not** `req.ip`: behind the tunnel every request
genuinely arrives from `127.0.0.1`, so limiting on `req.ip` would put the whole
internet in one bucket and lock everyone out the moment one person was busy.

That header is only trustworthy because nothing can reach the origin except
through the tunnel. **If this app is ever port-forwarded, that assumption
breaks** and the header becomes forgeable.

| Endpoint | Budget |
|---|---|
| `POST /api/rooms` | 30 / hour |
| `POST /api/rooms/:code/join` | 40 / hour |
| availability + travel-buffer writes | 300 / minute |
| everything under `/api` | 600 / minute |

Counted per *attempt*, not per success, so spraying invalid payloads is limited
too. Responses carry `RateLimit-Limit`, `RateLimit-Remaining` and
`RateLimit-Reset`; a rejection is `429` with `Retry-After`.

### Firewall

```bash
sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from 192.168.1.0/24 to any port 22   proto tcp comment 'SSH from LAN'
sudo ufw allow from 192.168.1.0/24 to any port 3000 proto tcp comment 'app from LAN'
sudo ufw allow from 192.168.1.0/24 to any port 3001 proto tcp comment 'game bot from LAN'
sudo ufw --force enable
```

This does not affect the public site: `cloudflared` dials **outbound** (covered
by `default allow outgoing`) and reaches the app over **loopback**, which ufw
does not filter. Port 3000 simply stops being reachable from anything but the
LAN.

> Always add the SSH rule **before** `enable`, and check the source subnet
> first (`echo $SSH_CLIENT`). Enabling ufw with no SSH rule locks you out of a
> headless machine.

### Response headers

`x-powered-by` is disabled — announcing the stack tells a scanner which CVE
list to work through. `X-Content-Type-Options`, `X-Frame-Options` and
`Referrer-Policy` are set on every response.

### Backups

[`backup.sh`](backup.sh) runs nightly at 03:00 from nickspi's crontab. Dumps to
`~/backups/findtime-YYYY-MM-DD.sql.gz`, keeps 14, logs to `~/backups/backup.log`.

```bash
crontab -l                     # confirm the schedule
tail ~/backups/backup.log      # did last night work?
./deploy/backup.sh             # run one now
```

Writes to a temp file and moves into place only on success — an interrupted
dump would otherwise leave a truncated file that looks valid right up until you
need it.

**Restoring is not tested by the backup running.** Periodically prove it:

```bash
createdb findtime_restoretest
gunzip -c ~/backups/findtime-2026-07-26.sql.gz | psql findtime_restoretest
psql findtime_restoretest -c '\dt'
dropdb findtime_restoretest
```

### Not covered by any of the above

- **The router.** Any pre-existing port forward or UPnP-opened port is exposed
  independently of this app. Worth auditing in the router admin page.
- **No authentication.** Anyone with a room code is in, by design. Codes are
  6 chars from a 32-symbol alphabet (~1.07 billion), so guessing is
  impractical, but there is no account model.

## Routine operations

```bash
# Deploy the latest commit
cd ~/findtime && git pull && npm install --omit=dev && sudo systemctl restart findtime

# Logs
journalctl -u findtime -f

# Back up the database
pg_dump findtime > ~/findtime-$(date +%F).sql

# Restore
psql findtime < ~/findtime-2026-07-25.sql
```

Expired rooms are deleted automatically — the server purges them hourly and at
startup, cascading to participants and availability.
