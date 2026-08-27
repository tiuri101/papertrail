from __future__ import annotations

from dataclasses import dataclass

import httpx

#: Sent on every outbound request Papertrail makes to a third party (metadata
#: providers, bibliographic URL probes). Kept in one place so a deployment that
#: wants to identify itself only has to change it here.
USER_AGENT = "Papertrail/0.1 (mailto:admin@example.invalid)"

#: Some origins reject a bare ``HEAD`` (or answer it misleadingly) but serve a
#: normal ``GET``. When a HEAD comes back with one of these, or fails at the
#: transport layer, ``check_url`` retries once with GET before deciding.
_HEAD_RETRY_STATUSES = frozenset({400, 401, 403, 405, 406, 501})


@dataclass(frozen=True)
class UrlHealth:
    """Outcome of probing a single URL.

    ``reachable`` is ``True``/``False`` once the probe got an HTTP response, and
    ``None`` when it never did (timeout, DNS failure, TLS error, redirect loop)
    -- "we could not tell", which must not be shown as a dead link.
    """

    reachable: bool | None
    status_code: int | None = None
    error: str | None = None


def check_url(url: str, *, timeout: float) -> UrlHealth:
    """Follow redirects and report whether ``url`` resolves to a non-error
    response. Tries ``HEAD`` first (cheap), falling back to ``GET`` when the
    server clearly dislikes HEAD. Never raises: a probe that cannot reach a
    verdict returns ``reachable=None`` with ``error`` set."""
    try:
        with httpx.Client(
            follow_redirects=True,
            timeout=timeout,
            headers={"User-Agent": USER_AGENT},
        ) as client:
            try:
                response = client.head(url)
                if response.status_code in _HEAD_RETRY_STATUSES:
                    response = client.get(url)
            except httpx.TransportError:
                # HEAD hung up / reset -- give GET one chance before giving up.
                response = client.get(url)
    except httpx.TimeoutException as exc:
        return UrlHealth(None, error=f"Request timed out: {exc}")
    except httpx.TransportError as exc:
        return UrlHealth(None, error=f"{type(exc).__name__}: {exc}")
    except httpx.HTTPError as exc:
        # Redirect loop, invalid URL, decoding error -- resolved to no verdict.
        return UrlHealth(None, error=f"{type(exc).__name__}: {exc}")
    return UrlHealth(response.status_code < 400, status_code=response.status_code)
