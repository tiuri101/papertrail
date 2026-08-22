# Papertrail

## Project Description and Requirements Specification

**Project name:** Papertrail  
**Document status:** Living requirements and implemented-capabilities specification (synchronized with the current codebase)  
**Application type:** Self-hosted multi-user web application  
**Primary purpose:** Support systematic and structured academic literature reviews from search-result import through screening, data extraction, quality assessment, and PRISMA 2020 reporting.

---

## 1. Overview

Papertrail is a self-hosted web application for managing academic literature reviews. It is intended for review projects with hundreds to a few thousand publications and supports collaborative workflows involving an installation administrator, project owners, and multiple reviewers.

Users manually export literature search results from academic databases such as ScienceDirect, IEEE Xplore, the ACM Digital Library, and SpringerLink. These exports are imported into Papertrail, normalized, checked for duplicates, screened in two stages, and processed through configurable extraction and quality-assessment forms.

Papertrail stores full-text PDFs that reviewers supply, either uploaded directly or retrieved through an optional paired Chrome extension using the reviewer's own browser network access and sign-in state. The Papertrail server itself never scrapes publisher full text using server-side institutional credentials; it also provides DOI, publisher, and other external links for cases where a reviewer obtains the full text manually outside the application.

The application follows the structure and reporting requirements of PRISMA 2020 where applicable. It records the information needed to generate a PRISMA flow diagram, exclusion tables, review datasets, and bibliographic exports.

---

## 2. Goals

Papertrail should:

1. Centralize the workflow of an academic literature review.
2. Preserve transparent and auditable screening decisions.
3. Support multiple reviewers and configurable review procedures.
4. Normalize heterogeneous exports from major academic databases.
5. Identify and resolve duplicate records before screening.
6. Separate title/abstract screening from full-text screening.
7. Support configurable extraction and quality-assessment forms.
8. Generate PRISMA 2020 counts and an SVG flow diagram.
9. Export review data in practical academic formats.
10. Remain suitable for self-hosting and local user management.
11. Store full text PDFs.
12. Provide users with LLM-support during screening and data extraction.

---

## 3. Non-Goals

The current scope does not:

- Automatically include or exclude records on behalf of reviewers.
- Search academic databases directly.
- Model repeated/living-review search updates as first-class review cycles.
- Model several publications as reports of one underlying study.
- Provide public registration or self-service account creation.
- Support institutional single sign-on.
- Provide an archived/read-only project state.
- Act as a reference manager intended to replace Zotero, EndNote, or similar tools.
- Support conditional logic in extraction forms.
- Support two independent quality assessors with quality-assessment reconciliation. Dual independent data extraction is supported.

---

## 4. Users and Roles

Papertrail has three roles: administrator, project owner, and reviewer. Administrator and project owner are collectively referred to below as **project managers** for a given project, since they have identical rights over it.

### 4.1 Administrator

There is at least one installation-wide administrator account. Only the administrator can:

- Create and manage local user accounts.

The administrator additionally has every project manager right, below, on every project, whether or not the administrator is that project's owner.

### 4.2 Project owner

Any authenticated user can create a review project; the creator becomes that project's owner. A project owner has full management rights over that project, equivalent to the administrator's, but scoped to it alone. A project manager (its owner, or the administrator) can:

- Configure and rename the project, and add or remove project members.
- Configure reviewer eligibility by activity.
- Manually add a publication record directly (as opposed to through an import).
- Mark a project ready to enter duplicate review, and reverse a completed merge.
- Edit normalized publication metadata.
- Trigger metadata enrichment for one or multiple records.
- Resolve metadata conflicts.
- Configure screening procedures, including the number of required reviewers per stage.
- Create and edit project-specific forms, and save one as a reusable template.
- Record final consensus decisions.
- Reopen submitted extraction or quality-assessment work.
- Perform reviewer activities when eligible.
- Reopen, move back, reset, or delete the project.
- Generate and download exports.
- View all project data and the audit log.

A project manager may not edit or replace an individual reviewer's submitted screening decision. A project manager records a separate final consensus decision where required.

