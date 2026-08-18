# Reviewer Guide

Reviewers only see projects in which they are members and activities for which they are eligible. The interface only shows actions you're allowed to take — for example, project setup and administration pages are only visible to that project's owner or an administrator.

Any project member can edit the project's research questions and inclusion/exclusion criteria, document a database search and upload its import file, resolve duplicate candidates, and generate and download exports (PRISMA outputs, the Excel workbook, Parquet, JSON, CSV, and BibTeX).

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

Only project members can view PDF metadata or content. Full-text reviewers, project owners, and administrators can upload, replace, and remove PDFs. The Papertrail server does not scrape publisher content itself; only upload files you are authorized to access and store, or use the optional browser-assisted retrieval described below.

When a newly retrieved document is marked available, save that retrieval status first. Papertrail then opens the normal full-text screening item so page-aware LLM assistance can be prepared and shown without combining retrieval and eligibility into one premature decision.

### Browser-assisted PDF retrieval

If your institution provides IP-based publisher access, a VPN, or you're already signed in to a publisher in Chrome, you can pair the optional **Papertrail Browser Helper** Chrome extension so it retrieves PDFs through your own computer's network connection and browser sign-in state, then uploads them through this same PDF pipeline. Papertrail never receives your institutional credentials, publisher passwords, or browser cookies through this feature -- only the resulting PDF.

**Pairing:** In Papertrail, go to Account Settings → Browser Helpers → **Pair new browser helper**. Copy the one-time pairing secret shown (it is displayed once and expires after about 10 minutes). Click the Papertrail Browser Helper icon in Chrome's toolbar and **Set up** -- this opens a small setup window near the toolbar button. Enter your Papertrail server URL, the pairing secret, and a device name, then **Pair**. Chrome will prompt you to allow the extension access to your Papertrail server's address -- allow it; this only grants access to your own Papertrail server, not to any publisher site.

**Running a retrieval batch:** On a project's Full-Text page, if a browser helper is paired you'll see how many publications are missing full text and a **Retrieve missing PDFs** button. Clicking it queues persistent retrieval jobs in Papertrail -- open the Papertrail Browser Helper extension and start the retrieval session to process them; it keeps working even if you close the Papertrail tab. As PDFs are retrieved, they automatically become available and enter the normal full-text screening queue, exactly as a manual upload would; no screening or inclusion decision is made automatically.

The extension checks in the background every few minutes for jobs waiting to be processed and shows the count as a badge on its toolbar icon -- so you don't need to keep the retrieval window open just to notice that a batch was queued. This check only reports a count; you still open the extension and click **Start** to actually retrieve anything.

