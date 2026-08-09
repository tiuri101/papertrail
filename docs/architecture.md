# Architecture

Papertrail is an API-first modular monolith. A React/TypeScript single-page application communicates with a FastAPI backend. PostgreSQL is the authoritative store for bibliographic records, PDF metadata and version links, workflow state, sessions, audit events, queue reservations, background jobs, durable email notifications, LLM schemas, page text, immutable LLM runs, suggestions, and reviewer provenance. PDF binaries are held in a dedicated persistent filesystem volume. An optional dedicated worker communicates over HTTP with an independently operated Ollama server.

```text
Browser (React/TypeScript)
          |
  external reverse proxy (out of scope)
       /     \
  FastAPI   static frontend
      |
 PostgreSQL <---- threaded worker
      |              |
 PDF metadata    imports, PDF matching,
      |          duplicate scoring, exports
 PDF volume
```

## Backend modules

The backend is divided by domain: accounts, projects, imports, publications, deduplication, screening, conflicts, full text, forms, extraction, quality, reporting, audit, integrations, and jobs. FastAPI routes perform validation and authorization, then call domain services. Cross-module workflow changes use explicit service functions and database transactions.

## Background work

A dedicated worker process polls a durable PostgreSQL job table and dispatches claimed jobs through `ThreadPoolExecutor`. Claims use leases and short row-locking transactions. Threads create independent SQLAlchemy sessions. Imports, enrichment, duplicate detection, and export generation are idempotent or safely retryable.

Optional SMTP delivery uses the same queue. Domain actions create a deduplicated `email_notifications` record and enqueue a lightweight `send_email` job in the same transaction. The recipient address is snapshotted for deterministic delivery, while SMTP credentials remain backend-only.

## Reviewer queues

Screening, extraction, and quality work items use deterministic ranks derived from the global seed, project, publication, and stage. A short transaction atomically claims an item; the one-day user reservation is stored as data rather than as a long-running database lock.

## Data preservation

Imported source rows are immutable and linked to normalized publications. Each PDF version has a stable document ID and generated storage key; one partial unique index permits at most one active PDF per publication. Replacement and logical removal preserve prior metadata and files. Duplicate merges transfer every document to the canonical publication and retain conflicting files as history. Individual reviewer decisions and revisions remain separate from PDF availability and final project decisions. Dynamic forms use immutable versions and stable field identifiers.

LLM assistance keeps HTTP transport, page-aware PDF extraction, schema/version management, task-specific versioned prompts, structured validation, evidence verification, orchestration, and reviewer integration separate. A shared immutable run lifecycle covers title/abstract screening, full-text screening, data extraction, and extraction validation. Deterministic fingerprints expose stale results when metadata, criteria, PDFs, text, forms, human responses, prompts, or the configured model change. LLM fields map to stable extraction-field keys, while all suggestions remain separate from authoritative decisions and extraction responses. Normal workers claim text jobs; the LLM-only worker claims inference jobs with its own concurrency limit through the same leased PostgreSQL queue.

## Deployment

Docker Compose runs PostgreSQL, a one-shot migration container, FastAPI, the threaded worker, and the built React frontend, pulling the backend and frontend images published as `tiuri101/papertrail-backend` and `tiuri101/papertrail-frontend`. The frontend and API each publish their own configurable host port (`PAPERTRAIL_FRONTEND_PORT`, `PAPERTRAIL_API_PORT`); routing them under a single public hostname is handled by an external reverse proxy outside this project's scope. Original imports and generated exports share a persistent application-file volume; PDFs use a separate `papertrail_pdf_data` volume mounted only by FastAPI and the worker. PDF content is never exposed as static storage.
