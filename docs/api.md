# API Overview

The versioned API is exposed under `/api/v1`. FastAPI serves interactive OpenAPI documentation at `/docs` and the schema at `/openapi.json`.

Authentication uses an opaque HTTP-only session cookie. The login and session-bootstrap responses provide a CSRF token. Mutating requests must include that token in the `X-CSRF-Token` header.

Long-running operations return a background-job identifier. Poll `/api/v1/jobs/{job_id}` for status and progress. Generated artifacts are downloaded through authorization-checked project endpoints.

Full-text document endpoints are publication-scoped:

- `GET/POST/DELETE /projects/{projectId}/publications/{publicationId}/full-text`
- `GET /projects/{projectId}/publications/{publicationId}/full-text/content`
- `GET /projects/{projectId}/publications/{publicationId}/full-text/history`
- `GET /projects/{projectId}/imports/{importId}/pdf-matches`
- `POST /projects/{projectId}/imports/{importId}/pdf-matches/resolve`

PDF content is streamed only after project authorization with `application/pdf` and inline content disposition. Publication list/detail responses include a compact `fullText` availability object, avoiding one request per list item.

## Browser-assisted PDF retrieval

Session-authenticated endpoints (cookie + CSRF, same as the rest of the API):

- `POST/GET /browser-agents`, `POST /browser-agents/pairing-secrets`, `DELETE /browser-agents/{agentId}` -- pair, list, and revoke this account's browser helpers.
- `POST /projects/{projectId}/pdf-retrieval-batches`, `GET .../pdf-retrieval-batches[/{batchId}]`, `GET .../pdf-retrieval-batches/missing-count`, `POST .../{batchId}/cancel`, `POST .../{batchId}/retry-failed` -- start and monitor a "retrieve missing PDFs" run for a project (requires full-text reviewer access).

Unauthenticated: `POST /browser-agents/pair` consumes a one-time pairing secret and returns the agent's bearer token exactly once.

Agent-authenticated endpoints (a paired extension's own opaque bearer token in `Authorization: Bearer <token>` -- this token is never accepted by, and never substitutes for, the session-cookie endpoints above):

- `GET /browser-agent/me`
- `GET /browser-agent/retrieval-jobs/pending-count`
- `POST /browser-agent/retrieval-jobs/claim`
- `POST /browser-agent/retrieval-jobs/{jobId}/state`
- `POST /browser-agent/retrieval-jobs/{jobId}/upload`
- `POST /browser-agent/retrieval-jobs/{jobId}/retry`

The claim response exposes only what the extension needs to retrieve one publication (id, title, DOI, publisher URL, and the byte limit/lease expiry) -- no reviewer notes, screening answers, or extraction data. The upload endpoint derives the target publication from the claimed job server-side; the extension cannot upload to an arbitrary publication ID. `pending-count` is a cheap, read-only count (no claiming, no per-project access re-check) the extension polls in the background every few minutes to show a badge; it never triggers retrieval by itself.

## LLM assistance

Project-manager endpoints under `/projects/{projectId}/llm` expose installation/project settings, connection testing, capability toggles, editable/versioned extraction-schema management, and paginated task diagnostics. `/projects/{projectId}/publications/{publicationId}/llm/run` queues extraction suggestions for a manager or assigned extractor.

Assigned screening reviewers use `GET/POST /projects/{projectId}/screening/work-items/{itemId}/llm-title-abstract` and `.../llm-full-text`. The title/abstract GET response is deliberately redacted to a `hidden` state until that reviewer has submitted a current decision; it does not return the run ID, status, model, decision, or reasoning. Extraction suggestions remain at `/projects/{projectId}/extraction/{itemId}/llm-suggestions`. When project validation is enabled, the validation cohort is queued only after every extraction work item is complete. `GET /projects/{projectId}/llm/extraction-validation-review` returns the authorized reviewer or manager overview, `GET /projects/{projectId}/extraction/{itemId}` opens a completed response for revision, and item-level `GET/POST .../llm-validation` reports or retries validation after the cohort gate has been reached.
