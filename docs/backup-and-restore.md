# Backup and Restore

Papertrail's authoritative state spans PostgreSQL plus two persistent Docker volumes:

- `papertrail_files` — imported source files and generated exports;
- `papertrail_pdf_data` — stored full-text PDF versions.

PostgreSQL contains bibliographic/workflow state, PDF metadata and stable document-version links, audit data, form versions, extracted page text, LLM settings/runs/evidence, notification state, and credentials saved through Global Settings. A database-only backup is therefore incomplete, and a volume-only backup cannot reconstruct the review state.

## Create a backup

From the repository/deployment directory, run:

```bash
scripts/backup.sh
```

The default destination is:

```text
./backups/papertrail-YYYYMMDDTHHMMSSZ/
```

You can provide another directory:

```bash
scripts/backup.sh /mnt/backup/papertrail-2026-08-22
```

The script briefly stops `frontend`, `api`, `worker`, and `llm-worker` so that PostgreSQL, imported/exported files, and PDFs represent one consistent maintenance-window snapshot. PostgreSQL remains running for `pg_dump`. Services that were running before the backup are started again after a successful normal backup; if the backup itself fails, the script also attempts to restore the previous running state.

A version-2 backup contains:

```text
database.dump       PostgreSQL custom-format dump
files.tar.gz        papertrail_files volume
pdfs.tar.gz         papertrail_pdf_data volume
BACKUP_INFO.txt     backup format/timestamp/database metadata
SHA256SUMS.txt      portable SHA-256 checksums
[environment.env]   exact deployment .env, when .env existed
```

### Backups contain sensitive data

`environment.env` is an **exact copy of the deployment `.env`**, not a sanitized example. It can contain PostgreSQL credentials, the initial administrator password, SMTP credentials, Ollama API keys, internal hostnames, and other infrastructure configuration.

Even when no `.env` file is present, PostgreSQL can contain SMTP/Ollama secrets saved through Global Settings. Treat the entire backup directory as sensitive research/credential material. Store it outside the Papertrail host, encrypt it at rest, restrict access, and include it in your normal secret-rotation/retention policy.

`environment.env` is included for disaster-recovery reference. The restore script deliberately does **not** overwrite the current deployment's `.env` automatically.

## Upgrade backups

`scripts/upgrade.sh` calls:

```bash
scripts/backup.sh --leave-stopped ...
```

The same consistency-preserving backup is created, but successful backup completion leaves the application services stopped so the migration can run without old application processes writing to the database. This option is intended for scripted maintenance; normal manual backups should omit it.

## Restore

Restore into a compatible Papertrail deployment from the repository/deployment directory:

```bash
scripts/restore.sh ./backups/papertrail-YYYYMMDDTHHMMSSZ
```

Before making destructive changes, the restore script:

1. checks that `database.dump`, `files.tar.gz`, and `pdfs.tar.gz` exist;
2. verifies `SHA256SUMS.txt` when it is present;
3. stops `frontend`, `api`, `worker`, and `llm-worker`;
4. ensures PostgreSQL is running and ready.

It then replaces the configured PostgreSQL database, fully replaces both application volumes (including hidden files), runs the current migration container, and starts the Compose deployment again.

If a legacy backup has no `SHA256SUMS.txt`, restore prints a warning and continues; verify such archives through your external backup system before using them in production.

### Environment/configuration during restore

Docker Compose uses the **current deployment's** `.env` to configure the PostgreSQL/container environment. The restore script reads the active database name and user from the running PostgreSQL container rather than sourcing `.env` as a shell script. If restoring onto a new host, prepare a valid `.env` first. Compare it with the backup's `environment.env` if available, but do not blindly copy old public hostnames, proxy addresses, secrets, or image tags.

The migration container idempotently creates the configured administrator only if needed; restoring the database preserves existing accounts and password hashes.

## Post-restore verification

Before reopening the service to normal users, verify at least:

```bash
docker compose ps
curl -f http://127.0.0.1:${PAPERTRAIL_API_PORT:-8000}/health
curl -f http://127.0.0.1:${PAPERTRAIL_API_PORT:-8000}/ready
```

Then perform a representative application check:

- sign in;
- open an existing project;
- open a stored PDF and a prior PDF version if one exists;
- inspect a screening/extraction record;
- generate or download an export;
- inspect failed/background jobs;
- if enabled, test SMTP and Ollama separately.

Test the complete restore procedure periodically on an isolated host. A backup that has never been restored is not a verified disaster-recovery plan.
