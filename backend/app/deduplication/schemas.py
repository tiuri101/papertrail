from datetime import datetime
from typing import Literal

from pydantic import Field

from app.api.schemas import ApiModel


class UrlCheckOut(ApiModel):
    kind: str
    url: str
    reachable: bool | None
    status_code: int | None = Field(serialization_alias="statusCode")
    checked_at: datetime = Field(serialization_alias="checkedAt")


class CandidatePublication(ApiModel):
    id: str
    title: str
    authors: str | None
    publication_year: int | None = Field(serialization_alias="publicationYear")
    venue: str | None
    doi: str | None
    publisher_url: str | None = Field(serialization_alias="publisherUrl")
    #: publisher_url + DOI-URL reachability, written by the
    #: ``assess_duplicate_candidates`` job; empty until it has run.
    url_checks: list[UrlCheckOut] = Field(
        default_factory=list, serialization_alias="urlChecks"
    )


class CandidateResponse(ApiModel):
    id: str
    publication_a_id: str = Field(serialization_alias="publicationAId")
    publication_b_id: str = Field(serialization_alias="publicationBId")
    publication_a: CandidatePublication = Field(serialization_alias="publicationA")
    publication_b: CandidatePublication = Field(serialization_alias="publicationB")
    match_reasons: list[str] = Field(serialization_alias="matchReasons")
    title_similarity: float | None = Field(serialization_alias="titleSimilarity")
    author_similarity: float | None = Field(serialization_alias="authorSimilarity")
    year_agreement: bool | None = Field(serialization_alias="yearAgreement")
    confidence: float
    status: str
    auto_resolved: bool = Field(serialization_alias="autoResolved")
    resolved_by_id: str | None = Field(
        default=None, serialization_alias="resolvedById"
    )
    resolved_by_name: str | None = Field(
        default=None, serialization_alias="resolvedByName"
    )
    resolved_at: datetime | None = Field(
        default=None, serialization_alias="resolvedAt"
    )
    resolution_note: str | None = Field(
        default=None, serialization_alias="resolutionNote"
    )
    # Non-binding external-provider assist for an unresolved pair (see
    # DuplicateCandidate.provider_recommendation). "merge" points at
    # providerRecommendedCanonicalId; "distinct"/"uncertain" do not.
    provider_recommendation: str | None = Field(
        default=None, serialization_alias="providerRecommendation"
    )
    provider_recommended_canonical_id: str | None = Field(
        default=None, serialization_alias="providerRecommendedCanonicalId"
    )
    provider_recommendation_reason: str | None = Field(
        default=None, serialization_alias="providerRecommendationReason"
    )
    provider_recommendation_source: str | None = Field(
        default=None, serialization_alias="providerRecommendationSource"
    )
    # For a currently-merged candidate: which record was kept, and the active
    # (non-reversed) PublicationMerge that a revision would undo.
    canonical_publication_id: str | None = Field(
        default=None, serialization_alias="canonicalPublicationId"
    )
    merge_id: str | None = Field(default=None, serialization_alias="mergeId")
    reserved_until: datetime | None = Field(
        default=None, serialization_alias="reservedUntil"
    )
    reserved_by_id: str | None = Field(
        default=None, serialization_alias="reservedById"
    )


class MergeRequest(ApiModel):
    canonical_publication_id: str = Field(alias="canonicalPublicationId")


class ResolutionNote(ApiModel):
    note: str | None = None


class ReviseRequest(ApiModel):
    """Change an already-resolved candidate to a different outcome. Only
    permitted while the project is still in duplicate review."""

    resolution: Literal["merge", "not_duplicate"]
    canonical_publication_id: str | None = Field(
        default=None, alias="canonicalPublicationId"
    )
    note: str | None = None


class DuplicateProgress(ApiModel):
    remaining: int
    resolved: int
    total: int
