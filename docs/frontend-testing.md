# Frontend testing

Papertrail uses two complementary frontend test layers.

## Component and integration tests

Vitest, React Testing Library, and jsdom cover API behavior and React workflows without requiring a running backend. The test suite uses mocked `fetch` responses while retaining the real routing, TanStack Query behavior, form events, and component state.

Covered areas include:

- API credentials, JSON requests, multipart uploads, CSRF headers, errors, and empty responses
- Session loading, authentication redirects, login, logout, and session caching
- Administrator-only navigation and route protection
- Project-owner and administrator gating of project administration, conflict resolution, form management, and the audit log
- User and project creation
- Import upload behavior and error handling
- Publication and project views
- Duplicate resolution and canonical-record selection by any project member
- Screening queues, explicit criterion completion, exclusions, draft restoration, and empty queues
- Screening reviewer-count and disagreement/uncertain-resolution configuration
- Consensus decisions and full-text retrieval status
- Extraction and quality-assessment submissions, including malformed JSON
- Dynamic form creation and required fields
- Project integrity and reopening
- PRISMA display and export generation

Run the suite with:

```bash
cd frontend
npm test
```

Run interactively during development with:

```bash
npm run test:watch
```

## Browser workflows

Playwright runs the built application behavior in Chromium while intercepting API requests. The initial browser workflows cover:

- Unauthenticated redirect and administrator login
- Reviewer-specific navigation restrictions
- A complete title/abstract exclusion decision
- Dual extraction: an independent extractor submission followed by manager reconciliation
- PRISMA reporting and Excel export generation

Run the browser suite with:

```bash
cd frontend
npx playwright install chromium
npm run test:e2e
```

## Type checking and linting

Production source and test source have separate TypeScript configurations:

```bash
npm run typecheck
npm run lint
npm run build
```

The production build excludes test files. The test TypeScript configuration includes Vitest, Testing Library, and Playwright types.

## Continuous integration

The frontend CI job runs, in order:

1. Dependency installation
2. Production and test type checking
3. ESLint
4. Vitest
5. Production build
6. Chromium installation
7. Playwright

A frontend change should not be merged when any of these steps fails. CI also has separate backend and Browser Helper verification jobs; pull requests and manually dispatched CI runs execute the test jobs, while release pushes build/package artifacts instead.
