# LLM-assisted screening and data extraction

Papertrail can prepare structured screening assistance, evidence-backed extraction suggestions, and optional validation of completed human extractions with an external Ollama server.

> LLM suggestions are not authoritative review data. Human reviewers remain responsible for every screening decision and final extraction.

## Architecture and processing trigger

The normal PostgreSQL-backed worker extracts text from each eligible active PDF with `pypdf`, preserving physical PDF page numbers. A dedicated LLM worker uses the same job table but claims only Ollama inference jobs, which limits GPU concurrency independently from ordinary jobs. Text, immutable runs, validated suggestions, evidence-verification results, runtime metrics, and reviewer-versus-suggestion provenance are stored in PostgreSQL. PDF binaries remain in `papertrail_pdf_data`.

Title/abstract suggestions use bibliographic metadata and project criteria and are queued when title/abstract work items are created, before a reviewer opens or decides a paper. Opening a paper promotes its queued job so the result is more likely to be ready immediately after the independent human decision. The API still returns only a redacted `hidden` state until that reviewer submits a current decision. Full-text assistance, extraction suggestions, and validation require page-aware PDF text. Expensive PDF processing starts only when all of these are true:

- installation-level LLM support is enabled;
- the project has enabled at least one relevant full-text capability;
- the publication has a current title/abstract inclusion decision;
- an active PDF exists;
- the publication has not been excluded at full text.

An early bulk-imported PDF therefore remains idle until title/abstract inclusion. If the publication was already included, uploading or replacing its PDF queues processing immediately. Queued full-text inference is cancelled when practical after full-text exclusion; completed historical processing is retained.

Projects control title/abstract suggestions, full-text screening assistance, data extraction, and extraction validation independently. New capabilities default to disabled for existing projects.

## Configuration

```dotenv
PAPERTRAIL_LLM_ENABLED=true
PAPERTRAIL_OLLAMA_BASE_URL=http://192.168.1.50:11434
PAPERTRAIL_OLLAMA_MODEL=qwen3:8b
PAPERTRAIL_OLLAMA_REQUEST_TIMEOUT_SECONDS=300
PAPERTRAIL_LLM_MAX_CONCURRENT_JOBS=1
PAPERTRAIL_LLM_CONTEXT_LENGTH=32768
PAPERTRAIL_LLM_MAX_EVIDENCE_ITEMS=3
PAPERTRAIL_LLM_MAX_EVIDENCE_QUOTE_CHARS=500
# Optional bearer token for a protected reverse proxy:
# PAPERTRAIL_OLLAMA_API_KEY=secret
```

`PAPERTRAIL_OLLAMA_BASE_URL` is the server base URL, without `/api/chat`. Papertrail sends native `POST /api/chat` requests with `stream=false`, `think=false`, JSON-schema structured output, temperature zero, and the configured context length. Credentials are backend-only and are neither returned by APIs nor logged. `PAPERTRAIL_LLM_ENABLED=false` leaves every existing workflow fully functional and requires no Ollama or GPU for development and tests.

Ollama must already contain the configured model. The project administration connection test calls Ollama's model-list endpoint and reports reachability and model availability; it never pulls a model. The normal Compose stack does not contain Ollama or GPU configuration.

## Project schema and versioning

Project owners and administrators configure LLM assistance in Project Administration. “Create LLM schema from extraction form” creates one evidence-required LLM field per active extraction field. Each field has a label, explicit extraction instruction, output type, stable-key mapping, options/range, evidence requirement, inference policy, enabled flag, and order. LLM-only helper fields are supported.

Supported types are short text, long text, number, checkbox/boolean, single selection, multiple selection, date, URL, and rating. Mapped field types and selection options must match the active extraction field. Mappings use the extraction field's stable key, so label and order changes survive; archived or type-replaced fields are reported as outdated and block publication until resolved.

Published versions are immutable. Editing a published schema forks a new draft. Publishing makes it current but retains prior versions and runs. Existing runs are marked outdated relative to a newer schema; they are not deleted or silently rerun. Administrators can explicitly queue all title/abstract-eligible papers or only full-text-included papers with the current schema; assigned extraction reviewers can queue/re-run their current paper. Active duplicate runs for the same document/schema pair are prevented.

## Text, prompts, evidence, and long documents

Text is stored page-by-page against the exact stable `document_id`. Image-only/scanned PDFs are marked unsupported with an OCR-required message; Papertrail does not perform OCR. Replacing a PDF creates a new document, text extraction, and LLM run while historical document text and runs remain attached to the old version.

