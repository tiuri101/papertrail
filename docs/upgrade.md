# Upgrade Guide

Papertrail database migrations are forward migrations. The supported rollback strategy for production data is restoration of the pre-upgrade backup, not manually reversing migration steps against a live database.

## Standard upgrade

1. Read the release notes and confirm database/container compatibility.
2. Set `PAPERTRAIL_IMAGE_TAG` in `.env` to the release you intend to deploy.
3. Run:

   ```bash
   scripts/upgrade.sh
   ```

   You may optionally supply the pre-upgrade backup directory:

   ```bash
   scripts/upgrade.sh /mnt/backup/papertrail-pre-upgrade
   ```

The current script performs the following sequence:

1. pulls the configured PostgreSQL/backend/frontend images while the existing application is still online;
2. creates a consistency-preserving PostgreSQL + file-volume + PDF-volume backup;
3. leaves the application writers stopped after that backup;
4. runs the one-shot migration/admin-bootstrap container while the old API/workers remain stopped;
5. starts the updated Compose services with `--remove-orphans`.

The script does **not** build images locally; production images are pulled from the image references in `docker-compose.yml` using `PAPERTRAIL_IMAGE_TAG`.

If the migration command fails, the script exits with the application services still stopped. Investigate the migration error or restore the printed pre-upgrade backup before restarting Papertrail; do not start an older application binary against a database that may have been partially migrated.

## Verification

After a successful upgrade:

```bash
docker compose ps
curl -f http://127.0.0.1:${PAPERTRAIL_API_PORT:-8000}/health
curl -f http://127.0.0.1:${PAPERTRAIL_API_PORT:-8000}/ready
```

Then test at least:

- sign-in/session bootstrap;
- opening a representative project;
- the active reviewer queue;
- a stored PDF;
- one background job or export;
- Browser Helper pairing/retrieval if that feature is used;
- SMTP/Ollama connectivity if those integrations are enabled.

Keep the pre-upgrade backup until the upgraded installation has been verified and your normal backup-retention policy has taken over.
