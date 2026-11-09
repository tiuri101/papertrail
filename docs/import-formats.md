# Import Formats

Papertrail accepts CSV, TSV, XLSX, RIS, and BibTeX files. Column headers are matched against a shared alias table that recognizes common variants used by ScienceDirect, IEEE Xplore, ACM Digital Library, SpringerLink, and similar exports (for example "document title", "source title", or "cover date"), so most exports normalize automatically without per-source configuration.

The preferred normalized fields are title, authors, abstract, year, venue, publication type, DOI, URL, keywords, ISBN, ISSN, PubMed ID, and arXiv ID. Title is required for a valid imported record. Unrecognized columns can be previewed and mapped to a normalized field before import. Original rows are retained unchanged for provenance.

## RIS

Records run from `TY` to `ER`. Long values wrap onto untagged continuation lines, which are joined back onto the field above, so abstracts and titles are never truncated at the first line. A record that never closes with `ER` ends where the next `TY` begins.

Tags are read in the canonical `XX  - value` form; the looser forms real exporters emit (one space, no space, or a four-character MEDLINE tag such as `PMID-` or `LID -`) are accepted for tags RIS actually defines, so a continuation line that happens to start with letters and a hyphen is not mistaken for a new field.

Because exporters disagree about which tag carries which field, several tags feed one normalized field and the best available one wins regardless of line order:

| Field | Tags, best first |
| --- | --- |
| Title | `TI`, `T1`, `CT`, `ST` |
| Authors | `AU`, `A1` (accumulated; editors in `A2`–`A4` are ignored) |
| Abstract | `AB`, `N2` |
| DOI | `DO`, `DI`, `LID` (a trailing `[doi]` marker is stripped) |
| Year | `PY`, `Y1`, `DA`, `Y2` (any four-digit year within the value) |
| Venue | `JF`, `JO`, `JT`, `T2`, `SO`, `JA`, `J1`, `J2`, `BT`, `T3` |
| URL | `UR`, `LK`, `L2` |
| Keywords | `KW` (accumulated) |
| ISBN / ISSN | `SN`, `BN` — the tag does not distinguish them, so the value's shape does |
| PubMed ID | `PMID` |
| Publication type | `TY` |

Pagination, volume, issue, address, and language tags are parsed but have no normalized field and are not stored on the publication.

## BibTeX

The supported subset covers what reference managers actually export, not the whole of BibTeX:

- Entries delimited by `{}` or `()`, of any entry type; the entry type becomes the publication type and the citation key is kept for provenance.
- Values as braced groups nested to any depth, quoted strings, bare numbers, and `@string` macros, joined with `#` concatenation. `@string`, `@comment`, and `@preamble` blocks are handled and never become records; a stray `@` elsewhere in the file is ignored.
- Braces used only to protect capitalization (`{COVID-19}`, <code>&#123;&#123;visual analytics&#125;&#125;</code>) are removed; LaTeX accent and special-character commands (`{\"u}`, `\'e`, `{\ss}`) are decoded to Unicode.
- `and`-separated author lists are normalized to the same `; ` separator RIS records use. A name wrapped in its own braces — <code>author = &#123;&#123;Ministry of Health and Care&#125;&#125;</code> — stays one author.
- `journal`, `journaltitle`, and `booktitle` map to venue; `eprint` (with `archivePrefix = {arXiv}`, or with no `archivePrefix`) maps to the arXiv ID; `pmid` maps to the PubMed ID.

Not supported, and not planned: BibTeX's `\newcommand`/macro expansion beyond `@string`, `crossref` inheritance between entries, and `.bst` style semantics. Fields with no normalized counterpart (`volume`, `number`, `pages`, `note`, `publisher`, …) are parsed and retained in the raw imported record but are not stored on the publication.

`backend/tests/fixtures/import_formats` holds sanitized representative exports from PubMed, Scopus, Web of Science, EndNote, Zotero, Google Scholar, and a legacy manager; `backend/tests/test_import_format_compatibility.py` asserts what each one produces.

## Optional PDFs

The same import form accepts multiple local PDF files and/or multiple ZIP archives containing PDFs. PDFs are matched conservatively within that import batch: an exact normalized DOI is strongest, followed by reliable PDF metadata, an exact normalized title, and a strongly similar title corroborated by author or year.

High-confidence unique matches are attached automatically. Ambiguous, unmatched, and existing-PDF conflicts remain in the match-review screen. A reviewer can choose another publication, skip the file, keep an existing PDF, or explicitly replace it. Existing PDFs are never replaced automatically. Invalid and duplicate files are reported individually without rolling back valid files.

ZIP entries are processed one archive at a time in temporary storage with batch-wide file-count and expanded-size limits plus compression-ratio and path-traversal protections. A bad archive is reported without preventing the remaining archives from being processed. Non-PDF entries are reported and ignored. Supported full-text inputs are PDFs and ZIPs containing PDFs.

The Papertrail server does not scrape publisher full text using server-side institutional credentials, and import PDFs must be supplied by users who are authorized to access and store them. An optional paired Chrome extension (the "Browser Helper") can retrieve PDFs through the user's own browser network access and sign-in state and upload them through this same PDF pipeline -- see [Reviewer guide](user-guide.md#browser-assisted-pdf-retrieval).

Unresolved bulk files remain in protected staging storage so they can be attached during match review. Attached files move to generated project/publication keys. Replaced and logically removed PDFs remain in protected storage as history; reviewer actions do not physically erase historical versions.
