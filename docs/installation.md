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
3. Set `PAPERTRAIL_IMAGE_TAG` to the backend/frontend image tag to deploy.
4. For local HTTP, retain the default `PAPERTRAIL_FRONTEND_PORT=80`, `PAPERTRAIL_API_PORT=8000`, and `PAPERTRAIL_SESSION_COOKIE_SECURE=false`.
5. For production, put an external reverse proxy in front of the frontend and API ports under the public hostname, include that hostname in `PAPERTRAIL_ALLOWED_HOSTS`, set the matching HTTPS origin, and enable secure cookies. Configuring that reverse proxy is outside the scope of this Compose file. The `frontend` and `api` ports are published to `127.0.0.1` only, so a reverse proxy on the same host can reach them but the internet cannot. If your reverse proxy instead runs on a different host or in a separate container network, set `PAPERTRAIL_FRONTEND_BIND`/`PAPERTRAIL_API_BIND` to an address it can reach and `PAPERTRAIL_TRUSTED_PROXY_IPS` to its source IP (the API trusts `X-Forwarded-For` only from that address, which login-throttle rate limiting relies on).
6. Run `docker compose up -d`.
7. Run `scripts/create_admin.sh`.
8. Remove `PAPERTRAIL_ADMIN_PASSWORD` from `.env` after the account has been created.
9. Open the configured Papertrail address and sign in.

The one-shot `migrate` container applies all Alembic migrations before the API and worker start.

Full-text binaries live in the dedicated `papertrail_pdf_data` Docker volume, mounted only in the API and worker containers. `PAPERTRAIL_MAX_PDF_SIZE_MB` controls the per-file server-side limit (50 MB by default in Compose). Host-based deployments must set `PAPERTRAIL_PDF_STORAGE_PATH` to a persistent writable directory. Back up PostgreSQL and this PDF volume together; the database alone is not a complete backup.

LLM-assisted extraction is optional and uses a separately operated Ollama server. Set `PAPERTRAIL_LLM_ENABLED=true`, `PAPERTRAIL_OLLAMA_BASE_URL`, and `PAPERTRAIL_OLLAMA_MODEL`; tune the timeout, context length, and dedicated LLM concurrency with the variables documented in [LLM-assisted extraction](llm-assisted-extraction.md). Compose adds a Papertrail `llm-worker` using the backend image and PostgreSQL queue, but does not add Ollama, model installation, or GPU configuration. Ensure the worker host can reach the configured Ollama URL and secure that route because it carries full paper text.

Email notifications are optional and are delivered asynchronously by the normal worker. Set `PAPERTRAIL_EMAIL_ENABLED=true`, the externally reachable `PAPERTRAIL_PUBLIC_BASE_URL`, `PAPERTRAIL_SMTP_HOST`, and `PAPERTRAIL_SMTP_FROM_ADDRESS`. Configure `PAPERTRAIL_SMTP_PORT` (587 by default), optional username/password, and exactly one of STARTTLS or implicit SSL as required by the mail provider. SMTP credentials are backend/worker-only and are not exposed to the frontend. Papertrail retries transient delivery failures through the PostgreSQL job queue.

## Production example

```dotenv
PAPERTRAIL_IMAGE_TAG=1.4.0
PAPERTRAIL_SESSION_COOKIE_SECURE=true
PAPERTRAIL_ALLOWED_HOSTS=papertrail.example.org
PAPERTRAIL_CORS_ORIGINS=https://papertrail.example.org
PAPERTRAIL_PUBLIC_BASE_URL=https://papertrail.example.org
```

## Verification

```bash
docker compose ps
curl -f http://localhost:${PAPERTRAIL_API_PORT:-8000}/health
```

The `postgres`, `api`, `worker`, `llm-worker`, and `frontend` services should be running. The `migrate` service should have exited successfully. With LLM support disabled, `llm-worker` remains idle.
