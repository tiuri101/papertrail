#!/usr/bin/env sh
set -eu

backup=${1:?Usage: scripts/restore.sh PATH_TO_BACKUP_DIRECTORY}
backup_abs=$(cd "$backup" && pwd)

for required in database.dump files.tar.gz pdfs.tar.gz; do
  [ -f "$backup_abs/$required" ] || {
    echo "Missing $required" >&2
    exit 1
  }
done

if [ -f "$backup_abs/SHA256SUMS.txt" ]; then
  echo "Verifying backup checksums..."
  (
    cd "$backup_abs"
    sha256sum -c SHA256SUMS.txt
  )
else
  echo "WARNING: backup has no SHA256SUMS.txt; integrity cannot be verified automatically." >&2
fi

echo "Stopping application services..."
docker compose stop frontend worker llm-worker api >/dev/null

echo "Ensuring PostgreSQL is running..."
docker compose up -d postgres >/dev/null
attempt=0
until docker compose exec -T postgres sh -c \
  'exec pg_isready --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"' \
  >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "PostgreSQL did not become ready; application services remain stopped." >&2
    exit 1
  fi
  sleep 2
done

echo "Restoring database..."
docker compose exec -T postgres sh -c \
  'exec dropdb --username "$POSTGRES_USER" --if-exists "$POSTGRES_DB"'
docker compose exec -T postgres sh -c \
  'exec createdb --username "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T postgres sh -c \
  'exec pg_restore --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --exit-on-error' \
  < "$backup_abs/database.dump"

echo "Restoring imported files and exports..."
docker run --rm \
  -v papertrail_files:/data \
  -v "$backup_abs":/backup:ro \
  alpine:3.22 sh -c \
  'find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -C /data -xzf /backup/files.tar.gz'

echo "Restoring stored PDFs..."
docker run --rm \
  -v papertrail_pdf_data:/pdf-data \
  -v "$backup_abs":/backup:ro \
  alpine:3.22 sh -c \
  'find /pdf-data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -C /pdf-data -xzf /backup/pdfs.tar.gz'

echo "Applying migrations and restarting services..."
docker compose run --rm migrate
docker compose up -d --remove-orphans

echo "Restore completed. Verify /health, /ready, sign-in, a stored PDF, and a representative export before resuming normal use."
if [ -f "$backup_abs/environment.env" ]; then
  echo "The backup contains environment.env for disaster-recovery reference; it was not copied over the current .env."
fi
