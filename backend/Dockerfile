FROM python:3.13-slim

ARG APP_VERSION=dev

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PAPERTRAIL_APP_VERSION=$APP_VERSION

WORKDIR /app

# requirements.lock pins every third-party dependency (transitive included) to
# an exact version with hashes, so this build resolves the same versions every
# time until requirements.lock is deliberately regenerated -- see
# docs/developer-guide.md#updating-backend-dependencies. --require-hashes also
# refuses to install anything that isn't listed here with a matching hash.
COPY requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock

COPY pyproject.toml ./
COPY app ./app
COPY migrations ./migrations
COPY alembic.ini ./alembic.ini
# The project's own dependencies are already satisfied by requirements.lock
# above; --no-deps stops pip from re-resolving them from pyproject.toml's
# unpinned ranges.
RUN pip install --no-cache-dir --no-deps .

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
