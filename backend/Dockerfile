# The Browser Helper's own build is reproduced here (not just referenced as a
# pre-built artifact) so a single `docker build` from the repo root always
# ships a zip that matches the backend/app it is packaged next to. The build
# context for this Dockerfile must be the repository root -- see the
# `docker-images` job in .github/workflows/ci.yml.
FROM node:22-alpine AS extension-build

WORKDIR /extension

COPY browser-extension/package.json browser-extension/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY browser-extension ./
RUN npm run build

# `zip` isn't in the base alpine image; the backend download endpoint
# (app/pdf_acquisition/routes.py) serves this file as-is to reviewers.
RUN apk add --no-cache zip \
    && cd dist \
    && zip -rX /papertrail-browser-extension.zip .

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
COPY backend/requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock

COPY backend/pyproject.toml ./
COPY backend/app ./app
COPY backend/migrations ./migrations
COPY backend/alembic.ini ./alembic.ini
# The project's own dependencies are already satisfied by requirements.lock
# above; --no-deps stops pip from re-resolving them from pyproject.toml's
# unpinned ranges.
RUN pip install --no-cache-dir --no-deps .

COPY --from=extension-build /papertrail-browser-extension.zip ./static/papertrail-browser-extension.zip

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
