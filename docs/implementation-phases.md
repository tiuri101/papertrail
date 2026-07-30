# Papertrail Implementation Phases

## Purpose

This document defines an ordered implementation roadmap for **Papertrail**, a self-hosted multi-user web application for managing academic literature reviews.

The phases are designed to be implemented sequentially. Each phase should leave the application in a testable and internally coherent state. Later phases depend on data models, APIs, and workflow guarantees established earlier.

This roadmap assumes the following architecture:

- **Backend:** FastAPI
- **Backend language:** Python
- **Validation:** Pydantic
- **ORM:** SQLAlchemy 2
- **Database migrations:** Alembic
- **Database:** PostgreSQL
- **Frontend:** React with TypeScript
- **Frontend build system:** Vite
- **Routing:** React Router
- **Server-state management:** TanStack Query
- **Forms:** React Hook Form
- **Client-side validation:** Zod
- **Styling:** Tailwind CSS
- **Background processing:** Dedicated multithreaded Python worker
- **Persistent job queue:** PostgreSQL
- **Deployment:** Docker Compose
- **Testing:** pytest, Vitest, React Testing Library, and Playwright

The application should remain a **modular monolith**. The FastAPI API and background worker share the same domain services, SQLAlchemy models, validation logic, and database.

---

# Phase 0 — Project Foundation

## Goal

Create a stable development foundation before implementing domain-specific functionality.

## Scope

### Repository structure

Create a monorepo or clearly structured repository containing:

```text
papertrail/
├── backend/
├── frontend/
├── deployment/
├── docs/
├── scripts/
├── .github/ or .gitlab/
├── docker-compose.yml
└── README.md
```

Recommended backend structure:

```text
backend/
├── app/
│   ├── api/
│   ├── accounts/
│   ├── projects/
│   ├── searches/
│   ├── imports/
│   ├── publications/
│   ├── deduplication/
│   ├── screening/
│   ├── extraction/
│   ├── quality/
│   ├── reporting/
│   ├── audit/
│   ├── integrations/
│   └── jobs/
├── migrations/
├── tests/
└── pyproject.toml
```

Recommended frontend structure:

```text
frontend/
├── src/
│   ├── app/
│   ├── api/
│   ├── components/
│   ├── features/
│   ├── hooks/
│   ├── utilities/
│   └── main.tsx
├── tests/
└── package.json
```

### Development environment

Set up:

- FastAPI application
- React/TypeScript application
- PostgreSQL container
- API container
- Frontend development container or local development setup
- Reverse proxy configuration
- Shared environment-variable handling
- Persistent development volumes
- Health-check endpoints

### Backend infrastructure

Implement:

- SQLAlchemy engine and session management
- Alembic migrations
- Pydantic application settings
- Structured logging
- Central exception handling
- API version prefix, such as `/api/v1`
- Request identifiers
- Basic health and readiness endpoints

### Frontend infrastructure

Implement:

- React Router
- TanStack Query provider
- Shared API client
- Global error boundary
- Basic application shell
- Login route placeholder
- Protected-route mechanism
- Environment-specific API base URL

### Code quality

Configure:

- Python formatter and linter
- Python static type checking
- TypeScript strict mode
- ESLint and Prettier
- Pre-commit hooks
- Backend and frontend test commands
- Continuous-integration pipeline

## Deliverables

- Running backend and frontend
- PostgreSQL connection
- First Alembic migration
- Docker Compose development environment
- Automated linting and test pipeline
- Developer setup documentation

## Completion criteria

Phase 0 is complete when:

- A developer can clone the repository and start the application using documented commands.
- The frontend can call the backend health endpoint.
- Database migrations run automatically or through a documented command.
- Backend and frontend test suites execute successfully.
- CI rejects formatting, linting, type-checking, or test failures.

---

# Phase 1 — Authentication, Users, and Authorization

## Goal

Establish secure local authentication and the two-role user model before project data is introduced.

## Scope

### User accounts

Implement local user accounts with:

- Username
- Display name
- Password hash
- Active or disabled state
- Administrator flag
- Created timestamp
- Last-login timestamp

There is one installation-wide administrator role. All other accounts are reviewers.

### Session authentication

Use server-managed sessions stored in PostgreSQL.

Implement:

- Login
- Logout
- Session creation
- Session revocation
- Secure HTTP-only cookies
- SameSite cookie protection
- Session expiry
- Disabled-account enforcement
- Password verification
- Administrator-triggered password reset

Do not store authentication tokens in browser local storage.

### User administration

The administrator can:

- Create reviewer accounts
- Disable accounts
- Reset passwords
- View active accounts
- View account memberships once projects exist

Public registration is not supported.

### Authorization foundation

Implement reusable backend authorization dependencies for:

- Authenticated user
- Administrator
- Project member
- Activity-eligible reviewer

The final project-specific checks will be extended in later phases.

### Frontend

Implement:

- Login page
- Logout action
- Current-user query
- Protected application routes
- Administrator-only route handling
- User-management screen

## Deliverables

