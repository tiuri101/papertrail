# Reviewer Guide

Reviewers only see projects in which they are members and activities for which they are eligible. The interface only shows actions you're allowed to take — for example, project setup and administration pages are only visible to that project's owner or an administrator.

Any project member can edit the project's research questions and inclusion/exclusion criteria, document a database search and upload its import file, resolve duplicate candidates, and generate and download exports (PRISMA outputs, the Excel workbook, and BibTeX).

## Search documentation and imports

Record the database, search string, date, and any filters used for each search, and upload the corresponding export file. You may select multiple PDFs and/or multiple ZIP archives of PDFs in the same form. After import, review only ambiguous, unmatched, or existing-PDF conflicts; high-confidence DOI and title matches are attached automatically. Unrecognized metadata columns can be mapped to a normalized field before import.

## Duplicate review

Any project member can resolve a suggested duplicate as not a duplicate, or merge it and choose which record stays canonical. Marking the project ready to enter duplicate review, and reversing a completed merge, is done by the project owner or an administrator.

## Screening

Open the active screening queue, inspect the publication metadata, complete every inclusion and exclusion criterion, and select include, exclude, uncertain, or duplicate. Notes are optional for every decision. Draft work is autosaved, and a reserved item remains assigned for up to one hour unless released.

In independent screening, other reviewers' answers remain hidden until all required decisions have been submitted. A submitted decision can be revised; any existing consensus is then invalidated and must be resolved again.

How publications reach your queue depends on the stage's allocation setting, configured by the project owner or an administrator: with **Claim** (the default), publications aren't assigned in advance — the queue hands you the next unclaimed one as you work. With **Divided**, publications are pre-assigned round-robin across eligible reviewers, weighted by each reviewer's configured workload weight.

## Full text

Papertrail provides DOI and publisher links and stores PDFs supplied by authorized project users. During full-text work, upload a missing PDF directly from the screening page. An attached PDF can be viewed in the browser, replaced, or logically removed. Replacement creates a new stable document version and retains the previous file in the collapsible history; removal preserves history and does not change any screening decision. PDFs imported before screening become available when the publication reaches the full-text stage.

Only project members can view PDF metadata or content. Full-text reviewers, project owners, and administrators can upload, replace, and remove PDFs. Papertrail does not automatically download or scrape publisher content; only upload files you are authorized to access and store.

When a newly retrieved document is marked available, save that retrieval status first. Papertrail then opens the normal full-text screening item so page-aware LLM assistance can be prepared and shown without combining retrieval and eligibility into one premature decision.

## LLM assistance

Administrators can independently enable title/abstract suggestions, full-text assistance, extraction suggestions, and post-extraction validation. A title/abstract result is generated independently as soon as screening work is created and is withheld by the server until the assigned reviewer submits their own decision. The suggestion panel appears below Notes on the same form. After **Submit Decision**, it is revealed and the action changes to **Submit Decision**; the reviewer can change their answers before confirming, but the LLM never changes them automatically. Full-text screening uses the same submit-and-confirm interaction, while its evidence assistance remains visible during review and points to verified passages and physical PDF pages.

In Data Extraction, the assigned reviewer sees each mapped suggestion beside the normal editable field, including explicit/inferred/ambiguous/missing status and verified or unverified page evidence. Existing drafts are never overwritten; apply a suggestion explicitly or enter any different value. LLM-only helper fields are informational and are not submitted or exported. If optional extraction validation is enabled, it starts only after every paper has been manually extracted. Its progress appears as a separate extraction-stage checklist item. Use **Review LLM Extraction Validation** on the project page to inspect contradicted, uncertain, or unverifiable values and reopen the normal human extraction for correction. Validation never changes reviewer data, and LLM errors never prevent screening or manual extraction.

The normal submitted extraction and exports always use reviewer-controlled values. Papertrail retains the immutable original suggestion separately for audit and evaluation. See [LLM-assisted extraction](llm-assisted-extraction.md) for processing, privacy, and versioning details.

## Email notifications

If the installation administrator enables email and records your address, Papertrail emails you when your account is created and when you are added to or removed from a project. Administrators are notified whenever a new project is created. Project owners also receive a summary after all currently scheduled LLM jobs for a task stage have finished. You can update or clear your address under Account Settings.

## Extraction and quality assessment

Each included publication has one extractor and, when enabled, one quality assessor. As with screening, the project owner or an administrator chooses how publications reach reviewers for each of these stages: **Claim** (the default) lets reviewers pick up the next unclaimed publication themselves, while **Pre-assigned** divides publications round-robin across eligible reviewers ahead of time, weighted by workload weight. Complete all required fields before submission. Submitted work can be revised, or reopened by the project owner or an administrator.

## Final results

Any project member can browse a sortable, paginated table of every finally included publication alongside its extraction answers and, when enabled, quality-assessment answers and score.
