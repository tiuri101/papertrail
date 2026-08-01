# Administrator Guide

The installation administrator creates all local user accounts and has full access to every review project. Any signed-in user can create a project; the user who creates it becomes that project's **owner** and gets the same management rights as the administrator, scoped to that one project.

## Project ownership

- **Administrator** — one or more installation-wide accounts. Can create and disable any user account, and manages every project as if they owned it.
- **Project owner** — whoever created the project. Can manage members and their screening eligibility, screening configuration, highlighted keywords, project details, publication metadata and enrichment, metadata-conflict resolution, screening-conflict resolution, project-specific forms, the audit log, and lifecycle actions (mark ready for duplicate review, reopen, move back, reset, delete, reverse a merge) — for that project only.
- **Reviewer / project member** — anyone added to a project. Can perform the screening, extraction, and quality-assessment activities they're eligible for; edit the project's research questions and inclusion/exclusion criteria; document searches and upload import files; resolve duplicate candidates (not a duplicate, or merge); and generate and download exports. Members only see the projects they belong to, and only the actions within a project they're actually permitted to perform.

An administrator is not automatically a reviewer on a project — reviewer eligibility (screening, extraction, quality assessment, adjudication) is still granted per member, independently of ownership.

## Recommended project sequence

1. Create reviewer accounts (administrator only).
2. Create a project — any user can do this and becomes its owner — and add eligible reviewers.
3. Define research questions and criteria (owner, administrator, or any project member); configure screening settings, including the number of reviewers required per stage and how disagreements and uncertain decisions are resolved (owner or administrator).
4. Document each database search and import its export file (any project member).
5. Review metadata and run enrichment where required (owner or administrator).
6. Resolve all duplicate candidates (any project member marks each as not a duplicate or merges it; the owner or administrator marks the project ready to enter duplicate review and can reverse a merge).
7. Complete title/abstract screening and resolve disagreements.
8. Track manual full-text retrieval and complete full-text screening.
9. Configure extraction and quality-assessment forms.
10. Complete extraction and quality assessment.
11. Review integrity warnings and generate PRISMA, XLSX, and BibTeX exports.

## Accounts

Only the administrator creates and disables user accounts. Disable accounts rather than deleting them when historical decisions must remain attributable. Password resets replace the password while retaining the account identity.

## Lifecycle changes

Papertrail advances stages automatically when their completion rules are satisfied. A completed project may be reopened at a selected earlier stage. Reopening retains downstream data but excludes data that is no longer applicable from active counts.

## Background jobs

Imports, enrichment, duplicate detection, and exports are durable PostgreSQL jobs processed by the threaded worker. Inspect failed jobs before retrying. Restarting the API does not lose queued jobs.
