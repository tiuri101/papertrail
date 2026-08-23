# Architecture

Papertrail is an API-first modular monolith. A React/TypeScript single-page application communicates with a FastAPI backend. PostgreSQL is the authoritative store for bibliographic records, workflow state, sessions, audit events, queue reservations, background jobs, notification state, form versions, LLM configuration/results, extracted page text, and PDF metadata/version links. PDF binaries live in a dedicated persistent filesystem volume. The optional Chrome Browser Helper executes publisher retrieval work on the reviewer's computer. Optional SMTP and Ollama integrations are external services.

```text
React SPA -------------------------------+
                                         | session cookie + CSRF
Chrome Browser Helper -------------------| bearer agent token
                                         v
                                  +-------------+
                                  |   FastAPI   |
                                  +------+------+ 
                                         |
                          +--------------+--------------+
                          |                             |
                    +-----v-----+                 +-----v------+
                    | PostgreSQL |                 | PDF volume |
                    +-----+-----+                 +------------+
                          |
              +-----------+-----------+
              |                       |
       +------v-------+        +------v-------+
       | normal worker |        |  LLM worker  |
       +------+-------+        +------+-------+
              |                       |
            SMTP                    Ollama
              |
       notification mail

The production frontend is a separate static container. An external reverse proxy
normally exposes the frontend and `/api` under the public HTTPS hostname.
```

## Backend modules

`backend/app/` is organized by domain rather than by technical layer alone. Current major domains include:

- `accounts` — local users, sessions, login/reset throttling, self-service account settings;
- `projects` — project model, membership/eligibility, criteria/RQs, screening configuration, lifecycle/integrity operations;
- `imports` — search documentation, bibliographic imports, bulk PDF matching;
- `publications` — normalized records, metadata editing/enrichment, exports for individual records;
- `deduplication` — duplicate scoring, merge/reversal;
- `screening` and `conflicts` — reviewer work, revisions, final decisions, conflict resolution;
- `fulltext` — human retrieval status and protected PDF document/version management;
- `pdf_acquisition` — Browser Helper pairing, batches, externally executed PDF retrieval jobs;
- `forms` — extraction/quality form templates, versions, and fields;
- `review_work` — shared extraction/quality allocation and progress mechanics;
- `extraction` and `quality` — reviewer responses and authoritative results;
- `analysis` — stage narratives, reviewer agreement, research-question analysis endpoints/jobs;
- `reporting` — PRISMA, final results, Evidence Matrix, exports;
- `llm` — installation/project settings, prompts, task orchestration, evidence validation, immutable runs;
- `notifications` — durable email notification records/templates/delivery;
- `instance_settings` — administrator-managed database overrides for selected installation settings;
- `jobs` — durable server-side job queue, leasing, diagnostics, retries;
- `audit` — project audit trail, dashboard/progress read models;
- `integrations` — external metadata clients.

Most API-facing domains broadly separate request validation/authorization, business/service logic, persistence models, and schemas. Some domains deliberately have additional specialized modules where the responsibility is large enough to warrant it. Cross-domain workflow changes should go through explicit service functions and database transactions rather than ad-hoc direct writes.

## Authentication and authorization

The web application uses opaque PostgreSQL-backed sessions in an HTTP-only cookie. Login/session responses provide a CSRF token, and mutating session-authenticated API requests require `X-CSRF-Token`.

Authorization is checked server-side. The installation administrator can manage all projects and local user accounts. Each project creator becomes its owner with project-scoped management rights. Membership additionally carries reviewer eligibility for title/abstract screening, full-text screening, extraction, quality assessment, and adjudication.

The Browser Helper uses a separate opaque bearer token that is valid only for `/api/v1/browser-agent/...` endpoints. A one-time, short-lived pairing secret minted from the normal session flow is exchanged for that agent token; only its hash is stored server-side.

## Browser-assisted PDF retrieval

`pdf_acquisition` is intentionally separate from `fulltext`. `fulltext` owns the authoritative human retrieval state and the protected PDF/document-version pipeline; `pdf_acquisition` owns work executed externally by a paired Chrome extension.

A `PdfRetrievalBatch` groups `PdfRetrievalJob` rows created for a manual **Retrieve missing PDFs** operation. In addition, when a title/abstract final decision becomes **Include**, Papertrail can immediately auto-queue that publication for browser retrieval when it is still missing a PDF and the workflow has an eligible paired helper. This avoids waiting for a later batch action.

