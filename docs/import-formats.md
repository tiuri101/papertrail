# Import Formats

Papertrail accepts CSV, TSV, XLSX, RIS, and BibTeX files. Column headers are matched against a shared alias table that recognizes common variants used by ScienceDirect, IEEE Xplore, ACM Digital Library, SpringerLink, and similar exports (for example "document title", "source title", or "cover date"), so most exports normalize automatically without per-source configuration.

The preferred normalized fields are title, authors, abstract, year, venue, publication type, DOI, URL, keywords, ISBN, and ISSN. Title is required for a valid imported record. Unrecognized columns can be previewed and mapped to a normalized field, including PubMed and arXiv identifiers, before import. Original rows are retained unchanged for provenance.

## Optional PDFs

The same import form accepts multiple local PDF files and/or multiple ZIP archives containing PDFs. PDFs are matched conservatively within that import batch: an exact normalized DOI is strongest, followed by reliable PDF metadata, an exact normalized title, and a strongly similar title corroborated by author or year.

High-confidence unique matches are attached automatically. Ambiguous, unmatched, and existing-PDF conflicts remain in the match-review screen. A reviewer can choose another publication, skip the file, keep an existing PDF, or explicitly replace it. Existing PDFs are never replaced automatically. Invalid and duplicate files are reported individually without rolling back valid files.

ZIP entries are processed one archive at a time in temporary storage with batch-wide file-count and expanded-size limits plus compression-ratio and path-traversal protections. A bad archive is reported without preventing the remaining archives from being processed. Non-PDF entries are reported and ignored. Supported full-text inputs are PDFs and ZIPs containing PDFs.

Papertrail does not automatically retrieve, download, or scrape publisher PDFs. Users are responsible for supplying files they are authorized to access and store.

Unresolved bulk files remain in protected staging storage so they can be attached during match review. Attached files move to generated project/publication keys. Replaced and logically removed PDFs remain in protected storage as history; reviewer actions do not physically erase historical versions.
