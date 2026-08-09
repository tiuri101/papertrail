# Local Development

This setup runs only PostgreSQL in Docker. FastAPI, the background worker, and the React development server run directly on the host so reloads, debugging, test execution, and IDE integration remain fast and transparent.

## Local process layout

```text
Browser http://localhost:5173
        │
        ▼
React/Vite development server
        │ /api proxy
        ▼
FastAPI http://127.0.0.1:8000
        │
        ├── PostgreSQL localhost:5432  ← the only Docker service
        └── local data directories under backend/data/

Separate host process:
Python threaded background worker ─────┘
```

## Prerequisites

Install:

- Python 3.12 or newer
- Node.js 22 LTS and npm
- Docker Desktop or Docker Engine with Compose v2
- Git

On Windows, run commands from PowerShell at the repository root.

Check the tools:

```powershell
python --version
node --version
npm --version
docker compose version
```

## Windows: recommended setup

The helper script performs the initial setup, including the editable backend installation, PostgreSQL startup, migrations, and frontend dependency installation.

```powershell
Copy-Item .env.development.example .env.development
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\dev.ps1 setup
.\scripts\dev.ps1 create-admin
.\scripts\dev.ps1 start
```

`start` opens the API, general worker, resource-limited LLM worker, and frontend in
separate PowerShell windows. The LLM worker remains idle when LLM assistance is disabled. Open:

- Papertrail: http://localhost:5173
- FastAPI documentation: http://127.0.0.1:8000/docs
- API health check: http://127.0.0.1:8000/health

The administrator command asks for the password interactively. Passwords must contain at least 12 characters.

### Normal Windows workflow

After the initial setup:

```powershell
.\scripts\dev.ps1 db-up
.\scripts\dev.ps1 start
```

Stop PostgreSQL when finished:

```powershell
.\scripts\dev.ps1 db-down
```

Closing the API, both worker terminals, and frontend terminal stops those host processes.

## macOS or Linux: recommended setup

```bash
cp .env.development.example .env.development
./scripts/dev.sh setup
./scripts/dev.sh create-admin
```

Run these commands in three terminals:

```bash
./scripts/dev.sh api
./scripts/dev.sh worker
./scripts/dev.sh frontend
```

Open http://localhost:5173.

## Manual setup

The helper scripts are optional. The following commands show exactly what they do.

### 1. Create the development configuration

Windows:

```powershell
Copy-Item .env.development.example .env.development
```

macOS or Linux:

```bash
cp .env.development.example .env.development
```

The file configures both the PostgreSQL container and the host processes. It is ignored by Git.

### 2. Start PostgreSQL

```powershell
docker compose -f docker-compose.dev.yml --env-file .env.development up -d --wait postgres
```

Only PostgreSQL is created. The API, worker, frontend, and migration containers from the production Compose file are not started.

Inspect its state:

```powershell
docker compose -f docker-compose.dev.yml --env-file .env.development ps
```

### 3. Prepare the backend

From the repository root:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -e ".[dev]"
python -m alembic upgrade head
python -m app.cli create-admin
```

On macOS or Linux, activate the environment with:

```bash
source .venv/bin/activate
```

The editable installation is deliberately restricted to the `app` package. Runtime directories such as `data`, `migrations`, and `tests` are not treated as distributable Python packages.

### 4. Run the API

From `backend`, with the virtual environment active:

```powershell
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

### 5. Run the background worker

Open a second terminal:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python -m app.jobs.worker
```

The worker is required for imports, metadata enrichment, duplicate detection, and export generation.

### 6. Run the frontend

Open a third terminal:

```powershell
cd frontend
npm install
npm run dev
```

Vite serves the frontend at http://localhost:5173 and proxies `/api` requests to FastAPI at http://localhost:8000. This avoids separate frontend API configuration during development.

## Development commands

### PowerShell helper

```text
.\scripts\dev.ps1 setup          Initial dependency installation and migration
.\scripts\dev.ps1 create-admin   Create the local administrator
.\scripts\dev.ps1 start          Launch API, both workers, and frontend windows
.\scripts\dev.ps1 api            Run FastAPI with reload
.\scripts\dev.ps1 worker         Run the threaded worker
.\scripts\dev.ps1 llm-worker     Run the resource-limited Ollama worker
.\scripts\dev.ps1 frontend       Run Vite
.\scripts\dev.ps1 migrate        Apply Alembic migrations
.\scripts\dev.ps1 db-up          Start PostgreSQL
.\scripts\dev.ps1 db-down        Stop PostgreSQL
.\scripts\dev.ps1 db-status      Show PostgreSQL status
.\scripts\dev.ps1 db-reset       Delete and recreate the development database
.\scripts\dev.ps1 test           Run backend and frontend unit checks
.\scripts\dev.ps1 test-e2e       Install Chromium and run Playwright
```

The Unix helper does not provide `start`; run the API, general worker, LLM worker when needed,
and frontend in separate terminals.

## Tests and quality checks

### Backend

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python -m pytest
python -m pytest --cov=app --cov-report=term-missing
python -m ruff check app tests
python -m mypy app
```

Backend tests use isolated test databases and do not require the development PostgreSQL container unless a test explicitly targets PostgreSQL behavior.

### Frontend unit and component tests