- Complete local login flow
- Administrator-managed user accounts
- Secure session handling
- Reusable authorization layer
- Authentication test coverage

## Completion criteria

Phase 1 is complete when:

- The administrator can create and disable reviewer accounts.
- Reviewers can log in and log out.
- Disabled users immediately lose access.
- Unauthorized API calls receive correct HTTP responses.
- Administrator-only API routes cannot be accessed by reviewers.
- Authentication survives normal page reloads without client-side token storage.

---

# Phase 2 — Projects, Membership, and Review Configuration

## Goal

Implement the core project model and the configuration required before records can be imported.

## Scope

### Project model

Implement projects with:

- Name
- Description
- Review type
- Current lifecycle state
- Created timestamp
- Completed timestamp
- Reopened timestamp
- Global random seed
- Configuration-ready flag

Supported review types:

- Systematic review
- Scoping review
- Systematic mapping study
- Other

### Project membership

Implement:

- Project membership
- Reviewer eligibility per activity
- Administrator membership
- Reviewer removal
- Membership validation

Eligibility flags should include:

- Title/abstract screening
- Full-text screening
- Extraction
- Quality assessment
- Adjudication

A reviewer may belong to several projects.

### Research design

Implement project-managed:

- Research questions
- Inclusion criteria
- Exclusion criteria
- Ordering of criteria
- Active/inactive state where useful

### Screening configuration

Implement independent configuration for:

- Title/abstract screening
- Full-text screening

Each stage should configure:

- Number of required reviewers
- Independent or divided screening
- Uncertain-decision resolution method
- Conflict-resolution method

Supported conflict-resolution methods:

- Discussion followed by consensus
- Administrator-recorded consensus
- Additional independent reviewer
- Designated adjudicator
- Majority decision

### Exclusion reasons

Implement:

- Title/abstract exclusion reasons
- Full-text exclusion reasons
- Required display order
- Active/inactive state

When a project is created, the full-text reason list should initially be copied from the title/abstract reason list. Both lists then become independently editable.

### Lifecycle foundation

Implement project states:

1. Draft
2. Duplicate review
3. Title/abstract screening
4. Full-text retrieval and screening
5. Extraction and quality assessment
6. Completed

Only the draft state is functionally active in this phase. Later phases add transition rules.

### Frontend

Implement:

- Project list
- Project creation
- Project overview
- Member management
- Eligibility management
- Research-question editor
- Criteria editor
- Screening settings
- Exclusion-reason editor

## Deliverables

- Configurable review projects
- Multi-project reviewer membership
- Screening-stage configuration
- Research questions and criteria
- Project configuration UI

## Completion criteria

Phase 2 is complete when:

- The administrator can create several projects.
- A reviewer can belong to several projects.
- Activity eligibility can be configured independently.
- Research questions and criteria can be created and reordered.
- Screening requirements can differ between stages.
- Exclusion-reason lists can be edited independently.
- Reviewers only see projects in which they are members.

---

# Phase 3 — Search Documentation and Import Framework

## Goal

Allow the administrator to document database searches and import bibliographic records while preserving provenance.

## Scope

### Search documentation

Implement search-source records containing:

- Database or source name
- Exact search query
- Search date
- Applied filters
- Exported result count
- Uploaded source file reference
- Import date
- Importing user

### Import batches

Implement import batches with:

- Project
- Search-source reference
- Original filename
- File type
- Status
- Record count
- Invalid-record count
- Created user
- Created timestamp
- Completion timestamp

### Supported file formats

Implement:

- CSV
- XLSX
- RIS
- BibTeX

### Source adapters

Create an adapter interface for:

- Format detection
- Source detection
- Preview generation
- Field mapping
- Record parsing
- Validation

Initial source adapters:

- Generic CSV
- Generic XLSX
- IEEE Xplore
- ScienceDirect
- ACM Digital Library
- SpringerLink
- RIS
- BibTeX

### Column mapping

Implement:

- Automatic source-field detection
- Manual source-to-target field mapping
- Import preview
- Required-field validation
- Confirmation before import

### Imported records

Store immutable imported records containing:

- Raw imported values
- Parsed imported values
- Import-batch reference
- Original row number or source key
- Validation state
- Import warnings

Do not immediately discard or overwrite source data.

### Manual records

Allow the administrator to manually create a publication record without an import file.

Detailed citation-chasing classifications are not required.

### Background worker foundation

Introduce the PostgreSQL-backed job table and dedicated worker process.

Initial job types:

- Parse import
- Validate import
- Create normalized records

Implement:

- Job claiming with `FOR UPDATE SKIP LOCKED`
- ThreadPoolExecutor
- Worker identifier
- Lease expiry
- Retry count
- Progress updates
- Failure reporting

### Frontend

Implement:

- Search-documentation form
- File-upload screen
- Import preview
- Column-mapping screen
- Import progress screen
- Import summary
- Invalid-row report
- Manual publication entry

## Deliverables

- Search documentation
- Import adapters
- Persistent source records
- PostgreSQL-backed threaded job worker
- Import preview and confirmation flow

