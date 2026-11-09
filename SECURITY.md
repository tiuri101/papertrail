# Security Policy

## Supported versions

Papertrail is released as `YEAR.MONTH.PATCH`. Security fixes are made on the
latest release only; please upgrade to it before reporting.

| Version | Supported |
| ------- | --------- |
| Latest release | ✅ |
| Older releases | ❌ |

The Browser Helper extension ships with each release
(`papertrail-browser-extension-<release>.zip`) and follows the same support policy.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Report them privately through GitHub instead:
[**Report a vulnerability**](https://github.com/tiuri101/papertrail/security/advisories/new)

Please include:

- the affected component (backend API, web app, worker, Browser Helper, deployment)
  and version
- a description of the issue and its impact
- steps to reproduce it, ideally against a local development instance
- any suggested fix, if you have one

Never include real credentials, session cookies, browser-agent tokens, or data from
an actual literature review in a report.

## What to expect

- You will get an acknowledgement within 7 days.
- We will keep you informed while we investigate and work on a fix.
- Once a fix is released, we will publish a security advisory and credit you,
  unless you prefer to stay anonymous.

## Scope

In scope: the Papertrail backend, web app, background workers, Browser Helper
extension, and the Docker deployment files in this repository.

Out of scope: vulnerabilities in a publisher's website, in Ollama or other
third-party software (report those upstream), and problems that require an
attacker to already have administrator access to the server.
