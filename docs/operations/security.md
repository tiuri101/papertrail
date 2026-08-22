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

## Login and password recovery

Papertrail throttles failed logins by account identity/client address. Password-reset requests use a similar persisted throttle and configurable reset-link lifetime/attempt limit. Forgot-password responses do not reveal whether a submitted email belongs to an active account.

An administrator password reset or emailed password reset revokes existing sessions and Browser Helper credentials. Account disabling also revokes them.

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

## Secrets

Keep `.env` and other real secret files out of source control. SMTP passwords and Ollama API keys can also be stored in PostgreSQL through Global Settings.

A complete Papertrail backup contains:

- PostgreSQL (and therefore any DB-stored integration secrets);
- `papertrail_files`;
- `papertrail_pdf_data`;
- an exact `environment.env` copy of `.env` when one existed at backup time.

Encrypt backups at rest, restrict access, and store them outside the Papertrail host. `environment.env` is intentionally not restored automatically.

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
