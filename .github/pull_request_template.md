## Summary

<!-- What does this change and why? Link the issue it resolves.
Example: Replace per-bulk "LLM processing finished" emails with one debounced
digest per project, and let users turn email categories off. Closes #123. -->

## Changes

<!-- The notable changes, one line each.
Example:
- `BackgroundJob.run_after` lets the digest check wait for a quiet period
- `projects.llm_notified_through` keeps digests from reporting work twice
- New "Email Notifications" section in Account Settings
-->

## Screenshots or screen recordings

<!-- Required for UI changes; otherwise delete this section. -->

| Before | After |
| ------ | ----- |
|        |       |

## Database migrations

<!-- Name the new Alembic revision(s), or write "None".
Example: `0015_email_digest_prefs`, validated on a fresh PostgreSQL database. -->

## Testing

<!-- How was this verified?
Example: New tests in `tests/test_llm_digest_email.py`; full backend suite,
frontend `npm run verify`; checked the settings page manually. -->

## Checklist

- [ ] Targets `dev` (only `dev` merges into `main`)
- [ ] A failing test was added before the fix or new domain behavior
- [ ] Backend: `pytest`, `ruff check app tests`, `mypy app` pass
- [ ] Frontend / Browser Helper: typecheck, lint, and tests pass (if touched)
- [ ] Before/after screenshots added for UI changes
- [ ] Schema changes have an inspected Alembic migration
- [ ] Audit events are written in the same transaction as the action they describe
- [ ] No long-running work is started from a request thread
