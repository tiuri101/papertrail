# Upgrade Guide

1. Read the release notes and confirm supported database and container versions.
2. Run `scripts/upgrade.sh`. The script creates a backup, pulls base images, rebuilds Papertrail, applies migrations, and restarts services.
3. Check `docker compose ps` and the API health endpoint.
4. Run a representative login, project, queue, and export check.

Do not skip backups. Database migrations are forward migrations; rollback should be performed by restoring the pre-upgrade backup rather than manually reversing production data changes.