## Completion criteria

Phase 3 is complete when:

- CSV, XLSX, RIS, and BibTeX files can be imported.
- Known source exports are recognized where fixture examples are available.
- Unknown CSV/XLSX layouts can be manually mapped.
- Original imported values remain stored.
- Invalid rows are visible and do not silently disappear.
- Import work survives an API restart because it is persisted as a job.
- A manually entered publication can be created.

---

# Phase 4 — Publication Normalization and Metadata Enrichment

## Goal

Create a stable normalized publication model and allow administrator-controlled enrichment through external metadata services.

## Scope

### Normalized publication model

Implement publication records with:

- Internal identifier
- Title
- Formatted authors string
- Abstract
- Publication year
- Venue
- Publication type
- DOI
- Publisher URL
- Keywords
- ISBN
- ISSN
- PubMed identifier
- arXiv identifier
- Other identifiers
- Active/merged state

### Provenance

Implement links between:

- Publication
- Imported record
- Import batch
- Search source

A publication may have several imported source records.

### Normalization

Implement normalization rules for:

- DOI casing and prefixes
- Title whitespace
- Author string whitespace
- Year parsing
- Keyword separators
- URL validation
- Empty-value handling
- Publication type mapping

### Manual editing

The administrator can edit normalized publication metadata.

### Metadata enrichment

Implement on-demand enrichment using:

- Crossref
- Semantic Scholar

Supported operations:

- Enrich one publication
- Enrich selected publications
- Bulk enrich publications with missing metadata

### Candidate matching

Support:

- Direct DOI lookup
- Title-and-author search when DOI is unavailable
- Candidate display
- Manual candidate confirmation

### Conflict resolution

Important conflicting fields require manual review:

- DOI
- Title
- Authors
- Publication year
- Abstract
- Venue

Provide:

- Current value
- Proposed value
- Data source
- Keep-current action
- Accept-proposed action

### Background jobs

Add job types for:

- Single-record enrichment
- Bulk enrichment
- Metadata candidate search

Add:

- External API timeouts
- Retries with backoff
- Rate limiting
- Per-service error reporting

### Frontend

Implement:

- Publication metadata view
- Metadata editing
- Enrichment action
- Bulk-enrichment action
- Candidate-match dialog
- Conflict-resolution interface
- Job-progress feedback

## Deliverables

- Normalized publication database
- Provenance-preserving source links
- Crossref integration
- Semantic Scholar integration
- Manual metadata conflict resolution

## Completion criteria

Phase 4 is complete when:

- Imported records create normalized publications.
- Multiple imported records can point to one publication later.
- Publications without DOIs are supported.
- The administrator can edit metadata.
- Missing metadata can be enriched by DOI.
- Title-and-author candidate matches require confirmation.
- Important conflicts are never silently overwritten.
- Bulk enrichment reports progress and recoverable failures.

---

# Phase 5 — Duplicate Detection and Resolution

## Goal

Provide a complete duplicate-review stage before screening begins.

## Scope

### Duplicate-candidate generation

Generate duplicate suggestions using:

1. Exact DOI match
2. Exact normalized-title match
3. Fuzzy title similarity
4. Title and publication-year similarity
5. Title and author similarity
6. Other shared identifiers

Use RapidFuzz or an equivalent similarity library.

### Candidate model

Store:

- Publication A
- Publication B
- Match reasons
- DOI match flag
- Title similarity score
- Author similarity score
- Year agreement
- Overall confidence
- Resolution state

### Duplicate-review decisions

Supported decisions:

- Not a duplicate
- Merge
- Confirm canonical record

Every candidate must be resolved before screening can begin.

### Merge process

A merge should:

- Select or create one canonical publication.
- Prefer more complete metadata by default.
- Require manual resolution of important conflicts.
- Retain all imported source records.
- Retain all search-source provenance.
- Mark the non-canonical publication as merged.
- Redirect active project workflows to the canonical publication.
- Record a reversible merge entry.

Do not physically delete merged publications.

### Merge reversal

Allow the administrator to reverse a merge before screening.

Late reversal after screening should require returning the project to duplicate review and displaying a warning.

### Project transition

Implement the automatic transition:

```text
Draft → Duplicate review
```

when project configuration is ready and records exist.

Implement:

```text
Duplicate review → Title/abstract screening
```

when every duplicate candidate has been resolved.

### Frontend

Implement:

- Duplicate-review queue
- Side-by-side publication comparison
- Similarity evidence
- Metadata conflict selection
- Canonical-record selection
- Merge action
- Merge reversal
- Duplicate-review progress

## Deliverables

- Duplicate-detection job
- Complete duplicate-review workflow
- Reversible canonical merges
- Automatic transition into title/abstract screening

## Completion criteria

Phase 5 is complete when:

- Duplicate suggestions are generated for a project.
- Suggestions are never merged automatically.
- All suggestions must be resolved.
- Merges preserve all source records and provenance.
- Merges can be reversed.
- Title/abstract screening cannot begin while unresolved suggestions exist.
- The project automatically advances when duplicate review is complete.

