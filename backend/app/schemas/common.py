from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    email: str
    password: str


class SubmissionCreate(BaseModel):
    title: str | None = Field(default=None, max_length=255)


class WorkflowAction(BaseModel):
    comment: str | None = None


class NotifyCoordinatorAction(BaseModel):
    message: str = Field(..., min_length=1, max_length=2000)


class ReviewAction(BaseModel):
    decision: Literal["APPROVE", "REJECT"]
    comment: str | None = None


class ShareRequest(BaseModel):
    user_id: int = Field(..., ge=1)


class SubmissionPermissionsReplace(BaseModel):
    reader_user_ids: list[int] = []
    editor_user_ids: list[int] = []


class SubmissionTitlePatch(BaseModel):
    title: str | None = Field(default=None, max_length=255)


class GisaDraftPatch(BaseModel):
    report_date: str | None = None
    district: str | None = None
    county: str | None = None
    route: str | None = None
    post_mile: str | None = None
    ea: str | None = None
    project_id: str | None = None
    date_incident_reported: str | None = None
    district_contact: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    distribution_code: str | None = None
    highway_status_code: str | None = None
    lanes_closed_count: int | None = None
    open_highway_traffic_lanes_count: int | None = None
    pavement_ground_cracks: bool | None = None
    crack_length_ft: float | None = None
    crack_horizontal_in: float | None = None
    crack_vertical_in: float | None = None
    crack_depth_in: float | None = None
    settlement_in: float | None = None
    bulge_in: float | None = None
    indented_by_rocks: bool | None = None
    failure_rock_fall: bool | None = None
    failure_topple: bool | None = None
    failure_slide: bool | None = None
    failure_spread: bool | None = None
    failure_flow: bool | None = None
    failure_compound: bool | None = None
    failure_erosion: bool | None = None
    failure_surficial_failure: bool | None = None
    failure_scoured_toe: bool | None = None
    failure_washout: bool | None = None
    distribution_advancing: bool | None = None
    distribution_retrogressive: bool | None = None
    distribution_enlarging: bool | None = None
    distribution_widening: bool | None = None
    distribution_moving: bool | None = None
    distribution_confined: bool | None = None
    material_rock: bool | None = None
    material_soil: bool | None = None
    material_bedding: bool | None = None
    material_joints: bool | None = None
    material_fractures: bool | None = None
    est_soil_pct: float | None = None
    est_clay_pct: float | None = None
    est_silt_pct: float | None = None
    est_sand_pct: float | None = None
    est_gravel_pct: float | None = None
    water_dry: bool | None = None
    water_moist: bool | None = None
    water_wet: bool | None = None
    water_flowing: bool | None = None
    water_seep: bool | None = None
    water_spring: bool | None = None
    vegetation_trees: float | None = None
    vegetation_bushes_shrubs: float | None = None
    vegetation_groundcover: float | None = None
    drainage_clogged_inlet: bool | None = None
    drainage_compromised_drains: bool | None = None
    drainage_surface_runoff: bool | None = None
    drainage_torrent_surge_flood: bool | None = None
    impact_impacted_adj_utilities: bool | None = None
    impact_maybe_adj_utilities: bool | None = None
    impact_adj_utilities: str | None = None
    impact_impacted_adj_properties: bool | None = None
    impact_maybe_adj_properties: bool | None = None
    impact_adj_properties: str | None = None
    impact_impacted_adj_structure: bool | None = None
    impact_maybe_adj_structure: bool | None = None
    impact_adj_structure: str | None = None
    measure_slope_height_ft: float | None = None
    measure_original_slope_deg: float | None = None
    measure_landslide_width_ft: float | None = None
    measure_landslide_length_ft: float | None = None
    measure_main_scarp_height_ft: float | None = None
    measure_landslide_slope_deg: float | None = None
    measure_roadway_length_ft: float | None = None
    measure_roadway_width_ft: float | None = None
    record_of_event_notes: str | None = None
    maintenance_history_notes: str | None = None
    geotechnical_assessment_notes: str | None = None
    recommendations_notes: str | None = None
    sketchpad_notes: str | None = None
    observations_notes: str | None = None
    geometry_json: dict | None = None


class ReplaceIncidentTypes(BaseModel):
    items: list[str]


class ReplaceActions(BaseModel):
    immediate: list[str] = []
    follow_up: list[str] = []


class GeometryUpsert(BaseModel):
    geometry: dict = Field(..., description="GeoJSON geometry object (Polygon/MultiPolygon/etc)")
    srid: int = Field(default=4326, ge=1, le=999999)
    source: str = Field(default="MOBILE_ARCGIS", max_length=64)


class GeometryResponse(BaseModel):
    submission_id: int
    geometry: dict | None
    srid: int | None = 4326
    source: str | None = None


class IncidentCreate(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    incident_type: str | None = Field(default=None, max_length=64)
    description: str | None = None
    first_observed_at: datetime
    first_occurred_at: datetime | None = None
    latitude: float
    longitude: float
    district: str = Field(..., min_length=1, max_length=64)
    county: str = Field(..., min_length=1, max_length=64)
    route: str = Field(..., min_length=1, max_length=64)
    post_mile: str = Field(..., min_length=1, max_length=64)


class IncidentAssignRequest(BaseModel):
    assignee_user_id: int = Field(..., ge=1)


class IncidentResolveRequest(BaseModel):
    comment: str | None = None


class IncidentCoordinatorForwardRequest(BaseModel):
    comment: str | None = None


class IncidentLocationLinkRequest(BaseModel):
    mode: Literal["EXISTING", "CREATE_NEW"]
    location_id: int | None = Field(default=None, ge=1)
    comment: str | None = None


class IncidentRequestRevision(BaseModel):
    comment: str | None = None
    revision_fields: list[str] = []


class IncidentAssignBranchChiefRequest(BaseModel):
    branch_chief_user_id: int = Field(..., ge=1)


class IncidentAssignEngineerRequest(BaseModel):
    engineer_user_id: int = Field(..., ge=1)
