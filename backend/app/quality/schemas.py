from pydantic import BaseModel, ConfigDict, Field
class ApiModel(BaseModel): model_config=ConfigDict(from_attributes=True,populate_by_name=True)
class QualityConfigUpdate(ApiModel): enabled:bool; mode:str="both"; aggregation:str="sum"
class QualitySubmit(ApiModel): answers:dict
class QualityItemResponse(ApiModel): id:str; publication_id:str=Field(serialization_alias="publicationId"); status:str; draft:dict
class QualityResponseModel(ApiModel): id:str; answers:dict; total_score:float|None=Field(serialization_alias="totalScore"); version:int
