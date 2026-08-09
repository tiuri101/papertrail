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

Run the API, worker, and frontend in separate terminals on macOS or Linux.

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

## Frontend checks

```powershell
cd frontend
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

## Releasing

Versions follow `YEAR.MONTH.PATCH` (e.g. `2026.07.01`, then `2026.07.02` for the next release the same month). To cut a release from `main` with a clean working tree:

```powershell
.\scripts\release.ps1
```

```bash
./scripts/release.sh
```

This computes the next version, creates an annotated git tag, and pushes it. Pushing the tag triggers CI, which runs the full test suite, builds and pushes `tiuri101/papertrail-backend` and `tiuri101/papertrail-frontend` images tagged with that version, and creates the GitHub release. Pass an explicit version (e.g. `.\scripts\release.ps1 2026.07.02`) to override the computed one.

## Design rules

- Keep FastAPI routes thin and put business rules in domain services.
- Use PostgreSQL as the authoritative queue and workflow store.
- Write semantic audit events in the same transaction as the domain action.
- Preserve imported records and individual reviewer decisions.
- Add a failing test before correcting a defect or adding non-trivial domain behavior.
- Create Alembic migrations for every persistent schema change and validate the full migration chain on a fresh database.
- Do not start important background work from FastAPI request threads; enqueue it for the persistent worker.
- Keep frontend server state in TanStack Query and validate authoritative rules again in FastAPI.
