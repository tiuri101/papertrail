# Configuration Reference

Papertrail has two configuration layers:

1. **Environment configuration** loaded by `backend/app/core/config.py` from `PAPERTRAIL_*` variables (and from `.env`/`.env.development` for host-based runs).
2. **Administrator overrides** stored in PostgreSQL and edited from **Global Settings**. These override selected environment defaults for API/runtime code that calls the effective-settings services.

The Docker Compose deployment also has Compose-only variables for PostgreSQL, image selection, host port binding, trusted proxies, and initial administrator creation.

## Precedence and persistence

Environment values are the baseline. When a corresponding Global Settings value has been saved, the stored database value is returned by `effective_instance_settings()` or `effective_llm_settings()` and therefore takes precedence for callers using those services.

Stored Global Settings are part of the PostgreSQL backup. Secrets saved there (SMTP password and Ollama API key) are stored in the database and are never echoed back to the browser; submitting a blank secret keeps the existing value.

There are two current implementation exceptions worth knowing:

- The **normal worker's thread count and poll interval** are read from environment settings when the worker process starts. The values saved as `workerThreads` and `jobPollIntervalSeconds` in Global Settings are not currently used by the worker's startup loop. Configure `PAPERTRAIL_WORKER_THREADS` and `PAPERTRAIL_JOB_POLL_INTERVAL_SECONDS` and restart the worker when these values must change.
- The **LLM worker's concurrency** is read from `PAPERTRAIL_LLM_MAX_CONCURRENT_JOBS` when that process starts. The installation-level `maxConcurrentJobs` value is persisted and returned by the LLM settings API, but does not currently change the worker thread pool. Configure the environment variable and restart `llm-worker` for the effective concurrency limit.
- The **forgot-password request gate** currently checks process-level `PAPERTRAIL_EMAIL_ENABLED` before it queues a reset email. Other notification paths use the effective database-overridden email settings. If self-service password recovery is required, set `PAPERTRAIL_EMAIL_ENABLED=true` together with valid SMTP host/from values in the API environment and restart the API. Global Settings can still override the effective SMTP/public-URL values used by queued mail, but enabling email only in Global Settings is not sufficient for the forgot-password route in the current implementation.

Job lease duration is different: the worker reads the effective instance setting when it claims a job, so a saved `jobLeaseSeconds` change applies to newly claimed jobs without a process restart.

## Compose-only deployment variables