**When retrieval can't complete automatically:** publications that need institutional sign-in, weren't found, or otherwise failed remain visible with a short reason. Signing in to the publisher in Chrome and retrying (from either the extension or the project's PDF retrieval panel) often resolves an authentication requirement. A publication that can't be retrieved automatically simply stays in the normal manual retrieval workflow -- upload it yourself, search elsewhere, use interlibrary loan, or mark it not found/inaccessible as usual. An automated attempt failing never marks a paper as unobtainable on your behalf.

You can revoke a browser helper at any time from Account Settings, which immediately prevents it from claiming or completing further retrieval jobs.

## LLM assistance

Administrators can independently enable title/abstract suggestions, full-text assistance, extraction suggestions, and post-extraction validation. A title/abstract result is generated independently as soon as screening work is created and is withheld by the server until the assigned reviewer submits their own decision. The suggestion panel appears below Notes on the same form. After **Submit Decision**, it is revealed and the action changes to **Submit Decision**; the reviewer can change their answers before confirming, but the LLM never changes them automatically. Full-text screening uses the same submit-and-confirm interaction, while its evidence assistance remains visible during review and points to verified passages and physical PDF pages.

In Data Extraction, the assigned reviewer sees each mapped suggestion beside the normal editable field, including explicit/inferred/ambiguous/missing status and verified or unverified page evidence. Existing drafts are never overwritten; apply a suggestion explicitly or enter any different value. LLM-only helper fields are informational and are not submitted or exported. If optional extraction validation is enabled, it starts only after every paper has been manually extracted. Its progress appears as a separate extraction-stage checklist item. Use **Review LLM Extraction Validation** on the project page to inspect contradicted, uncertain, or unverifiable values and reopen the normal human extraction for correction. Validation never changes reviewer data, and LLM errors never prevent screening or manual extraction.

The normal submitted extraction and exports always use reviewer-controlled values. Papertrail retains the immutable original suggestion separately for audit and evaluation. See [LLM-assisted extraction](llm-assisted-extraction.md) for processing, privacy, and versioning details.

## Email notifications

If the installation administrator enables email and records your address, Papertrail emails you when your account is created and when you are added to or removed from a project. Administrators are notified whenever a new project is created. Project owners also receive a summary after all currently scheduled LLM jobs for a task stage have finished. You can update or clear your address under Account Settings.

## Extraction and quality assessment

Each included publication has one extractor, or — if the project owner or administrator has configured **two independent extractors** (Project Administration → Extraction Settings, locked once any response exists) — two reviewers who extract it independently without seeing each other's answers until their own is complete. When enabled, each publication also has one quality assessor. As with screening, the project owner or an administrator chooses how publications reach reviewers for each of these stages: **Claim** (the default) lets reviewers pick up the next unclaimed publication themselves, while **Pre-assigned** divides publications round-robin across eligible reviewers ahead of time, weighted by workload weight. Complete all required fields before submission. Submitted work can be revised, or reopened by the project owner or an administrator.

In two-extractor projects, once both reviewers finish a publication Papertrail compares their answers field by field. Full agreement finalizes the result immediately — no extra step. A disagreement sends the publication to the **Reconciliation** queue, visible only to the project owner, an administrator, or a member granted the adjudicator permission. There, the adjudicator sees both answers per field, picks reviewer A's, reviewer B's, or enters a manual value for whichever fields disagree (agreeing fields are pre-filled), adds a required note, and submits — this becomes the authoritative result, and both original reviewer responses are kept as-is. See [Review Workflow](review-workflow.md) for the full mechanics.

## Final results

Any project member can browse a sortable, paginated table of every finally included publication alongside its extraction answers and, when enabled, quality-assessment answers and score.

## Charts & Analysis

Beyond the per-stage progress charts, the Charts & Analysis page has three views built on the project's authoritative results:

**Reviewer Analysis** shows how independent reviewers agreed with each other for title/abstract and full-text screening, without ever naming who made which decision — reviewers are shown only as anonymous "Reviewer A", "Reviewer B", etc. Alongside raw percent agreement, it reports **Cohen's kappa** (for two reviewers) or **Fleiss' kappa** (for more than two): a measure of agreement that corrects for how often reviewers would agree purely by chance. Kappa ranges roughly from 0 (no better than chance) to 1 (perfect agreement); as a rough guide, below 0.4 is usually considered weak agreement, 0.4–0.75 moderate to good, and above 0.75 excellent — but always read it alongside the raw agreement rate and how many decisions it's based on. Kappa shows as "N/A" (never a bare "0") when there isn't enough data to compute it meaningfully, or when every reviewer picked the same option so there's no variation to measure agreement over.

**Evidence Matrix** is a spreadsheet-like view of every included publication against every extraction and quality field, with the authoritative (single-reviewer, agreed, reconciled, or overridden) value in each cell. A publication still awaiting reconciliation shows as a distinct "pending reconciliation" state rather than looking like a blank/missing answer. Search, per-field filters, and column visibility all work server-side for large projects. Click a cell to see its resolution method and, where traceable, the exact quoted evidence behind it.

**Research Question Analysis** optionally generates an LLM synthesis of the authoritative results for each research question, when your administrator has enabled "AI-generated interpretive analysis" for the project (the same toggle that controls the per-stage narrative summaries above). Every statement links to `[SRC-xxxx]` badges you can expand to see exactly which publication, field, and value it's based on — including the original evidence quote when one is traceable. The synthesis never invents a citation: a claim the model couldn't tie back to real project data is dropped rather than shown unsupported. A "may be outdated" banner appears once the underlying data has changed since the synthesis was generated; regenerate it from the same card.
