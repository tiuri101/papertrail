#!/usr/bin/env sh
set -eu

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

: "${PAPERTRAIL_ADMIN_PASSWORD:?Set PAPERTRAIL_ADMIN_PASSWORD in the environment or .env}"
docker compose exec -T \
  -e PAPERTRAIL_ADMIN_USERNAME="${PAPERTRAIL_ADMIN_USERNAME:-admin}" \
  -e PAPERTRAIL_ADMIN_DISPLAY_NAME="${PAPERTRAIL_ADMIN_DISPLAY_NAME:-Papertrail Administrator}" \
  -e PAPERTRAIL_ADMIN_PASSWORD="$PAPERTRAIL_ADMIN_PASSWORD" \
  api python -m app.cli create-admin
