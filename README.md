# Papertrail

Papertrail is a self-hosted, multi-user web application for structured academic literature reviews. It imports bibliographic exports, preserves source provenance, supports duplicate review and configurable multi-reviewer screening, tracks manual full-text retrieval, collects extraction and quality-assessment data, and produces PRISMA 2020, XLSX, and BibTeX outputs.

## Architecture

- FastAPI, Pydantic, SQLAlchemy 2, and Alembic
- PostgreSQL
- React and TypeScript with Vite
- TanStack Query and React Hook Form
- PostgreSQL-backed multithreaded worker
- Docker Compose and Caddy for production deployment

Papertrail is a modular monolith. The API and worker share domain services and one authoritative database.

## Local development

Local development uses Docker only for PostgreSQL. FastAPI, the worker, and Vite run directly on the host.

### Windows PowerShell

```powershell
Copy-Item .env.development.example .env.development
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\dev.ps1 setup
.\scripts\dev.ps1 create-admin
.\scripts\dev.ps1 start
```

Open http://localhost:5173.

### macOS or Linux

```bash
cp .env.development.example .env.development
./scripts/dev.sh setup
./scripts/dev.sh create-admin
```

Then run `api`, `worker`, and `frontend` in separate terminals.

See the [local-development guide](docs/local-development.md) for manual setup, testing, database management, IDE configuration, and troubleshooting.

## Production deployment

```bash
cp .env.example .env
# Replace all example passwords and configure the public hostname.
docker compose up -d --build
scripts/create_admin.sh
```

See [Installation](docs/installation.md) for production configuration.

## Documentation

- [Local development](docs/local-development.md)
- [Architecture](docs/architecture.md)
- [Administrator guide](docs/administrator-guide.md)
- [Reviewer guide](docs/user-guide.md)
- [Developer guide](docs/developer-guide.md)
- [Frontend testing](docs/frontend-testing.md)
- [Backup and restore](docs/backup-and-restore.md)
- [Import formats](docs/import-formats.md)
- [API overview](docs/api.md)
