# GISA Data Dictionary (ERIS)

## To Preview Dictionary in VS Code press `Ctrl+Shift+V`

## Scope
This document lists the GISA tables and fields used in ERIS:
- `submission_gisa` (1:1 with `submissions`)
- `submission_gisa_incident_types` (repeatable incident type codes)
- `submission_gisa_actions` (repeatable immediate/follow-up action codes)

Use this as a handoff reference for integration work.

## Modeling Notes
- `submission_gisa.submission_id` is both the PK of `submission_gisa` and an FK to `submissions.id`.
- Many checklist fields are stored as `TINYINT` booleans (`0 = No`, `1 = Yes`).
- Repeatable code-list values are stored in child tables:
  - `submission_gisa_incident_types`
  - `submission_gisa_actions`
- Percent fields are constrained to `0..100` individually.
- `geometry_json` is optional and may store GeoJSON or ArcGIS JSON (shape/type not DB-enforced in current draft).

## Table: `submission_gisa`

### Keys and audit
| Field | Type | Required | Notes |
|---|---|---:|---|
| `submission_id` | `BIGINT` | Yes | PK, FK -> `submissions.id` |
| `updated_by_user_id` | `BIGINT` | No | FK -> `users.id` |
| `created_at` | `DATETIME` | Yes | default current timestamp |
| `updated_at` | `DATETIME` | Yes | auto-updated timestamp |

### Section A: Header / Administrative context
| Field | Type | Required | Notes |
|---|---|---:|---|
| `report_date` | `DATE` | No | |
| `district` | `VARCHAR(64)` | No | captured code/value |
| `county` | `VARCHAR(64)` | No | captured code/value |
| `route` | `VARCHAR(64)` | No | captured code/value |
| `post_mile` | `VARCHAR(64)` | No | captured value |
| `ea` | `VARCHAR(16)` | No | |
| `project_id` | `VARCHAR(32)` | No | |
| `date_incident_reported` | `DATE` | No | |
| `district_contact` | `TEXT` | No | |

### Section B: Geospatial location
| Field | Type | Required | Notes |
|---|---|---:|---|
| `latitude` | `DECIMAL(10,7)` | No | constrained `-90..90` |
| `longitude` | `DECIMAL(10,7)` | No | constrained `-180..180` |

### Section C: Classification / operations status
| Field | Type | Required | Notes |
|---|---|---:|---|
| `distribution_code` | `VARCHAR(64)` | No | domain/app code |
| `highway_status_code` | `VARCHAR(64)` | No | domain/app code |
| `lanes_closed_count` | `INT` | No | constrained `>= 0` |
| `open_highway_traffic_lanes_count` | `INT` | No | constrained `>= 0` |

### Section D: Pavement / ground condition
| Field | Type | Required | Notes |
|---|---|---:|---|
| `pavement_ground_cracks` | `TINYINT` | Yes | boolean 0/1 |
| `crack_length_ft` | `DECIMAL(10,2)` | No | |
| `crack_horizontal_in` | `DECIMAL(10,2)` | No | |
| `crack_vertical_in` | `DECIMAL(10,2)` | No | |
| `crack_depth_in` | `DECIMAL(10,2)` | No | |
| `settlement_in` | `DECIMAL(10,2)` | No | |
| `bulge_in` | `DECIMAL(10,2)` | No | |
| `indented_by_rocks` | `TINYINT` | Yes | boolean 0/1 |

### Section E: Failure / incident type flags
| Field | Type | Required | Notes |
|---|---|---:|---|
| `failure_rock_fall` | `TINYINT` | Yes | boolean 0/1 |
| `failure_topple` | `TINYINT` | Yes | boolean 0/1 |
| `failure_slide` | `TINYINT` | Yes | boolean 0/1 |
| `failure_spread` | `TINYINT` | Yes | boolean 0/1 |
| `failure_flow` | `TINYINT` | Yes | boolean 0/1 |
| `failure_compound` | `TINYINT` | Yes | boolean 0/1 |
| `failure_erosion` | `TINYINT` | Yes | boolean 0/1 |
| `failure_surficial_failure` | `TINYINT` | Yes | boolean 0/1 |
| `failure_scoured_toe` | `TINYINT` | Yes | boolean 0/1 |
| `failure_washout` | `TINYINT` | Yes | boolean 0/1 |

### Section F: Distribution movement flags
| Field | Type | Required | Notes |
|---|---|---:|---|
| `distribution_advancing` | `TINYINT` | Yes | boolean 0/1 |
| `distribution_retrogressive` | `TINYINT` | Yes | boolean 0/1 |
| `distribution_enlarging` | `TINYINT` | Yes | boolean 0/1 |
| `distribution_widening` | `TINYINT` | Yes | boolean 0/1 |
| `distribution_moving` | `TINYINT` | Yes | boolean 0/1 |
| `distribution_confined` | `TINYINT` | Yes | boolean 0/1 |

### Section G: Material flags
| Field | Type | Required | Notes |
|---|---|---:|---|
| `material_rock` | `TINYINT` | Yes | boolean 0/1 |
| `material_soil` | `TINYINT` | Yes | boolean 0/1 |
| `material_bedding` | `TINYINT` | Yes | boolean 0/1 |
| `material_joints` | `TINYINT` | Yes | boolean 0/1 |
| `material_fractures` | `TINYINT` | Yes | boolean 0/1 |

