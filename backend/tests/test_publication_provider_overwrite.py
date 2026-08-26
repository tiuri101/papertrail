"""overwrite_values_from_providers is the one path in the app that lets a
metadata provider clobber an already-set field outright, no MetadataConflict
involved -- see app.publications.service for why that's safe only for the
browser extension's create-while-capturing flow and nowhere else.
"""

from __future__ import annotations

from app.integrations.metadata import LookupOutcome, MetadataLookup
from app.publications.service import overwrite_values_from_providers


class StubProvider:
    def __init__(self, name: str, result: MetadataLookup) -> None:
        self.name = name
        self.result = result
        self.calls = 0

    def lookup_doi(self, doi: str) -> MetadataLookup:
        self.calls += 1
        return self.result


def use_providers(monkeypatch, *providers: StubProvider) -> None:
    monkeypatch.setattr(
        "app.publications.service.metadata_providers", lambda: list(providers)
    )


FOUND = MetadataLookup(
    LookupOutcome.FOUND,
    data={
        "title": "Authoritative Title",
        "authors": "Doe, Jane",
        "publication_year": 2024,
        "venue": "Journal of Tests",
        "doi": "10.1/exact",
        "abstract": "An authoritative abstract.",
    },
)
NOT_FOUND = MetadataLookup(LookupOutcome.NOT_FOUND, error="HTTP 404")
FAILED = MetadataLookup(LookupOutcome.TRANSIENT_FAILURE, error="Request timed out")


def test_overwrites_every_returned_field_even_when_already_set(monkeypatch) -> None:
    use_providers(monkeypatch, StubProvider("crossref", FOUND))
    values = {"title": "Typed Title", "doi": "10.1/exact", "authors": "Someone Else"}

    result = overwrite_values_from_providers(values)

    assert result["title"] == "Authoritative Title"
    assert result["authors"] == "Doe, Jane"
    assert result["publication_year"] == 2024
    assert result["venue"] == "Journal of Tests"
    assert result["abstract"] == "An authoritative abstract."


def test_leaves_values_unchanged_without_a_doi(monkeypatch) -> None:
    provider = StubProvider("crossref", FOUND)
    use_providers(monkeypatch, provider)
    values = {"title": "Typed Title"}

    result = overwrite_values_from_providers(values)

    assert result == values
    assert provider.calls == 0


def test_leaves_values_unchanged_when_no_provider_has_a_record(monkeypatch) -> None:
    use_providers(
        monkeypatch,
        StubProvider("crossref", NOT_FOUND),
        StubProvider("semantic_scholar", NOT_FOUND),
    )
    values = {"title": "Typed Title", "doi": "10.1/unknown"}

    result = overwrite_values_from_providers(values)

    assert result == values


def test_a_lookup_failure_never_blocks_creation(monkeypatch) -> None:
    use_providers(
        monkeypatch,
        StubProvider("crossref", FAILED),
        StubProvider("semantic_scholar", NOT_FOUND),
    )
    values = {"title": "Typed Title", "doi": "10.1/unreachable"}

    result = overwrite_values_from_providers(values)

    assert result == values


def test_falls_through_to_the_next_provider(monkeypatch) -> None:
    use_providers(
        monkeypatch, StubProvider("crossref", FAILED), StubProvider("semantic_scholar", FOUND)
    )
    values = {"title": "Typed Title", "doi": "10.1/exact"}

    result = overwrite_values_from_providers(values)

    assert result["title"] == "Authoritative Title"


def test_does_not_mutate_the_original_dict(monkeypatch) -> None:
    use_providers(monkeypatch, StubProvider("crossref", FOUND))
    values = {"title": "Typed Title", "doi": "10.1/exact"}

    overwrite_values_from_providers(values)

    assert values["title"] == "Typed Title"
