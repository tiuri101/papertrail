# Local Development Update Validation

> Historical snapshot from an earlier development phase. Counts below are frozen at that point in time and do not reflect the current codebase; see [Local development](local-development.md) for the current setup and CI for current results.

## Scope

The local development environment was changed so that only PostgreSQL runs in Docker. FastAPI, the threaded worker, and React/Vite run directly on the host.

## Added

- `docker-compose.dev.yml` with PostgreSQL as its only service
- `.env.development.example`
- `scripts/dev.ps1` for Windows PowerShell
- `scripts/dev.sh` for macOS and Linux
- `docs/local-development.md`
- VS Code launch configurations, tasks, settings, and extension recommendations
- Backend tests for package discovery, development configuration, and the database-only Compose definition
- `papertrail` command-line entry point

## Corrected

- Added explicit setuptools package discovery so editable installation includes only `app*`
- Excluded runtime `data`, Alembic `migrations`, and `tests` directories from distribution discovery
- Made development environment files discoverable when commands run from either the repository root or `backend`
- Corrected Pydantic settings handling for comma-separated CORS origins and allowed hosts by disabling premature JSON decoding
- Made the Vite development server use fixed local addresses and proxy `/api` to FastAPI

## Validation performed

- Backend test suite: **45 passed**
- Editable package build: succeeded with the current installed build tools using `--no-build-isolation --no-deps`
- Installed `papertrail` CLI entry point: `papertrail --help` succeeded
- Python syntax compilation: succeeded
- Unix development script syntax: succeeded with `sh -n`
- VS Code JSON files: parsed successfully
- Local Markdown links: all resolved

## Environment limitations

Docker is unavailable in the artifact-generation environment, so the PostgreSQL container itself was not started here. The Compose definition is covered by a structural test that verifies PostgreSQL is the only development service.

The environment's internal package mirror could not provide isolated build dependencies or the optional linting packages. The project configuration is compatible with normal PyPI, and the original user-side editable-install failure is addressed by explicit package discovery.
