# Installation

> This guide covers production-like deployment. For host-based development with only PostgreSQL in Docker, use the [local-development guide](local-development.md).

## Requirements

- Docker Engine 27 or newer
- Docker Compose v2
- At least 2 CPU cores and 4 GB RAM
- A persistent host with enough storage for PostgreSQL, imported source files, and generated exports

## Initial installation

1. Copy `.env.example` to `.env`.
2. Replace the PostgreSQL and administrator passwords.
3. For local HTTP, retain `PAPERTRAIL_SITE_ADDRESS=:80` and `PAPERTRAIL_SESSION_COOKIE_SECURE=false`.
4. For production, set `PAPERTRAIL_SITE_ADDRESS` to the public hostname, include that hostname in `PAPERTRAIL_ALLOWED_HOSTS`, set the matching HTTPS origin, and enable secure cookies.
5. Run `docker compose up -d --build`.
6. Run `scripts/create_admin.sh`.
7. Remove `PAPERTRAIL_ADMIN_PASSWORD` from `.env` after the account has been created.
8. Open the configured Papertrail address and sign in.

The one-shot `migrate` container applies all Alembic migrations before the API and worker start. Caddy routes `/api/*` to FastAPI and all other paths to the React application.

## Production example

```dotenv
PAPERTRAIL_SITE_ADDRESS=papertrail.example.org
PAPERTRAIL_SESSION_COOKIE_SECURE=true
PAPERTRAIL_ALLOWED_HOSTS=papertrail.example.org
PAPERTRAIL_CORS_ORIGINS=https://papertrail.example.org
```

Caddy obtains and renews TLS certificates automatically when the hostname resolves to the server and ports 80 and 443 are reachable.

## Verification

```bash
docker compose ps
curl -f http://localhost/health
```

The `postgres`, `api`, `worker`, `frontend`, and `gateway` services should be running. The `migrate` service should have exited successfully.
