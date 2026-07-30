# Backup and Restore

## Backup

Run:

```bash
scripts/backup.sh
```

The backup contains a PostgreSQL custom-format dump, an archive of import and export files, and SHA-256 checksums. Store backups outside the Papertrail host and protect them because they contain review data and account information.

## Restore

On a compatible Papertrail installation, run:

```bash
scripts/restore.sh ./backups/papertrail-YYYYMMDDTHHMMSSZ
```

The restore operation stops application services, replaces the database and file volume, reapplies migrations, and restarts Papertrail. Test restoration periodically on a separate host.
