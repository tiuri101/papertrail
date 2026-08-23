# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Papertrail is a self-hosted, multi-user tool for structured literature reviews (import → deduplicate → screen → retrieve full text → extract → quality-assess → report), with an optional local-LLM (Ollama) assistance layer that only ever suggests — reviewer decisions are always authoritative. It is an API-first modular monolith: a FastAPI backend (`backend/`), a React/TypeScript SPA (`frontend/`), and a standalone Chrome MV3 extension (`browser-extension/`) that performs browser-assisted PDF retrieval.

## Commands

### Backend (`cd backend`, with `.venv` active)

```powershell
python -m pytest                                    # run tests
python -m pytest path/to/test_file.py::test_name     # run a single test
python -m pytest --cov=app --cov-report=term-missing
python -m ruff check app tests
python -m mypy app
python -m alembic upgrade head
python -m alembic revision --autogenerate -m "describe the schema change"
```

Backend tests default to an in-memory SQLite engine (see `backend/tests/conftest.py`); they do not need the dev PostgreSQL container unless a test sets `PAPERTRAIL_TEST_DATABASE_URL` explicitly to target Postgres behavior.

### Frontend (`cd frontend`)

```powershell
npm run typecheck   # tsc -p tsconfig.app.json && tsc -p tsconfig.test.json (prod/test configs are separate)
npm run lint
npm test            # vitest run
npm run test:watch  # vitest, interactive
npm run build        # tsc -b && vite build
npm run test:e2e    # playwright test (npx playwright install chromium first)
npm run verify       # typecheck + lint + build + test + test:e2e, in that order
```

### Browser extension (`cd browser-extension`) — standalone package, not part of the frontend workspace

```powershell
npm run typecheck
npm run lint
npm test           # vitest run, jsdom + mocked chrome.* APIs (see tests/chrome-mock.ts); no real Chrome or network
npm run dev        # vite build --watch; load browser-extension/dist as an unpacked extension, no HMR
npm run build
```

### Local dev environment

Only PostgreSQL runs in Docker; FastAPI, the worker, and Vite run on the host. `.\scripts\dev.ps1 setup|start|api|worker|llm-worker|frontend|migrate|db-up|db-down|db-status|db-reset|test|test-e2e` (see `docs/local-development.md` for the macOS/Linux equivalent and manual step-by-step setup). LLM assistance is disabled by default; the general test suite never needs Ollama or a GPU.

## Architecture

### Backend module layout

`backend/app/` is divided by domain: `accounts`, `projects`, `imports`, `publications`, `deduplication`, `screening`, `conflicts`, `fulltext`, `pdf_acquisition`, `forms`, `review_work`, `extraction`, `quality`, `analysis`, `reporting`, `audit`, `notifications`, `instance_settings`, `integrations`, `llm`, and `jobs`. Most API-facing domains separate route validation/authorization from service/business logic and persistence models, but larger domains use additional specialized modules where appropriate. Cross-module workflow changes go through explicit service functions and DB transactions rather than ad-hoc direct writes.

### Background work

A dedicated worker process (`app.jobs.worker`) polls a durable PostgreSQL job table (`BackgroundJob`) and dispatches claimed work through `ThreadPoolExecutor`; claims use `SELECT ... FOR UPDATE SKIP LOCKED` leases and short row-locking transactions, and each thread gets its own SQLAlchemy session. Imports, metadata enrichment, duplicate detection, export generation, and email delivery are idempotent/safely retryable and run here — **never start this kind of work from a FastAPI request thread**. A separate resource-limited "LLM worker" (`python -m app.jobs.worker --llm`) claims LLM inference jobs through the same queue with its own concurrency limit.

### Browser-assisted PDF retrieval (`pdf_acquisition`)

A domain deliberately separate from `fulltext`, for PDFs retrieved by the optional paired `browser-extension/` rather than uploaded directly:

