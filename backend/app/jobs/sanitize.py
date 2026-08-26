"""Separate a background job's member-safe output from its privileged
diagnostics.

A failing worker records the full Python traceback so an administrator can
actually debug it (see ``app.jobs.worker``). That text routinely contains
stack frames, absolute filesystem paths of the deployment, raw exception
reprs, SQL statements with bound parameters, and internal hostnames -- none
of which an ordinary project member has any business reading, and all of
which are useful reconnaissance to an attacker who has obtained a low
privilege account.

The split is therefore made *in the serializer*, not in the UI:

* :func:`public_job_result` is the only way a job's ``result`` reaches an
  ordinary job response. It drops the diagnostic keys entirely, so a
  traceback can never be carried out through a normal job payload even if a
  future handler starts writing one under a familiar name.
* :func:`public_error_message` redacts the message-shaped leaks (paths,
  URLs, SQL, addresses, stack frames) that ``str(exc)`` picks up, while
  keeping the short human-readable part a reviewer needs to understand that
  their import failed.

The unredacted values stay reachable through the manager/administrator
diagnostics endpoint (``GET /jobs/{job_id}/error``), which gates them on
``is_admin`` or project-manager status.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

# Keys a job ``result`` may carry that are diagnostics, never public output.
# Dropped wholesale rather than redacted: there is no safe partial rendering
# of a traceback.
DIAGNOSTIC_RESULT_KEYS = frozenset(
    {
        "errorDetails",
        "error_details",
        "errorTraceback",
        "traceback",
        "stack",
        "stackTrace",
    }
)

# Result keys whose value is free-form text derived from an exception, so it
# gets the same redaction as ``error_message``.
_MESSAGE_RESULT_KEYS = frozenset({"error", "errorMessage", "error_message", "message"})

PUBLIC_ERROR_MESSAGE_MAX_LENGTH = 500
_REDACTED = "[redacted]"

# Order matters: the broadest structural leaks are cut first, then URLs
# (which contain the "//" the POSIX path rule would otherwise match), then
# bare paths and addresses.
_REDACTIONS: tuple[tuple[re.Pattern[str], str], ...] = (
    # A traceback or a bare stack frame that made it into the message text.
    (re.compile(r"Traceback \(most recent call last\):.*", re.DOTALL), _REDACTED),
    (re.compile(r'\s*File "[^"]*", line \d+.*', re.DOTALL), _REDACTED),
    # SQLAlchemy appends the failing statement and its bound parameters.
    (re.compile(r"\[SQL:.*", re.DOTALL), _REDACTED),
    (re.compile(r"\[parameters:.*", re.DOTALL), _REDACTED),
    # Any URL: internal hostnames, ports, and sometimes embedded credentials.
    (re.compile(r"\b[a-z][a-z0-9+.\-]*://\S+", re.IGNORECASE), "[url]"),
    # Windows and POSIX absolute filesystem paths.
    (re.compile(r"\b[A-Za-z]:[\\/][^\s'\"<>|]*"), "[path]"),
    (re.compile(r"(?<![\w.~])/(?:[\w.\-@%+]+/)+[\w.\-@%+]*"), "[path]"),
    # Bare IPv4 addresses (optionally with a port).
    (re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b(?::\d+)?"), "[address]"),
    # A bare internal hostname, with or without a port: either a private-use
    # TLD, or any dotted name carrying an explicit port (a service address,
    # never prose).
    (
        re.compile(
            r"\b[\w-]+(?:\.[\w-]+)*"
            r"\.(?:local|localdomain|localhost|internal|intranet|lan|corp|home|svc)"
            r"\b(?::\d{1,5})?",
            re.IGNORECASE,
        ),
        "[host]",
    ),
    (re.compile(r"\b[\w-]+(?:\.[\w-]+)+:\d{1,5}\b"), "[host]"),
)

_WHITESPACE = re.compile(r"\s+")


def public_error_message(message: str | None) -> str | None:
    """Redact a worker error message down to something safe for any member.

    Keeps the short human-readable part ("Diagnostic failure", "Project not
    found") and replaces the structural leaks around it.
    """
    if not message:
        return message
    redacted = message
    for pattern, replacement in _REDACTIONS:
        redacted = pattern.sub(replacement, redacted)
    redacted = _WHITESPACE.sub(" ", redacted).strip()
    if not redacted or redacted == _REDACTED:
        return "The job failed. Ask a project manager for the diagnostic report."
    return redacted[:PUBLIC_ERROR_MESSAGE_MAX_LENGTH]


def public_job_result(result: Any) -> dict[str, Any] | None:
    """The member-visible view of a job's ``result`` payload.

    Diagnostic keys are removed outright; exception-derived message keys are
    redacted. Everything else (record counts, artifact ids, run ids -- the
    values the UI actually renders) is passed through unchanged.
    """
    if not isinstance(result, Mapping):
        return None
    public: dict[str, Any] = {}
    for key, value in result.items():
        if key in DIAGNOSTIC_RESULT_KEYS:
            continue
        if key in _MESSAGE_RESULT_KEYS and isinstance(value, str):
            public[key] = public_error_message(value)
            continue
        public[key] = value
    return public


def diagnostic_error_details(result: Any) -> str | None:
    """The privileged traceback text, for the manager/admin-only endpoint."""
    if not isinstance(result, Mapping):
        return None
    for key in ("errorDetails", "error_details", "errorTraceback", "traceback"):
        value = result.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def error_type(result: Any) -> str | None:
    """The exception class name -- a safe error *category*, not a repr."""
    if not isinstance(result, Mapping):
        return None
    value = result.get("errorType")
    return value if isinstance(value, str) and value else None
