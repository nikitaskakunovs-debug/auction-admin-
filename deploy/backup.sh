#!/usr/bin/env bash
# Nightly Postgres backup → DigitalOcean Spaces (S3). Install on the droplet:
#   apt-get install -y s3cmd && s3cmd --configure   (Spaces key/secret, fra1)
#   crontab -e →  15 3 * * * /opt/auction/deploy/backup.sh >> /var/log/auction-backup.log 2>&1
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="/tmp/auction-${STAMP}.sql.gz"
BUCKET="${BACKUP_BUCKET:-$(grep -oP '^S3_BUCKET=\K.*' "$DIR/.env")}"

docker compose -f "$DIR/docker-compose.prod.yml" exec -T postgres \
  pg_dump -U auction auction | gzip > "$FILE"

s3cmd put "$FILE" "s3://${BUCKET}/backups/$(basename "$FILE")"
rm -f "$FILE"

# Prune remote backups older than 14 days.
CUTOFF="$(date -d '14 days ago' +%Y%m%d)"
s3cmd ls "s3://${BUCKET}/backups/" | awk '{print $4}' | while read -r obj; do
  name="$(basename "$obj")"
  day="$(echo "$name" | grep -oP 'auction-\K[0-9]{8}' || true)"
  if [ -n "$day" ] && [ "$day" -lt "$CUTOFF" ]; then
    s3cmd del "$obj"
  fi
done

echo "backup ok: ${STAMP}"
