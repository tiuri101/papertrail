# API Overview

Papertrail exposes its versioned JSON API under `/api/v1`. FastAPI's generated OpenAPI output is the authoritative endpoint/schema reference:

- interactive Swagger UI: `/docs`
- OpenAPI schema: `/openapi.json`

This document describes conventions and the main endpoint groups. Do not treat it as a hand-maintained substitute for OpenAPI.

## Authentication and CSRF

The web UI uses an opaque PostgreSQL-backed session stored in an HTTP-only cookie.

Important authentication endpoints include:

- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/session`
- `GET /api/v1/auth/me`
- `PATCH /api/v1/auth/me`
- `POST /api/v1/auth/forgot-password`
- `POST /api/v1/auth/reset-password`

Login/session responses include the current CSRF token. Mutating session-authenticated requests require it as:

```http
X-CSRF-Token: <token>
```

Browser Helper agent endpoints use a separate bearer-token mechanism described below; an agent token is not accepted as a replacement for a normal session cookie.

## Health endpoints

Health endpoints are not under `/api/v1`:

- `GET /health` — process liveness;
- `GET /ready` — application readiness marker. The current implementation returns `{"status":"ready"}` without probing PostgreSQL, workers, SMTP, or Ollama.

Do not treat `/ready` as a full dependency health check in the current implementation; combine it with container/PostgreSQL/service checks.

## Error and request conventions

The API returns JSON domain errors through the central FastAPI error handlers. Authorization is enforced server-side even when the frontend hides an unavailable action.

Generated file downloads and PDF streams are authorization checked. API responses under the versioned prefix are sent with `Cache-Control: no-store`, and security headers are added by application middleware.

## Background jobs

Long-running server-side operations return or expose a background-job identifier. Global job lookup endpoints are:

- `GET /api/v1/jobs/{job_id}`
- `GET /api/v1/jobs/{job_id}/error`

Project job management is under:

- `GET /api/v1/projects/{project_id}/jobs`
- `GET /api/v1/projects/{project_id}/jobs/summary`
- `POST /api/v1/projects/{project_id}/jobs/{job_id}/restart`
- `POST /api/v1/projects/{project_id}/jobs/restart`

Detailed error output is restricted according to project/administrator authorization.

## Main endpoint groups

The current API includes these major domains. Use `/docs` for exact methods, request bodies, response types, and permissions.

| Area | Main path family |
| --- | --- |
| Accounts/users | `/auth/...`, `/users/...` |
| Global Settings | `/instance-settings`, `/llm/installation-settings...` |
| Projects/membership/configuration | `/projects...` |
| Research questions/criteria/prompt settings | `/projects/{project_id}/...` |
| Search documentation/imports/PDF matching | `/projects/{project_id}/searches...`, `/imports...`, `/pdf-matches...` |
| Publications/metadata/enrichment | `/projects/{project_id}/publications...`, `/projects/{project_id}/metadata-conflicts...` |
| Bookmarks | `/bookmarks...`, `/projects/{project_id}/bookmarks/ids`, `/projects/{project_id}/publications/{publication_id}/bookmark` |
| Duplicate review | `/projects/{project_id}/duplicates...`, `/merges...` |
| Screening | `/projects/{project_id}/screening...` |
| Screening conflict resolution | `/projects/{project_id}/screening/{stage}/conflicts...` |
| Full-text retrieval status | `/projects/{project_id}/full-text...` |
| PDF documents | `/projects/{project_id}/publications/{publication_id}/full-text...` |
| Browser Helper | `/browser-agents...`, `/browser-agent...`, `/projects/{project_id}/pdf-retrieval-batches...` |
| Forms/templates | `/form-templates`, `/forms...`, `/projects/{project_id}/forms` |
| Extraction/reconciliation | `/projects/{project_id}/extraction...` |
| Quality assessment | `/projects/{project_id}/quality...` |
| LLM assistance | `/llm/...`, `/projects/{project_id}/llm...`, item-specific LLM routes |
| Analysis | `/projects/{project_id}/analysis...`, `/research-questions/{id}/analysis...` |
| Reporting/exports | `/projects/{project_id}/prisma...`, `/final-results`, `/evidence-matrix...`, `/exports...` |
| Audit/progress | `/projects/{project_id}/audit`, `/dashboard`, `/reviewer-progress` |
| Integrity/lifecycle | `/projects/{project_id}/integrity...`, `/reopen`, `/move-back`, `/reset`, `/clone`, `/transfer-ownership` |

## Full-text document API

Publication-scoped document endpoints include:

- `GET /api/v1/projects/{project_id}/publications/{publication_id}/full-text`
- `POST /api/v1/projects/{project_id}/publications/{publication_id}/full-text`
- `DELETE /api/v1/projects/{project_id}/publications/{publication_id}/full-text`
- `GET /api/v1/projects/{project_id}/publications/{publication_id}/full-text/content`
- `GET /api/v1/projects/{project_id}/publications/{publication_id}/full-text/history`

Bulk import/matching endpoints include project/import PDF-match routes under `/projects/{project_id}/imports/{import_batch_id}/pdf-matches` and `/projects/{project_id}/pdf-matches`.

PDF content is streamed only after project authorization as `application/pdf` with inline disposition. Publication responses expose compact full-text availability information so list pages do not need one PDF-status request per publication.

## Browser-assisted PDF retrieval

### Session-authenticated user endpoints

- `POST /api/v1/browser-agents/pairing-secrets` — create a one-time pairing secret;
- `GET /api/v1/browser-agents` — list this user's paired helpers;
- `GET /api/v1/browser-agents/extension-download` — download the Browser Helper ZIP bundled in the backend image (404 on a source/dev backend);
- `DELETE /api/v1/browser-agents/{agent_id}` — revoke one helper;
- `POST /api/v1/browser-agents/pair` — consume a pairing secret and return the agent bearer token exactly once. This endpoint is intentionally usable without an existing session because the one-time secret is the credential.

Project retrieval batches:

- `POST /api/v1/projects/{project_id}/pdf-retrieval-batches`
- `GET /api/v1/projects/{project_id}/pdf-retrieval-batches`
- `GET /api/v1/projects/{project_id}/pdf-retrieval-batches/missing-count`
- `GET /api/v1/projects/{project_id}/pdf-retrieval-batches/{batch_id}`
- `POST /api/v1/projects/{project_id}/pdf-retrieval-batches/{batch_id}/cancel`
- `POST /api/v1/projects/{project_id}/pdf-retrieval-batches/{batch_id}/retry-failed`

Creating/cancelling/retrying a batch requires full-text-reviewer access (project owner/administrator also qualifies); read operations require project access.

### Agent-token endpoints

A paired extension sends `Authorization: Bearer <agent-token>` to:

- `GET /api/v1/browser-agent/me`
- `GET /api/v1/browser-agent/retrieval-jobs/pending-count`
- `POST /api/v1/browser-agent/retrieval-jobs/claim`
- `POST /api/v1/browser-agent/retrieval-jobs/{job_id}/state`
- `POST /api/v1/browser-agent/retrieval-jobs/{job_id}/upload`
- `POST /api/v1/browser-agent/retrieval-jobs/{job_id}/retry`

Capturing a PDF the user opened themselves uses:

- `GET /api/v1/browser-agent/projects`
- `GET /api/v1/browser-agent/projects/{project_id}/publications/search`
- `POST /api/v1/browser-agent/projects/{project_id}/publications`
- `POST /api/v1/browser-agent/pdf-captures/detect`
- `POST /api/v1/browser-agent/publications/{publication_id}/pdf-captures`

The claim response exposes only retrieval-relevant publication data. The upload route derives its publication from the claimed job server-side; an extension cannot supply an arbitrary target publication ID.

## Dual extraction and reconciliation

Representative endpoints:

- `GET/PUT /api/v1/projects/{project_id}/extraction-config`
- `GET /api/v1/projects/{project_id}/extraction/publications/{publication_id}/final`
- `GET /api/v1/projects/{project_id}/extraction/reconciliation`
- `GET /api/v1/projects/{project_id}/extraction/reconciliation/{publication_id}`
- `POST /api/v1/projects/{project_id}/extraction/reconciliation/{publication_id}`
- `POST /api/v1/projects/{project_id}/extraction/{item_id}/override`

The final result is separate from the individual extraction work-item responses. Reconciliation routes are restricted to project managers or members with adjudication permission.

## Analysis and Evidence Matrix

Representative endpoints:

- `GET /api/v1/projects/{project_id}/analysis/reviewer-analysis/{stage}`
- `POST /api/v1/projects/{project_id}/evidence-matrix`
- `GET /api/v1/projects/{project_id}/evidence-matrix/cell/{publication_id}/{source_type}/{field_key}`
- `GET /api/v1/projects/{project_id}/research-questions/{research_question_id}/analysis`
- `GET /api/v1/projects/{project_id}/research-questions/{research_question_id}/analysis/history`
- `POST /api/v1/projects/{project_id}/research-questions/{research_question_id}/analysis/regenerate`

Reviewer-analysis responses are anonymized. Evidence Matrix cell details return authoritative value/resolution information and traceable evidence when available.

## Global Settings API

Installation administrators can read/update selected persisted instance settings with:

- `GET /api/v1/instance-settings`
- `PATCH /api/v1/instance-settings`
- `POST /api/v1/instance-settings/test-email`

LLM installation settings/prompts use `/api/v1/llm/installation-settings...` routes. See [Configuration](configuration.md) for precedence and the process-level settings that still come directly from the environment.
