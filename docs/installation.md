# Installation

> This guide covers production-like deployment. For host-based development with only PostgreSQL in Docker, use the [local-development guide](local-development.md).

## Requirements

- Docker Engine 27 or newer
- Docker Compose v2
- At least 2 CPU cores and 4 GB RAM
- A persistent host with enough storage for PostgreSQL, imported source files, generated exports, and full-text PDFs

## Initial installation

1. Copy `.env.example` to `.env`.
2. Replace the PostgreSQL and administrator passwords.
3. For local HTTP, retain `PAPERTRAIL_SITE_ADDRESS=:80` and `PAPERTRAIL_SESSION_COOKIE_SECURE=false`.
4. For production, set `PAPERTRAIL_SITE_ADDRESS` to the public hostname, include that hostname in `PAPERTRAIL_ALLOWED_HOSTS`, set the matching HTTPS origin, and enable secure cookies.
5. Run `docker compose up -d --build`.
6. Run `scripts/create_admin.sh`.
7. Remove `PAPERTRAIL_ADMIN_PASSWORD` from `.env` after the account has been created.
8. Open the configured Papertrail address and sign in.

The one-shot `migrate` container applies all Alembic migrations before the API and worker start.

Full-text binaries live in the dedicated `papertrail_pdf_data` Docker volume, mounted only in the API and worker containers. `PAPERTRAIL_MAX_PDF_SIZE_MB` controls the per-file server-side limit (50 MB by default in Compose). Host-based deployments must set `PAPERTRAIL_PDF_STORAGE_PATH` to a persistent writable directory. Back up PostgreSQL and this PDF volume together; the database alone is not a complete backup.

LLM-assisted extraction is optional and uses a separately operated Ollama server. Set `PAPERTRAIL_LLM_ENABLED=true`, `PAPERTRAIL_OLLAMA_BASE_URL`, and `PAPERTRAIL_OLLAMA_MODEL`; tune the timeout, context length, and dedicated LLM concurrency with the variables documented in [LLM-assisted extraction](llm-assisted-extraction.md). Compose adds a Papertrail `llm-worker` using the backend image and PostgreSQL queue, but does not add Ollama, model installation, or GPU configuration. Ensure the worker host can reach the configured Ollama URL and secure that route because it carries full paper text.

Email notifications are optional and are delivered asynchronously by the normal worker. Set `PAPERTRAIL_EMAIL_ENABLED=true`, the externally reachable `PAPERTRAIL_PUBLIC_BASE_URL`, `PAPERTRAIL_SMTP_HOST`, and `PAPERTRAIL_SMTP_FROM_ADDRESS`. Configure `PAPERTRAIL_SMTP_PORT` (587 by default), optional username/password, and exactly one of STARTTLS or implicit SSL as required by the mail provider. SMTP credentials are backend/worker-only and are not exposed to the frontend. Papertrail retries transient delivery failures through the PostgreSQL job queue.

## Production example

```dotenv
PAPERTRAIL_SITE_ADDRESS=papertrail.example.org
PAPERTRAIL_SESSION_COOKIE_SECURE=true
PAPERTRAIL_ALLOWED_HOSTS=papertrail.example.org
PAPERTRAIL_CORS_ORIGINS=https://papertrail.example.org
PAPERTRAIL_PUBLIC_BASE_URL=https://papertrail.example.org
```

## Verification

```bash
docker compose ps
curl -f http://localhost/health
```

The `postgres`, `api`, `worker`, `llm-worker`, `frontend`, and `gateway` services should be running. The `migrate` service should have exited successfully. With LLM support disabled, `llm-worker` remains idle.