---

# Phase 6 — Title and Abstract Screening

## Goal

Implement the first complete multi-reviewer screening workflow.

## Scope

### Screening work items

Create work items containing:

- Project
- Publication
- Screening stage
- Reviewer slot
- Assigned or reserving reviewer
- Random rank
- Reservation expiry
- Submission state

### Random queue order

Generate one deterministic project-wide random order using:

- Stored global seed
- Project identifier
- Publication identifier
- Screening stage

The order must be reproducible.

### Queue claims

Implement atomic queue claiming using PostgreSQL row locking.

A claim should:

- Reserve one available reviewer slot.
- Prevent concurrent claiming of the same slot.
- Set a one-day reservation expiry.
- Immediately commit the claim transaction.
- Allow explicit skip or release.

### Screening form

Display:

- Title
- Authors
- Year
- Venue
- Publication type
- Abstract
- Keywords
- DOI
- Publisher URL
- Source databases
- Inclusion criteria
- Exclusion criteria
- Decision controls
- Exclusion reason
- Optional notes

### Criteria completion

Every inclusion and exclusion criterion must be explicitly answered before submission.

The checklist does not automatically determine the decision.

### Decisions

Support:

- Include
- Exclude
- Uncertain
- Duplicate

Exactly one exclusion reason is required for exclusion.

### Independent screening

When independent screening is enabled:

- Each publication has the configured number of reviewer slots.
- A reviewer cannot occupy several slots for the same publication.
- Decisions remain hidden until all required reviewers submit.
- Submitted criteria, notes, and reasons are hidden with the decision.
- After reveal, all reviewers can see the submitted decisions.

### Divided screening

When divided screening is enabled:

- Work is automatically distributed approximately evenly.
- Each publication receives the configured number of reviewer assignments.
- No administrator-managed manual assignment interface is required.

### Drafts and autosave

Autosave:

- Criteria selections
- Current decision
- Exclusion reason
- Notes

Drafts remain associated with the reserved reviewer slot.

### Revisions

Submitted decisions may be revised.

Each revision should:

- Create a new revision entry
- Preserve the previous version
- Be included in the audit log
- Re-evaluate conflict status

### Frontend

Implement:

- Screening queue
- Record-by-record screening view
- Autosave feedback
- Skip and release actions
- Decision submission
- Revision workflow
- Screening progress dashboard

## Deliverables

- Database-backed screening queue
- Independent and divided screening
- Hidden-decision behavior
- Criteria checklists
- Revision history
- Title/abstract progress tracking

## Completion criteria

Phase 6 is complete when:

- Two reviewers cannot claim the same reviewer slot.
- Queue reservations expire after one day.
- Screening follows the shared deterministic random order.
- Every criterion must be completed before submission.
- Exclusions require one reason.
- Independent decisions remain inaccessible until reveal.
- Reviewers can revise their own decisions.
- The application accurately identifies agreements, conflicts, and uncertain outcomes.

---

# Phase 7 — Conflict Resolution and Final Decisions

## Goal

Resolve uncertain and conflicting screening outcomes without altering individual reviewer decisions.

## Scope

### Conflict detection

Detect:

- Include/exclude disagreement
- Unresolved uncertain decisions
- Duplicate disagreement
- Missing required additional reviewer
- Majority ties where applicable

### Final-decision model

Store separately:

- Stage
- Publication
- Final outcome
- Resolution method
- Resolving administrator or adjudicator
- Optional consensus note
- Created timestamp
- Invalidated timestamp

Never overwrite individual reviewer decisions.

### Resolution workflows

Support:

- Discussion followed by consensus
- Administrator-recorded consensus
- Additional independent reviewer
- Designated adjudicator
- Majority decision

### Additional reviewers

Where configured:

- Create an additional reviewer slot.
- Return the publication to the eligible queue.
- Hide the additional decision as appropriate.
- Recalculate the final outcome after submission.

### Consensus invalidation

If a reviewer changes a decision after consensus:

- Mark the final decision invalid.
- Return the publication to conflict resolution.
- Preserve the old consensus in the audit log.
- Require a new final decision.

### Transition to full-text stage

Implement automatic transition when:

- Every publication has the required reviewer decisions.
- Every conflict is resolved.
- Every uncertain outcome is resolved.
- A final project decision exists where required.

### Frontend

Implement:

- Conflict-resolution queue
- Side-by-side reviewer decisions
- Criteria comparison
- Notes and exclusion-reason comparison
- Resolution-method display
- Final-consensus form
- Consensus invalidation status

## Deliverables

- Conflict-resolution workflow
- Final project decisions
- Additional-reviewer workflow
- Consensus invalidation
- Automatic transition to full-text stage

## Completion criteria

Phase 7 is complete when:

- Individual reviewer decisions remain immutable to the administrator.
- Final decisions are stored separately.
- All configured resolution methods work.
- Revised reviewer decisions invalidate prior consensus.
- Title/abstract screening only completes when all records are resolved.
- The project automatically transitions to full-text retrieval and screening.