These values are consumed by `docker-compose.yml` or the administrator bootstrap command rather than by the Pydantic `Settings` model.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PAPERTRAIL_IMAGE_TAG` | none; required | Backend/frontend image tag to deploy. |
| `POSTGRES_DB` | `papertrail` | PostgreSQL database name. |
| `POSTGRES_USER` | `papertrail` | PostgreSQL user. |
| `POSTGRES_PASSWORD` | `change-me` | PostgreSQL password; replace for production. |
| `PAPERTRAIL_ADMIN_USERNAME` | `admin` | Initial administrator username used by the migration container. |
| `PAPERTRAIL_ADMIN_DISPLAY_NAME` | `Papertrail Administrator` | Initial administrator display name. |
| `PAPERTRAIL_ADMIN_PASSWORD` | none; required | Initial administrator password. Only the `migrate` service receives this; `api`/`worker`/`llm-worker` do not. Existing administrator accounts are not reset by subsequent migration runs. |
| `PAPERTRAIL_RUNTIME_DATABASE_ROLE` | none; required | Name of the least-privilege PostgreSQL role that `api`/`worker`/`llm-worker` connect as (DML only — no schema/DDL rights). `migrate` creates/refreshes this role via `python -m app.cli ensure-runtime-role` after applying migrations. See [Security Operations](operations/security.md#database-privilege-separation). |
| `PAPERTRAIL_RUNTIME_DATABASE_PASSWORD` | none; required | Password for the role above. Generate with `python -c "import secrets; print(secrets.token_urlsafe(32))"`. Changing it requires restarting `migrate` (to update the role) and then `api`/`worker`/`llm-worker`. |
| `PAPERTRAIL_API_BIND` | `127.0.0.1` | Host/interface to which container port 8000 is published. |
| `PAPERTRAIL_API_PORT` | `8000` | Published API port. |
| `PAPERTRAIL_FRONTEND_BIND` | `127.0.0.1` | Host/interface to which container port 80 is published. |
| `PAPERTRAIL_FRONTEND_PORT` | `80` | Published frontend port. |
| `PAPERTRAIL_TRUSTED_PROXY_IPS` | `127.0.0.1` | Value passed to Uvicorn `--forwarded-allow-ips`. Only list reverse proxies that are allowed to supply forwarded client addresses. |

## Core application settings

All settings below use the `PAPERTRAIL_` prefix. Defaults are those in `backend/app/core/config.py` unless Compose supplies a different default.

| Variable | Default | Global Settings override | Notes |
| --- | --- | --- | --- |
| `PAPERTRAIL_ENV` | `development` | no | Compose defaults this to `production`. Tests use `test`. With `production`, startup fails closed on insecure defaults — see [Security Operations](operations/security.md#production-configuration-is-fail-closed). |
| `PAPERTRAIL_ALLOW_INSECURE_PRODUCTION` | `false` | no | Explicit escape hatch to let `PAPERTRAIL_ENV=production` start despite an insecure setting (e.g. a throwaway internal staging stack). Never set on an internet-facing installation. |
| `PAPERTRAIL_API_DOCS_ENABLED` | unset | no | Forces `/docs`, `/redoc`, `/openapi.json` on or off regardless of environment. Unset means "on outside production, off in production". |
| `PAPERTRAIL_APP_NAME` | `Papertrail` | no | FastAPI application title. |
| `PAPERTRAIL_APP_VERSION` | `dev` | no | Normally injected into built images. |
| `PAPERTRAIL_API_PREFIX` | `/api/v1` | no | Versioned API prefix. |
| `PAPERTRAIL_DATABASE_URL` | local SQLite URL | no | Compose supplies the PostgreSQL URL. |
| `PAPERTRAIL_CORS_ORIGINS` | `http://localhost:5173` | no | Comma-separated list when provided as an environment string. Compose defaults to `http://localhost`. |
| `PAPERTRAIL_ALLOWED_HOSTS` | localhost/test hosts | no | Comma-separated trusted Host-header values. Compose defaults to `localhost,127.0.0.1`. |
| `PAPERTRAIL_SESSION_COOKIE_NAME` | `papertrail_session` | no | HTTP-only session cookie name. |
| `PAPERTRAIL_SESSION_COOKIE_SECURE` | `false` | no | Set `true` when the public site is HTTPS. |
| `PAPERTRAIL_SESSION_TTL_HOURS` | `168` | no | Session lifetime. |
| `PAPERTRAIL_LOGIN_MAX_ATTEMPTS` | `5` | no | Failed login attempts per account+address before a temporary block. The account-wide limit is 3x and the source-address-wide limit 6x this value. |
| `PAPERTRAIL_LOGIN_WINDOW_SECONDS` | `900` | no | Login-throttle counting window. |
| `PAPERTRAIL_LOGIN_BLOCK_SECONDS` | `900` | no | Temporary login/password-reset block duration. |
| `PAPERTRAIL_PASSWORD_RESET_TTL_MINUTES` | `60` | yes | Password-reset link lifetime. |
| `PAPERTRAIL_PASSWORD_RESET_MAX_ATTEMPTS` | `5` | yes | Reset-request threshold per email+address; the same 3x/6x account and address scopes apply. |
| `PAPERTRAIL_MAX_UPLOAD_BYTES` | `26214400` | no | General upload limit used outside the PDF-specific path. |
| `PAPERTRAIL_IMPORT_DIR` | `./data/imports` | no | Compose fixes this to `/data/imports`. |
| `PAPERTRAIL_EXPORT_DIR` | `./data/exports` | no | Compose fixes this to `/data/exports`. |
| `PAPERTRAIL_PDF_STORAGE_PATH` | `./data/pdfs` | no | Compose fixes this to `/pdf-data`. |
| `PAPERTRAIL_MAX_PDF_SIZE_MB` | `50` | yes | Per-PDF limit for manual and browser-assisted PDF uploads. |
| `PAPERTRAIL_MAX_PDF_ARCHIVE_SIZE_MB` | `500` | no | Maximum uploaded PDF archive size. |
| `PAPERTRAIL_MAX_PDF_BATCH_FILES` | `1000` | no | Maximum number of PDF files accepted in one bulk batch. |
| `PAPERTRAIL_MAX_PDF_ZIP_EXPANDED_BYTES` | `1073741824` | no | Maximum expanded ZIP size for bulk PDF imports. |
| `PAPERTRAIL_WORKER_THREADS` | `4` | stored value exists; see exception above | Normal worker thread pool size at process startup. |
| `PAPERTRAIL_JOB_POLL_INTERVAL_SECONDS` | `1` | stored value exists; see exception above | Normal and LLM worker polling interval at process startup. |
| `PAPERTRAIL_JOB_LEASE_SECONDS` | `300` | yes | Lease length for newly claimed server-side background jobs. |
| `PAPERTRAIL_BROWSER_AGENT_PAIRING_TTL_MINUTES` | `10` | no | Lifetime of a one-time Browser Helper pairing secret. |
| `PAPERTRAIL_BROWSER_RETRIEVAL_LEASE_SECONDS` | `300` | yes | Lease length for a Browser Helper retrieval job. |
| `PAPERTRAIL_BROWSER_EXTENSION_ZIP_PATH` | `static/papertrail-browser-extension.zip` | no | Browser Helper ZIP served by the in-app download. The backend image bakes it in at this path; only change it for a custom build. |

