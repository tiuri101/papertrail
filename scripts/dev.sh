#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
ENV_FILE="$ROOT/.env.development"
ENV_EXAMPLE="$ROOT/.env.development.example"
COMPOSE_FILE="$ROOT/docker-compose.dev.yml"
VENV_PYTHON="$BACKEND/.venv/bin/python"
COMMAND=${1:-help}

ensure_env() {
  if [ ! -f "$ENV_FILE" ]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    echo "Created .env.development from .env.development.example."
  fi
}

compose() {
  ensure_env
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

ensure_venv() {
  if [ ! -x "$VENV_PYTHON" ]; then
    python3 -m venv "$BACKEND/.venv"
  fi
}

backend_python() {
  [ -x "$VENV_PYTHON" ] || {
    echo "Backend virtual environment not found. Run: ./scripts/dev.sh setup" >&2
    exit 1
  }
  (cd "$BACKEND" && "$VENV_PYTHON" "$@")
}

show_help() {
  cat <<'HELP'
Papertrail local-development helper

  ./scripts/dev.sh setup
  ./scripts/dev.sh create-admin

Run these in separate terminals:
  ./scripts/dev.sh api
  ./scripts/dev.sh worker
  ./scripts/dev.sh llm-worker
  ./scripts/dev.sh frontend

Database:
  ./scripts/dev.sh db-up | db-down | db-reset | db-status | migrate

Tests:
  ./scripts/dev.sh test
  ./scripts/dev.sh test-e2e
HELP
}

case "$COMMAND" in
  help)
    show_help
    ;;
  setup)
    ensure_env
    compose up -d --wait postgres
    ensure_venv
    backend_python -m pip install --upgrade pip
    backend_python -m pip install -e '.[dev]'
    backend_python -m alembic upgrade head
    (cd "$FRONTEND" && npm install)
    echo "Development setup is ready."
    echo "Next: ./scripts/dev.sh create-admin"
    ;;
  db-up)
    compose up -d --wait postgres
    ;;
  db-down)
    compose down
    ;;
  db-reset)
    printf 'This deletes the local development database. Type RESET to continue: '
    read -r answer
    [ "$answer" = RESET ] || { echo "Cancelled."; exit 0; }
    compose down -v
    compose up -d --wait postgres
    backend_python -m alembic upgrade head
    ;;
  db-status)
    compose ps
    ;;
  migrate)
    backend_python -m alembic upgrade head
    ;;
  create-admin)
    backend_python -m app.cli create-admin
    ;;
  api)
    backend_python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
    ;;
  worker)
    backend_python -m app.jobs.worker
    ;;
  llm-worker)
    backend_python -m app.jobs.worker --llm
    ;;
  frontend)
    (cd "$FRONTEND" && npm run dev)
    ;;
  test)
    backend_python -m pytest
    backend_python -m ruff check app tests
    (cd "$FRONTEND" && npm run typecheck && npm run lint && npm test)
    ;;
  test-e2e)
    (cd "$FRONTEND" && npx playwright install chromium && npm run test:e2e)
    ;;
  *)
    echo "Unknown command: $COMMAND" >&2
    show_help >&2
    exit 2
    ;;
esac