---

# Phase 8 — Full-Text Retrieval and Screening

## Goal

Track manual full-text retrieval and perform the second screening stage.

## Scope

### Retrieval status

Support:

- Not yet sought
- Full text available
- Full text requested
- Full text not found
- Full text inaccessible

Papertrail does not download or store full-text files.

### External links

Provide:

- DOI link
- Publisher URL
- Other useful identifier-based links

### PRISMA distinction

Keep reports not retrieved separate from full-text exclusions.

Only records marked as full text available enter full-text screening.

### Full-text screening

Reuse the screening engine with stage-specific:

- Reviewer count
- Independent or divided mode
- Exclusion reasons
- Conflict-resolution method
- Uncertain-decision handling
- Queue work items
- Criteria checklists
- Notes
- Revisions

### Transition to extraction

Advance when every title/abstract inclusion has either:

- A non-retrieved status, or
- A completed and resolved full-text decision

### Frontend

Implement:

- Full-text retrieval queue
- Retrieval-status controls
- External-link controls
- Reports-not-retrieved overview
- Full-text screening queue
- Stage-specific exclusion reasons
- Full-text conflict resolution
- Full-text progress dashboard

## Deliverables

- Manual retrieval tracking
- Full-text screening
- Separate PRISMA report-retrieval counts
- Automatic transition into extraction and quality assessment

## Completion criteria

Phase 8 is complete when:

- Full-text retrieval is tracked without storing PDFs.
- Reports not retrieved are counted separately.
- Only available reports are screened.
- Full-text screening uses its own project configuration.
- Full-text exclusions require one reason.
- All conflicts and uncertain outcomes must be resolved.
- The project advances automatically when the stage is complete.

---

# Phase 9 — Dynamic Forms and Templates

## Goal

Implement the configurable form system needed for extraction and quality assessment.

## Scope

### Form model

Implement:

- Form template
- Project form
- Form version
- Form field
- Field option
- Field order
- Required/optional state
- Active/archived field state

### Supported field types

Implement:

- Short text
- Long text
- Number
- Checkbox
- Single selection
- Multiple selection
- Date
- URL
- Rating scale

Conditional logic is not required.

### Stable field identity

Every field must have a stable UUID that survives:

- Label changes
- Reordering
- New form versions

### Form templates

The administrator can:

- Create templates
- Copy templates
- Edit templates
- Create a project form from a template
- Create a template from a project form

Changing a template must not alter existing project forms.

### Form versioning

Published form versions should be immutable.

Editing an active project form should:

- Display a warning
- Create a new version
- Preserve prior responses
- Record an audit event

### Form-change behavior

Implement:

- Rename field without losing values
- Add required field and reopen affected completed responses
- Add optional field without reopening completed responses
- Archive removed fields
- Explicit migration requirement for incompatible type changes

### Frontend form builder

Implement:

- Field creation
- Field type selection
- Required/optional setting
- Option management
- Field ordering
- Template selection
- Version warning
- Form preview

## Deliverables

- Versioned dynamic-form engine
- Extraction templates
- Quality-assessment templates
- Project-specific form copies
- Safe form-evolution rules

## Completion criteria

Phase 9 is complete when:

- The administrator can build forms without code changes.
- Templates can be reused.
- Project copies remain independent.
- Existing responses survive field renaming and removal.
- Adding required fields reopens affected work.
- Incompatible field-type changes cannot silently corrupt data.
- Form changes are versioned and logged.

---

# Phase 10 — Data Extraction

## Goal

Collect project-specific structured findings for every finally included publication.

## Scope

### Extraction assignments

Every included publication receives exactly one extraction work item.

Multiple reviewers may perform extraction in a project, but each publication has one responsible reviewer.

### Queue behavior

Use:

- Shared deterministic queue order
- One-day reservation
- Skip and release
- Autosaved drafts
- Eligibility checks

### Extraction responses

Store:

- Publication
- Assigned reviewer
- Form version
- JSONB answers
- Draft/completed state
- Completion timestamp
- Revision number

Validate all answers server-side against the active form version.

### Visibility

Reviewers can access only their own assigned extraction work.

The administrator can see all extraction work.

### Revisions and reopening

The assigned reviewer may revise submitted extraction data.

The administrator may reopen extraction work but may not silently edit the reviewer’s answers.

### Form changes

When the extraction form changes:

- Recalculate completeness.
- Reopen work where a new required field is missing.
- Retain archived-field values.
- Continue displaying the correct version context.

### Frontend

Implement:

- Extraction queue
- Dynamic extraction form
- Autosave
- Submission
- Revision
- Administrator overview
- Reopen action
- Completion progress

## Deliverables

- Single-reviewer extraction workflow
- Dynamic extraction rendering
- Autosave and revisions
- Administrator oversight
- Completeness calculation

## Completion criteria

Phase 10 is complete when:

