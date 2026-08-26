"""The single definition of what counts as an acceptable Papertrail password.

Every path that *sets* a password -- administrator-created accounts, the
self-service password change, the emailed forgot-password reset, and the
``papertrail create-admin`` bootstrap -- validates through here, so the
requirement cannot drift between them. Deliberately passphrase-friendly:
a long minimum with no mandatory character classes, because forced
composition rules push people towards short, predictable passwords.
"""

from __future__ import annotations

from app.api.errors import DomainError

MIN_PASSWORD_LENGTH = 12
# Argon2 hashes the whole input; an unbounded field is a cheap way to make the
# server burn CPU, so cap it well above any realistic passphrase.
MAX_PASSWORD_LENGTH = 256

PASSWORD_REQUIREMENTS_TEXT = (
    f"Use at least {MIN_PASSWORD_LENGTH} characters. A passphrase of a few "
    "unrelated words is easier to remember and harder to guess than a short "
    "password with symbol substitutions."
)

PASSWORD_TOO_SHORT_MESSAGE = (
    f"Password must be at least {MIN_PASSWORD_LENGTH} characters long"
)
PASSWORD_TOO_LONG_MESSAGE = (
    f"Password must be at most {MAX_PASSWORD_LENGTH} characters long"
)


def password_policy_violation(password: str) -> str | None:
    """Return the reason ``password`` is unacceptable, or ``None`` if it is."""
    if len(password) < MIN_PASSWORD_LENGTH:
        return PASSWORD_TOO_SHORT_MESSAGE
    if len(password) > MAX_PASSWORD_LENGTH:
        return PASSWORD_TOO_LONG_MESSAGE
    return None


def validate_password_policy(password: str) -> None:
    """Raise ``DomainError`` unless ``password`` satisfies the policy.

    Never include the candidate password in the error -- the message is
    returned to the client and written to logs by the CLI.
    """
    violation = password_policy_violation(password)
    if violation is not None:
        raise DomainError(violation)
