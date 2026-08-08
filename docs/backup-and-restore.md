# Backup and Restore

## Backup

Run:

```bash
scripts/backup.sh
```

Every complete backup must contain both the PostgreSQL database and the `papertrail_pdf_data` volume, in addition to the existing import/export file volume. PostgreSQL contains document metadata and version links, but not PDF binaries; restoring the database alone leaves every full-text document unavailable.

PostgreSQL also contains LLM project settings, schema versions, page-aware extracted text, immutable run results and metrics, evidence verification, and reviewer-versus-suggestion provenance. These derived records require no additional volume, but must be restored with the matching PDF snapshot because every record pins a stable PDF document version.

The bundled backup script predates PDF storage and archives the database plus import/export files. Until it is extended, separately snapshot or archive `papertrail_pdf_data` using your Docker-volume or host backup tooling. Keep the database and PDF-volume snapshots from the same maintenance window. Store backups outside the Papertrail host and protect them because PDFs and review data may be sensitive.

## Restore

On a compatible Papertrail installation, run:

```bash
scripts/restore.sh ./backups/papertrail-YYYYMMDDTHHMMSSZ
```

The restore operation stops application services, replaces the database and import/export file volume, reapplies migrations, and restarts Papertrail. Restore the matching `papertrail_pdf_data` snapshot as part of the same operation before allowing users back into the application. Test database, file-volume, and PDF-volume restoration periodically on a separate host.
