#!/usr/bin/env bash
# Backup local state: RustFS objects + n8n DB/encryption key + this repo's config.
# ponytail: local dir copy only; for cloud, swap rsync for `rclone sync ... r2:bucket`.
set -euo pipefail
cd "$(dirname "$0")"
DEST="${1:-${BACKUP_DIR:-$HOME/video-factory-backups}}/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"
sqlite3 "$HOME/.n8n/database.sqlite" ".backup '$DEST/n8n.sqlite'"   # consistent while n8n runs
cp "$HOME/.n8n/config" "$DEST/n8n-config"                           # encryption key: creds unreadable without it
rsync -a data/s3/ "$DEST/s3/"
cp .env docker-compose.yml "$DEST/"
chmod -R go-rwx "$DEST"
echo "$DEST"
