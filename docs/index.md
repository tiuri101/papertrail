# Papertrail documentation

Papertrail is a self-hosted, multi-user tool for structured literature reviews:
import → deduplicate → screen → retrieve full text → extract → quality-assess → report.
An optional local LLM (Ollama) can suggest screening decisions and extracted data.

The source code lives at [github.com/tiuri101/papertrail](https://github.com/tiuri101/papertrail).

## Getting started

- [Installation](installation.md): deploy Papertrail with Docker Compose
- [Configuration reference](configuration.md): every setting and environment variable
- [Upgrade guide](upgrade.md): moving to a new release
- [Backup and restore](backup-and-restore.md): protecting the database and PDF volume

## Using Papertrail

- [Reviewer guide](user-guide.md): day-to-day work as a reviewer
- [Review workflow](review-workflow.md): how a review moves from import to report
- [Import formats](import-formats.md): supported CSV, TSV, XLSX, RIS, and BibTeX files
- [Browser Helper](browser-helper.md): retrieving PDFs through your own browser
- [LLM-assisted screening and extraction](llm-assisted-extraction.md)

## Administration and operations

- [Administrator guide](administrator-guide.md): users, projects, and instance settings
- [Security](operations/security.md)
- [Reliability](operations/reliability.md)

## Development

- [Architecture](architecture.md) and the [interactive architecture overview](architecture/interactive/index.html)
- [Developer guide](developer-guide.md)
- [Local development](local-development.md)
- [Frontend testing](frontend-testing.md)
- [API overview](api.md)
