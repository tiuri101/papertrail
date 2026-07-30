#!/usr/bin/env sh
set -eu

backup=${1:?Usage: scripts/restore.sh PATH_TO_BACKUP_DIRECTORY}
[ -f "$backup/database.dump" ] || { echo "Missing database.dump" >&2; exit 1; }
[ -f "$backup/files.tar.gz" ] || { echo "Missing files.tar.gz" >&2; exit 1; }

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

echo "Stopping application services..."
docker compose stop gateway frontend worker api

echo "Restoring database..."
docker compose exec -T postgres dropdb \
  --username "${POSTGRES_USER:-papertrail}" \
  --if-exists "${POSTGRES_DB:-papertrail}"
docker compose exec -T postgres createdb \
  --username "${POSTGRES_USER:-papertrail}" \
  "${POSTGRES_DB:-papertrail}"
docker compose exec -T postgres pg_restore \
  --username "${POSTGRES_USER:-papertrail}" \
  --dbname "${POSTGRES_DB:-papertrail}" \
  --clean --if-exists < "$backup/database.dump"

echo "Restoring files..."
docker run --rm \
  -v papertrail_files:/data \
  -v "$(cd "$backup" && pwd)":/backup:ro \
  alpine:3.22 sh -c 'rm -rf /data/* && tar -C /data -xzf /backup/files.tar.gz'

echo "Applying migrations and restarting services..."
docker compose run --rm migrate
docker compose up -d
