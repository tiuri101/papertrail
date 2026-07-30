# Administrator Guide

The installation administrator creates all local user accounts and manages every review project.

## Recommended project sequence

1. Create reviewer accounts.
2. Create a project and add eligible reviewers.
3. Define research questions, criteria, screening settings, and exclusion reasons.
4. Document each database search and import its export file.
5. Review metadata and run enrichment where required.
6. Resolve all duplicate candidates.
7. Complete title/abstract screening and resolve disagreements.
8. Track manual full-text retrieval and complete full-text screening.
9. Configure extraction and quality-assessment forms.
10. Complete extraction and quality assessment.
11. Review integrity warnings and generate PRISMA, XLSX, and BibTeX exports.

## Accounts

Accounts are created by the administrator. Disable accounts rather than deleting them when historical decisions must remain attributable. Password resets replace the password while retaining the account identity.

## Lifecycle changes

Papertrail advances stages automatically when their completion rules are satisfied. A completed project may be reopened at a selected earlier stage. Reopening retains downstream data but excludes data that is no longer applicable from active counts.

## Background jobs

Imports, enrichment, duplicate detection, and exports are durable PostgreSQL jobs processed by the threaded worker. Inspect failed jobs before retrying. Restarting the API does not lose queued jobs.
