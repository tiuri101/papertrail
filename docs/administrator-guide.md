# Administrator Guide

Papertrail has one installation-wide administrator role and project-scoped ownership. Any signed-in user can create a project; the creator becomes that project's **owner**. Installation administrators can manage every project as though they were its owner, but reviewer eligibility remains explicit per project.

## Roles and permissions

- **Installation administrator** — creates/disables/reactivates local user accounts, edits Global Settings, and has project-manager rights on every project.
- **Project owner** — manages one project's membership, reviewer eligibility/workload weights, screening/extraction/quality configuration, project forms, metadata/enrichment conflicts, screening conflict resolution, project jobs/integrity, audit log, and lifecycle operations.
- **Project member/reviewer** — sees only projects they belong to. Members may perform reviewer work for activities for which they are eligible. Regardless of reviewer eligibility, project members can edit research questions and inclusion/exclusion criteria, document searches and upload imports, resolve duplicate candidates, and create/download exports.
- **Adjudicator permission** — a project membership flag used for extraction reconciliation. Project owners and administrators can always reconcile; other members need `canAdjudicate`.

An administrator is not automatically an ordinary reviewer. Grant title/abstract, full-text, extraction, and quality eligibility when the administrator should also receive reviewer work.

## Recommended project setup

The **Setup Wizard** and Project Administration expose the same underlying project configuration. A practical sequence is:

1. Create local reviewer accounts (administrator only).
2. Create the project and add members.
3. Define research questions and inclusion/exclusion criteria.
4. Configure reviewer eligibility, workload weights, reviewer counts, allocation modes, and disagreement/uncertain-resolution settings.
5. Configure highlighted screening keywords and project-specific LLM prompt instructions when used.
6. Document each database search and import its export; optionally upload PDFs/ZIP archives with the import.
7. Review normalized metadata, manually add records when needed, and run metadata enrichment.
8. Resolve duplicate candidates and mark the project ready for screening.
9. Complete title/abstract screening and resolve unresolved conflicts.
10. Retrieve/store full text and complete full-text screening.
11. Configure extraction and quality forms before those stages begin.
12. Complete extraction, optional reconciliation, and quality assessment.
13. Review project integrity/job failures, then generate PRISMA and data exports.

Papertrail advances lifecycle stages automatically when completion conditions are satisfied. Project managers can also reopen, move back, reset, or delete projects from Project Administration; these operations are audited and have different data-retention consequences, so read the confirmation text before executing them.

### Copying a project

**Copy Project** (Project Administration → Workflow) creates a new, independent project in exactly the source project's current state: configuration, forms, members and their roles, searches and imports, publications, duplicate-review history, PDFs and extracted text, screening decisions and final decisions, extraction and quality-assessment work (including drafts and open reservations), LLM runs and suggestions, analyses, bookmarks, and the audit log. The user who makes the copy becomes its owner; the previous owner stays a member. Background jobs, queued emails, and generated exports are not copied.

The copy runs as a `clone_project` background job on the general worker. PDFs and uploaded import files are physically copied, so make sure the PDF volume has room for a second set of the project's files. A copy is refused while the source project has queued or running background jobs, because their half-finished work would be copied with nothing left to finish it — wait for them, then try again. When email is enabled, the user who requested the copy is emailed once it finishes (with a link to the new project) or once it has failed for good (with the reason); failed attempts that will still be retried send nothing.

## Account administration

Only installation administrators create and manage local accounts.

When creating an account:

- username and temporary password are required;
- email is optional;
- the user is required to change the administrator-set password after first sign-in;
- when SMTP is enabled and an email is present, Papertrail queues a welcome email with the username/login URL but never sends the temporary password.

Administrators can update account profile fields, reset a password, disable an account, and reactivate it later. Historical screening/extraction/audit attribution is retained when an account is disabled.

Disabling an account or resetting its password revokes its active sessions and paired Browser Helper credentials. An emailed self-service password reset does the same because a Browser Helper bearer token is independent of the user's password.

Users can maintain their own display name/email and password under Account Settings. Forgot-password recovery requires email delivery to be configured; the public response does not reveal whether an account exists for the submitted email.

## Global Settings

Installation administrators can open **Global Settings** (`/instance-settings`). The page has sections for:

- LLM connection/model/runtime limits and connection testing;
- installation-wide AI base-prompt overrides;
- SMTP delivery and the public base URL, including a test-email action;
- password-reset lifetime/throttling;
- full-text PDF size and Browser Helper retrieval lease;
- background-job thread/poll/lease values.

Most saved values are stored in PostgreSQL and override environment defaults for code paths using Papertrail's effective-settings services. There are current process-level exceptions for worker thread count/poll interval, LLM concurrency, and the forgot-password email-enabled gate; use the environment values described in [Configuration](configuration.md) where those paths are involved.

Changes to Global Settings are audit logged. SMTP/Ollama secrets stored there are database secrets and are included in a PostgreSQL backup.

## Reviewer allocation

Each stage that assigns publications to reviewers has its own allocation setting.

### Screening

- **Claim** — publications are not assigned ahead of time; reviewers claim the next available item as they work.
- **Divided** — publications are pre-assigned round-robin across eligible reviewers, weighted by membership workload weight.
- **Independent** — every eligible reviewer receives every publication; decisions remain hidden until the required reviewer count has submitted.

The required reviewer count is configured separately for title/abstract and full-text screening.

### Extraction and quality assessment

- **Claim** — reviewers claim available items.
- **Pre-assigned** — work is divided up front across eligible reviewers using workload weights.