### Section H: Material composition percentages
| Field | Type | Required | Notes |
|---|---|---:|---|
| `est_soil_pct` | `DECIMAL(5,2)` | No | constrained `0..100` |
| `est_clay_pct` | `DECIMAL(5,2)` | No | constrained `0..100` |
| `est_silt_pct` | `DECIMAL(5,2)` | No | constrained `0..100` |
| `est_sand_pct` | `DECIMAL(5,2)` | No | constrained `0..100` |
| `est_gravel_pct` | `DECIMAL(5,2)` | No | constrained `0..100` |

### Section I: Water content/state flags
| Field | Type | Required | Notes |
|---|---|---:|---|
| `water_dry` | `TINYINT` | Yes | boolean 0/1 |
| `water_moist` | `TINYINT` | Yes | boolean 0/1 |
| `water_wet` | `TINYINT` | Yes | boolean 0/1 |
| `water_flowing` | `TINYINT` | Yes | boolean 0/1 |
| `water_seep` | `TINYINT` | Yes | boolean 0/1 |
| `water_spring` | `TINYINT` | Yes | boolean 0/1 |

### Section J: Vegetation coverage percentages
| Field | Type | Required | Notes |
|---|---|---:|---|
| `vegetation_trees` | `DECIMAL(5,2)` | No | constrained `0..100` |
| `vegetation_bushes_shrubs` | `DECIMAL(5,2)` | No | constrained `0..100` |
| `vegetation_groundcover` | `DECIMAL(5,2)` | No | constrained `0..100` |

### Section K: Drainage condition flags
| Field | Type | Required | Notes |
|---|---|---:|---|
| `drainage_clogged_inlet` | `TINYINT` | Yes | boolean 0/1 |
| `drainage_compromised_drains` | `TINYINT` | Yes | boolean 0/1 |
| `drainage_surface_runoff` | `TINYINT` | Yes | boolean 0/1 |
| `drainage_torrent_surge_flood` | `TINYINT` | Yes | boolean 0/1 |

### Section L: Adjacent impact flags + notes
| Field | Type | Required | Notes |
|---|---|---:|---|
| `impact_impacted_adj_utilities` | `TINYINT` | Yes | boolean 0/1 |
| `impact_maybe_adj_utilities` | `TINYINT` | Yes | boolean 0/1 |
| `impact_adj_utilities` | `VARCHAR(255)` | No | free text notes |
| `impact_impacted_adj_properties` | `TINYINT` | Yes | boolean 0/1 |
| `impact_maybe_adj_properties` | `TINYINT` | Yes | boolean 0/1 |
| `impact_adj_properties` | `VARCHAR(255)` | No | free text notes |
| `impact_impacted_adj_structure` | `TINYINT` | Yes | boolean 0/1 |
| `impact_maybe_adj_structure` | `TINYINT` | Yes | boolean 0/1 |
| `impact_adj_structure` | `VARCHAR(255)` | No | free text notes |

### Section M: Field measurements
| Field | Type | Required | Notes |
|---|---|---:|---|
| `measure_slope_height_ft` | `DECIMAL(10,2)` | No | |
| `measure_original_slope_deg` | `DECIMAL(10,2)` | No | |
| `measure_landslide_width_ft` | `DECIMAL(10,2)` | No | |
| `measure_landslide_length_ft` | `DECIMAL(10,2)` | No | |
| `measure_main_scarp_height_ft` | `DECIMAL(10,2)` | No | |
| `measure_landslide_slope_deg` | `DECIMAL(10,2)` | No | |
| `measure_roadway_length_ft` | `DECIMAL(10,2)` | No | |
| `measure_roadway_width_ft` | `DECIMAL(10,2)` | No | |

### Section N: Narrative notes
| Field | Type | Required | Notes |
|---|---|---:|---|
| `record_of_event_notes` | `TEXT` | No | |
| `maintenance_history_notes` | `TEXT` | No | |
| `geotechnical_assessment_notes` | `TEXT` | No | |
| `recommendations_notes` | `TEXT` | No | |
| `sketchpad_notes` | `TEXT` | No | |

### Section O: Additional data
| Field | Type | Required | Notes |
|---|---|---:|---|
| `observations_notes` | `TEXT` | No | |
| `geometry_json` | `JSON` | No | optional geometry payload |

## Table: `submission_gisa_incident_types`
| Field | Type | Required | Notes |
|---|---|---:|---|
| `submission_id` | `BIGINT` | Yes | FK -> `submissions.id` |
| `incident_type_code` | `VARCHAR(64)` | Yes | one selected code |
| `created_at` | `DATETIME` | Yes | default current timestamp |

Key/constraints:
- Primary Key: (`submission_id`, `incident_type_code`)

## Table: `submission_gisa_actions`
| Field | Type | Required | Notes |
|---|---|---:|---|
| `submission_id` | `BIGINT` | Yes | FK -> `submissions.id` |
| `action_group` | `VARCHAR(16)` | Yes | `IMMEDIATE` or `FOLLOW_UP` |
| `action_code` | `VARCHAR(64)` | Yes | selected action code |
| `created_at` | `DATETIME` | Yes | default current timestamp |

Key/constraints:
- Primary Key: (`submission_id`, `action_group`, `action_code`)
- Check: `action_group IN ('IMMEDIATE', 'FOLLOW_UP')`

## Integration mapping guidance (Survey123)
- Map each boolean `TINYINT` field as a yes/no question.
- Map `%` fields as decimal numbers with `[0,100]` validation.
- Map `submission_gisa_incident_types` and `submission_gisa_actions` as repeats (or related records from multi-selects).
- If geometry is captured, map `geometry_json` to the ArcGIS/GeoJSON shape expected by your ETL layer.
