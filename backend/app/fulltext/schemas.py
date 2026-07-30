from pydantic import BaseModel, ConfigDict, Field

class ApiModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True, use_enum_values=True)

class RetrievalResponse(ApiModel):
    id: str
    publication_id: str = Field(serialization_alias="publicationId")
    status: str
    note: str | None

class RetrievalUpdate(ApiModel):
    status: str
    note: str | None = None
