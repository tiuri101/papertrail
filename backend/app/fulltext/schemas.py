from pydantic import BaseModel, ConfigDict, Field


class ApiModel(BaseModel):
    model_config = ConfigDict(
        from_attributes=True, populate_by_name=True, use_enum_values=True
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