Creating extraction and quality-assessment templates from scratch, and deleting templates from the shared catalog, remains administrator-only; a project owner can browse the catalog to start a project form from a template, and can save one of their own project's forms as a new reusable template.

### 4.3 Reviewer

A reviewer can belong to multiple projects. Reviewer eligibility is configured independently for:

- Title and abstract screening
- Full-text screening
- Data extraction
- Quality assessment
- Extraction reconciliation/adjudication

Reviewers can only access and perform activities for which they are eligible, and only within projects they are a member of. The interface does not show actions a reviewer isn't permitted to take.

Regardless of eligibility, any project member can edit the project's research questions and inclusion/exclusion criteria; document a database search and upload its import file; resolve a duplicate suggestion as not a duplicate or perform a merge; and generate and download exports.

Reviewers do not see extraction or quality-assessment data assigned to other reviewers. They may see other reviewers’ screening decisions, criterion selections, and notes after all required independent decisions have been submitted.

---

## 5. Project Model

Each project contains:

- Project name
- Optional description
- Review type
- Research questions
- Inclusion criteria
- Exclusion criteria
- Project members
- Reviewer eligibility
- Screening configuration
- Search documentation
- Imported publication records
- Duplicate-resolution state
- Extraction form
- Quality-assessment form
- Workflow state
- Audit log

Supported review types should include at least:

- Systematic review
- Scoping review
- Systematic mapping study
- Other

The selected review type is descriptive and does not automatically impose a fixed methodology.

---

## 6. Project Lifecycle

A project progresses through the following states:

1. **Draft**
2. **Duplicate review**
3. **Title/abstract screening**
4. **Full-text retrieval and screening**
5. **Extraction and quality assessment**
6. **Completed**

The project has one shared lifecycle state for all users.

### 6.1 Automatic transitions

Papertrail automatically advances a project when the completion conditions for the current stage are met.

#### Draft to duplicate review

The project can enter duplicate review when:

