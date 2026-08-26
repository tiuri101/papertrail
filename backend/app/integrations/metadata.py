from __future__ import annotations

import enum
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

import httpx


class LookupOutcome(enum.StrEnum):
    """What a single metadata provider call actually told us.

    "The provider has no record for this DOI" and "the provider could not be
    reached" are entirely different facts: the first is a final answer and the
    second is no answer at all. Collapsing them (the old broad
    ``except Exception: continue``) made an enrichment job report success with
    no enrichment whenever Crossref happened to be down, and lost the retry
    that would have fixed it.
    """

    FOUND = "found"
    #: The provider answered and has no record for this identifier.
    NOT_FOUND = "not_found"
    #: Timeout, DNS/connection error, 429, or 5xx -- retrying may succeed.
    TRANSIENT_FAILURE = "transient_failure"
    #: A 4xx we caused, or an unreadable response -- retrying will not help.
    PERMANENT_FAILURE = "permanent_failure"


@dataclass(frozen=True)
class MetadataLookup:
    outcome: LookupOutcome
    data: dict[str, Any] | None = None
    error: str | None = None

    @property
    def is_transient_failure(self) -> bool:
        return self.outcome is LookupOutcome.TRANSIENT_FAILURE

    @property
    def is_failure(self) -> bool:
        return self.outcome in {
            LookupOutcome.TRANSIENT_FAILURE,
            LookupOutcome.PERMANENT_FAILURE,
        }


class MetadataProvider(Protocol):
    name: str

    def lookup_doi(self, doi: str) -> MetadataLookup:
        ...


def _classify_status(status_code: int) -> MetadataLookup:
    if status_code == 404:
        return MetadataLookup(LookupOutcome.NOT_FOUND, error=f"HTTP {status_code}")
    if status_code == 429 or status_code >= 500:
        return MetadataLookup(
            LookupOutcome.TRANSIENT_FAILURE, error=f"HTTP {status_code}"
        )
    return MetadataLookup(LookupOutcome.PERMANENT_FAILURE, error=f"HTTP {status_code}")


def classified_lookup(call: Callable[[], dict[str, Any] | None]) -> MetadataLookup:
    """Run one provider request and classify its outcome.

    Only the exception types a provider call can actually produce are caught,
    so a genuine bug in the mapping code still surfaces as a job failure
    instead of being silently reported as "this provider has no record".
    """
    try:
        data = call()
    except httpx.HTTPStatusError as exc:
        return _classify_status(exc.response.status_code)
    except httpx.TimeoutException as exc:
        return MetadataLookup(
            LookupOutcome.TRANSIENT_FAILURE, error=f"Request timed out: {exc}"
        )
    except httpx.TransportError as exc:
        # Connection refused, DNS failure, TLS error, read error, ...
        return MetadataLookup(
            LookupOutcome.TRANSIENT_FAILURE,
            error=f"{type(exc).__name__}: {exc}",
        )
    except (ValueError, KeyError, TypeError) as exc:
        # Malformed JSON or a payload shaped differently than documented.
        return MetadataLookup(
            LookupOutcome.PERMANENT_FAILURE,
            error=f"Unreadable provider response: {exc}",
        )
    if not data:
        return MetadataLookup(LookupOutcome.NOT_FOUND, error="Empty provider response")
    return MetadataLookup(LookupOutcome.FOUND, data=data)


class CrossrefClient:
    base_url = "https://api.crossref.org"
    name = "crossref"

    def __init__(self, timeout: float = 15.0) -> None:
        self.timeout = timeout

    def lookup_doi(self, doi: str) -> MetadataLookup:
        def request() -> dict[str, Any]:
            with httpx.Client(
                timeout=self.timeout,
                headers={"User-Agent": "Papertrail/0.1 (mailto:admin@example.invalid)"},
            ) as client:
                response = client.get(f"{self.base_url}/works/{doi}")
                response.raise_for_status()
                item = response.json()["message"]
            return self._map(item)

        return classified_lookup(request)

    def search(self, title: str, authors: str | None = None) -> list[dict[str, Any]]:
        query = title if not authors else f"{title} {authors}"
        with httpx.Client(timeout=self.timeout) as client:
            response = client.get(
                f"{self.base_url}/works",
                params={"query.bibliographic": query, "rows": 5},
            )
            response.raise_for_status()
            return [self._map(item) for item in response.json()["message"]["items"]]

    @staticmethod
    def _map(item: dict[str, Any]) -> dict[str, Any]:
        authors = (
            "; ".join(
                " ".join(filter(None, [a.get("given"), a.get("family")]))
                for a in item.get("author", [])
            )
            or None
        )
        year = None
        parts = (item.get("published-print") or item.get("published-online") or {}).get(
            "date-parts", []
        )
        if parts and parts[0]:
            year = parts[0][0]
        return {
            "title": (item.get("title") or [None])[0],
            "authors": authors,
            "abstract": item.get("abstract"),
            "publication_year": year,
            "venue": (item.get("container-title") or [None])[0],
            "doi": item.get("DOI"),
            "publisher_url": item.get("URL"),
            "publication_type": item.get("type"),
        }


class SemanticScholarClient:
    base_url = "https://api.semanticscholar.org/graph/v1"
    fields = "title,authors,abstract,year,venue,externalIds,url,publicationTypes"
    name = "semantic_scholar"

    def __init__(self, api_key: str | None = None, timeout: float = 15.0) -> None:
        self.api_key = api_key
        self.timeout = timeout

    def lookup_doi(self, doi: str) -> MetadataLookup:
        def request() -> dict[str, Any]:
            headers = {"x-api-key": self.api_key} if self.api_key else {}
            with httpx.Client(timeout=self.timeout, headers=headers) as client:
                response = client.get(
                    f"{self.base_url}/paper/DOI:{doi}", params={"fields": self.fields}
                )
                response.raise_for_status()
                body = response.json()
            return self._map(body) if body else {}

        return classified_lookup(request)

    def search(self, title: str, authors: str | None = None) -> list[dict[str, Any]]:
        headers = {"x-api-key": self.api_key} if self.api_key else {}
        with httpx.Client(timeout=self.timeout, headers=headers) as client:
            response = client.get(
                f"{self.base_url}/paper/search",
                params={"query": title, "limit": 5, "fields": self.fields},
            )
            response.raise_for_status()
            return [self._map(item) for item in response.json().get("data", [])]

    @staticmethod
    def _map(item: dict[str, Any]) -> dict[str, Any]:
        ids = item.get("externalIds") or {}
        return {
            "title": item.get("title"),
            "authors": "; ".join(a.get("name", "") for a in item.get("authors", []))
            or None,
            "abstract": item.get("abstract"),
            "publication_year": item.get("year"),
            "venue": item.get("venue"),
            "doi": ids.get("DOI"),
            "publisher_url": item.get("url"),
            "publication_type": "; ".join(item.get("publicationTypes") or []) or None,
        }