- Every included publication has one extraction assignment.
- Only eligible reviewers can claim extraction work.
- Required fields are validated.
- Drafts survive page reloads and reservations.
- Submitted extraction can be revised.
- The administrator can reopen work without modifying answers.
- Form-version changes preserve historical responses.

---

# Phase 11 — Quality Assessment

## Goal

Implement one-reviewer quality assessment with configurable qualitative and numerical scoring.

## Scope

### Quality-assessment configuration

Allow the project to use:

- No quality assessment
- Qualitative assessment
- Numerical scoring
- Both qualitative and numerical assessment

### Assignments

Every included publication requiring assessment receives exactly one quality-assessment work item.

The same reviewer may perform extraction and quality assessment unless eligibility prevents it.

### Quality responses

Use the dynamic-form system.

Support:

- Categorical answers
- Numerical values
- Comments
- Rating scales
- Required questions

### Scoring

Support:

- Simple sums
- Weighted sums
- Average scores where configured
- Stored calculated total
- Recalculation after revisions

Quality scores must never automatically include or exclude a publication.

### Queue and visibility

Use:

- One-day reservation
- Eligibility checks
- Shared random order
- Autosave
- Reviewer-only visibility
- Administrator overview

### Revisions and reopening

The assigned reviewer may revise the assessment.

The administrator may reopen it.

### Frontend

Implement:

- Quality-assessment queue
- Dynamic form
- Score preview
- Submission and revision
- Administrator overview
- Reopen action
- Completion progress

## Deliverables

- Configurable quality-assessment workflow
- Numerical and qualitative assessment
- Automatic scoring
- Single-reviewer assignment model

## Completion criteria

Phase 11 is complete when:

- Quality assessment can be disabled per project.
- Enabled projects assign exactly one reviewer per publication.
- Scores calculate correctly.
- Weighting works where configured.
- Scores do not alter inclusion decisions.
- Responses can be revised and reopened.
- Completion status respects required questions.

---

# Phase 12 — PRISMA Reporting and Exports

## Goal

Generate the required academic outputs directly from project data.

## Scope

### PRISMA 2020 counts

Calculate:

- Records identified from databases
- Records identified from other sources
- Duplicate records removed
- Records screened
- Records excluded
- Reports sought for retrieval
- Reports not retrieved
- Reports assessed for eligibility
- Full-text reports excluded by reason
- Publications included

Counts must be computed from authoritative project records and cannot be manually overwritten.

### PRISMA SVG

Create a fixed PRISMA 2020 SVG template.

The generation process should:

- Validate count consistency
- Populate calculated values
- Escape user-entered text
- Produce downloadable SVG
- Store the export artifact
- Record export generation in the audit log

### Excel export

Generate one XLSX workbook with worksheets for:

- Project overview
- Research questions
- Inclusion criteria
- Exclusion criteria
- Search documentation
- Imports
- Normalized records
- Duplicate decisions
- Title/abstract screening
- Full-text retrieval
- Full-text screening
- Exclusions
- Included publications
- Extraction
- Quality assessment
- Audit history

Use stable identifiers across worksheets.

Prevent spreadsheet-formula injection.

### BibTeX export

Support configurable scopes:

- Included publications
- All screened publications
- Excluded publications
- Duplicate publications
- Selected decision or status set

Generate stable fallback citation keys.

### Background jobs

Generate exports through the threaded worker.

Support:

- Progress reporting
- Download after completion
- Failed-export reporting
- Safe regeneration
- Authorization-checked downloads

### Frontend

Implement:

- Reporting dashboard
- PRISMA count preview
- Data-consistency warnings
- Export configuration
- Job progress
- Download links
- Export history

## Deliverables

- PRISMA 2020 calculations
- SVG flow diagram
- XLSX workbook
- Configurable BibTeX export
- Secure artifact downloads

## Completion criteria

Phase 12 is complete when:

- PRISMA counts reconcile with workflow records.
- Reports not retrieved are separate from full-text exclusions.
- The SVG is valid and downloadable.
- Excel contains all required worksheets.
- Spreadsheet cells are protected against formula injection.
- BibTeX output is syntactically valid.
- Export jobs survive API restarts.

---

# Phase 13 — Audit Logging and Administrative Oversight

## Goal

Complete the cross-cutting audit trail and administrative monitoring required for a transparent review process.

## Scope

### Audit-event model

Store:

- Timestamp
- User
- Project
- Action type
- Entity type
- Entity identifier
- Human-readable summary
- Structured metadata

### Audited actions

Ensure semantic audit events exist for:

- Project creation
- Configuration changes
- Membership changes
- Lifecycle transitions
- Imports
- Metadata edits
- Metadata enrichment
- Duplicate decisions
- Merge reversals
- Screening submissions
- Screening revisions
- Consensus creation
- Consensus invalidation
- Retrieval-status changes
- Form-version changes
- Extraction submissions
- Quality-assessment submissions
- Reopened work
- Project completion
- Project reopening
- Export generation

Audit events should be written in the same transaction as the domain change.

### Administrative dashboard

Show:

