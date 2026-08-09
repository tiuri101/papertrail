# Papertrail

Papertrail is a self-hosted, multi-user web application for structured academic literature reviews. It imports bibliographic exports and optional full-text PDFs, preserves source provenance and PDF version history, supports duplicate review and configurable multi-reviewer screening, tracks manual full-text retrieval, and provides optional evidence-backed extraction suggestions through an external Ollama service. Reviewer-controlled extraction and quality-assessment data remain authoritative.

## Features

- **Import and provenance** — import bibliographic exports from multiple databases
- **PDF management** — attach full-text PDFs with version history; PDFs are stored locally and never fetched from publishers
- **Duplicate review** — configurable duplicate scoring with reviewer-driven merge decisions
- **Multi-reviewer screening** — title/abstract and full-text screening stages with configurable reviewer counts and conflict resolution
- **Dynamic extraction forms** — versioned, project-defined forms with stable field identifiers for structured data extraction
- **Quality assessment** — reviewer-recorded quality/risk-of-bias evaluation, kept separate from extraction data
- **Optional LLM assistance** — evidence-backed suggestions for screening, extraction, and validation via an external Ollama service; suggestions are advisory only and reviewer decisions remain authoritative
- **Reporting and export** — PRISMA flow outputs, Excel workbooks, and BibTeX export
- **Audit trail** — durable audit logging of workflow and reviewer actions
- **Role-based access** — project-scoped membership so reviewers only see projects and actions they're eligible for

## Architecture

- FastAPI, Pydantic, SQLAlchemy 2, and Alembic
- PostgreSQL
- React and TypeScript with Vite
- TanStack Query and React Hook Form
- PostgreSQL-backed multithreaded worker
- Docker Compose production deployment

Papertrail is a modular monolith. The API and worker share domain services and one authoritative database.

PDF binaries are stored in a dedicated persistent filesystem volume, while their metadata and stable document IDs are stored in PostgreSQL. Papertrail never downloads or scrapes publisher PDFs; users must supply files they are authorized to access and store.

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
- [LLM-assisted extraction](docs/llm-assisted-extraction.md)
- [API overview](docs/api.md)
