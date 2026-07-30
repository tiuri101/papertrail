from pydantic import BaseModel, ConfigDict, Field
class ApiModel(BaseModel): model_config=ConfigDict(from_attributes=True,populate_by_name=True)
class ExtractionSubmit(ApiModel): answers: dict
class ExtractionItemResponse(ApiModel):
    id:str; publication_id:str=Field(serialization_alias="publicationId"); assigned_reviewer_id:str=Field(serialization_alias="assignedReviewerId"); status:str; draft:dict
class ExtractionResponseModel(ApiModel):
    id:str; answers:dict; version:int; form_version_id:str=Field(serialization_alias="formVersionId")
