# Review Workflow

Papertrail uses six shared project states: draft, duplicate review, title/abstract screening, full-text retrieval and screening, extraction and quality assessment, and completed.

Automatic transitions depend on authoritative workflow records. Duplicate suggestions must all be resolved before screening. Records imported after that are checked for duplicates first and held out of screening (`Publication.duplicate_check_pending`, or membership in an unresolved duplicate pair) until the check and any resulting pair are resolved; a merge always keeps the record carrying screening decisions, and a merge of two screened records with different outcomes suspends automatic finalization of the kept record at that stage (`PublicationMerge.outcome_conflict_stages`) until a manager resolves it. Screening requires all reviewer slots and conflict resolutions. Full-text work distinguishes reports not retrieved from eligibility exclusions. Completion requires extraction and any enabled quality assessment for every finally included publication, and — in dual-extractor projects — an empty reconciliation queue.

## Data extraction: single vs. two independent extractors

A project owner or administrator configures whether each included publication is extracted once or independently by two reviewers (Project Administration → Extraction Settings; this cannot be changed once any extraction response exists). The setting mirrors screening's reviewer-count model, but extraction's authoritative outcome is always a single record — `FinalExtraction` — rather than the raw per-reviewer response:

- **Single extractor** (default): the reviewer's submitted response becomes the authoritative `FinalExtraction` immediately (`resolution_method: single_reviewer`). Nothing about reconciliation applies in this mode.
- **Two independent extractors**: each publication gets two extraction slots. A reviewer's own slot is never affected by what the other slot contains; **blinding is per-reviewer and asymmetric** — you cannot see the sibling slot's answers, drafts, or history until *your own* slot is complete, regardless of whether the sibling finished first. Project managers and adjudicators always see both, since resolving a disagreement requires it.
  - If both completed responses agree on every field, Papertrail finalizes the result automatically (`resolution_method: agreement`) — no reconciliation step is ever shown for a fully-agreeing publication.
  - If they disagree on any field, the publication enters the **reconciliation queue** until it is resolved. This is a derived queue (publications where both slots are complete but no current final result exists yet), not a separate manual tracking step.

## Reconciliation

Reconciliation is restricted to the project owner, an administrator, or a member explicitly granted the **adjudicator** permission (Project Members → a member's **Adjudication** permission). Opening a queued publication shows both slots' answers side by side per field. Fields both reviewers agree on are pre-filled and read-only; for each disagreeing field the adjudicator picks reviewer A's value, reviewer B's value, or enters a manual value. A note is required. Submitting re-validates the merged answer set through the same rules a normal submission uses and records the result as `resolution_method: reconciliation`, with the original two responses preserved as-is — reconciliation never edits or discards either reviewer's individual submission.

A project owner or administrator can also directly **override** a publication's final extraction (single- or dual-extractor mode) with a required note; this is recorded as `resolution_method: override` and, like reconciliation, never modifies the underlying reviewer response(s) it replaces.

## Revisions

A reviewer can revise a completed extraction slot at any time (subject to normal permissions). Revising invalidates the current `FinalExtraction` for that publication first: in single-extractor mode the new response becomes final immediately; in dual-extractor mode Papertrail re-runs the same agree/disagree check against the sibling slot, either producing a fresh automatic agreement or re-opening the reconciliation queue. Every prior final result stays in the audit trail as invalidated history — it is never deleted.

## Charts & Analysis

The project's Charts & Analysis page builds several views on top of the authoritative screening and extraction/quality results:

- **Reviewer Analysis** — anonymized inter-rater agreement for title/abstract and full-text screening (see [User Guide](user-guide.md) for how to read it).
- **Evidence Matrix** — every included publication against every extraction/quality field, with the authoritative value and, where traceable, the exact source quotation behind it.
- **Research Question Analysis** — optional LLM-generated synthesis of the authoritative results per research question, every statement traceable to specific source facts (see [LLM-assisted extraction](llm-assisted-extraction.md)).
