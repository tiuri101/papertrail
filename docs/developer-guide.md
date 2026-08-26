# Developer Guide

Start with the detailed [local-development guide](local-development.md). The normal development setup runs only PostgreSQL in Docker; FastAPI, the threaded worker, and React/Vite run directly on the host.

## Initial setup

Windows PowerShell:

```powershell
Copy-Item .env.development.example .env.development
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\dev.ps1 setup
.\scripts\dev.ps1 create-admin
.\scripts\dev.ps1 start
```

macOS or Linux:

```bash
cp .env.development.example .env.development
./scripts/dev.sh setup
./scripts/dev.sh create-admin
```

Run the API, normal worker, LLM worker, and frontend in separate terminals on macOS or Linux. The LLM worker can remain idle when LLM support is disabled.

## Development URLs

- React application: http://localhost:5173
- FastAPI: http://127.0.0.1:8000
- OpenAPI documentation: http://127.0.0.1:8000/docs
- Health check: http://127.0.0.1:8000/health
- PostgreSQL: localhost:5432

## Backend checks

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python -m pytest
python -m ruff check app tests
python -m mypy app
```

## Updating backend dependencies

`backend/requirements.lock` pins every third-party backend dependency (transitive included) to an exact version with hashes. The production Docker image installs from this lock file with `pip install --require-hashes`, not from `pyproject.toml`'s open version ranges, so the same source revision resolves the same dependency versions until the lock is deliberately regenerated. `pyproject.toml` stays the human-maintained source of *declared* dependencies and their acceptable ranges.

To deliberately update dependencies:

1. Edit the version ranges in `backend/pyproject.toml` as needed.
2. Regenerate the lock **inside a Linux container matching the production base image**, not on a Windows/macOS host — some dependencies (e.g. `uvloop`, a Unix-only dependency of `uvicorn[standard]`) resolve differently per platform, and a lock generated on the wrong platform silently omits them:

   ```powershell
   cd backend
   docker run --rm -v ${PWD}:/work -w /work python:3.13-slim sh -c "pip install pip-tools && pip-compile --generate-hashes --allow-unsafe --output-file=requirements.lock pyproject.toml"
   ```

3. Run the full backend test suite (`python -m pytest`, `python -m mypy app`) against the newly locked versions.
4. Commit `pyproject.toml` and `requirements.lock` together.

Base images (`python:3.13-slim`, `node:22-alpine`, `nginx:1.29-alpine`) are pinned by tag with an explanatory comment rather than by digest, so that routine OS/security patches inside the same minor version keep flowing in automatically; pin by digest instead if your threat model requires it.

## Frontend checks

```powershell
cd frontend
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

## Browser extension checks

```powershell
cd browser-extension
npm run typecheck
npm run lint
npm test
npm run build
```

See [local development](local-development.md#browser-extension-development) for loading the unpacked extension and pairing it with a local Papertrail instance.

## Branching and releasing

Day-to-day work happens on `dev`. Changes reach `main` only through a pull request from `dev`. Pull requests and manually dispatched (`workflow_dispatch`) CI runs execute the backend, frontend, and Browser Helper verification jobs. Pushes to `main`/release tags do not run those test jobs, so branch protection should require the pull-request checks before merge.

Pushes to `main` (i.e. a merged pull request) skip the test jobs and release automatically. CI derives the next `YEAR.MONTH.PATCH` version (e.g. `2026.07.01`, then `2026.07.02` for the next release the same month) from the highest existing tag for the current year/month, builds and pushes `linux/amd64` `tiuri101/papertrail-backend` and `tiuri101/papertrail-frontend` images, builds the Browser Helper, packages it as `papertrail-browser-extension-<version>.zip`, and creates the GitHub release with generated notes plus that ZIP. There is no manual release step for a normal merge to `main`.

An out-of-band release can still be cut by pushing a tag matching `YEAR.MONTH.PATCH` directly (e.g. for a hotfix); CI treats the tag value as the exact release version, builds/pushes the images, packages the Browser Helper, and creates the release.

## Design rules

- Keep FastAPI routes thin and put business rules in domain services.
- Use PostgreSQL as the authoritative queue and workflow store.
- Write semantic audit events in the same transaction as the domain action.
- Preserve imported records and individual reviewer decisions.
- Add a failing test before correcting a defect or adding non-trivial domain behavior.
- Create Alembic migrations for every persistent schema change and validate the full migration chain on a fresh database.
- Do not start important background work from FastAPI request threads; enqueue it for the persistent worker.
- Keep frontend server state in TanStack Query and validate authoritative rules again in FastAPI.
- Keep publisher-specific logic (PDF discovery, redirect handling, publisher HTTP quirks) inside `browser-extension/`, not the backend; the backend should only ever understand a publication, a retrieval job, a browser agent, and a PDF result. FastAPI still validates every uploaded PDF independently -- the extension's own checks are only an early rejection, never the authority.

## Related documentation

- [Configuration reference](configuration.md)
- [Browser Helper](browser-helper.md)
- [API overview](api.md)
- [Architecture](architecture.md)