```powershell
cd frontend
npm run typecheck
npm run lint
npm test
npm run test:watch
npm run build
```

### Browser tests

```powershell
cd frontend
npx playwright install chromium
npm run test:e2e
```

The current Playwright tests mock API responses and start their own Vite server. They do not require the FastAPI process or PostgreSQL.

## Database tasks

### Apply migrations

```powershell
.\scripts\dev.ps1 migrate
```

Create an Alembic migration after changing SQLAlchemy models:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python -m alembic revision --autogenerate -m "describe the schema change"
python -m alembic upgrade head
```

Always inspect autogenerated migrations before committing them.

### Reset the development database

```powershell
.\scripts\dev.ps1 db-reset
```

This removes the `papertrail_postgres_dev_data` Docker volume, starts a clean database, and reapplies all migrations. Imported files under `backend/data` are not deleted automatically.

### Connect to PostgreSQL

```powershell
docker compose -f docker-compose.dev.yml --env-file .env.development exec postgres psql -U papertrail -d papertrail
```

## Configuration

Papertrail reads configuration from environment variables prefixed with `PAPERTRAIL_`. During host development it also searches for `.env.development` in both the current directory and its parent, so backend commands work from either the repository root or `backend`.

Important values:

| Variable | Development default | Purpose |
|---|---|---|
| `PAPERTRAIL_DATABASE_URL` | PostgreSQL on localhost:5432 | SQLAlchemy connection |
| `PAPERTRAIL_CORS_ORIGINS` | `http://localhost:5173` | Permitted frontend origin |
| `PAPERTRAIL_ALLOWED_HOSTS` | localhost and testserver | Trusted host validation |
| `PAPERTRAIL_IMPORT_DIR` | `./data/imports` | Imported source files |
| `PAPERTRAIL_EXPORT_DIR` | `./data/exports` | Generated exports |
| `PAPERTRAIL_SESSION_COOKIE_SECURE` | `false` | Allows local HTTP cookies |
| `PAPERTRAIL_WORKER_THREADS` | `4` | Background-worker concurrency |

Do not enable secure cookies for local HTTP. Enable them in production behind HTTPS.

### Visual Studio Code

Select the interpreter:

```text
backend/.venv/Scripts/python.exe    Windows
backend/.venv/bin/python            macOS/Linux
```

Use `backend` as the working directory for FastAPI, Alembic, pytest, and worker launch configurations.

Suggested API launch command:

```text
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Suggested worker launch command:

```text
python -m app.jobs.worker
```

LLM assistance is disabled by default and the general test suite never needs Ollama or a GPU. To develop the optional integration against a separately running Ollama host, set `PAPERTRAIL_LLM_ENABLED=true`, `PAPERTRAIL_OLLAMA_BASE_URL=http://192.168.1.50:11434`, and `PAPERTRAIL_OLLAMA_MODEL=qwen3:8b`, then run the resource-limited worker separately:

```text
python -m app.jobs.worker --llm
```

Model installation/pulling remains an Ollama administration task. See [LLM-assisted extraction](llm-assisted-extraction.md).

### PyCharm

Configure `backend/.venv` as the project interpreter and set `backend` as the working directory for backend run configurations.

## Troubleshooting

### `Multiple top-level packages discovered`

This was caused by incomplete setuptools package discovery. The project now explicitly includes only `app*`. Ensure your `backend/pyproject.toml` begins with the `[build-system]` and `[tool.setuptools.packages.find]` sections from the repository.

Then retry:

```powershell
python -m pip install -e ".[dev]"
```

### Port 5432 is already in use

Change both values in `.env.development`:

```dotenv
POSTGRES_PORT=5433
PAPERTRAIL_DATABASE_URL=postgresql+psycopg://papertrail:papertrail-dev@localhost:5433/papertrail
```

Restart the database:

```powershell
.\scripts\dev.ps1 db-down
.\scripts\dev.ps1 db-up
```

### PowerShell blocks script execution

For the current terminal only:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

### API cannot connect to PostgreSQL

Check the container:

```powershell
.\scripts\dev.ps1 db-status
docker compose -f docker-compose.dev.yml --env-file .env.development logs postgres
```

Confirm that `POSTGRES_PASSWORD` and the password embedded in `PAPERTRAIL_DATABASE_URL` match.

### Login works through FastAPI but not through React

Verify:

- React is running on http://localhost:5173.
- FastAPI is running on http://127.0.0.1:8000.
- `PAPERTRAIL_CORS_ORIGINS` contains `http://localhost:5173`.
- `PAPERTRAIL_SESSION_COOKIE_SECURE` is `false` for local HTTP.

### Import or export remains queued

The worker is not running. Start it in a separate terminal:

```powershell
.\scripts\dev.ps1 worker
```

### Frontend dependency state is broken

PowerShell:

```powershell
cd frontend
Remove-Item -Recurse -Force node_modules
Remove-Item package-lock.json -ErrorAction SilentlyContinue
npm cache verify
npm install
```

## Production versus development

Use:

- `docker-compose.dev.yml` for local development; it starts PostgreSQL only.
- `docker-compose.yml` for production-like self-hosting; it starts PostgreSQL, migrations, API, worker, and frontend, pulling prebuilt images.

Do not use the development database password or local cookie settings in production.
