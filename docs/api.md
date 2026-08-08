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

PDF content is streamed only after project authorization with `application/pdf` and inline content disposition. API responses never expose filesystem paths. Publication list/detail responses include a compact `fullText` availability object, avoiding one request per list item.

## LLM-assisted extraction

Project-manager endpoints under `/projects/{projectId}/llm` expose installation/project settings (never credentials), connection testing, editable/versioned schema management, and paginated run diagnostics. `/projects/{projectId}/publications/{publicationId}/llm/run` queues an eligible run for a manager or the assigned extraction reviewer. `/projects/{projectId}/extraction/{itemId}/llm-suggestions` exposes the current document/current schema result only to that work item's assigned reviewer or a project manager.

The API never proxies arbitrary browser requests to Ollama. Ollama responses are validated and persisted before any suggestion is returned. Screening endpoints do not include LLM extraction results.
