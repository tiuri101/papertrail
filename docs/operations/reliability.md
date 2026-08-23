# Reliability Operations

Papertrail's durable state is split between PostgreSQL and two application file volumes. Reliability procedures must keep these stores and the background-job system consistent.

## Health and readiness

The API exposes:

- `GET /health` for basic process liveness;
- `GET /ready` for readiness.

Docker Compose uses `/health` for the API container healthcheck. The current `/ready` handler does not probe PostgreSQL or other dependencies, so do not use it as the sole criterion for routing traffic.

Also monitor `docker compose ps` for PostgreSQL, API, normal worker, LLM worker, and frontend state.

## Background jobs

Server-side background work is persisted in PostgreSQL. A worker claims jobs with an expiring lease and renews active leases with a heartbeat. If a process dies and the lease expires, the work can be claimed again.

Job handlers should therefore be idempotent or explicitly tolerate retry. Project managers can inspect project jobs, attempts, diagnostics, and restart eligible failed jobs through the Jobs UI/API.

Do not use repeated manual restarts as a substitute for fixing deterministic failures. Common external dependencies include SMTP, metadata services, PDF processing, and Ollama.

Browser Helper retrieval jobs are a separate externally executed queue with their own leases; they are not `BackgroundJob` rows. An expired Browser Helper claim can be retried without changing the authoritative human retrieval status.

## Backups

Use `scripts/backup.sh`. It briefly quiesces the application writers so the following are captured from one maintenance window:

- PostgreSQL custom-format dump;
- `papertrail_files` volume;
- `papertrail_pdf_data` volume;
- portable SHA-256 checksums;
- deployment `.env` when present.

Backups can contain both sensitive review data and credentials. Store them off-host, encrypted, and with tested retention/restore procedures.

See [Backup and Restore](../backup-and-restore.md).

## Restore testing

Periodically restore a backup on an isolated host and verify:

- checksum verification;
- sign-in and project data;
- stored/current and historical PDFs;
- screening/extraction state;
- export generation;
- migrations against the restored database;
- optional SMTP/Ollama connectivity when applicable.

Do not consider an untested archive a verified disaster-recovery plan.

## Upgrades and migrations

`scripts/upgrade.sh` implements a quiesced upgrade path:

1. pull target images while the current app remains online;
2. stop application writers while taking the pre-upgrade backup;
3. leave API/workers/frontend stopped;
4. run the migration/bootstrap container;
5. start the upgraded deployment.

If migration fails, application services remain stopped. Restore the pre-upgrade backup or correct the migration problem before restarting. Do not run an older application image against a database that may have been partially migrated.

Database migrations are forward migrations; production rollback is backup restoration.

## Storage monitoring

Monitor free space for:

- the PostgreSQL volume;
- `papertrail_files` imports/exports;
- `papertrail_pdf_data` PDF version history;
- external backup storage.

PDF replacement/removal is history-preserving, so PDF storage can continue to grow even when only one active document is shown for a publication. Export artifacts and retained imports also consume `papertrail_files`.

## External service outages

- **SMTP unavailable:** notification jobs can fail/retry; the originating account/project/workflow change is not rolled back.
- **Ollama unavailable:** LLM jobs can fail/retry; manual screening/extraction/reporting remains authoritative and should remain usable.
- **Browser Helper unavailable:** queued retrieval jobs remain pending/attention state; reviewers can still upload PDFs manually.
- **Metadata provider unavailable:** enrichment can fail without invalidating imported bibliographic data.

## Operational checks after maintenance

After backup/restore/upgrade or infrastructure changes, verify:

```bash
docker compose ps
curl -f http://127.0.0.1:${PAPERTRAIL_API_PORT:-8000}/health
curl -f http://127.0.0.1:${PAPERTRAIL_API_PORT:-8000}/ready
```

Then test login, one protected PDF, the active queue, and one background operation/export.
