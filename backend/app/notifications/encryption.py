"""Authenticated encryption for the sensitive half of a queued email payload.

A queued password-reset email has to carry a *usable* reset link until the
worker sends it. Storing that link in the ordinary ``EmailNotification.context``
JSON means a single ``SELECT`` -- a read-only replica, a stray backup, a SQL
injection elsewhere -- hands over a working credential for every outstanding
reset. So the credential-bearing fields are encrypted with a key that lives in
the process environment and never in PostgreSQL: the database rows alone are
not enough to recover a token.

Everything here is AES-256-GCM from ``cryptography``; there is no hand-rolled
crypto, and nothing this module exposes ever returns, raises or logs key
material or plaintext.
"""

from __future__ import annotations

import base64
import json
import os
from collections.abc import Mapping
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.core.config import get_settings

#: Minimum length of the configured secret. The value is stretched with HKDF,
#: not a password KDF, so it must be a high-entropy random string rather than a
#: memorable passphrase -- see ``docs/configuration.md``.
MIN_KEY_LENGTH = 32

_NONCE_BYTES = 12
_HKDF_INFO = b"papertrail-notification-payload-v1"
_ENVELOPE_VERSION = "v1"

_derived_keys: dict[str, bytes] = {}


class NotificationEncryptionError(Exception):
    """A sanitized encryption/decryption failure.

    Instances are surfaced to administrators (job error text, logs), so the
    message must stay free of key material, ciphertext and plaintext.
    """


class NotificationKeyUnavailableError(NotificationEncryptionError):
    """The application encryption key is missing or too weak to use."""


def _configured_key() -> str | None:
    """The configured key, or ``None`` when it is unset or blank."""
    value = get_settings().notification_encryption_key
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def encryption_available() -> bool:
    """Whether sensitive payloads can currently be encrypted at all."""
    key = _configured_key()
    return key is not None and len(key) >= MIN_KEY_LENGTH


def _key_material() -> bytes:
    key = _configured_key()
    if key is None:
        raise NotificationKeyUnavailableError(
            "PAPERTRAIL_NOTIFICATION_ENCRYPTION_KEY is not configured"
        )
    if len(key) < MIN_KEY_LENGTH:
        raise NotificationKeyUnavailableError(
            "PAPERTRAIL_NOTIFICATION_ENCRYPTION_KEY must be at least "
            f"{MIN_KEY_LENGTH} characters long"
        )
    cached = _derived_keys.get(key)
    if cached is None:
        cached = HKDF(
            algorithm=SHA256(),
            length=32,
            salt=None,
            info=_HKDF_INFO,
        ).derive(key.encode("utf-8"))
        _derived_keys[key] = cached
    return cached


def encrypt_payload(payload: Mapping[str, Any], *, associated_data: str) -> str:
    """Encrypt ``payload`` into a self-describing base64 envelope.

    ``associated_data`` is authenticated but not encrypted; passing the record's
    identity (template plus recipient) means a ciphertext cannot be replayed
    into a different notification row.
    """
    key = _key_material()
    nonce = os.urandom(_NONCE_BYTES)
    plaintext = json.dumps(dict(payload), separators=(",", ":")).encode("utf-8")
    ciphertext = AESGCM(key).encrypt(
        nonce, plaintext, associated_data.encode("utf-8")
    )
    envelope = base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii")
    return f"{_ENVELOPE_VERSION}:{envelope}"


def decrypt_payload(envelope: str, *, associated_data: str) -> dict[str, Any]:
    """Reverse :func:`encrypt_payload`.

    Raises :class:`NotificationEncryptionError` -- with a message safe to store
    and log -- for a wrong key, a tampered record, or an unreadable envelope.
    """
    key = _key_material()
    version, separator, encoded = envelope.partition(":")
    if not separator or version != _ENVELOPE_VERSION:
        raise NotificationEncryptionError(
            "Encrypted payload uses an unsupported envelope format"
        )
    try:
        raw = base64.urlsafe_b64decode(encoded.encode("ascii"))
    except (ValueError, UnicodeEncodeError) as exc:
        raise NotificationEncryptionError(
            "Encrypted payload is not valid base64"
        ) from exc
    if len(raw) <= _NONCE_BYTES:
        raise NotificationEncryptionError("Encrypted payload is truncated")
    try:
        plaintext = AESGCM(key).decrypt(
            raw[:_NONCE_BYTES], raw[_NONCE_BYTES:], associated_data.encode("utf-8")
        )
    except Exception:  # cryptography raises InvalidTag for a wrong key
        # `from None`: the underlying exception is chained into worker logs
        # otherwise, and there is nothing diagnostic in it anyway.
        raise NotificationEncryptionError(
            "Encrypted payload could not be decrypted with the configured "
            "PAPERTRAIL_NOTIFICATION_ENCRYPTION_KEY"
        ) from None
    try:
        decoded = json.loads(plaintext)
    except ValueError:
        # `from None` again: never chain an error raised while holding the
        # decrypted plaintext.
        raise NotificationEncryptionError(
            "Decrypted payload is not valid JSON"
        ) from None
    if not isinstance(decoded, dict):
        raise NotificationEncryptionError("Decrypted payload is not an object")
    return decoded