Extraction can use one or two reviewers per publication. Quality assessment currently uses one assessor per publication.

Workload weight only affects pre-divided/pre-assigned allocation. It has no effect in Claim or Independent modes.

## Dual extraction and reconciliation

Extraction Settings can select one extractor (default) or two independent extractors per publication. The reviewer-count setting is locked once extraction responses exist.

In a two-extractor project:

1. both reviewers submit independently;
2. Papertrail compares authoritative field values after both slots are complete;
3. full agreement creates the final extraction automatically;
4. disagreements enter the **Reconciliation** queue;
5. a project owner, administrator, or member with adjudication permission resolves each disagreeing field using reviewer A, reviewer B, or a manual value and supplies the required note.

Individual reviewer responses remain intact. The reconciled `FinalExtraction` is a separate authoritative result.

## Quality-assessment configuration

Quality assessment is optional and currently uses one assessor per publication. Project forms can be qualitative, numerical, or both. Scoring metadata can assign values to select/checkbox answers and weights to numeric/rating fields. The configured aggregation supports `sum`, `average`, and `weighted_average`; quality scores are reported but never automatically include/exclude a publication.

## Screening conflicts

Papertrail can automatically finalize unanimous decisions and, when configured, an unambiguous majority. Other unresolved screening cases appear in Conflict Resolution for the project owner/administrator. The manager can record a final consensus or request an additional reviewer. Original reviewer decisions remain preserved separately from the final project decision.

## Publications and metadata

Project managers can:

- manually add a publication;
- edit normalized metadata;
- trigger metadata enrichment individually or in bulk;
- inspect and resolve proposed metadata conflicts;
- export an individual record as BibTeX or its active PDF;
- remove project publications through the authorized workflow.

Imported source rows remain available for provenance even when normalized metadata is edited.

## Browser-assisted PDF retrieval

Reviewers can pair the optional Chrome Browser Helper from Account Settings. It retrieves publisher PDFs through that reviewer's browser network access/sign-in state and uploads them to Papertrail; publisher credentials/cookies are never sent to Papertrail.

A title/abstract final **Include** can automatically queue retrieval for that publication when it is missing a PDF and an eligible paired helper is available. Full-text reviewers/managers can also use **Retrieve missing PDFs** to create a batch manually.

See [Browser Helper](browser-helper.md) for released-extension installation, pairing, retries, token behavior, and API boundaries.

## Email notifications

Email is installation-level optional configuration. Current durable email events include:

- account creation and requested password-reset links;
- notification to active administrators when a project is created;
- project membership added/removed (permission-only membership edits do not send mail);
- project-owner notice when a project moves on to its next workflow stage, and when it is completed;
- project-owner **LLM processing finished** summary: one email per project once all of its queued batch LLM work (bulk runs and the PDF text preparation they wait on) has finished and nothing more has finished for 10 minutes. Work that finishes in a steady trickle — for example while duplicates are resolved one at a time, each releasing a publication into screening — produces one summary when it stops, not one email per publication. Each summary covers only work that finished since the previous one. Runs a reviewer starts for a single publication are not reported;
- to the user who started it, when a publication import finishes or fails for good (one email per imported file);
- to the user who requested it, when a project copy finishes or fails for good;
- project-owner alert when duplicate detection fails for good, because the records it was checking go on to screening unchecked.

Failure emails are sent only once a job has used up its retries; attempts that will still be retried send nothing.

Each user chooses which optional categories they receive under **Account Settings → Email Notifications**. Account-creation and password-reset emails cannot be turned off, and the "New projects" category is only offered to administrators.

Email delivery is a normal background job with retry state. SMTP failure does not roll back the domain operation that caused the notification.

## Background jobs and diagnostics

Imports, enrichment, duplicate detection, export generation, PDF text processing, notifications, and AI/analysis tasks are durable PostgreSQL jobs. Restarting the API does not discard queued work.

Project managers can open a project's **Jobs** page to inspect:

- job type/stage;
- queued, running, completed, or failed state;
- attempts and retry limits;
- progress/result metadata;
- summarized failure diagnostics;
- detailed error information where authorized;
- restart actions for failed jobs that are eligible for retry.

Do not repeatedly restart a deterministic failure without addressing the cause (for example, invalid input or unavailable external service). Leases make an interrupted claimed job available again after expiry; an active worker heartbeat renews the lease while work is still running.

Screening/extraction/validation LLM inference and research-question synthesis are claimed only by the separate resource-limited LLM worker (`python -m app.jobs.worker --llm`), so a busy Ollama backend does not consume the normal worker pool.

## Project integrity

Project Administration exposes an integrity check and repair operation backed by `/projects/{project_id}/integrity` and `/integrity/repair`. Use the scan when a project appears to have inconsistent downstream work after lifecycle changes, form changes, or other exceptional conditions.

Review the reported findings before repair. Repairs operate through domain cleanup/reinitialization logic and are audit logged; they are not a substitute for a database restore when persistent storage itself is damaged.

## Backup, upgrade, and security

Use the bundled consistency-preserving backup/restore scripts rather than backing up PostgreSQL alone. Papertrail also requires `papertrail_files` and `papertrail_pdf_data`, and backups can contain credentials. See:

- [Configuration](configuration.md)
- [Backup and Restore](backup-and-restore.md)
- [Upgrade Guide](upgrade.md)
- [Reliability Operations](operations/reliability.md)
- [Security Operations](operations/security.md)
