#!/usr/bin/env sh
set -eu

scripts/backup.sh "${1:-./backups/pre-upgrade-$(date -u +%Y%m%dT%H%M%SZ)}"
docker compose pull postgres api worker llm-worker frontend migrate
docker compose run --rm migrate
docker compose up -d --remove-orphans
