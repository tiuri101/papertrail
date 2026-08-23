# Installation

> This guide covers the production-style Docker Compose deployment. For host-based development with only PostgreSQL in Docker, use [Local Development](local-development.md).

## Requirements

- Docker Engine 27 or newer
- Docker Compose v2
- At least 2 CPU cores and 4 GB RAM for a small installation
- Persistent storage for PostgreSQL, imported/exported files, and full-text PDFs
- A reverse proxy/TLS endpoint for an internet-accessible deployment

The current CI release workflow publishes the backend and frontend Docker images for **`linux/amd64`**. ARM hosts require locally built images or a future multi-architecture release.

Optional features additionally require:

- an SMTP server for email/password recovery;
- an independently operated Ollama endpoint for LLM functionality;
- Chrome with the matching Browser Helper release for browser-assisted PDF retrieval.

## Initial installation

1. Copy `.env.example` to `.env`.
2. Replace the PostgreSQL and administrator passwords.
3. Set `PAPERTRAIL_IMAGE_TAG` to the backend/frontend release tag to deploy.
4. Configure host binding/reverse-proxy values for your environment.
5. Run:

   ```bash
   docker compose up -d
   ```

6. Check service status and health/readiness.
7. Open Papertrail through the configured public address and sign in using the bootstrap administrator account.

The one-shot `migrate` service runs Alembic migrations and then invokes the idempotent administrator bootstrap before `api` starts. If the administrator account already exists, a later deployment/migration run does not reset its password.

Keep `PAPERTRAIL_ADMIN_PASSWORD` available for future migration-container invocations unless you deliberately change the deployment/bootstrap process.

## Reverse proxy and ports

By default the production Compose file publishes:

- API container port 8000 to `127.0.0.1:${PAPERTRAIL_API_PORT:-8000}`;
- frontend container port 80 to `127.0.0.1:${PAPERTRAIL_FRONTEND_PORT:-80}`.

This makes a same-host reverse proxy the expected public entry point.

For a public HTTPS installation:

- include the public hostname in `PAPERTRAIL_ALLOWED_HOSTS`;
- set `PAPERTRAIL_CORS_ORIGINS` to the HTTPS frontend origin;
- set `PAPERTRAIL_PUBLIC_BASE_URL` to the public URL used in email/Browser Helper setup;
- set `PAPERTRAIL_SESSION_COOKIE_SECURE=true`;
- set `PAPERTRAIL_TRUSTED_PROXY_IPS` to the source IP(s) from which Uvicorn is allowed to trust forwarded client addresses.

If the proxy is on another host/network, set `PAPERTRAIL_API_BIND` and `PAPERTRAIL_FRONTEND_BIND` to addresses that proxy can reach. Do not expose the API publicly while trusting arbitrary forwarded addresses: login throttling uses the post-proxy client address.

See [Configuration](configuration.md) and [Security Operations](operations/security.md).

## Persistent data

The Compose deployment uses three named volumes:

- `papertrail_postgres_data` — PostgreSQL;
- `papertrail_files` — import/export files;
- `papertrail_pdf_data` — protected full-text PDF binaries/history.

A complete backup requires PostgreSQL plus both application file volumes. Use `scripts/backup.sh`; do not rely on a database-only backup. See [Backup and Restore](backup-and-restore.md).

## Global Settings after first sign-in

Installation administrators can open **Global Settings** to configure selected persistent settings without editing `.env`, including:

- Ollama connection/model/prompt overrides;
- SMTP and public base URL;
- password-reset limits;
- maximum PDF size and Browser Helper retrieval lease;
- background-job settings.

Environment variables remain the baseline and some process-level worker values are still read directly at worker startup. [Configuration](configuration.md) documents exact precedence and current exceptions.

## Optional email

Email delivery is asynchronous through the normal worker. Configuration requires a public base URL, SMTP host/from address, and the provider's TLS/authentication settings. The Global Settings page can send a test email to the administrator's own account address.

Password recovery from the login page depends on email being enabled. In the current implementation the forgot-password request gate checks process-level `PAPERTRAIL_EMAIL_ENABLED`, so installations that require self-service recovery should enable email and provide valid SMTP host/from values in the API environment as well as any Global Settings overrides; see [Configuration](configuration.md). Account creation itself does not require an email address.

## Optional Ollama/LLM

Ollama is not part of `docker-compose.yml`. Operate it separately and ensure Papertrail can reach the configured HTTP(S) endpoint. Configure the installation through environment variables or Global Settings, then enable individual LLM capabilities per project.

Paper text can be sent to the configured Ollama service for full-text/extraction tasks, so secure that network path and host appropriately. See [LLM-assisted extraction](llm-assisted-extraction.md).

## Optional Browser Helper

Papertrail releases package the Chrome Browser Helper as a ZIP attached to the GitHub release. Users install it as an unpacked extension and pair it from Account Settings. See [Browser Helper](browser-helper.md).

## Verification

Check Compose state:

```bash
docker compose ps
```

The expected long-running services are:

- `postgres`
- `api`
- `worker`
- `llm-worker`
- `frontend`

`migrate` should have exited successfully.

Check API liveness and readiness from the host:

```bash
curl -f http://127.0.0.1:${PAPERTRAIL_API_PORT:-8000}/health
curl -f http://127.0.0.1:${PAPERTRAIL_API_PORT:-8000}/ready
```

Then verify sign-in, one project page, and a representative background operation. If optional integrations are enabled, test SMTP/Ollama and pair a Browser Helper separately.

## First backup and upgrades

Create an initial verified backup after configuration and before substantial review work:

```bash
scripts/backup.sh
```

Use [Upgrade Guide](upgrade.md) for release upgrades. The upgrade script pulls release images, takes a quiesced pre-upgrade backup, migrates while the old application services remain stopped, and then starts the new deployment.