- Current lifecycle state
- Stage progress
- Unresolved duplicates
- Screening conflicts
- Uncertain decisions
- Reports not retrieved
- Extraction remaining
- Quality assessment remaining
- Failed background jobs
- Recent audit events

### Audit export

Include audit history in the project Excel export.

A separate raw audit export may also be provided.

## Deliverables

- Complete semantic audit trail
- Administrative status dashboard
- Audit inspection interface
- Audit export support

## Completion criteria

Phase 13 is complete when:

- Every significant domain action creates an audit event.
- Audit entries identify the responsible user.
- Audit entries are not editable through normal application interfaces.
- Project progress can be understood from the dashboard.
- Consensus invalidation and lifecycle changes are traceable.
- Audit history appears in exports.

---

# Phase 14 — Completion, Reopening, and Workflow Integrity

## Goal

Finalize lifecycle behavior and ensure that projects can be completed and safely reopened.

## Scope

### Completion

Automatically mark a project completed when:

- Full-text screening is resolved.
- Every included publication has completed extraction.
- Every required quality assessment is complete.
- All required fields are complete.
- No active conflicts remain.

### Completed-state behavior

A completed project remains accessible.

The administrator can:

- View all data
- Generate exports
- Reopen the project

Reviewer editing should normally stop until the project is reopened.

### Reopening

The administrator selects the target stage.

Reopening should:

- Preserve downstream records
- Recalculate active publication sets
- Exclude no-longer-applicable downstream records from active counts
- Preserve their stored data
- Record an audit event
- Recreate missing work items where needed
- Re-evaluate consensus and completion conditions

### Backward transitions

Create explicit application services for moving between stages.

Avoid implementing lifecycle behavior directly inside API route handlers.

### Integrity checks

Implement project-level consistency checks for:

- Missing canonical publications
- Unresolved duplicates
- Incorrect reviewer-slot counts
- Orphaned final decisions
- Incomplete required criteria
- Included records without downstream work
- PRISMA count inconsistencies
- Form responses using unknown field identifiers

### Frontend

Implement:

- Completion summary
- Reopen-project dialog
- Target-stage selection
- Consequence warning
- Integrity-warning display

## Deliverables

- Automatic project completion
- Safe reopening
- Downstream data preservation
- Project consistency validation

## Completion criteria

Phase 14 is complete when:

- Projects complete automatically under the documented rules.
- Completed projects can be reopened.
- Reopening never deletes downstream data.
- No-longer-applicable work is excluded from active counts.
- The administrator receives clear warnings before moving backward.
- Integrity checks detect deliberately introduced invalid test data.

---

# Phase 15 — Security, Reliability, and Performance Hardening

## Goal

Prepare Papertrail for real self-hosted use.

## Scope

### Security

Verify and harden:

- Password hashing
- Session expiry
- Session revocation
- Secure cookie configuration
- CSRF protection
- CORS configuration
- Server-side authorization
- Upload validation
- File-size limits
- Filename sanitization
- MIME-type checks
- XSS protection
- SQL-injection resistance
- Formula-injection prevention
- External-metadata sanitization
- Secret management
- Rate limiting for login
- Download authorization

### Hidden reviewer decisions

Test that hidden decisions cannot be retrieved through:

- API responses
- Alternate endpoints
- Browser developer tools
- Error responses
- Export endpoints
- Progress endpoints

### Worker reliability

Implement:

- Graceful shutdown
- Lease renewal
- Expired-job recovery
- Idempotent task execution
- Bounded thread count
- Per-job timeout strategy
- Retry classification
- External API rate limiting
- Job cancellation where safe

### Database reliability

Implement:

- Transaction boundaries
- Deadlock retry handling
- Appropriate indexes
- Unique constraints
- Foreign-key constraints
- Backup documentation
- Restore documentation

### Performance

Test realistic projects containing:

- Several thousand imported records
- Multiple simultaneous reviewers
- Long abstracts
- Large extraction forms
- Bulk enrichment
- XLSX export

Optimize:

- Queue-claim queries
- Duplicate-candidate queries
- Project progress aggregation
- Screening dashboard queries
- Export memory use

### Accessibility

Verify:

- Keyboard navigation
- Visible focus states
- Form labels
- Screen-reader names
- Error announcements
- Sufficient contrast
- Non-color-only status indicators

## Deliverables

- Security review checklist
- Load and concurrency tests
- Database index review
- Backup and recovery guide
- Accessibility review
- Worker failure-recovery tests

## Completion criteria

Phase 15 is complete when:

- Authorization tests cover every project-scoped API.
- Hidden decisions cannot be accessed before reveal.
- Two reviewers cannot claim the same slot under load.
- Expired jobs and reservations recover correctly.
- Backup and restore procedures are documented and tested.
- Common review workloads remain responsive.
- Critical workflows are keyboard accessible.

---

# Phase 16 — Deployment, Documentation, and First Release

## Goal

Package Papertrail as a maintainable self-hosted application.

## Scope

### Production containers

Provide containers for:

