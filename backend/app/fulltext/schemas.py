from datetime import datetime

from pydantic import Field

from app.api.schemas import EnumApiModel as ApiModel


class DocumentUserResponse(ApiModel):
    id: str
    display_name: str = Field(serialization_alias="displayName")


class DocumentResponse(ApiModel):
    id: str
    original_filename: str = Field(serialization_alias="originalFilename")
    mime_type: str = Field(serialization_alias="mimeType")
    file_size: int = Field(serialization_alias="fileSize")
    page_count: int | None = Field(default=None, serialization_alias="pageCount")
    sha256: str
    uploaded_at: datetime = Field(serialization_alias="uploadedAt")
    uploaded_by: DocumentUserResponse | None = Field(serialization_alias="uploadedBy")
    is_active: bool = Field(serialization_alias="isActive")
    replaced_by_document_id: str | None = Field(
        serialization_alias="replacedByDocumentId"
    )
    removed_at: datetime | None = Field(serialization_alias="removedAt")
    source: str
    import_batch_id: str | None = Field(serialization_alias="importBatchId")


class FullTextDocumentResponse(ApiModel):
    available: bool
    document: DocumentResponse | None = None
    retrieval_status: str | None = Field(
        default=None, serialization_alias="retrievalStatus"
    )


class RetrievalPublication(ApiModel):
    id: str
    title: str
    authors: str | None
    publication_year: int | None = Field(serialization_alias="publicationYear")
    doi: str | None
    publisher_url: str | None = Field(serialization_alias="publisherUrl")


class RetrievalResponse(ApiModel):
    id: str
    publication_id: str = Field(serialization_alias="publicationId")
    publication: RetrievalPublication
    status: str
    note: str | None
    decision_submitted: bool = Field(
        default=False, serialization_alias="decisionSubmitted"
    )


class RetrievalDecisionSubmit(ApiModel):
    outcome: str
    criteria_answers: dict[str, bool] = Field(alias="criteriaAnswers")
    notes: str | None = None


class RetrievalUpdate(ApiModel):
    status: str
    note: str | None = None
    decision: RetrievalDecisionSubmit | None = None


class RetrievalProgressResponse(ApiModel):
    total: int
    addressed: int
