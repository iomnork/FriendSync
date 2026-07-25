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

## 4. Public access via Cloudflare Tunnel

Gives an HTTPS URL without port forwarding; the Pi dials out, so nothing is
exposed inbound.

```bash
# Install (arm64)
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb -o /tmp/cf.deb
sudo dpkg -i /tmp/cf.deb

# Authenticate — opens a browser, pick the domain you added to Cloudflare
cloudflared tunnel login

# Create the tunnel and point a hostname at the local app
cloudflared tunnel create findtime
cloudflared tunnel route dns findtime findtime.<your-domain>

# Run it as a service
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

Tunnel config lives at `/etc/cloudflared/config.yml`:

```yaml
tunnel: findtime
credentials-file: /root/.cloudflared/<TUNNEL-UUID>.json
ingress:
  - hostname: findtime.<your-domain>
    service: http://localhost:3000
  - service: http_status:404
```

> Cloudflare Tunnel needs a domain on a Cloudflare account. For a throwaway
> test URL with no domain, `cloudflared tunnel --url http://localhost:3000`
> prints a temporary `*.trycloudflare.com` address that dies with the process.

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