- At least one record has been imported or manually added.
- The project configuration required for screening is complete.
- A project manager (the project's owner or the administrator) marks the draft configuration as ready.

#### Duplicate review to title/abstract screening

The project advances only when every duplicate suggestion has been resolved.

#### Title/abstract screening to full-text retrieval and screening

The project advances when:

- Every eligible record has the configured number of valid screening decisions.
- All uncertain outcomes have been resolved according to the project configuration.
- All screening conflicts have a final resolution.

#### Full-text retrieval and screening to extraction and quality assessment

The project advances when every title/abstract inclusion has either:

- Been recorded as a report that could not be retrieved, or
- Completed full-text screening with all required decisions and conflict resolutions.

#### Extraction and quality assessment to completed

The project advances when:

- Every finally included publication has a completed extraction.
- Every finally included publication has a completed quality assessment when quality assessment is enabled.
- All required form fields are complete.

### 6.2 Moving backward and reopening

A project manager may reopen a completed project or move a project back to an earlier stage.

Downstream data is retained and is not deleted. Data that no longer applies to the active publication set is excluded from active workflow counts and standard outputs but remains stored for traceability.

The stage change is recorded in the audit log.

---

## 7. Search Documentation

For each imported database result set, Papertrail stores:

- Database or source name
- Exact search query
- Search date
- Applied filters
- Number of exported results
- Uploaded source file
- Import date
- User who performed the import

Repeated update searches are outside the initial scope. Multiple imports are nevertheless permitted, for example when results originate from several databases.

Manually added records and records found through citation chasing are supported. A detailed classification of how such records were discovered is not required.

---

## 8. Supported Import Formats

Papertrail supports:

- CSV
- TSV
- XLSX
- RIS
- BibTeX

The application should recognize common export structures from:

- ScienceDirect
- IEEE Xplore
- ACM Digital Library
- SpringerLink

When automatic recognition fails, a project manager can map source columns to Papertrail fields manually.

Import processing should include:

- File validation
- Encoding handling
- Preview before confirmation
- Field mapping
- Import summary
- Invalid-record reporting
- Preservation of the original source data
- Provenance tracking for every imported record

Reasonable size limits should accommodate review projects containing hundreds to low thousands of records.

---

## 9. Publication Record Model

Each publication is treated as one review unit.

A normalized record may contain:

- Internal record identifier
- Title
- Formatted authors string
- Abstract
- Publication year
- Venue, journal, conference, or book title
- Publication type
- DOI
- Publisher URL
- Keywords
- ISBN
- ISSN
- PubMed identifier
- arXiv identifier
- Other external identifiers
- Source databases
- Original imported records
- Import provenance
- Current normalized metadata

Records without a DOI are fully supported.

Authors are stored as formatted strings rather than as separate person entities.

The application does not maintain a complete version history for every metadata value. Relevant administrative changes are still recorded in the audit log.

---

## 10. Metadata Editing and Enrichment

A project manager can manually edit normalized publication metadata.

Metadata enrichment is performed on request, either:

- For one record
- For a selected group of records
- In bulk for all records with missing metadata

The initial enrichment services are:

- Crossref
- Semantic Scholar

Enrichment should primarily fill missing metadata. Existing values may be replaced only after user review where a meaningful conflict exists.

Important conflicting fields require manual resolution:

- DOI
- Title
- Authors
- Publication year
- Abstract
- Venue

For records without a DOI, Papertrail may search by title and authors and present candidate matches for manual confirmation.

The application should display the current and proposed values side by side during conflict resolution.

---

## 11. Duplicate Detection and Resolution

Duplicate review is completed before title/abstract screening begins.

Papertrail suggests potential duplicates but never merges them automatically.

Duplicate detection should consider:

1. Exact DOI matches
2. Exact normalized title matches
3. Similar titles combined with publication year
4. Similar titles combined with author information
5. Other matching identifiers

Each suggestion is resolved as:

- Not a duplicate
- Merge into another record
- Confirm as canonical record

### 11.1 Merge behavior

A confirmed merge:

- Produces one canonical record.
- Prefers the most complete metadata by default.
- Requires manual resolution for conflicting important fields.
- Preserves all source databases.
- Preserves all original imported records.
- Preserves provenance.
- Is reversible.

Late duplicate merges after screening are not part of the normal workflow. The application may require the project to return to duplicate review before allowing such a merge.

---

## 12. Screening Configuration

Title/abstract screening and full-text screening are separate stages.

Each stage can independently configure:

- Number of required reviewers
- Independent screening or divided screening
- Conflict-resolution method
- Handling of uncertain decisions
- Reviewer eligibility

The number of required reviewers can differ between title/abstract and full-text screening.

### 12.1 Screening decisions

Available decisions are:

- Include
- Exclude
- Uncertain
- Duplicate

Screening notes are optional for all decisions, including exclusions.

### 12.2 Criteria checklists

All project inclusion and exclusion criteria are shown as checkboxes during screening.

A reviewer must explicitly complete every criterion checkbox before submitting a decision.

The final decision is not automatically calculated from the checkbox selections. The criteria serve as a documented assessment aid.

---

## 13. Screening Queue

Reviewers work through a queue rather than browsing a searchable record catalogue.

The queue uses one randomized project-wide order generated from a stored global seed. This makes the order reproducible.

### 13.1 Queue reservations

When a reviewer opens a record for screening:

- The relevant reviewer slot is reserved for that reviewer.
- The reservation lasts up to one hour.
- Other reviewers cannot take the same slot during the reservation.
- The reviewer may skip or release the record, returning it to the queue.
- Draft form content should be autosaved.

The same queue pattern applies to extraction and quality assessment.

### 13.2 Divided screening

When records are divided between reviewers:

- Papertrail distributes work automatically.
- Distribution should be approximately even.
- Reviewers receive one screening slot per assigned record.

### 13.3 Independent screening

When multiple independent reviewers are required:

- Each publication has the configured number of reviewer slots.
- A reviewer cannot fill more than one slot for the same publication.
- Decisions remain hidden until all required reviewers have submitted.
- After reveal, reviewers can see the other decisions, criteria, and notes.

---

## 14. Revising Decisions

Reviewers may revise their submitted decisions without a permanent lock.

Every revision is recorded in the audit log.

When a revision affects a record with an existing final consensus decision:

- The consensus decision becomes invalid.
- The record returns to conflict resolution.
- The previous consensus remains available in the audit log.
- A new final decision must be recorded.

---

## 15. Uncertain Decisions and Conflicts

The project manager configures how uncertain and conflicting decisions are resolved.

Supported screening resolution behavior includes:

- Automatic finalization when all required current decisions agree
- Automatic majority finalization when majority resolution is configured and there is an unambiguous majority
- An additional independent reviewer requested by the project owner/administrator
- A final consensus/override recorded by the project owner or administrator

The screening configuration model also contains an `adjudicator` resolution value, but the current screening-conflict endpoints are manager-restricted; the membership `can_adjudicate` permission is used for extraction reconciliation rather than delegated screening conflict resolution.

Papertrail stores the original reviewer decisions separately from the final project decision.

The final consensus decision may include a note. Requiring a note is configurable or left to the project manager's judgment.

A separate discussion or comment system is not required.

---

## 16. Full-Text Retrieval and Screening

Papertrail stores full-text PDFs. For each publication, the application also provides available external links, including:

- DOI link
- Publisher URL
- Other identifier-based links where useful

Reviewers obtain the full text either by uploading a PDF they are authorized to access and store, or by pairing an optional Chrome Manifest V3 extension ("Browser Helper") that retrieves it through the reviewer's own browser network access and sign-in state (e.g. institutional IP access, VPN, or an existing publisher sign-in in Chrome) and uploads it through the same PDF pipeline. The Papertrail server never scrapes publisher full text using server-side institutional credentials, receives publisher cookies or credentials, or bypasses publisher access controls. Automated browser retrieval attempts are tracked separately from the retrieval status below: only a successful automated retrieval changes it, and an automated failure never marks a publication as not found or inaccessible on a reviewer's behalf.

### 16.1 Retrieval status

Full-text retrieval is tracked separately from full-text eligibility screening.

Supported statuses include:

- Not yet sought
- Full text available
- Full text requested
- Full text not found
- Full text inaccessible

Reports that cannot be retrieved are reported separately from full-text exclusions in accordance with PRISMA 2020.

Only publications with an available full text proceed to full-text screening.

### 16.2 Full-text decisions

Full-text screening uses the standard decisions:

- Include
- Exclude
- Uncertain
- Duplicate

---

## 17. Data Extraction

Every publication included after full-text screening receives one extraction slot, or two independent extraction slots when the project is configured for dual extraction. The extractor-count setting is locked once extraction responses exist.

With one extractor, the submitted response becomes the authoritative final extraction. With two extractors, Papertrail compares both completed responses: exact agreement finalizes automatically, while disagreements enter a reconciliation queue for a project manager or member with adjudication permission. Individual reviewer responses are retained separately from the authoritative `FinalExtraction`.

Extraction work is distributed through Claim or Pre-assigned allocation.

### 17.1 Extraction forms

Each project has an individual extraction form.

The form can be:

- Created from scratch
- Copied from a reusable template
- Saved as a new reusable template

After copying a template, the project form is independent from the source template.

Supported field types are:

- Short text
- Long text
- Number
- Checkbox
- Single selection
- Multiple selection
- Date
- URL
- Rating scale

Each field can be required or optional.

Extraction is intended primarily for summarized findings and project-specific qualitative or quantitative dimensions.

### 17.2 Editing and reopening

The assigned reviewer may revise submitted extraction data.

A project manager may reopen an extraction assigned to another reviewer but may not silently replace that reviewer’s answers.

---

## 18. Quality Assessment

Quality assessment is configurable per project.

Every publication requiring quality assessment receives exactly one responsible reviewer.

The same reviewer may perform both extraction and quality assessment for a publication unless project eligibility or assignment rules prevent it.

### 18.1 Quality-assessment forms

Quality-assessment forms support:

- Reusable templates
- Project-specific copies
- Required and optional questions
- Categorical answers
- Numerical scores
- Reviewer comments
- Automatic totals
- Simple sums or weighted scoring where configured

The project manager decides whether the project uses:

- Qualitative assessment only
- Numerical scoring only
- Both

Quality scores do not automatically include or exclude a publication.

A project manager may reopen a submitted assessment. The assigned reviewer may revise it.

---

## 19. Form Changes and Versioning

Extraction and quality-assessment forms remain editable after work has begun.

Changes require:

- A warning describing possible consequences
- An audit-log entry
- Form versioning
- Preservation of previously entered data

Recommended behavior:

- Renaming a field preserves all values.
- Adding a required field reopens previously completed items until the new field is completed.
- Adding an optional field does not invalidate completed items.
- Removing a field archives it rather than deleting its historical values.
- Changing a field type after values exist requires an explicit migration or replacement field.
- Standard exports use the active form by default, with an option to include archived fields where useful.

---

## 20. Templates

Papertrail supports reusable templates for:

- Extraction forms
- Quality-assessment forms

Creating a template from scratch and deleting a template are administrator-only. Any project manager (a project's owner, or the administrator) can browse the shared template catalog and use a template when creating a project form. A project owner can additionally save one of their own project's forms as a new reusable template.

A template can be:

- Created from scratch
- Copied
- Edited
- Used when creating a project form
- Created from an existing project form

Changing a template does not retroactively change project forms already created from it.

---

## 21. PRISMA 2020 Support

Papertrail implements PRISMA 2020 flow reporting based directly on project records.

The application records and calculates counts for at least:

- Records identified from databases and other sources
- Duplicate records removed
- Records screened
- Records excluded during title/abstract screening
- Reports sought for retrieval
- Reports not retrieved
- Reports assessed for eligibility
- Reports excluded at full-text stage
- Publications included in the review

Because Papertrail uses publications as review units and does not model multiple reports per underlying study, the included-publication count is also used as the final included-study count.

The PRISMA counts cannot be manually overwritten.

Papertrail generates a downloadable PRISMA 2020 flow diagram in SVG format.

---

## 22. Exports

### 22.1 Excel export

Papertrail generates one XLSX workbook with separate worksheets for at least:

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
- Included publications
- Extraction data
- Quality-assessment data
- Audit history

The workbook should use stable identifiers so records can be traced across worksheets.

### 22.2 Parquet export

Papertrail generates a compact Parquet dataset of final included publications. Publication metadata, extraction and quality-assessment status, and dynamic form answers are available as analysis-ready columns. Structured answers are preserved as JSON strings, and dynamic columns use `extraction_` or `quality_` prefixes with stable form field keys.

Papertrail also generates JSON and CSV versions of the same final included results. JSON preserves the nested result structure; CSV uses the flattened analysis columns and is intended for broad interoperability with programming languages, spreadsheets, and dashboards.

### 22.3 PRISMA outputs

Papertrail exports:

- PRISMA 2020 flow counts
- PRISMA supporting tables
- Full-text exclusions
- SVG flow diagram

### 22.4 BibTeX export

BibTeX export scope is configurable.

Supported scopes should include:

- Included publications
- All screened publications
- Excluded publications
- Duplicate records
- A selected project status or decision set

The application should generate valid BibTeX entries using the best available metadata and stable fallback citation keys.

### 22.5 Final results view

Beyond the downloadable exports, Papertrail provides an in-application, sortable and paginated table of every finally included publication together with its extraction answers and, when quality assessment is enabled, its quality-assessment answers and total score. Any project member can view it; it does not require generating a background export job.

---

## 23. Audit Logging

Papertrail maintains an audit log for significant actions.

Logged actions include:

- Project creation and configuration changes
- Lifecycle transitions
- User and membership changes
- Import operations
- Duplicate decisions and reversals
- Metadata edits and enrichment
- Screening submissions and revisions
- Consensus decisions and invalidations
- Form changes and form-version creation
- Extraction and quality-assessment submissions
- Reopening of work
- Project completion and reopening
- Export generation

An audit entry should contain:

- Timestamp
- User
- Project
- Action type
- Affected entity
- Brief description

The audit log does not need to store a complete historical copy of every metadata value.

---

## 24. User Interface Requirements

The interface should prioritize focused, record-by-record work.

### 24.1 Project dashboard

The dashboard should show:

- Current project stage
- Progress through the active stage
- Number of records by status
- Unresolved duplicates
- Uncertain decisions
- Screening conflicts
- Full texts not retrieved
- Remaining extraction work
- Remaining quality-assessment work
- Available exports

### 24.2 Screening view

The screening view should display at least:

- Title
- Authors
- Publication year
- Venue
- Publication type
- Abstract
- Keywords
- DOI
- Publisher link
- Source databases
- Inclusion-criteria checklist
- Exclusion-criteria checklist
- Decision controls
- Optional notes
- Queue actions

Keyboard shortcuts are provided for common screening actions and are configurable/viewable from Account Settings.

### 24.3 Administrative views

Administrative views, visible only to a project's owner or the administrator, are required for:

- Project setup
- Member and eligibility management
- Metadata conflict resolution
- Screening configuration
- Conflict resolution
- Form and template editing
- Audit-log inspection

Reviewers do not see navigation to these views, and do not need a general searchable or sortable record browser. All project members see the research-questions and criteria editor, search documentation and import upload, duplicate review, and exports.

---

## 25. Authentication and Deployment

Papertrail is self-hosted.

Authentication uses local usernames and passwords.

Requirements include:

- Administrator-created accounts
- Secure password hashing
- Session management
- Login rate limiting
- Account disabling
- Password reset by the administrator and email-based self-service reset when SMTP is enabled
- Role and project authorization checks

Institutional login, OAuth, OpenID Connect, and public registration are outside the initial scope.

A containerized deployment using Docker or Docker Compose is recommended.

The deployment should support:

- Persistent database storage
- Persistent imported source-file/export storage
- Persistent full-text PDF storage
- Environment-based configuration plus administrator-managed database overrides for selected settings
- Consistent PostgreSQL + application-file + PDF backups and tested restoration
- HTTPS through an external reverse proxy
- Application logs
- Health checks

A relational database such as PostgreSQL is recommended.

---

## 26. Non-Functional Requirements

### 26.1 Performance

The application should remain responsive for projects containing:

- Hundreds to low thousands of records
- Several concurrent reviewers
- Multiple imports per project
- Large abstracts and structured extraction forms

Long-running operations such as bulk import, duplicate detection, metadata enrichment, and export generation should report progress and should not block unrelated user activity.

### 26.2 Reliability

- Submitted decisions must not be lost.
- Draft form content should autosave.
- Duplicate merges must be reversible.
- Lifecycle changes must preserve downstream data.
- Export generation must not modify project data.
- Failed imports should be recoverable without partial hidden changes.

### 26.3 Security

- All project access must be authorization-checked server-side.
- Reviewer decisions hidden during independent screening must not be exposed through APIs or page source.
- Uploaded files must be validated.
- Spreadsheet-formula injection must be prevented in exports.
- External metadata must be treated as untrusted input.
- The application should provide CSRF, XSS, and SQL-injection protections appropriate to the chosen framework.
- Secrets must be stored outside source control.

### 26.4 Accessibility

The interface should:

- Be keyboard accessible
- Use semantic form controls
- Provide visible labels
- Maintain sufficient contrast
- Avoid encoding status through color alone
- Provide accessible names for icons and controls
- Produce an accessible screening workflow

### 26.5 Browser support

The application should support current desktop versions of:

- Chrome
- Firefox
- Edge
- Safari

The primary workflow is desktop-oriented. Mobile support may be limited to basic viewing and administration.

---

## 27. Current Delivered Core Scope

The current implementation includes:

1. Local authentication and user administration
2. Project creation and lifecycle management
3. Research questions and criteria
4. Search documentation
5. CSV, TSV, XLSX, RIS, and BibTeX imports
6. Known database mappings and manual column mapping
7. Normalized publication records
8. Crossref and Semantic Scholar enrichment
9. Duplicate suggestions and reversible merging
10. Title/abstract screening
11. Full-text retrieval-status tracking
12. Full-text screening
13. Configurable multi-reviewer behavior
14. Conflict and consensus handling
15. Project-specific extraction forms
16. Reusable extraction templates
17. Project-specific quality-assessment forms
18. Reusable quality-assessment templates
19. Excel exports
20. Parquet, JSON, and CSV exports
21. Configurable BibTeX exports
22. PRISMA 2020 tables and SVG flow diagram
23. Audit logging
24. Docker-based self-hosted deployment
25. Protected PDF upload/storage with version history and bulk PDF matching
26. Optional paired Chrome Browser Helper for browser-assisted PDF retrieval
27. One- or two-reviewer data extraction with authoritative final results and reconciliation
28. Optional evidence-backed Ollama assistance for screening, extraction, validation, and research-question synthesis
29. Anonymized reviewer-agreement analysis and server-side Evidence Matrix
30. Durable background-job diagnostics/retry and project integrity scan/repair
31. Administrator Global Settings for selected SMTP, PDF, worker, password-reset, and LLM configuration
32. Consistency-preserving backup/restore scripts covering PostgreSQL, imports/exports, and PDFs

---

## 28. Future Extensions

Potential later additions include:

- Study-level grouping of multiple publication reports
- Versioned review protocols and protocol-registration metadata
- Dual independent quality/risk-of-bias assessment with reconciliation
- OCR for image-only PDFs and multiple document roles (supplement, protocol, correction)
- Active-learning prioritization of the screening queue without automated decisions
- Living-review/search-update cycles
- Tags, collections, saved filters, and review samples
- Open-access PDF discovery and citation chasing
- Structured risk-of-bias instrument libraries/visualizations
- PRISMA-S and additional review-type reporting standards
- Direct reference-manager integrations such as Zotero synchronization
- PDF annotation
- Institutional authentication
- Read-only/finer-grained project roles
- In-application notification center/deadlines beyond the existing email notifications
- API tokens/webhooks for external automation

These are potential enhancements rather than requirements of the current delivered workflow.

---

## 29. Core Acceptance Criteria

The current core workflow is considered functionally complete when an administrator can create user accounts, any user can create a review project, and a project manager (the project's owner or the administrator) can:

1. Add and configure eligible reviewers.
2. Define research questions, criteria, and reviewer rules.
3. Document searches and import records from supported formats.
4. Normalize records and enrich missing metadata.
5. Resolve every duplicate suggestion and perform reversible merges.
6. Run title/abstract screening with one or multiple reviewers.
7. Keep independent decisions hidden until all required decisions are submitted.
8. Resolve uncertain and conflicting decisions.
9. Track full-text retrieval (manual or Browser Helper-assisted), store versioned PDFs, and run full-text screening.
10. Assign one or two extractors per included publication according to project configuration, reconcile dual-extractor disagreements, and assign one quality assessor when quality assessment is enabled.
11. Collect project-specific structured extraction and quality data.
12. Modify forms with warnings, versioning, and data preservation.
13. Complete and reopen a project without losing downstream information.
14. Export a structured Excel workbook.
15. Export an analysis-ready Parquet dataset.
16. Export configurable BibTeX files.
17. Generate PRISMA 2020 tables and a valid SVG flow diagram.
18. Review an audit trail of significant project actions.

---

## 30. Summary

Papertrail is a collaborative, self-hosted review-management application centered on transparent human decision-making. It imports bibliographic exports, normalizes and deduplicates records, supports configurable multi-reviewer screening, stores full-text PDFs obtained manually or through the paired Browser Helper, supports one- or two-reviewer structured extraction with authoritative reconciliation, and provides configurable quality-assessment workflows.

Its primary differentiators are a focused queue-based review process, flexible project-specific forms, strict decision provenance, reversible duplicate handling, and direct generation of PRISMA 2020 and academic export outputs.
