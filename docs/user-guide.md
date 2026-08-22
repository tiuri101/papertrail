# Reviewer Guide

Reviewers see only projects in which they are members. Within a project, reviewer work is further controlled by eligibility for title/abstract screening, full-text screening, extraction, and quality assessment. Project-management screens are limited to the project owner and installation administrators.

Regardless of reviewer eligibility, project members can edit the project's research questions and inclusion/exclusion criteria, document searches and upload imports, resolve duplicate candidates, and create/download project exports.

## Account settings and password recovery

Open **Account Settings** from the application navigation to manage:

- display name and email address;
- your password;
- screening hotkeys;
- paired Browser Helpers.

Changing your password requires the current password and revokes your other active sessions. If an administrator gave you a temporary password, Papertrail requires a password change before normal application use.

If you forget your password, choose **Forgot password?** on the login page and enter the email address associated with the account. For privacy, Papertrail gives the same public response whether or not that email exists. When self-service password-recovery email is fully configured (see [Configuration](configuration.md)) and a matching active account exists, the reset link is sent by email. Resetting the password revokes existing sessions and Browser Helper tokens and signs you in with a fresh session.

Administrators configure reset-link lifetime and request throttling in Global Settings.

## Search documentation and imports

For each database search, record the database/platform, exact search string, search date, and filters used, then upload the corresponding bibliographic export.

Supported metadata imports include CSV, TSV, XLSX, RIS, and BibTeX; see [Import Formats](import-formats.md). Unknown tabular columns can be mapped to normalized fields during import.

The same import flow can accept multiple PDFs and/or ZIP archives of PDFs. High-confidence DOI/title matches can be attached automatically; ambiguous, unmatched, and existing-PDF conflicts remain available for review and manual resolution.

## Publications and metadata

Project members can browse the project publication set and open publication details. Project owners/administrators can edit normalized publication metadata, trigger enrichment, and resolve conflicting enrichment proposals. Source/import provenance remains separate from normalized metadata edits.

Project managers can also manually add a publication when it did not come from one of the documented import files.

## Duplicate review

Any project member can resolve a suggested duplicate as **not a duplicate** or merge the pair and choose which publication remains canonical. The project owner/administrator marks the project ready to enter duplicate review and can reverse a completed merge.

A merge preserves provenance and transfers related data/documents to the canonical publication according to the workflow rules; it is not a hard delete of the duplicate history.

## Screening

Open the active screening queue, inspect the publication metadata, complete each inclusion/exclusion criterion, and choose **Include**, **Exclude**, **Uncertain**, or **Duplicate**. Notes are optional unless a particular follow-up workflow requires a reason.

Draft state is saved while you work. A claimed/reserved item has a finite reservation and can be released when you do not intend to complete it.

How records reach you depends on the stage configuration:

- **Claim** — the next eligible unclaimed record is assigned as you work;
- **Divided** — records are pre-assigned across eligible reviewers using workload weights;
- **Independent** — each eligible reviewer receives each publication (screening only).

When multiple independent decisions are required, other reviewers' decisions remain hidden until the configured decision count has been submitted. Submitted screening decisions can be revised; revising a decision invalidates any final decision that depended on the superseded response and may return the publication to conflict resolution.

Screening hotkeys can be configured/viewed from Account Settings.

## Full text

Papertrail stores full-text PDFs supplied by authorized project users and provides DOI/publisher links for manual retrieval. Full-text reviewers, project owners, and administrators can upload/replace/remove PDFs; other project members can view authorized project PDF metadata/content.

Replacing a PDF creates a new stable document version and preserves the prior version in history. Logical removal removes the active association without erasing document history. PDFs imported before full-text screening become available when the publication reaches the appropriate workflow stage.

A publication's human retrieval status is separate from the full-text eligibility decision. A newly available PDF opens/enables the normal full-text screening work; obtaining a PDF never includes/excludes a publication automatically.

### Browser-assisted PDF retrieval

The optional **Papertrail Browser Helper** retrieves publisher PDFs through your own Chrome network access/sign-in state. Papertrail never receives publisher passwords, institutional credentials, or browser cookies through this feature.

For installation instructions, see [Browser Helper](browser-helper.md). Released Papertrail versions attach a matching Browser Helper ZIP to the GitHub release; it is installed as an unpacked Chrome extension.

To pair it:

1. Open **Account Settings → Browser Helpers → Pair new browser helper**.
2. Copy the one-time pairing secret (10 minutes by default).
3. Open the Browser Helper and choose **Set up**.
4. Enter the Papertrail server URL, secret, and a device name.
5. Pair and approve Chrome access to your Papertrail server origin.

Retrieval work can be queued in two ways:

- after a title/abstract final **Include**, Papertrail can automatically queue that publication when it is still missing a PDF and an eligible paired helper is available;
- on the Full-Text page, **Retrieve missing PDFs** creates a manual batch for missing publications.

