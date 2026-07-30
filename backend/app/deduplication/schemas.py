from pydantic import BaseModel, ConfigDict, Field

class ApiModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

class CandidateResponse(ApiModel):
    id: str
    publication_a_id: str = Field(serialization_alias="publicationAId")
    publication_b_id: str = Field(serialization_alias="publicationBId")
    match_reasons: list[str] = Field(serialization_alias="matchReasons")
    title_similarity: float | None = Field(serialization_alias="titleSimilarity")
    author_similarity: float | None = Field(serialization_alias="authorSimilarity")
    year_agreement: bool | None = Field(serialization_alias="yearAgreement")
    confidence: float
    status: str

class MergeRequest(ApiModel):
    canonical_publication_id: str = Field(alias="canonicalPublicationId")

class ResolutionNote(ApiModel):
    note: str | None = None
