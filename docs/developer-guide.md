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

## Branching and releasing

Day-to-day work happens on `dev`. Changes reach `main` only through a pull request from `dev`. Every push and pull request runs the full backend and frontend test suites; nothing merges without CI passing.

Merging a pull request into `main` releases automatically. CI derives the next `YEAR.MONTH.PATCH` version (e.g. `2026.07.01`, then `2026.07.02` for the next release the same month) from the highest existing tag for the current year and month, builds and pushes `tiuri101/papertrail-backend` and `tiuri101/papertrail-frontend` images tagged with that version, tags the merge commit, and creates the GitHub release with generated notes. There is no manual release step.

An out-of-band release can still be cut by pushing an annotated tag matching `YEAR.MONTH.PATCH` directly (e.g. for a hotfix); CI treats a tag push the same way and releases that exact version.

## Design rules

- Keep FastAPI routes thin and put business rules in domain services.
- Use PostgreSQL as the authoritative queue and workflow store.
- Write semantic audit events in the same transaction as the domain action.
- Preserve imported records and individual reviewer decisions.
- Add a failing test before correcting a defect or adding non-trivial domain behavior.
- Create Alembic migrations for every persistent schema change and validate the full migration chain on a fresh database.
- Do not start important background work from FastAPI request threads; enqueue it for the persistent worker.
- Keep frontend server state in TanStack Query and validate authoritative rules again in FastAPI.