The production Compose file only passes a subset of these advanced values into backend containers. Variables not present in the `x-backend-environment` block of `docker-compose.yml` must be explicitly added there (or otherwise injected into the containers) before changing them in `.env` will affect that deployment.

## Email / SMTP

Email is optional. When enabled, `PAPERTRAIL_SMTP_HOST` and `PAPERTRAIL_SMTP_FROM_ADDRESS` are required, and STARTTLS and implicit SSL cannot both be enabled.

| Variable | Default | Global Settings override |
| --- | --- | --- |
| `PAPERTRAIL_EMAIL_ENABLED` | `false` | yes |
| `PAPERTRAIL_PUBLIC_BASE_URL` | `http://localhost:5173` | yes |
| `PAPERTRAIL_SMTP_HOST` | unset | yes |
| `PAPERTRAIL_SMTP_PORT` | `587` | yes |
| `PAPERTRAIL_SMTP_USERNAME` | unset | yes |
| `PAPERTRAIL_SMTP_PASSWORD` | unset | yes; stored secret |
| `PAPERTRAIL_SMTP_FROM_ADDRESS` | unset | yes |
| `PAPERTRAIL_SMTP_STARTTLS` | `true` | yes |
| `PAPERTRAIL_SMTP_USE_SSL` | `false` | yes |
| `PAPERTRAIL_SMTP_TIMEOUT_SECONDS` | `30` | yes |
| `PAPERTRAIL_NOTIFICATION_ENCRYPTION_KEY` | unset | no; environment only |

The administrator can send a test message from Global Settings. The recipient is the administrator's own account email address.

### Notification encryption key

A queued password-reset email has to carry a working reset link until the worker
delivers it. That link is a credential, so it is never written to PostgreSQL in
clear text: it is sealed with AES-256-GCM under
`PAPERTRAIL_NOTIFICATION_ENCRYPTION_KEY`, and the ciphertext is discarded once
the message has been sent. A database dump on its own therefore cannot yield a
usable reset token.

- **Required for self-service password recovery.** Without it the
  forgot-password route still answers identically for every address (it must not
  become an account-existence oracle), but queues nothing and logs an error
  naming this variable. Every other email template is unaffected.
- **Must be identical for the API and the worker processes**, and must survive
  restarts — a key that changes between queueing and sending makes the pending
  email undeliverable (the job fails with a "could not be decrypted" error).
- **Environment/secret store only.** It is never stored in the database, never
  returned by an API, never exposed in Global Settings, and never logged. It is
  not overridable from Global Settings by design.
