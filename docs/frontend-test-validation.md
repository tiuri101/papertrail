# Frontend test validation report

> Historical snapshot from an earlier development phase. Test counts and file counts below are frozen at that point in time and do not reflect the current suite; see [Frontend testing](frontend-testing.md) for the current test layout and CI for current results.

## Added test coverage

The placeholder smoke test was removed and replaced by:

- **45 Vitest component/integration tests** across 21 frontend test files
- **4 Playwright browser tests** across 3 workflow specifications
- Shared test utilities for React Router, TanStack Query, mocked HTTP responses, cleanup, and CSRF reset

The tests cover authentication, role-based access, users, projects, imports, publications, duplicate review, screening, conflict resolution, full-text retrieval, forms, extraction, quality assessment, lifecycle integrity, PRISMA reporting, and exports.

## Defects and design issues corrected while adding tests

1. Screening criteria were previously initialized to `false`. This allowed submission without an explicit reviewer response. Criteria now start unanswered and every criterion must be deliberately answered before submission.
2. Reviewer accounts previously saw the user-administration navigation item and could enter its frontend route. Navigation and routing are now administrator-gated.
3. Login now seeds the TanStack Query session cache, preventing an unnecessary immediate session reload.
4. Import, user, project, duplicate, conflict, full-text, form, extraction, quality, and reporting screens now expose relevant request errors.
5. File upload and full-text status controls received explicit accessible labels.
6. Several compressed single-line components were refactored into readable, maintainable structures.

## Validation completed in this environment

- Backend test suite: **42 passed**
- Fresh Alembic migration chain: **passed through revision 0015**
- TypeScript/TSX syntax parsing: **56 files, 0 syntax diagnostics**
- Production frontend line-length scan: **0 lines over 160 characters**
- Test inventory: **49 frontend test cases in 24 test files**

## Validation not executable in this environment

The environment's internal npm mirror returned `404 Not Found` for the pinned `@eslint/js@9.33.0` package. Consequently, npm dependencies could not be installed here and the following commands could not be executed locally:

```bash
npm run typecheck
npm run lint
npm run build
npm test
npm run test:e2e
```

These commands are configured in CI. The frontend CI job installs dependencies, type-checks production and test code, runs ESLint, builds the production bundle, runs Vitest, installs Chromium, and runs Playwright.

The frontend suite should be considered added but not locally execution-verified until it has run successfully against a normal npm registry or in CI.