The extension periodically checks only the pending count and shows it on the toolbar badge. It does not retrieve anything until you open it and choose **Start**.

A successful Browser Helper upload goes through the same server-side PDF validation/storage path as a manual upload and makes the PDF available for normal screening. An automated failure does not mark the human retrieval outcome as not found/inaccessible. Sign in to the publisher/VPN and retry, upload manually, or use another authorized retrieval method as appropriate.

You can revoke a helper at any time from Account Settings.

## LLM assistance

LLM support is configured at two levels:

- the **installation administrator** enables/configures the Ollama integration in Global Settings;
- a **project owner or administrator** enables the individual LLM capabilities for a project.

For title/abstract screening, Papertrail can prepare a suggestion independently but withholds it until you submit your own current decision. The first action is **Submit Decision**. After the hidden comparison is revealed, the action becomes **Confirm Decision**. You can change your human answer before confirmation; the LLM never changes it automatically.

Full-text screening uses the same submit/confirm interaction, while evidence assistance can be visible during review because it is designed to help locate eligibility evidence in the PDF.

In Data Extraction, suggestions appear beside mapped controls with explicit/inferred/ambiguous/missing status and page-aware evidence. Existing drafts are never overwritten. Applying a suggestion is explicit, and you remain free to edit/replace it. LLM-only helper fields are informational and do not become submitted/exported extraction data.

Optional extraction validation runs against authoritative final extractions after the project's eligible extraction cohort has completed (including reconciliation where two extractors are used). **Review LLM Extraction Validation** shows contradicted/uncertain/unverifiable fields and links back to the normal human revision workflow. Validation never edits reviewer data.

Project-level **AI-generated interpretive analysis** also controls stage narrative/research-question synthesis views. Project owners/administrators control that capability. See [LLM-assisted extraction](llm-assisted-extraction.md) for prompt/version/evidence/privacy details.

## Email notifications

When the installation administrator enables SMTP and your account has an email address, Papertrail can email you when your account is created and when you are added to or removed from a project. Active administrators are notified of new projects. Project owners can receive stage-completion summaries for scheduled LLM work.

You can update or clear your email in Account Settings.

## Extraction and quality assessment

Each finally included publication has one extractor, or two independent extractors if the project owner/administrator configured dual extraction before extraction responses existed. Quality assessment currently assigns one assessor per publication when enabled.

For extraction and quality, allocation can be:

- **Claim** — eligible reviewers claim the next available item;
- **Pre-assigned** — work is divided round-robin across eligible reviewers using workload weights.

Complete all required form fields before submission. Submitted work can be revised by the responsible reviewer and can be reopened through the authorized management workflow.

When the quality form uses numerical scoring, Papertrail calculates the configured total/average/weighted-average score from the field scoring metadata. The displayed score is an assessment result only; it does not automatically include or exclude the publication.

### Dual-extractor reconciliation

When two extractors are configured, each works independently. Once both complete a publication, Papertrail compares their answers field-by-field.

- Full agreement creates the authoritative final extraction automatically.
- A disagreement enters **Reconciliation**.
- The project owner, an administrator, or a member with adjudication permission can choose reviewer A's value, reviewer B's value, or a manual value for each disagreement and must provide the reconciliation note required by the workflow.

Original reviewer responses remain preserved separately from the final result. See [Review Workflow](review-workflow.md).

## Final results and exports

Any project member can browse the project's authoritative final results: finally included publications plus final extraction values and, when configured/completed, quality-assessment values/scores.

Exports include PRISMA outputs and structured XLSX, Parquet, JSON, CSV, and BibTeX artifacts. Export generation is asynchronous; the generated artifact is downloaded through the project after the background job completes.

## Charts & Analysis

The Charts & Analysis area reads authoritative project results.

### Reviewer Analysis

Reviewer Analysis reports anonymized agreement for title/abstract and full-text screening. It includes raw agreement and Cohen's kappa (two reviewers) or Fleiss' kappa (more than two) where mathematically defined. Reviewer identities are not exposed in the analysis response.

### Evidence Matrix

The Evidence Matrix shows included publications against extraction/quality fields. Search/filter/column controls operate against server-side result data. Opening a cell shows its authoritative value/resolution method and traceable suggestion evidence where Papertrail can prove that lineage. A publication still awaiting extraction reconciliation is shown as pending reconciliation rather than as an ordinary blank value.

### Research Question Analysis

When **AI-generated interpretive analysis** is enabled for the project, Papertrail can generate one synthesis per research question over authoritative extraction/quality data. Statements cite `[SRC-xxxx]` source badges that resolve back to the specific publication/field/value and, where traceable, original evidence. Data changes can make a prior synthesis stale; regenerate from the analysis card when needed.
