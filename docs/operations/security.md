# Security Operations

Papertrail stores research data, full-text PDFs, local credentials, session data, and potentially SMTP/Ollama secrets. Treat the installation and its backups as sensitive systems.

## Authentication and sessions

The web UI uses opaque PostgreSQL-backed sessions stored in HTTP-only cookies. Mutating session-authenticated requests require the current CSRF token. Passwords are hashed with Argon2.

Production deployments should:

- terminate TLS at the trusted reverse proxy;
- set `PAPERTRAIL_SESSION_COOKIE_SECURE=true`;
- restrict `PAPERTRAIL_ALLOWED_HOSTS` and `PAPERTRAIL_CORS_ORIGINS`;
- keep the API/frontend bound only where the reverse proxy can reach them;
- set `PAPERTRAIL_TRUSTED_PROXY_IPS` only to real proxy source addresses.

Uvicorn is configured to trust forwarded client addresses only from the configured proxy list. This matters because login throttling uses the resolved client address.

## Production configuration is fail-closed

With `PAPERTRAIL_ENV=production`, startup refuses to run with:

- `PAPERTRAIL_SESSION_COOKIE_SECURE=false`;
- a `PAPERTRAIL_PUBLIC_BASE_URL` that is not `https://` (this is the browser-facing origin baked into password-reset links and the Browser Helper's upload target — the internal `http://` hop from the reverse proxy to the `api` container is a separate, expected thing and is not what this checks);
- a wildcard (`*`) or empty `PAPERTRAIL_CORS_ORIGINS`;
- a wildcard or empty `PAPERTRAIL_ALLOWED_HOSTS`;
- a well-known example password (`change-me` and similar) in `PAPERTRAIL_DATABASE_URL`, `PAPERTRAIL_RUNTIME_DATABASE_PASSWORD`, or `PAPERTRAIL_NOTIFICATION_ENCRYPTION_KEY`.

The startup error names the offending setting, never its value. Set `PAPERTRAIL_ALLOW_INSECURE_PRODUCTION=true` only for a deliberately insecure throwaway/staging stack — never on an installation reachable from the internet. Development and test are not held to these rules. See `backend/app/core/config.py::production_configuration_problems`.

## Login and password recovery

Papertrail counts every failed login three times: against the account+address pair, against the account on its own, and against the source address on its own. The pair limit is `PAPERTRAIL_LOGIN_MAX_ATTEMPTS`; the account-wide limit is three times that and the address-wide limit six times, so that an attacker cannot escape a counter by rotating source addresses against one account, or by spraying many usernames from one address, while a shared office address does not lock honest users out before the pair limit fires. A successful login clears the pair and account counters but deliberately not the address counter. Password-reset requests use the same three scopes under `PAPERTRAIL_PASSWORD_RESET_MAX_ATTEMPTS`, evaluated from the submitted address before any account lookup, so a rate-limit response never reveals whether the account exists. Forgot-password responses likewise do not reveal whether a submitted email belongs to an active account.

Throttle rows are pruned opportunistically during failed-authentication traffic once their counting window and any block have long expired, so the table cannot be grown without bound by an attacker.

Passwords must be at least 12 characters. The same rule is enforced by the administrator create-user and reset paths, self-service password change, the emailed reset link, and the `papertrail create-admin` bootstrap command; there are no mandatory character classes, so long passphrases are preferred.

An administrator password reset or emailed password reset revokes existing sessions and Browser Helper credentials. Account disabling also revokes them.

A queued password-reset email stores its reset link encrypted (see `PAPERTRAIL_NOTIFICATION_ENCRYPTION_KEY` in [Configuration](../configuration.md#notification-encryption-key)); read access to the database alone does not yield a usable reset token.

## Authorization model

Server-side authorization has these broad levels:

- installation administrator — manages local accounts and every project;
- project owner — project-scoped management rights;
- project member — access to the project plus activities allowed by reviewer eligibility/permissions.

Independent reviewer decisions that are meant to remain hidden are filtered server-side; they must not be exposed through alternate endpoints, exports, progress views, or page source before the workflow permits reveal.

Do not rely on frontend navigation hiding as an authorization boundary.

## Browser Helper security

The Browser Helper uses a separate opaque bearer token rather than the user's session cookie.

- Pairing secrets are single-use and short lived.
- The raw agent bearer token is returned once; Papertrail stores its hash.
- Agent tokens are accepted only by `/api/v1/browser-agent/...` routes.
- The extension never uploads publisher cookies, institutional passwords, or publisher authorization headers to Papertrail.
- The upload target is derived from the claimed server-side retrieval job, preventing an agent from choosing an arbitrary publication.

Revoke helpers from Account Settings when a device is lost/decommissioned. See [Browser Helper](../browser-helper.md).

## File/PDF security

PDFs are stored in `papertrail_pdf_data`, not exposed as a static web directory. Content is streamed only through project-authorized endpoints.

Papertrail performs upload size/type/PDF validation, including server-side revalidation of Browser Helper uploads. Bulk ZIP/PDF limits should be sized conservatively for the host.

Only upload/store publication files that the institution/reviewer is authorized to retain.

## Spreadsheet/export safety

Spreadsheet exports protect against formula injection. External metadata and imported strings are untrusted input and should remain escaped/validated when rendered or exported.

Generated export downloads are authorization checked and should not be placed in a public static directory.

## API documentation and version disclosure

`/docs`, `/redoc`, and `/openapi.json` are enabled by default outside production and disabled by default in production (`PAPERTRAIL_ENV=production`); override either way with `PAPERTRAIL_API_DOCS_ENABLED`. `/health` and `/ready` stay unauthenticated for container/reverse-proxy health checks and report only process status, never the running Papertrail version, so they cannot be used as an unauthenticated "which advisories apply here" lookup. Administrators can read the version at `GET /api/v1/system/info`, which requires an authenticated admin session.

## Database privilege separation

`docker-compose.yml` gives each backend process only the database identity it needs:

- `migrate` connects as the schema-owning identity (`POSTGRES_USER`/`POSTGRES_PASSWORD`) to run Alembic migrations, then provisions/refreshes a least-privilege runtime role (`PAPERTRAIL_RUNTIME_DATABASE_ROLE`/`PAPERTRAIL_RUNTIME_DATABASE_PASSWORD`) with `SELECT`/`INSERT`/`UPDATE`/`DELETE` on tables and `USAGE`/`SELECT` on sequences only — no `CREATE`/`DROP`/`ALTER` rights — via `python -m app.cli ensure-runtime-role`. `ALTER DEFAULT PRIVILEGES` covers tables added by future migrations automatically.
- `api`, `worker`, and `llm-worker` connect as that runtime role. None of them receive `PAPERTRAIL_ADMIN_PASSWORD` (the bootstrap administrator password), the schema-owner's database password, or each other's LLM credentials beyond what they need — only `migrate` sees the bootstrap admin password.
- A compromise of the API or a worker therefore cannot alter the schema, create/drop tables, or grant itself further privileges — only read/write the application's own data.

See `backend/app/db/session.py` (`_effective_database_url`) and `backend/app/db/runtime_role.py`.

## Container hardening

Every `docker-compose.yml` service runs with `cap_drop: [ALL]` and `security_opt: [no-new-privileges:true]`, plus a `pids_limit` and a memory limit. Every service also runs with a read-only root filesystem (`read_only: true`) and explicit `tmpfs` mounts for the few paths that must remain writable (`/tmp`, and for `postgres`/`frontend` the specific runtime directories their upstream images need). `postgres` and `frontend` (nginx) each get back the minimum extra Linux capabilities their official entrypoints require to start (`postgres`: `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID` to initialize/chown its data directory and drop from root; `frontend`: `CHOWN`, `SETUID`, `SETGID` for the same reason in nginx's master process). No container's configured user/UID/GID was changed from the upstream image default.

## Secrets

Keep `.env` and other real secret files out of source control. SMTP passwords and Ollama API keys can also be stored in PostgreSQL through Global Settings.

A complete Papertrail backup contains:

- PostgreSQL (and therefore any DB-stored integration secrets);
- `papertrail_files`;
- `papertrail_pdf_data`;
- an exact `environment.env` copy of `.env` when one existed at backup time.

`scripts/backup.sh` sets `umask 077` before creating anything and explicitly `chmod`s the destination directory and every archive/dump, so a backup is never inadvertently group/world readable regardless of the destination path's prior permissions or the umask of the helper container that produces `files.tar.gz`/`pdfs.tar.gz`. Encrypt backups at rest, restrict access, and store them outside the Papertrail host. `environment.env` is intentionally not restored automatically.

## Reverse proxy and network boundaries

Expose Papertrail through HTTPS. The production Compose ports bind to loopback by default. If a proxy runs on another host/container network, widen bind addresses only as required and constrain firewall access accordingly.

The Ollama path can carry full paper text and structured review data. Secure that route/host. SMTP carries account/project notification content. Browser Helper traffic contains retrieved PDFs and must use the trusted Papertrail HTTPS origin in production.

## Administrator practices

- use unique administrator credentials;
- disable former users rather than reusing accounts;
- inspect audit records around sensitive lifecycle/metadata decisions;
- review failed background-job diagnostics before retrying;
- test backup restoration;
- rotate any credential exposed through logs/backups/infrastructure incidents;
- keep Docker images and the reverse proxy patched.

See [Configuration](../configuration.md), [Backup and Restore](../backup-and-restore.md), and [Reliability Operations](reliability.md).
