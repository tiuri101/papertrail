# Architecture

Papertrail is an API-first modular monolith. A React/TypeScript single-page application communicates with a FastAPI backend. PostgreSQL is the authoritative store for bibliographic records, workflow state, sessions, audit events, queue reservations, and background jobs.

```text
Browser (React/TypeScript)
          |
        Caddy
       /     \
  FastAPI   static frontend
      |
 PostgreSQL <---- threaded worker
      |              |
 file metadata   imports, enrichment,
                 duplicate scoring, exports
```

## Backend modules

The backend is divided by domain: accounts, projects, imports, publications, deduplication, screening, conflicts, full text, forms, extraction, quality, reporting, audit, integrations, and jobs. FastAPI routes perform validation and authorization, then call domain services. Cross-module workflow changes use explicit service functions and database transactions.

## Background work

A dedicated worker process polls a durable PostgreSQL job table and dispatches claimed jobs through `ThreadPoolExecutor`. Claims use leases and short row-locking transactions. Threads create independent SQLAlchemy sessions. Imports, enrichment, duplicate detection, and export generation are idempotent or safely retryable.

## Reviewer queues

Screening, extraction, and quality work items use deterministic ranks derived from the global seed, project, publication, and stage. A short transaction atomically claims an item; the one-day user reservation is stored as data rather than as a long-running database lock.

## Data preservation

Imported source rows are immutable and linked to normalized publications. Duplicate merges preserve source relationships and are reversible. Individual reviewer decisions and revisions remain separate from final project decisions. Dynamic forms use immutable versions and stable field identifiers.

## Deployment

Docker Compose runs PostgreSQL, a one-shot migration container, FastAPI, the threaded worker, the built React frontend, and Caddy. Original imports and generated exports share a persistent application-file volume. Caddy can provide local HTTP or automatic HTTPS for a configured hostname.
