# Import Formats

Papertrail accepts CSV, TSV, XLSX, RIS, and BibTeX files. Column headers are matched against a shared alias table that recognizes common variants used by ScienceDirect, IEEE Xplore, ACM Digital Library, SpringerLink, and similar exports (for example "document title", "source title", or "cover date"), so most exports normalize automatically without per-source configuration.

The preferred normalized fields are title, authors, abstract, year, venue, publication type, DOI, URL, keywords, ISBN, and ISSN. Title is required for a valid imported record. Unrecognized columns can be previewed and mapped to a normalized field, including PubMed and arXiv identifiers, before import. Original rows are retained unchanged for provenance.