Retrieval jobs are not `BackgroundJob` rows because they are executed by the browser rather than a server worker. They use short expiring leases and `SELECT ... FOR UPDATE SKIP LOCKED` when claimed. The extension gets only the publication information necessary for retrieval and cannot choose an arbitrary upload target; the server derives the publication from the claimed job.

The extension discovers/fetches a likely publisher PDF through Chrome and performs an early validity check. FastAPI independently revalidates the upload and attaches it through the same PDF pipeline used by manual uploads, tagged with `DocumentSource.BROWSER_RETRIEVAL`. Only a successful PDF attachment automatically changes authoritative retrieval state to available. Authentication failures, not-found responses, access denial, invalid content, or network errors do not mark a human retrieval outcome.

See [Browser Helper](browser-helper.md) for installation and operation.

## Background work

Server-side background work is stored in PostgreSQL as durable `BackgroundJob` rows. Worker claims use short row-locking transactions and leases; a heartbeat renews active leases. Worker threads use independent SQLAlchemy sessions. Interrupted jobs whose leases expire become claimable again, and failed jobs retain diagnostics/retry state.

The normal worker handles jobs such as imports, metadata enrichment, duplicate detection, export generation, PDF text extraction, and email delivery. Optional SMTP notifications are represented by durable, deduplicated notification records and queued delivery jobs so mail-server failure does not roll back the originating domain action.

LLM assistance uses the same durable queue and a separate `llm-worker` process with its own concurrency limit. The LLM-only worker claims every job type that calls Ollama (screening/extraction/validation inference and research-question synthesis), while non-LLM work remains available to the normal worker.

Project managers can inspect a project's job list, stage summary, failed-job diagnostics, and restart eligible failed jobs through the project Jobs UI/API.

## Reviewer queues

Screening, extraction, and quality work use durable work-item rows rather than long-held database locks. Claim/pre-assignment behavior depends on the configured allocation mode. Screening can additionally use independent allocation where every eligible reviewer sees every publication.

Queue order uses deterministic ranks derived from project/reviewer/workflow inputs. Claim operations are atomic. Reviewer reservations are stored as data with an expiry rather than as long-running DB transactions.

## Data preservation

Imported source rows remain linked to normalized publications for provenance. Duplicate merges choose a canonical publication while preserving merge history and supporting reversal.

Each PDF version has a stable document ID and storage key. One active document can exist per publication; replacement and logical removal preserve earlier metadata/files as history. Duplicate merges transfer documents to the canonical publication and retain conflicting files as historical versions rather than silently deleting them.

Reviewer screening decisions and revisions remain separate from authoritative `FinalDecision` rows. Extraction similarly keeps individual slot responses separate from the authoritative `FinalExtraction`. One- or two-extractor projects therefore retain the original reviewer submissions even when automatic agreement, reconciliation, or manager override establishes the current final result.

Dynamic extraction/quality forms use versions and stable field identifiers so later form edits can preserve and reinterpret existing data explicitly rather than silently changing its meaning.

## LLM and evidence traceability

LLM assistance separates HTTP transport, page-aware PDF text extraction, task-specific prompts, schema/version management, structured validation, evidence verification, orchestration, and reviewer integration. Suggestions are immutable/advisory and remain separate from authoritative human screening and extraction data.

`reporting/evidence_dataset.py` is the canonical read-side projection used by the Evidence Matrix and research-question synthesis to resolve the current authoritative extraction/quality value and any traceable suggestion evidence. Research-question synthesis operates on authoritative structured results rather than raw individual reviewer responses.

## Deployment

The production `docker-compose.yml` defines:

- `postgres` — PostgreSQL 18;
- `migrate` — one-shot Alembic migration plus idempotent administrator bootstrap;
- `api` — FastAPI/Uvicorn;
- `worker` — normal server-side background worker;
- `llm-worker` — dedicated Ollama-oriented worker process;
- `frontend` — built React assets served by Nginx.

Backend and frontend images are pulled as `tiuri101/papertrail-backend:${PAPERTRAIL_IMAGE_TAG}` and `tiuri101/papertrail-frontend:${PAPERTRAIL_IMAGE_TAG}`. Current CI publishes `linux/amd64` images.

`papertrail_files` stores imports/exports, `papertrail_pdf_data` stores PDFs, and `papertrail_postgres_data` stores PostgreSQL. The API and frontend ports bind to loopback by default; an external reverse proxy is expected for public HTTPS deployments. PDF content is never exposed as a static public directory.

See [Configuration](configuration.md), [Installation](installation.md), and [Security Operations](operations/security.md).
