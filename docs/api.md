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

## LLM assistance

Project-manager endpoints under `/projects/{projectId}/llm` expose installation/project settings (never credentials), connection testing, capability toggles, editable/versioned extraction-schema management, and paginated task diagnostics. `/projects/{projectId}/publications/{publicationId}/llm/run` queues extraction suggestions for a manager or assigned extractor.

Assigned screening reviewers use `GET/POST /projects/{projectId}/screening/work-items/{itemId}/llm-title-abstract` and `.../llm-full-text`. The title/abstract GET response is deliberately redacted to a `hidden` state until that reviewer has submitted a current decision; it does not return the run ID, status, model, decision, or reasoning. Extraction suggestions remain at `/projects/{projectId}/extraction/{itemId}/llm-suggestions`; completed-human-value validation uses `GET/POST .../llm-validation`.

The API never proxies arbitrary browser requests to Ollama. Ollama responses are schema-validated, evidence-checked, and persisted before any suggestion is returned. Screening endpoints never return data-extraction results.
