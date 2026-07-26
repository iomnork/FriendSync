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