The prompt contains stable system rules, versioned field instructions/options, unmistakable `--- PDF PAGE N ---` boundaries, and a strict response schema. The model returns `explicit`, `inferred`, `ambiguous`, `not_found`, or `not_applicable` per field. Fields that forbid inference cannot accept an inferred result. Responses are validated again by Pydantic and by type/option rules; one structured repair request is attempted before deterministic failure.

Papertrail estimates prompt size conservatively. A fitting paper uses one pass. Longer papers are packed into page-aware chunks without splitting pages where possible, then consolidated through another structured request using only candidate values and candidate evidence. Candidate disagreement is instructed to become ambiguous.

Evidence is limited to short quotes and a small number of items. Every quote is whitespace-normalized and checked against the claimed physical PDF page. Verified, partially verified, and unverified evidence remain distinguishable; missing or fabricated evidence is never presented as verified and does not block manual extraction.

## Reviewer workflow and provenance

### Title/abstract screening

Papertrail may prepare a structured include/exclude/uncertain suggestion before the reviewer screens the record, but the result is withheld by the backend until that assigned reviewer has submitted a current decision. The model never receives that human decision. The hidden panel sits below Notes on the screening form. After the first submission, the same form remains open, reveals the comparison, and keeps its action labeled **Submit Decision**. The reviewer can adjust any answer before confirming; changed values create a normal versioned revision, while an unchanged confirmation advances without another write. Full-text screening uses the same confirmation interaction, although its evidence assistance remains visible before submission because it is intended to help locate eligibility evidence. Confidence remains an uncalibrated low/medium/high category, and a disagreement never changes the human decision automatically.

### Full-text screening

For active PDFs with usable text, the full-text screen shows criterion-by-criterion met/not-met/unclear assistance. Each evidence quote retains its physical PDF page and optional section label, is checked against that page's extracted text, and links to the authenticated PDF viewer. The overall include/exclude/uncertain suggestion is secondary; the reviewer still submits the normal decision. Missing text, model failure, and stale results remain non-blocking.

### Data extraction

Suggestions appear beside their mapped controls in Data Extraction. Existing drafts always take precedence and late results never overwrite reviewer work. Reviewers can apply/reset a suggestion, freely edit or replace it, inspect evidence, and open the authenticated PDF with a page fragment. Missing, ambiguous, inferred, processing, unavailable, failed, and outdated states are explicit. Helper fields appear in a secondary panel and never enter the official response.

Submitting uses the normal extraction validation, revision, autosave, and export paths. The original validated LLM result remains immutable. Papertrail automatically stores whether each final reviewer value accepted, modified, replaced, or did not use a suggestion. Standard exports continue to contain reviewer-controlled values only.

### Optional extraction validation

When enabled, validation waits until every included publication has been manually extracted. Submitting the final human extraction queues the project validation cohort; Papertrail does not run validation after each individual paper. Each task assesses the submitted human values as `supported`, `contradicted`, `uncertain`, or `not_verifiable`, with the same source-verified evidence. It never supplies replacement values or edits the extraction. The extraction-stage checklist tracks cohort completion, and the project page provides **Review LLM Extraction Validation** for revisiting contradicted, uncertain, and unverifiable fields. Reviewers can open the original extraction, correct it through the normal revision path, and receive a validation run for the new response. Ollama failure never blocks submission; failed or text-unavailable validations remain visible in the review overview.

Production prompt identifiers are versioned in backend code (`title_abstract_screening_v1`, `full_text_screening_v1`, `data_extraction_v2`, and `extraction_validation_v1`). Input fingerprints include the relevant metadata, criteria, document/text version, schema, human response, model, and prompt version, so changed inputs are reported as stale rather than silently reused.
Each immutable run also records its provider, configured model, and non-secret generation configuration (temperature, thinking mode, and context length).

## Reliability, privacy, and backup

Transient network, timeout, HTTP 5xx, and interruption failures use existing leases and bounded retries. Validation, missing-text, and unsupported-document failures stop cleanly. Ollama downtime never blocks API, screening, extraction, submission, reporting, or exports. Operational logs contain IDs, model, status, counts, durations, and error categories—not full papers, prompts, credentials, or sessions.

The external Ollama service receives only the material needed for the task: title/abstract metadata and criteria for metadata screening, or full text from one eligible paper plus criteria/field definitions/human values for full-text tasks. It does not receive passwords, sessions, reviewer notes, human screening decisions, or other publications. Administrators must assess and secure that network path and Ollama host appropriately.

A complete backup still requires PostgreSQL plus the PDF and import/export volumes. LLM schemas, page text, immutable runs, metrics, evidence, and provenance live in PostgreSQL; source PDFs live in `papertrail_pdf_data`.
