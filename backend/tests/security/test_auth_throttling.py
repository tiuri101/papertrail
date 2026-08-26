"""Authentication throttling must survive rotation of either coordinate.

Before this, every counter was keyed on the *pair* (account, source address).
That is exactly the bucket an attacker controls both halves of: spread one
account's guesses over a handful of addresses, or hold one address and walk a
list of usernames, and each individual bucket stays comfortably under the
limit. Each attempt is now counted three times -- pair, account, address -- so
either rotation runs into a ceiling.

The tests also pin the two things that must NOT change: unrelated users and
addresses keep independent budgets, and nothing about the responses lets a
caller tell an existing account from an absent one.
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import func, select

from app.accounts.models import LoginThrottle
from app.accounts.service import (
    ACCOUNT_SCOPE_ATTEMPT_MULTIPLIER,
    ADDRESS_SCOPE_ATTEMPT_MULTIPLIER,
    clear_login_failures,
    create_user,
    ensure_login_allowed,
    ensure_password_reset_allowed,
    login_identity_hash,
    prune_expired_throttles,
    record_login_failure,
    record_password_reset_attempt,
)
from app.api.errors import RateLimitError
from app.core.config import get_settings
from app.core.time import utcnow

VICTIM_PASSWORD = "victim-password-value"


@pytest.fixture()
def tight_limits(monkeypatch):
    """A small pair limit keeps the derived account/address limits countable."""
    settings = get_settings()
    monkeypatch.setattr(settings, "login_max_attempts", 2)
    monkeypatch.setattr(settings, "password_reset_max_attempts", 2)
    monkeypatch.setattr(settings, "login_window_seconds", 900)
    monkeypatch.setattr(settings, "login_block_seconds", 900)
    return settings


def _address(index: int) -> str:
    return f"203.0.113.{index}"


def test_one_account_guessed_from_many_addresses_hits_the_account_limit(
    db, tight_limits
) -> None:
    account_limit = tight_limits.login_max_attempts * ACCOUNT_SCOPE_ATTEMPT_MULTIPLIER
    create_user(db, "victim", "Victim", VICTIM_PASSWORD)
    db.commit()

    # One guess per address: every pair bucket stays at a single attempt, so
    # only the account-wide counter can notice this.
    for index in range(account_limit):
        ensure_login_allowed(db, "victim", _address(index))
        record_login_failure(db, "victim", _address(index))
    db.commit()

    with pytest.raises(RateLimitError):
        ensure_login_allowed(db, "victim", _address(account_limit + 50))


def test_one_address_spraying_many_usernames_hits_the_address_limit(
    db, tight_limits
) -> None:
    address_limit = tight_limits.login_max_attempts * ADDRESS_SCOPE_ATTEMPT_MULTIPLIER
    attacker = "198.51.100.7"

    # A different username each time: neither the pair nor the account counter
    # ever reaches two, so only the address-wide counter can notice.
    for index in range(address_limit):
        ensure_login_allowed(db, f"user{index}", attacker)
        record_login_failure(db, f"user{index}", attacker)
    db.commit()

    with pytest.raises(RateLimitError):
        ensure_login_allowed(db, "never-tried-before", attacker)


def test_unrelated_accounts_and_addresses_keep_independent_budgets(
    db, tight_limits
) -> None:
    account_limit = tight_limits.login_max_attempts * ACCOUNT_SCOPE_ATTEMPT_MULTIPLIER
    for index in range(account_limit):
        record_login_failure(db, "victim", _address(index))
    db.commit()
    with pytest.raises(RateLimitError):
        ensure_login_allowed(db, "victim", _address(1))

    # A colleague on one of the same addresses is untouched...
    ensure_login_allowed(db, "colleague", _address(1))
    # ... and so is the victim's own account seen from an address that has not
    # been part of the run, as far as the address-scoped counter is concerned.
    ensure_login_allowed(db, "colleague", "192.0.2.44")


def test_a_successful_login_clears_the_account_but_not_the_address_counter(
    db, tight_limits
) -> None:
    address_limit = tight_limits.login_max_attempts * ADDRESS_SCOPE_ATTEMPT_MULTIPLIER
    attacker = "198.51.100.8"
    for index in range(address_limit):
        record_login_failure(db, f"user{index}", attacker)
    db.commit()

    # Authenticating as one account must not launder away the evidence of a
    # spraying run coming from the same address.
    clear_login_failures(db, "user0", attacker)
    db.commit()
    with pytest.raises(RateLimitError):
        ensure_login_allowed(db, "user0", attacker)

    # The same account from somewhere else is fine again: the pair and account
    # counters really were cleared.
    ensure_login_allowed(db, "user0", "192.0.2.99")


def test_password_reset_requests_are_throttled_across_addresses(
    db, tight_limits
) -> None:
    account_limit = (
        tight_limits.password_reset_max_attempts * ACCOUNT_SCOPE_ATTEMPT_MULTIPLIER
    )
    email = "victim@example.org"
    for index in range(account_limit):
        ensure_password_reset_allowed(db, email, _address(index))
        record_password_reset_attempt(db, email, _address(index))
    db.commit()

    with pytest.raises(RateLimitError):
        ensure_password_reset_allowed(db, email, _address(account_limit + 50))
    # An unrelated address is still allowed to ask about an unrelated address.
    ensure_password_reset_allowed(db, "someone-else@example.org", "192.0.2.5")


def test_password_reset_throttling_does_not_reveal_whether_an_account_exists(
    client, db, tight_limits
) -> None:
    create_user(
        db, "known", "Known", VICTIM_PASSWORD, email="known@example.org"
    )
    db.commit()

    def responses(email: str) -> list[tuple[int, str]]:
        results = []
        for _ in range(tight_limits.password_reset_max_attempts + 1):
            response = client.post(
                "/api/v1/auth/forgot-password", json={"email": email}
            )
            results.append((response.status_code, response.text))
        return results

    known = responses("known@example.org")
    unknown = responses("nobody@example.org")

    # Same sequence of status codes and bodies either way: allowed, allowed,
    # then the identical generic rate-limit response.
    assert [status for status, _ in known] == [status for status, _ in unknown]
    assert [body for _, body in known] == [body for _, body in unknown]
    assert known[-1][0] == 429


def test_failed_logins_stay_generic_for_known_and_unknown_accounts(
    client, db, tight_limits
) -> None:
    create_user(db, "known", "Known", VICTIM_PASSWORD)
    db.commit()

    known = client.post(
        "/api/v1/auth/login", json={"username": "known", "password": "wrong-password"}
    )
    unknown = client.post(
        "/api/v1/auth/login", json={"username": "ghost", "password": "wrong-password"}
    )

    assert known.status_code == unknown.status_code == 401
    assert known.json() == unknown.json()


def test_expired_throttle_rows_are_pruned_but_live_ones_survive(db) -> None:
    settings = get_settings()
    retention = 4 * max(settings.login_window_seconds, settings.login_block_seconds)
    now = utcnow()

    def add(identity: str, age_seconds: int, blocked_in: int | None) -> None:
        db.add(
            LoginThrottle(
                identity_hash=login_identity_hash(identity, "203.0.113.1"),
                attempts=3,
                window_started_at=now - timedelta(seconds=age_seconds),
                blocked_until=(
                    None if blocked_in is None else now + timedelta(seconds=blocked_in)
                ),
            )
        )

    add("ancient", retention + 60, None)
    add("also-ancient", retention * 2, None)
    add("old-but-still-blocked", retention + 60, 300)
    add("recent", 30, None)
    db.commit()
    assert db.scalar(select(func.count()).select_from(LoginThrottle)) == 4

    removed = prune_expired_throttles(db)
    db.commit()

    assert removed == 2
    remaining = set(db.scalars(select(LoginThrottle.identity_hash)))
    assert remaining == {
        login_identity_hash("old-but-still-blocked", "203.0.113.1"),
        login_identity_hash("recent", "203.0.113.1"),
    }


def test_recording_a_failure_prunes_finished_rows(db) -> None:
    """Cleanup has to happen on its own during ordinary auth traffic -- there
    is no scheduled sweep, and an unbounded table is its own denial of service.
    """
    settings = get_settings()
    retention = 4 * max(settings.login_window_seconds, settings.login_block_seconds)
    db.add(
        LoginThrottle(
            identity_hash=login_identity_hash("ancient", "203.0.113.1"),
            attempts=9,
            window_started_at=utcnow() - timedelta(seconds=retention + 60),
            blocked_until=None,
        )
    )
    db.commit()

    record_login_failure(db, "someone", "203.0.113.2")
    db.commit()

    identities = set(db.scalars(select(LoginThrottle.identity_hash)))
    assert login_identity_hash("ancient", "203.0.113.1") not in identities
    assert login_identity_hash("someone", "203.0.113.2") in identities
