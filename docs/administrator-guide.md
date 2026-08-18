# Administrator Guide

The installation administrator creates all local user accounts and has full access to every review project. Any signed-in user can create a project; the user who creates it becomes that project's **owner** and gets the same management rights as the administrator, scoped to that one project.

## Project ownership

- **Administrator** — one or more installation-wide accounts. Can create and disable any user account, and manages every project as if they owned it.
- **Project owner** — whoever created the project. Can manage members, their screening eligibility, and their workload weight; screening, extraction, and quality-assessment allocation configuration; highlighted keywords, project details, publication metadata and enrichment, metadata-conflict resolution, screening-conflict resolution, project-specific forms, the audit log, and lifecycle actions (mark ready for duplicate review, reopen, move back, reset, delete, reverse a merge) — for that project only.
- **Reviewer / project member** — anyone added to a project. Can perform the screening, extraction, and quality-assessment activities they're eligible for; edit the project's research questions and inclusion/exclusion criteria; document searches and upload import files; resolve duplicate candidates (not a duplicate, or merge); and generate and download exports. Members only see the projects they belong to, and only the actions within a project they're actually permitted to perform.

An administrator is not automatically a reviewer on a project — reviewer eligibility (screening, extraction, quality assessment, adjudication) is still granted per member, independently of ownership.

## Recommended project sequence

1. Create reviewer accounts (administrator only).
2. Create a project — any user can do this and becomes its owner — and add eligible reviewers.
3. Define research questions and criteria (owner, administrator, or any project member); configure screening settings, including the number of reviewers required per stage, how publications are allocated to reviewers, and how disagreements and uncertain decisions are resolved (owner or administrator).
4. Document each database search and import its export file (any project member).
5. Review metadata and run enrichment where required (owner or administrator).
6. Resolve all duplicate candidates (any project member marks each as not a duplicate or merges it; the owner or administrator marks the project ready to enter duplicate review and can reverse a merge).
7. Complete title/abstract screening and resolve disagreements.
8. Track full-text retrieval (manual, or browser-assisted via a paired Chrome extension) and complete full-text screening.
9. Configure extraction and quality-assessment forms.
10. Complete extraction and quality assessment.
11. Review integrity warnings and generate PRISMA, XLSX, Parquet, JSON, CSV, and BibTeX exports.

## Accounts

Only the administrator creates and disables user accounts. An email address is optional; when email support is enabled, creating an account with an address queues a welcome message containing the username and login link, but never the temporary password. Users may maintain their own address in Account Settings. Disable accounts rather than deleting them when historical decisions must remain attributable. Password resets replace the password while retaining the account identity.

Deactivating a user or resetting their password (by an administrator, or the user's own emailed reset link) also revokes any browser helpers (paired Chrome extensions) they hold, in addition to their sessions -- a browser helper's bearer token authenticates independently of the password, so it must not remain usable once the account is disabled or considered compromised.

## Browser-assisted PDF retrieval

Reviewers can optionally pair a Chrome extension ("Browser Helper") from their own Account Settings so it retrieves publisher PDFs through their own computer's network access and sign-in state, then uploads them through the normal PDF pipeline -- see the [Reviewer guide](user-guide.md#browser-assisted-pdf-retrieval). The Papertrail server itself never scrapes publisher content or receives publisher credentials/cookies through this feature; it only issues short-lived retrieval jobs and validates whatever PDF the extension uploads, exactly as it would a manual upload. A user can revoke their own browser helpers at any time from Account Settings, which immediately prevents further use of that credential.

## Email notifications

Email is opt-in at installation level through SMTP configuration. The initial notification set covers account creation, notifying active administrators when a project is created, being added to or removed from a project (permission-only edits deliberately do not send mail), and a project-owner summary when all currently scheduled LLM jobs for one task stage reach a terminal state. Failed LLM jobs are counted separately in that summary. Each event has a durable, deduplicated notification record and is delivered by the normal worker with retries; SMTP downtime does not roll back the originating account, project, membership, or LLM operation.

## Reviewer allocation

Each stage that assigns publications to individual reviewers (title/abstract screening, full-text screening, data extraction, quality assessment) has its own allocation setting, configured from Project Members and each stage's settings in Project Administration or the Setup Wizard:

- **Claim** (default for every stage) — publications are left unassigned; a reviewer's queue hands them the next available one as they work, rather than pre-committing publications to specific people.
- **Divided** / **Pre-assigned** — publications are split across eligible reviewers up front, round-robin, weighted by each reviewer's **workload weight** (set per reviewer in Project Members; a reviewer with weight 2 receives roughly twice as many publications as one with weight 1, default 1 for everyone).
- **Independent** (title/abstract and full-text screening only) — every eligible reviewer sees every publication, rather than the work being split up at all.

Workload weight only affects stages using Divided/Pre-assigned allocation; it has no effect on a stage using Claim or Independent allocation, since nothing is being pre-divided in those modes.

## Data extraction: one or two extractors

Extraction Settings (Project Administration) lets you choose one extractor per publication (default) or two independent extractors with reconciliation of disagreements — see [Review Workflow](review-workflow.md) for the full mechanics. This choice is locked once any extraction response exists in the project, so decide before extraction work begins. In two-extractor projects, grant the **Adjudication** permission to specific members from Project Members if you want reviewers other than yourself or an administrator to resolve disagreements; project owners and administrators can always reconcile regardless of this flag.

## Lifecycle changes

Papertrail advances stages automatically when their completion rules are satisfied. A completed project may be reopened at a selected earlier stage. Reopening retains downstream data but excludes data that is no longer applicable from active counts.

## Background jobs

Imports, enrichment, duplicate detection, exports, and email delivery are durable PostgreSQL jobs processed by the threaded worker. Screening/extraction/validation LLM inference and research-question synthesis are claimed only by the separate, resource-limited LLM worker (`python -m app.jobs.worker --llm`), so a busy Ollama backend never starves ordinary workflow jobs. Inspect failed jobs before retrying. Restarting the API does not lose queued jobs.