- React frontend
- FastAPI API
- Threaded worker
- PostgreSQL
- Reverse proxy

The API and worker should use the same backend image with different startup commands.

### Persistent storage

Configure:

- PostgreSQL volume
- Import-file volume
- Export-file volume
- Backup location

### Configuration

Support environment variables for:

- Database connection
- Session settings
- Administrator bootstrap
- File limits
- Crossref identification
- Semantic Scholar API key where applicable
- Worker thread count
- Job polling interval
- Job lease duration
- External base URL
- Logging level

### Operations

Provide:

- Health checks
- Readiness checks
- Container restart policies
- Database migration command
- Initial administrator creation
- Log access
- Backup command
- Restore command
- Upgrade procedure

### Documentation

Write:

- User guide
- Administrator guide
- Installation guide
- Upgrade guide
- Backup and recovery guide
- Developer guide
- Architecture overview
- API overview
- Import-format guide
- Review-workflow guide

### Release validation

Run a complete acceptance scenario:

1. Create users.
2. Create a project.
3. Configure review criteria.
4. Import records from several formats.
5. Enrich metadata.
6. Resolve duplicates.
7. Complete title/abstract screening.
8. Resolve conflicts.
9. Track full-text retrieval.
10. Complete full-text screening.
11. Extract data.
12. Assess quality.
13. Complete the project.
14. Generate PRISMA, Excel, and BibTeX exports.
15. Reopen the project and verify data preservation.

## Deliverables

- Production Docker Compose setup
- Installation documentation
- Administrator documentation
- End-user documentation
- Release checklist
- Versioned first release

## Completion criteria

Phase 16 is complete when:

- Papertrail can be installed on a clean host using the documentation.
- Data persists across container restarts.
- Migrations can be applied during upgrades.
- Backups can be restored.
- The complete acceptance scenario succeeds.
- The application is ready for use in a real literature review.

---

# Recommended Milestones

The implementation phases can be grouped into broader milestones.

## Milestone 1 — Technical Foundation

Includes:

- Phase 0
- Phase 1
- Phase 2

Result:

A secure multi-user project-management application with configurable review projects.

## Milestone 2 — Literature Intake

Includes:

- Phase 3
- Phase 4
- Phase 5

Result:

Search exports can be imported, normalized, enriched, and deduplicated.

## Milestone 3 — Screening Workflow

Includes:

- Phase 6
- Phase 7
- Phase 8

Result:

Reviewers can complete title/abstract and full-text screening with configurable multi-reviewer conflict resolution.

## Milestone 4 — Evidence Collection

Includes:

- Phase 9
- Phase 10
- Phase 11

Result:

Projects can define reusable forms and collect extraction and quality-assessment data.

## Milestone 5 — Reporting and Governance

Includes:

- Phase 12
- Phase 13
- Phase 14

Result:

Projects can be completed, audited, reopened, and exported according to PRISMA 2020.

## Milestone 6 — Production Readiness

Includes:

- Phase 15
- Phase 16

Result:

Papertrail is secure, tested, documented, deployable, and ready for real use.

---

# Implementation Principles

The following principles should apply throughout all phases.

## 1. Keep PostgreSQL authoritative

Do not use browser state, in-memory worker state, or filesystem state as the authoritative source for workflow decisions.

## 2. Keep route handlers thin

FastAPI routes should:

- Validate input
- Resolve authorization
- Call an application service
- Return a response

Business rules belong in explicit services.

## 3. Use transactions for domain operations

Actions such as:

- Claiming queue work
- Merging duplicates
- Recording consensus
- Transitioning project stages
- Publishing form versions

must be transactional.

## 4. Record semantic audit events

Audit actions in terms users understand, not only as low-level database changes.

## 5. Preserve original reviewer decisions

Final project decisions must remain separate from individual reviewer decisions.

## 6. Preserve imported source data

Normalization and enrichment must not destroy original imported metadata.

## 7. Avoid premature distributed architecture

The API and worker are separate processes but belong to one modular application and one database.

## 8. Build workflow tests early

Every phase should include tests for its domain rules before proceeding to the next phase.

## 9. Keep long operations out of API requests

Imports, enrichment, duplicate detection, and export generation should use the persistent threaded worker.

## 10. Implement vertical slices

Each phase should include:

- Database schema
- Domain service
- API endpoints
- Frontend interface
- Authorization
- Tests
- Audit events where applicable

Avoid implementing the entire database first and postponing usable workflows until the end.

---

# Suggested First Development Slice

The first end-to-end slice should be deliberately small:

1. Administrator login
2. Reviewer account creation
3. Project creation
4. One inclusion criterion
5. One exclusion criterion
6. Generic CSV import
7. Normalized title and abstract
8. Single-reviewer title/abstract queue
9. Include or exclude decision
10. Basic project progress

This slice validates the central architecture before source-specific imports, multi-reviewer behavior, dynamic forms, and reporting are added.

It should not replace the ordered phases above, but it can be implemented across the early phases as an architectural proof of concept.