- Minimum 32 characters, and it must be high-entropy random data rather than a
  memorable phrase. Generate one with:

  ```bash
  python -c "import secrets; print(secrets.token_urlsafe(48))"
  ```

- **Rotation:** changing the key invalidates only reset emails that are still
  queued; affected users simply request a new link.
- `docker-compose.yml` already passes `PAPERTRAIL_NOTIFICATION_ENCRYPTION_KEY`
  through to the backend containers; set it in `.env`.

## Duplicate review assistance

After duplicate detection, the worker checks unresolved candidate pairs against Crossref and Semantic Scholar and probes each record's publisher/DOI links. Provider-confirmed same-work pairs are merged automatically; other pairs get a non-binding "keep this record" suggestion.

| Variable | Default | Global Settings override | Notes |
| --- | --- | --- | --- |
| `PAPERTRAIL_DUPLICATE_ASSESSMENT_ENABLED` | `true` | no | Set `false` on installations without outbound internet access. |
| `PAPERTRAIL_URL_CHECK_TIMEOUT_SECONDS` | `8` | no | Timeout per link probe; minimum 1. |

Neither is in the `x-backend-environment` block of `docker-compose.yml`; add them there to change them in a Compose deployment.

## Ollama / LLM settings

Ollama is an external service; Compose does not install or manage it.

| Variable | Default | Global Settings override |
| --- | --- | --- |
| `PAPERTRAIL_LLM_ENABLED` | `false` | yes |
| `PAPERTRAIL_OLLAMA_BASE_URL` | unset | yes |
| `PAPERTRAIL_OLLAMA_MODEL` | unset | yes |
| `PAPERTRAIL_OLLAMA_REQUEST_TIMEOUT_SECONDS` | `600` | yes |
| `PAPERTRAIL_OLLAMA_API_KEY` | unset | yes; stored secret |
| `PAPERTRAIL_LLM_MAX_CONCURRENT_JOBS` | `1` | stored value exists; see exception above |
| `PAPERTRAIL_LLM_CONTEXT_LENGTH` | `32768` | yes; minimum 4096 |
| `PAPERTRAIL_LLM_MAX_EVIDENCE_ITEMS` | `3` | yes; range 1–10 |
| `PAPERTRAIL_LLM_MAX_EVIDENCE_QUOTE_CHARS` | `500` | yes; range 50–2000 |
| `PAPERTRAIL_LLM_MAX_OUTPUT_TOKENS` | `4096` | yes; range 256–32768 |
| `PAPERTRAIL_LLM_TITLE_ABSTRACT_BASE_PROMPT` | built-in | yes through AI Prompts |
| `PAPERTRAIL_LLM_FULL_TEXT_BASE_PROMPT` | built-in | yes through AI Prompts |
| `PAPERTRAIL_LLM_EXTRACTION_BASE_PROMPT` | built-in | yes through AI Prompts |
| `PAPERTRAIL_LLM_VALIDATION_BASE_PROMPT` | built-in | yes through AI Prompts |

A blank API key or SMTP password submitted through Global Settings means "keep the existing stored secret". Prompt fields behave differently: blank prompt overrides reset that flow to the built-in prompt.

## Global Settings pages

Installation administrators can open **Global Settings** and edit:

- LLM connection, model (chosen from the models installed on the Ollama server), limits, and base-prompt overrides;
- SMTP delivery and public base URL;
- password-reset lifetime and reset-request throttling;
- maximum PDF size and Browser Helper retrieval lease;
- background-job thread/poll/lease values.

Changes are audit logged. Project-specific LLM capability toggles and project prompt instructions are separate from these installation-wide settings.

## Security-sensitive configuration

Keep `.env`, database backups, and any backup `environment.env` file out of source control. PostgreSQL can contain SMTP/Ollama secrets saved through Global Settings. The backup directory can therefore contain secrets even if no `.env` file was present at backup time.

For reverse-proxy deployments, set secure cookies, restrict allowed hosts/CORS origins, and set `PAPERTRAIL_TRUSTED_PROXY_IPS` to the actual proxy source addresses. Papertrail's login throttling relies on the client address after trusted proxy handling.
