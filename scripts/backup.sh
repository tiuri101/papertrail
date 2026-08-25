#!/usr/bin/env sh
set -eu

# Every file this script creates -- the backup directory, the dump, the
# archives, the manifest -- must be readable only by whoever runs the backup.
# Setting this before `mkdir -p "$destination"` is what actually matters: a
# umask set afterwards would not affect a directory that already exists.
umask 077

usage() {
  cat <<'USAGE'
Usage: scripts/backup.sh [--leave-stopped] [DESTINATION]

Creates a consistent Papertrail backup containing PostgreSQL, the application
file volume, the PDF volume, checksums, and (when present) the deployment .env.
Application writers are stopped while the snapshot is taken. By default the
services that were running before the backup are started again afterwards.

--leave-stopped  Keep API/worker/frontend services stopped after a successful
                 backup. Intended for scripts/upgrade.sh.
USAGE
}

leave_stopped=0
if [ "${1:-}" = "--leave-stopped" ]; then
  leave_stopped=1
  shift
fi
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi
if [ "$#" -gt 1 ]; then
  usage >&2
  exit 2
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
destination=${1:-"./backups/papertrail-$stamp"}
mkdir -p "$destination"
# umask only governs newly created entries: if $destination already existed
# (e.g. a caller-supplied path) it may still carry looser permissions from
# whatever created it, so tighten it explicitly.
chmod 700 "$destination"
destination_abs=$(cd "$destination" && pwd)

running_app_services=$(
  docker compose ps --status running --services 2>/dev/null \
    | awk '/^(api|worker|llm-worker|frontend)$/' \
    || true
)
backup_complete=0

restart_previous_services() {
  if [ -n "$running_app_services" ]; then
    echo "Restarting application services that were running before the backup..."
    # shellcheck disable=SC2086
    docker compose start $running_app_services >/dev/null
  fi
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  # A failed backup should not leave the installation offline. A successful
  # --leave-stopped backup intentionally remains quiesced for an upgrade.
  if [ "$backup_complete" -ne 1 ] || [ "$leave_stopped" -ne 1 ]; then
    restart_previous_services || true
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

echo "Quiescing Papertrail application services for a consistent snapshot..."
docker compose stop frontend worker llm-worker api >/dev/null

echo "Backing up PostgreSQL..."
docker compose exec -T postgres sh -c \
  'exec pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format=custom' \
  > "$destination_abs/database.dump"

echo "Backing up imported files and exports..."
# The umask above only governs this shell's own file creation; `tar` runs
# inside a separate alpine container with its own default umask, so the
# archive's mode has to be tightened explicitly once it lands on the host.
docker run --rm \
  -v papertrail_files:/data:ro \
  -v "$destination_abs":/backup \
  alpine:3.22 tar -C /data -czf /backup/files.tar.gz .
chmod 600 "$destination_abs/files.tar.gz"

echo "Backing up stored PDFs..."
docker run --rm \
  -v papertrail_pdf_data:/pdf-data:ro \
  -v "$destination_abs":/backup \
  alpine:3.22 tar -C /pdf-data -czf /backup/pdfs.tar.gz .
chmod 600 "$destination_abs/pdfs.tar.gz"

cat > "$destination_abs/BACKUP_INFO.txt" <<INFO
format_version=2
created_at_utc=$stamp
INFO
docker compose exec -T postgres sh -c \
  'printf "postgres_database=%s\npostgres_user=%s\n" "$POSTGRES_DB" "$POSTGRES_USER"' \
  >> "$destination_abs/BACKUP_INFO.txt"

checksum_files="database.dump files.tar.gz pdfs.tar.gz BACKUP_INFO.txt"
if [ -f .env ]; then
  echo "Copying deployment environment (contains secrets)..."
  cp .env "$destination_abs/environment.env"
  chmod 600 "$destination_abs/environment.env" 2>/dev/null || true
  checksum_files="$checksum_files environment.env"
fi

(
  cd "$destination_abs"
  # shellcheck disable=SC2086
  sha256sum $checksum_files > SHA256SUMS.txt
)

backup_complete=1
if [ "$leave_stopped" -eq 0 ]; then
  restart_previous_services
  running_app_services=""
fi
trap - EXIT HUP INT TERM

echo "Backup written to $destination_abs"
if [ "$leave_stopped" -eq 1 ]; then
  echo "Application services remain stopped (--leave-stopped)."
fi
