# Reliability Operations

Background work is persisted in PostgreSQL. Worker claims use leases; a heartbeat renews active leases, and an expired lease makes interrupted jobs claimable again. Jobs must be idempotent. Export generation uses one artifact per job, and import/enrichment handlers should only apply changes that are not already present.

Use PostgreSQL backups and test restoration regularly. The database and file-volume backup should represent the same application point in time. During upgrades, stop API writes and workers before applying migrations.
