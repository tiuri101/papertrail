#!/usr/bin/env sh
set -eu

backup_destination=${1:-./backups/pre-upgrade-$(date -u +%Y%m%dT%H%M%SZ)}

echo "Pulling target Papertrail images while the current installation remains online..."
docker compose pull postgres api worker llm-worker frontend migrate

echo "Creating a consistent pre-upgrade backup and quiescing application services..."
scripts/backup.sh --leave-stopped "$backup_destination"

echo "Applying database migrations..."
if ! docker compose run --rm migrate; then
  echo "Migration failed. Application services remain stopped." >&2
  echo "Investigate the migration error or restore $backup_destination before restarting Papertrail." >&2
  exit 1
fi

echo "Starting upgraded services..."
docker compose up -d --remove-orphans

echo "Upgrade completed. Verify docker compose ps and the API /health and /ready endpoints."
