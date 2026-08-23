import re

from pydantic import Field, field_validator

from app.api.schemas import ApiModel
from app.fulltext.schemas import FullTextDocumentResponse

_URL_SCHEME = re.compile(r"^\s*([a-zA-Z][a-zA-Z0-9+.\-]*):")


class ScreeningStatusResponse(ApiModel):
    title_abstract: str | None = Field(serialization_alias="titleAbstract")
    full_text: str | None = Field(serialization_alias="fullText")


class PublicationResponse(ApiModel):
    id: str
    project_id: str = Field(serialization_alias="projectId")
    title: str
    authors: str | None
    abstract: str | None
    publication_year: int | None = Field(serialization_alias="publicationYear")
    venue: str | None
    publication_type: str | None = Field(serialization_alias="publicationType")
    doi: str | None
    publisher_url: str | None = Field(serialization_alias="publisherUrl")
    keywords: str | None
    isbn: str | None
    issn: str | None
    pubmed_id: str | None = Field(serialization_alias="pubmedId")
    arxiv_id: str | None = Field(serialization_alias="arxivId")
    is_active: bool = Field(serialization_alias="isActive")
    full_text: FullTextDocumentResponse = Field(serialization_alias="fullText")
    screening_status: ScreeningStatusResponse = Field(
        serialization_alias="screeningStatus"
    )
    extraction_status: str | None = Field(serialization_alias="extractionStatus")


class PublicationUpdate(ApiModel):
    title: str | None = None
    authors: str | None = None
    abstract: str | None = None
    publication_year: int | None = Field(default=None, alias="publicationYear")
    venue: str | None = None
    publication_type: str | None = Field(default=None, alias="publicationType")
    doi: str | None = None
    publisher_url: str | None = Field(default=None, alias="publisherUrl")
    keywords: str | None = None
    isbn: str | None = None
    issn: str | None = None
    pubmed_id: str | None = Field(default=None, alias="pubmedId")
    arxiv_id: str | None = Field(default=None, alias="arxivId")

    @field_validator("publisher_url")
    @classmethod
    def validate_publisher_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        match = _URL_SCHEME.match(value)
        if match and match.group(1).lower() not in ("http", "https"):
            raise ValueError("publisherUrl must use http or https")
        return value


class ConflictResponse(ApiModel):
    id: str
    publication_id: str = Field(serialization_alias="publicationId")
    field_name: str = Field(serialization_alias="fieldName")
    current_value: str | None = Field(serialization_alias="currentValue")
    proposed_value: str | None = Field(serialization_alias="proposedValue")
    source_name: str = Field(serialization_alias="sourceName")
    status: str
    publication: PublicationResponse


class ConflictResolve(ApiModel):
    accept_proposed: bool = Field(alias="acceptProposed")


class PublicationCreate(PublicationUpdate):
    title: str


class BulkEnrichmentRequest(ApiModel):
    publication_ids: list[str] | None = Field(default=None, alias="publicationIds")
    missing_only: bool = Field(default=True, alias="missingOnly")


class BulkDeleteRequest(ApiModel):
    publication_ids: list[str] = Field(min_length=1, alias="publicationIds")