- The extension authenticates with its own opaque bearer token (`BrowserAgent`, hashed server-side, minted once via a single-use time-limited `BrowserAgentPairing` secret) — entirely separate from the session-cookie/CSRF mechanism the web UI uses, and unable to authenticate any other API.
- A `PdfRetrievalBatch` groups the `PdfRetrievalJob` rows for one manual "retrieve missing PDFs" action. A title/abstract final INCLUDE can also auto-queue an individual missing publication for an eligible paired helper. Jobs are leased to a claiming agent with a short expiring lease (same `SKIP LOCKED` pattern as the reviewer queues below) but are *not* `BackgroundJob`s — they execute externally, in the browser, not on a server-side worker.
- Publisher-specific logic (PDF discovery, redirect handling, per-publisher HTTP quirks) belongs in `browser-extension/` only, never in the backend. The backend only ever understands a publication, a retrieval job, a browser agent, and a PDF result.
- The extension uploads through the same `stage_pdf_upload`/`attach_staged_pdf` pipeline manual uploads use, tagged `DocumentSource.BROWSER_RETRIEVAL`. FastAPI re-validates every upload independently — the extension's own PDF/response validation is only an early rejection, never authoritative.
- Only a successful upload advances `FullTextRetrieval` to `AVAILABLE`. An automated retrieval failure (auth wall, not found, access denied, bad response, network error) must never mark a human retrieval outcome — it doesn't prove a human reviewer can't get the paper another way.
- The extension never forwards a publisher cookie, institutional credential, or captured `Cookie`/`Authorization` header to Papertrail.

### Reviewer queues

Screening, extraction, and quality work items use deterministic ranks derived from a global seed, project, publication, and stage. A short transaction atomically claims an item; the one-hour reservation is stored as data, not a long-running DB lock.

### Data preservation rules

Imported source rows are immutable and linked to normalized publications. Each PDF version has a stable document ID and generated storage key; a partial unique index permits at most one active PDF per publication. Replacement/removal preserve prior metadata and files rather than deleting them. Duplicate merges transfer every document to the canonical publication and retain conflicting files as history. Individual reviewer decisions stay separate from PDF availability and from final project decisions. Dynamic extraction forms use immutable versions with stable field identifiers, so historical answers stay valid as forms evolve.

### LLM assistance (`app/llm/`)

Keeps HTTP transport, page-aware PDF text extraction, schema/version management, task-specific versioned prompts, structured validation, evidence verification, orchestration, and reviewer integration in separate modules. A shared immutable run lifecycle covers title/abstract screening, full-text screening, extraction, and extraction validation. Deterministic fingerprints invalidate stale results when metadata, criteria, PDFs, text, forms, human responses, prompts, or the configured model change. Suggestions map to stable extraction-field keys and always stay separate from authoritative reviewer decisions.

### Storage split

PostgreSQL is authoritative for everything except PDF binaries: bibliographic records, PDF metadata/version links, workflow state, sessions, audit events, queue reservations, jobs, durable email notifications, LLM schemas/runs/suggestions. PDF binaries live in a dedicated persistent filesystem volume (`papertrail_pdf_data` in production; `backend/data/pdfs` locally), mounted only by FastAPI and the worker — PDF content is never served as static storage.

### Frontend

`frontend/src/features/<domain>/` mirrors the backend domains (screening, extraction, quality, fulltext, deduplication, audit, administration, llm, ...); shared UI lives in `src/components/`, cross-cutting hooks in `src/hooks/`. Server state lives in TanStack Query, not component state; forms use React Hook Form. FastAPI re-validates every authoritative rule already enforced in the UI — the frontend is a convenience layer, not a trust boundary.

## Design rules (from `docs/developer-guide.md`)

- Keep FastAPI routes thin; put business rules in domain services.
- Use PostgreSQL as the authoritative queue and workflow store.
- Write semantic audit events in the same transaction as the domain action they describe.
- Preserve imported records and individual reviewer decisions — don't overwrite history.
- Add a failing test before fixing a defect or adding non-trivial domain behavior.
- Create an Alembic migration for every persistent schema change, and validate the full migration chain on a fresh database. Always inspect autogenerated migrations before committing.
- Never start important background work from a FastAPI request thread — enqueue it for the persistent worker.

## Branching and releases

Work happens on `dev`; `main` is reached only via PR from `dev`. Pull requests and `workflow_dispatch` runs execute backend, frontend, and Browser Helper verification jobs; push/release workflows skip those test jobs. A merge to `main` derives the next `YEAR.MONTH.PATCH` release, builds/pushes the `linux/amd64` backend/frontend images, packages the Browser Helper as `papertrail-browser-extension-<version>.zip`, and creates the GitHub release with that ZIP.
