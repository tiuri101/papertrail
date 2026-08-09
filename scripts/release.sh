#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEFAULT_BRANCH=main
VERSION=${1:-}

cd "$ROOT"

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree has uncommitted changes. Commit or stash them before releasing." >&2
  exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "$DEFAULT_BRANCH" ]; then
  printf 'You are on branch "%s", not "%s". Continue anyway? [y/N] ' "$CURRENT_BRANCH" "$DEFAULT_BRANCH"
  read -r answer
  case "$answer" in
    y|Y) ;;
    *) echo "Cancelled."; exit 0 ;;
  esac
fi

echo "Fetching tags from origin..."
git fetch origin --tags --quiet

if [ -z "$VERSION" ]; then
  YEAR_MONTH=$(date +%Y.%m)
  LAST_PATCH=$(git tag -l "${YEAR_MONTH}.*" | sed -E "s/^${YEAR_MONTH}\.//" | sort -n | tail -1)
  if [ -z "$LAST_PATCH" ]; then
    NEXT_PATCH=1
  else
    NEXT_PATCH=$((10#$LAST_PATCH + 1))
  fi
  VERSION=$(printf '%s.%02d' "$YEAR_MONTH" "$NEXT_PATCH")
fi

if git rev-parse "$VERSION" >/dev/null 2>&1; then
  echo "Tag $VERSION already exists." >&2
  exit 1
fi

printf 'Release version %s. Create and push this tag? [y/N] ' "$VERSION"
read -r answer
case "$answer" in
  y|Y) ;;
  *) echo "Cancelled."; exit 0 ;;
esac

git tag -a "$VERSION" -m "Release $VERSION"
git push origin "$VERSION"

echo "Pushed tag $VERSION."
echo "CI will build and push the $VERSION container images and create the GitHub release."
