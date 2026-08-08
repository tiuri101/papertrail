# Architecture

Papertrail is an API-first modular monolith. A React/TypeScript single-page application communicates with a FastAPI backend. PostgreSQL is the authoritative store for bibliographic records, PDF metadata and version links, workflow state, sessions, audit events, queue reservations, background jobs, LLM schemas, page text, immutable LLM runs, suggestions, and reviewer provenance. PDF binaries are held in a dedicated persistent filesystem volume. An optional dedicated worker communicates over HTTP with an independently operated Ollama server; clients never communicate with Ollama.

```text
Browser (React/TypeScript)
          |
        Caddy
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

## Reviewer queues

Screening, extraction, and quality work items use deterministic ranks derived from the global seed, project, publication, and stage. A short transaction atomically claims an item; the one-day user reservation is stored as data rather than as a long-running database lock.

## Data preservation

Imported source rows are immutable and linked to normalized publications. Each PDF version has a stable document ID and generated storage key; one partial unique index permits at most one active PDF per publication. Replacement and logical removal preserve prior metadata and files. Duplicate merges transfer every document to the canonical publication and retain conflicting files as history. Individual reviewer decisions and revisions remain separate from PDF availability and final project decisions. Dynamic forms use immutable versions and stable field identifiers.

LLM extraction keeps HTTP transport, page-aware PDF extraction, schema/version management, prompt construction, evidence verification, orchestration, and reviewer integration separate. Text and runs pin the exact document and schema versions. LLM fields map to stable extraction-field keys, while suggestions remain separate from authoritative extraction responses. Normal workers claim text jobs; the LLM-only worker claims inference jobs with its own concurrency limit through the same leased PostgreSQL queue.

## Deployment

Docker Compose runs PostgreSQL, a one-shot migration container, FastAPI, the threaded worker, the built React frontend, and Caddy. Original imports and generated exports share a persistent application-file volume; PDFs use a separate `papertrail_pdf_data` volume mounted only by FastAPI and the worker. PDF content is never exposed as static storage. Caddy can provide local HTTP or automatic HTTPS for a configured hostname.
