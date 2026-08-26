"""Real-world RIS/BibTeX interoperability.

Each fixture in ``tests/fixtures/import_formats`` is a sanitized export in
the shape one real tool produces -- PubMed, Scopus, Web of Science, EndNote,
Zotero, Google Scholar, and a legacy manager that still writes ``@string``
macros and parenthesized entries. The assertions are written against
``publication_values`` (what actually lands on a ``Publication``) rather than
raw parser output, because that is the only level at which "did this import
work?" is a meaningful question.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from app.imports.adapters import (
    normalize_imported_row,
    parse_bibtex,
    parse_file,
    parse_ris,
)
from app.publications.service import publication_values

FIXTURES = Path(__file__).parent / "fixtures" / "import_formats"


def imported(filename: str) -> list[dict[str, Any]]:
    """Every record of a fixture, normalized exactly as an import would."""
    path = FIXTURES / filename
    return [
        publication_values(normalize_imported_row(row))
        for row in parse_file(path.name, path.read_bytes())
    ]


def test_every_fixture_parses_into_usable_records() -> None:
    for path in sorted(FIXTURES.iterdir()):
        records = imported(path.name)
        assert records, f"{path.name} produced no records"
        for record in records:
            assert record["title"] != "Untitled record", path.name
            assert record["publication_year"], path.name


# --------------------------------------------------------------------------
# RIS
# --------------------------------------------------------------------------


def test_pubmed_ris_keeps_wrapped_abstracts_and_medline_tags() -> None:
    first, second = imported("pubmed.ris")

    # The abstract wraps over four lines; keeping only the tagged first line
    # silently truncated it.
    assert first["abstract"] is not None
    assert first["abstract"].startswith("BACKGROUND: Mobile health")
    assert "Twenty-eight randomised trials" in first["abstract"]
    # So does the title.
    assert first["title"] == (
        "Mobile health interventions for type 2 diabetes: a systematic review"
        " and meta-analysis"
    )
    assert first["authors"] == "Smith, John A; Doe, Jane B"
    # LID carries the DOI with a trailing type marker; PMID- is a
    # four-character MEDLINE tag, not the canonical two-character RIS shape.
    assert first["doi"] == "10.1056/nejmoa2035389"
    assert first["pubmed_id"] == "33712145"
    assert first["issn"] == "1533-4406"
    assert first["venue"] == "The New England journal of medicine"
    assert first["keywords"] == (
        "Diabetes Mellitus, Type 2; Telemedicine; Self-Management"
    )
    assert first["publication_year"] == 2021
    assert first["publication_type"] == "JOUR"

    assert second["title"] == "Short report with no abstract"
    assert second["abstract"] is None
    assert second["publication_year"] == 2019


def test_scopus_ris_reads_conference_venue_isbn_and_wrapped_fields() -> None:
    conference, journal = imported("scopus.ris")

    # T2 is the only venue Scopus writes for a conference paper.
    assert conference["venue"] == (
        "Proceedings of the 2020 CHI Conference on Human Factors in Computing"
        " Systems"
    )
    assert conference["abstract"] is not None
    assert conference["abstract"].endswith("evaluate it with twelve domain experts.")
    # SN is an ISBN here and an ISSN in the journal record; only the value
    # says which.
    assert conference["isbn"] == "9781450367080"
    assert conference["issn"] is None
    assert conference["publisher_url"] == "https://doi.org/10.1145/3313831.3376234"

    assert journal["issn"] == "1077-2626"
    assert journal["isbn"] is None
    assert journal["venue"] == "IEEE Transactions on Visualization and Computer Graphics"
    assert journal["doi"] == "10.1109/tvcg.2019.1234567"


def test_web_of_science_ris_uses_so_for_venue_and_di_for_doi() -> None:
    (record,) = imported("web_of_science.ris")

    assert record["venue"] == "INTERNATIONAL JOURNAL OF HUMAN-COMPUTER STUDIES"
    assert record["doi"] == "10.1016/j.ijhcs.2018.05.002"
    assert record["authors"] == "Nowak, Piotr; O'Brien, Sean"
    assert record["abstract"] is not None
    assert "42 professional responders" in record["abstract"]
    assert record["keywords"] == "spatial interfaces; emergency response"
    # The FN/VR/PT preamble and the trailing EF are not records.
    assert record["title"] == "Evaluating spatial interfaces for emergency response"


def test_endnote_ris_reads_n2_abstracts_a1_authors_and_partial_dates() -> None:
    chapter, report = imported("endnote.ris")

    assert chapter["abstract"] is not None
    assert chapter["abstract"].startswith("This chapter reviews")
    assert chapter["authors"] == "Rossi, Elena; Tanaka, Hiro"
    assert chapter["venue"] == "Handbook of Interaction Design"
    assert chapter["publication_year"] == 2017  # from "2017///"
    assert chapter["isbn"] == "978-3-319-12345-6"

    assert report["authors"] == "World Health Organization"
    assert report["publication_type"] == "RPRT"


def test_zotero_ris_prefers_the_full_journal_name_over_the_abbreviation() -> None:
    (record,) = imported("zotero.ris")

    # T2 (full name) and J2 (abbreviation) are both present; preference, not
    # line order, decides.
    assert record["venue"] == "IEEE Transactions on Visualization and Computer Graphics"
    assert record["authors"] == "Müller, André; García-López, María"
    assert record["publication_year"] == 2020


def test_ris_still_parses_the_minimal_canonical_form() -> None:
    rows = parse_ris(
        b"TY  - JOUR\nTI  - Paper B\nAU  - Doe, Jane\nDO  - 10.1/b\nER  -\n"
    )

    assert rows == [
        {
            "publication_type": "JOUR",
            "title": "Paper B",
            "doi": "10.1/b",
            "authors": "Doe, Jane",
        }
    ]


def test_ris_record_without_a_closing_er_is_not_swallowed_by_the_next_one() -> None:
    rows = parse_ris(
        b"TY  - JOUR\nTI  - First paper\nPY  - 2020\n"
        b"TY  - JOUR\nTI  - Second paper\nPY  - 2021\nER  -\n"
    )

    assert [row["title"] for row in rows] == ["First paper", "Second paper"]


def test_ris_does_not_mistake_a_wrapped_abstract_line_for_a_tag() -> None:
    """A continuation line can begin with letters and a hyphen. Only a
    canonical "XX  - " line, or a tag RIS actually defines, starts a field."""
    rows = parse_ris(
        b"TY  - JOUR\nTI  - Triage study\n"
        b"AB  - We compared two systems.\n"
        b"AI - based triage was faster than manual triage.\n"
        b"XY-not a tag either\n"
        b"ER  -\n"
    )

    (row,) = rows
    assert row["abstract"] == (
        "We compared two systems. AI - based triage was faster than manual"
        " triage. XY-not a tag either"
    )


# --------------------------------------------------------------------------
# BibTeX
# --------------------------------------------------------------------------


def test_zotero_bibtex_handles_nesting_accents_and_corporate_authors() -> None:
    journal, conference, report, preprint = imported("zotero.bib")

    assert journal["title"] == "Immersive analytics for urban energy systems"
    assert journal["authors"] == "Müller, André; García-López, María"
    assert journal["abstract"] is not None
    assert journal["abstract"].endswith("linked 2-D statistical views.")
    assert journal["issn"] == "1077-2626"
    assert journal["venue"] == (
        "IEEE Transactions on Visualization and Computer Graphics"
    )
    assert journal["publication_year"] == 2020

    # Two levels of capitalization-protecting braces inside one value used to
    # defeat the field regex outright, leaving the raw braces in the title.
    assert conference["title"] == "A survey of visual analytics in COVID-19 research"
    assert conference["venue"] == (
        "Proceedings of the 2019 CHI Conference on Human Factors in Computing"
        " Systems"
    )
    assert conference["authors"] == "Chen, Wei; Nowak, Piotr"

    # A braced name containing "and" is one author, not two.
    assert report["authors"] == "World Health Organization and Partners"

    assert preprint["arxiv_id"] == "1601.01234"


def test_google_scholar_bibtex_normalizes_author_lists() -> None:
    article, conference, book = imported("google_scholar.bib")

    assert article["authors"] == "Smith, John A; Doe, Jane B; O'Brien, Seán"
    assert article["venue"] == "New England Journal of Medicine"
    assert article["publication_year"] == 2021
    assert conference["venue"] == "Proc. of the ACM Conference on Human Factors"
    assert book["isbn"] == "978-3-319-12345-6"
    assert book["publication_type"] == "book"


def test_legacy_bibtex_resolves_macros_and_parenthesized_entries() -> None:
    macro_entry, paren_entry = imported("legacy_macros.bib")

    # @string macro, resolved; @preamble and @comment are not records.
    assert macro_entry["venue"] == (
        "IEEE Transactions on Visualization and Computer Graphics"
    )
    assert macro_entry["title"] == "Designing for uncertainty in ACM venues"
    assert macro_entry["authors"] == "Rossi, Elena; Tanaka, Hiro"
    assert macro_entry["publication_year"] == 2017
    assert macro_entry["doi"] == "10.1109/tvcg.2017.7654321"

    # @ARTICLE( ... ) -- a parenthesized entry whose value contains a ")".
    assert paren_entry["title"] == (
        "Robust estimation for sensor networks (with a closing paren)"
    )
    assert paren_entry["venue"] == "Sensors"
    assert paren_entry["doi"] == "10.3390/s16010001"


def test_bibtex_concatenation_is_joined_rather_than_dropped() -> None:
    (record,) = parse_bibtex(
        b'@string{acm = "ACM"}\n'
        b'@book{k, title = "The " # acm # " Way", year = 1999}\n'
    )

    assert record["title"] == "The ACM Way"
    assert record["year"] == "1999"


def test_bibtex_still_parses_the_minimal_canonical_form() -> None:
    rows = parse_bibtex(
        b"@article{doe2026, title={Paper C}, author={Doe, Jane}, year={2026}}"
    )

    assert rows[0]["title"] == "Paper C"
    assert rows[0]["authors"] == "Doe, Jane"
    assert rows[0]["source_key"] == "doe2026"
    assert rows[0]["publication_type"] == "article"


def test_unsupported_extension_is_still_rejected() -> None:
    with pytest.raises(ValueError):
        parse_file("references.nbib", b"PMID- 1\n")
