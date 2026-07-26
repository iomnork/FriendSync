#!/usr/bin/env bash
#
# Nightly database backup. Runs as nickspi from cron — no sudo, no password,
# because peer auth over the Unix socket already trusts this user.
#
# Install:  crontab -l | { cat; echo "0 3 * * * $HOME/findtime/deploy/backup.sh"; } | crontab -
#
set -euo pipefail

DB="${PGDATABASE:-findtime}"
DIR="${BACKUP_DIR:-$HOME/backups}"
KEEP="${KEEP_DAYS:-14}"
LOG="$DIR/backup.log"

mkdir -p "$DIR"
OUT="$DIR/${DB}-$(date +%F).sql.gz"

log() { echo "$(date -Is)  $*" >> "$LOG"; }

# Write to a temp file and move into place only on success. A dump interrupted
# half way through would otherwise leave a truncated file that looks like a
# valid backup right up until the moment you need it.
if pg_dump "$DB" | gzip > "$OUT.tmp" 2>>"$LOG"; then
  mv "$OUT.tmp" "$OUT"
  log "OK   $OUT ($(du -h "$OUT" | cut -f1))"
else
  rm -f "$OUT.tmp"
  log "FAIL pg_dump of $DB failed"
  exit 1
fi

# Refuse to trust a backup that is suspiciously small — an empty database dumps
# to a few hundred bytes, and silently keeping those would be worse than none.
SIZE=$(stat -c %s "$OUT")
if [ "$SIZE" -lt 400 ]; then
  log "WARN $OUT is only ${SIZE}b — is the database empty?"
fi

# Rotate: keep the newest $KEEP, delete the rest.
REMOVED=$(ls -1t "$DIR/${DB}-"*.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) || true)
if [ -n "$REMOVED" ]; then
  echo "$REMOVED" | xargs -r rm --
  log "ROTA removed $(echo "$REMOVED" | wc -l) backup(s) older than $KEEP days"
fi
