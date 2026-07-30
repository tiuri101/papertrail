# Security Operations

Papertrail uses opaque PostgreSQL-backed sessions, HTTP-only cookies, CSRF tokens for mutations, Argon2 password hashing, login throttling, server-side project authorization, upload size and extension validation, authorization-checked downloads, and formula-injection protection for spreadsheet exports.

Production deployments must enable secure cookies, terminate TLS at the reverse proxy, replace all example credentials, restrict allowed hosts and CORS origins, keep secrets outside version control, and back up PostgreSQL and the persistent file volume together.

Hidden independent reviewer decisions are withheld by backend queries. They must never be included in progress, export, or alternate record endpoints before the configured reviewer count has submitted.
