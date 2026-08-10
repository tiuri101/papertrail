#!/usr/bin/env sh
set -eu

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
destination=${1:-"./backups/papertrail-$stamp"}
mkdir -p "$destination"

echo "Backing up PostgreSQL..."
docker compose exec -T postgres pg_dump \
  --username "${POSTGRES_USER:-papertrail}" \
  --dbname "${POSTGRES_DB:-papertrail}" \
  --format=custom > "$destination/database.dump"

echo "Backing up imported files and exports..."
docker run --rm \
  -v papertrail_files:/data:ro \
  -v "$(cd "$destination" && pwd)":/backup \
  alpine:3.22 tar -C /data -czf /backup/files.tar.gz .

echo "Backing up stored PDFs..."
docker run --rm \
  -v papertrail_pdf_data:/pdf-data:ro \
  -v "$(cd "$destination" && pwd)":/backup \
  alpine:3.22 tar -C /pdf-data -czf /backup/pdfs.tar.gz .

cp .env "$destination/environment.example" 2>/dev/null || true
sha256sum "$destination/database.dump" "$destination/files.tar.gz" "$destination/pdfs.tar.gz" > "$destination/SHA256SUMS.txt"
echo "Backup written to $destination"
