# Database entity-relationship diagrams

> **Generated** by `scripts/docs/generate_schema_docs.py` from a fully migrated database. Do not edit by hand; CI fails when this file is stale. Column-level detail is in the [schema reference](schema-reference.md).

ERIS has **61 tables** in MariaDB. File bytes (photos, PDFs, terrain packages) are in S3 object storage; tables hold only their bucket and key. One diagram per domain follows; a table from another domain appears with its key only, so the links between domains stay visible.

## How the domains connect

```mermaid
flowchart LR
    identity_and_access["Identity and access<br/>8 tables"]
    organization["Organization<br/>9 tables"]
    incidents["Incidents<br/>8 tables"]
    assessments["Assessments<br/>4 tables"]
    submissions_gisa["Submissions (GISA)<br/>11 tables"]
    attachments["Attachments<br/>4 tables"]
    notifications["Notifications<br/>3 tables"]
    maintenance_workflows["Maintenance workflows<br/>3 tables"]
    projects["Projects<br/>1 tables"]
    road_inventory["Road inventory<br/>4 tables"]
    terrain_and_offline_scenes["Terrain and offline scenes<br/>6 tables"]
    assessments -->|7 FK| identity_and_access
    assessments -->|4 FK| incidents
    assessments -->|2 FK| organization
    assessments -->|2 FK| submissions_gisa
    attachments -->|2 FK| identity_and_access
    attachments -->|1 FK| submissions_gisa
    incidents -->|1 FK| attachments
    incidents -->|12 FK| identity_and_access
    incidents -->|2 FK| road_inventory
    incidents -->|1 FK| submissions_gisa
    maintenance_workflows -->|2 FK| incidents
    notifications -->|4 FK| identity_and_access
    notifications -->|1 FK| incidents
    organization -->|5 FK| identity_and_access
    projects -->|1 FK| identity_and_access
    submissions_gisa -->|2 FK| attachments
    submissions_gisa -->|14 FK| identity_and_access
    submissions_gisa -->|1 FK| incidents
    submissions_gisa -->|2 FK| road_inventory
    terrain_and_offline_scenes -->|3 FK| identity_and_access
    terrain_and_offline_scenes -->|1 FK| projects
    terrain_and_offline_scenes -->|2 FK| submissions_gisa
```

An arrow points from the domain holding the foreign key to the domain it references.

## Contents

- [Identity and access](#identity-and-access) (8 tables)
- [Organization](#organization) (9 tables)
- [Incidents](#incidents) (8 tables)
- [Assessments](#assessments) (4 tables)
- [Submissions (GISA)](#submissions-gisa) (11 tables)
- [Attachments](#attachments) (4 tables)
- [Notifications](#notifications) (3 tables)
- [Maintenance workflows](#maintenance-workflows) (3 tables)
- [Projects](#projects) (1 tables)
- [Road inventory](#road-inventory) (4 tables)
- [Terrain and offline scenes](#terrain-and-offline-scenes) (6 tables)

## Identity and access

Accounts, roles, sessions, Entra links, first-admin marker.

```mermaid
erDiagram
    deployment_bootstrap {
        varchar name PK
        datetime completed_at
        bigint user_id
    }
    role_consolidation_audit {
        bigint user_id PK
        varchar old_role PK
        datetime assigned_at
        datetime recorded_at
    }
    roles {
        bigint id PK
        varchar name UK
        varchar description
    }
    user_external_identities {
        bigint id PK
        bigint user_id FK
        varchar provider
        char tenant_id
        char object_id
        varchar user_principal_name
        varchar email_at_link
        datetime linked_at
        bigint linked_by_user_id FK
        datetime last_login_at
    }
    user_roles {
        bigint user_id PK,FK
        bigint role_id PK,FK
        datetime assigned_at
    }
    user_saved_layouts {
        bigint id PK
        bigint user_id FK
        varchar scope
        varchar name
        longtext layout_json
        tinyint is_default
        datetime created_at
        datetime updated_at
    }
    user_sessions {
        bigint id PK
        bigint user_id FK
        char token_hash UK
        varchar client
        varchar auth_method
        datetime created_at
        datetime last_seen_at
        datetime expires_at
        datetime revoked_at
        varchar revoked_reason
        varchar user_agent
        varchar created_ip
    }
    users {
        bigint id PK
        varchar email UK
        varchar full_name
        varchar password_hash
        longtext metadata_json
        tinyint is_active
        datetime last_login_at
        datetime created_at
        datetime updated_at
    }
    roles ||--o{ user_roles : "role_id"
    users |o--o{ user_external_identities : "linked_by_user_id"
    users ||--o{ user_external_identities : "user_id"
    users ||--o{ user_roles : "user_id"
    users ||--o{ user_saved_layouts : "user_id"
    users ||--o{ user_sessions : "user_id"
```

## Organization

GeoTech offices, branches, districts, coverage and where people sit.

```mermaid
erDiagram
    geotech_office_routing {
        bigint id PK
        varchar district UK
        varchar office_code
        varchar office_name
        tinyint is_active
        datetime created_at
        datetime updated_at
    }
    org_branch_districts {
        bigint id PK
        bigint branch_id FK
        char district
        varchar source
        varchar notes
        tinyint is_active
        datetime created_at
        datetime updated_at
    }
    org_branches {
        bigint id PK
        bigint office_id FK
        bigint parent_branch_id FK
        varchar unit_type
        varchar letter
        varchar name
        varchar home_city
        char home_district
        varchar home_location_label
        bigint chief_user_id FK
        tinyint accepts_assignments
        tinyint is_active
        integer sort_order
        datetime created_at
        datetime updated_at
        varchar active_key UK
        varchar active_unit_key UK
    }
    org_classifications {
        bigint id PK
        varchar rule_kind
        varchar class_code
        varchar marker
        varchar title_pattern
        varchar level_code
        varchar title
        varchar eris_role
        tinyint is_supervisor
        integer priority
        varchar notes
        tinyint is_active
        datetime created_at
        datetime updated_at
    }
    org_coordinator_coverage {
        bigint id PK
        char district
        bigint user_id FK
        tinyint is_primary
        tinyint is_active
        datetime created_at
        datetime updated_at
    }
    org_district_crew {
        bigint id PK
        char district
        bigint user_id FK
        tinyint is_active
        datetime created_at
        datetime updated_at
    }
    org_office_districts {
        bigint id PK
        bigint office_id FK
        varchar org_type FK
        char district
        tinyint is_primary
        tinyint is_active
        varchar active_district_key UK
        datetime created_at
        datetime updated_at
    }
    org_offices {
        bigint id PK
        varchar code
        varchar org_type
        varchar unit_number
        varchar name
        varchar short_name
        varchar home_city
        char home_district
        varchar home_location_label
        tinyint is_routing_target
        tinyint is_active
        integer sort_order
        datetime created_at
        datetime updated_at
    }
    org_user_profiles {
        bigint user_id PK,FK
        bigint office_id FK
        bigint branch_id FK
        varchar tree_position
        varchar home_city
        char home_district
        varchar classification_code
        varchar classification_marker
        varchar position_number
        varchar job_title
        varchar level_code
        bigint supervisor_user_id FK
        varchar availability
        date available_from
        date available_until
        varchar source
        varchar notes
        datetime created_at
        datetime updated_at
    }
    users {
        bigint id PK
    }
    org_branches |o--o{ org_branches : "parent_branch_id"
    org_branches |o--o{ org_user_profiles : "branch_id"
    org_branches ||--o{ org_branch_districts : "branch_id"
    org_offices |o--o{ org_user_profiles : "office_id"
    org_offices ||--o{ org_branches : "office_id"
    org_offices ||--o{ org_office_districts : "office_id,org_type"
    users |o--o{ org_branches : "chief_user_id"
    users |o--o{ org_user_profiles : "supervisor_user_id"
    users ||--o{ org_coordinator_coverage : "user_id"
    users ||--o{ org_district_crew : "user_id"
    users ||--o{ org_user_profiles : "user_id"
```

## Incidents

Field reports, locations, routing, assignments and event groups.

```mermaid
erDiagram
    event_group_events {
        bigint id PK
        bigint event_group_id FK
        bigint incident_id FK
        bigint actor_user_id FK
        varchar event_type
        text notes
        longtext metadata_json
        datetime created_at
    }
    event_groups {
        bigint id PK
        varchar event_group_key UK
        varchar title
        text description
        varchar status
        bigint anchor_location_id FK
        decimal anchor_latitude
        decimal anchor_longitude
        varchar district
        varchar county
        varchar route
        varchar post_mile
        bigint created_from_incident_id FK
        bigint created_by_user_id FK
        varchar source
        datetime closed_at
        bigint closed_by_user_id FK
        datetime created_at
        datetime updated_at
    }
    incident_assignments {
        bigint id PK
        bigint incident_id FK
        bigint assignee_user_id FK
        bigint assigned_by_user_id FK
        varchar assignment_stage
        varchar assignment_mode
        tinyint is_active
        datetime created_at
        datetime updated_at
    }
    incident_attachments {
        bigint id PK
        bigint incident_id FK
        bigint attachment_id FK
        varchar kind
        integer sort_order
        datetime created_at
    }
    incident_locations {
        bigint id PK
        varchar display_name
        varchar district
        varchar county
        varchar route
        varchar post_mile_raw
        varchar post_mile_norm
        decimal latitude
        decimal longitude
        tinyint is_active
        datetime created_at
        datetime updated_at
    }
    incident_routing_assignments {
        bigint id PK
        varchar assignment_type
        varchar district
        varchar office_code
        bigint user_id FK
        tinyint is_active
        datetime created_at
        datetime updated_at
    }
    incident_submission_links {
        bigint incident_id PK,FK
        bigint submission_id FK,UK
        bigint linked_by_user_id FK
        datetime created_at
    }
    incidents {
        bigint id PK
        bigint event_group_id FK
        varchar incident_key UK
        datetime approved_at
        bigint approved_by_user_id FK
        bigint project_id
        varchar title
        varchar incident_type
        text description
        bigint location_id FK
        varchar location_match_status
        bigint location_reviewed_by_user_id FK
        datetime location_reviewed_at
        longtext location_match_metadata
        datetime first_observed_at
        datetime first_occurred_at
        decimal latitude
        decimal longitude
        varchar district
        varchar county
        varchar route
        varchar post_mile
        varchar office_code
        varchar current_stage
        varchar status
        bigint reporter_user_id FK
        datetime created_at
        datetime updated_at
        datetime resolved_at
        bigint resolved_by_user_id FK
        text resolution_comment
        bigint road_inventory_dataset_version_id FK
        bigint road_inventory_segment_id FK
        longtext road_inventory_snapshot_json
        varchar road_inventory_match_method
        datetime road_inventory_checked_at
        varchar triage_disposition
        bigint triage_decided_by_user_id FK
        datetime triage_decided_at
        text triage_notes
        bigint duplicate_of_incident_id FK
        bigint duplicate_of_location_id FK
    }
    attachments {
        bigint id PK
    }
    road_inventory_datasets {
        bigint id PK
    }
    road_segments {
        bigint id PK
    }
    submissions {
        bigint id PK
    }
    users {
        bigint id PK
    }
    attachments ||--o{ incident_attachments : "attachment_id"
    event_groups |o--o{ incidents : "event_group_id"
    event_groups ||--o{ event_group_events : "event_group_id"
    incident_locations |o--o{ event_groups : "anchor_location_id"
    incident_locations |o--o{ incidents : "duplicate_of_location_id"
    incident_locations |o--o{ incidents : "location_id"
    incidents |o--o{ event_group_events : "incident_id"
    incidents |o--o{ event_groups : "created_from_incident_id"
    incidents |o--o{ incidents : "duplicate_of_incident_id"
    incidents ||--o{ incident_assignments : "incident_id"
    incidents ||--o{ incident_attachments : "incident_id"
    incidents ||--o{ incident_submission_links : "incident_id"
    road_inventory_datasets |o--o{ incidents : "road_inventory_dataset_version_id"
    road_segments |o--o{ incidents : "road_inventory_segment_id"
    submissions ||--o{ incident_submission_links : "submission_id"
    users |o--o{ event_group_events : "actor_user_id"
    users |o--o{ event_groups : "closed_by_user_id"
    users |o--o{ incidents : "approved_by_user_id"
    users |o--o{ incidents : "location_reviewed_by_user_id"
    users |o--o{ incidents : "resolved_by_user_id"
    users |o--o{ incidents : "triage_decided_by_user_id"
    users ||--o{ event_groups : "created_by_user_id"
    users ||--o{ incident_assignments : "assigned_by_user_id"
    users ||--o{ incident_assignments : "assignee_user_id"
    users ||--o{ incident_routing_assignments : "user_id"
    users ||--o{ incident_submission_links : "linked_by_user_id"
    users ||--o{ incidents : "reporter_user_id"
```

## Assessments

Technical assessments routed to Staff or Senior Specialists.

```mermaid
erDiagram
    assessment_assignments {
        bigint id PK
        bigint assessment_id FK
        bigint user_id FK
        varchar assignment_role
        bigint assigned_by_user_id FK
        tinyint is_active
        varchar notes
        datetime created_at
        datetime updated_at
    }
    assessment_events {
        bigint id PK
        bigint assessment_id FK
        bigint incident_id FK
        bigint actor_user_id FK
        varchar event_type
        varchar disposition
        varchar from_state
        varchar to_state
        text notes
        bigint target_incident_id FK
        bigint target_location_id FK
        longtext metadata_json
        datetime created_at
    }
    assessment_submissions {
        bigint id PK
        bigint assessment_id FK
        bigint submission_id FK,UK
        bigint created_by_user_id FK
        datetime created_at
    }
    assessments {
        bigint id PK
        varchar assessment_uuid UK
        bigint incident_id FK,UK
        bigint submission_id FK
        varchar district
        varchar office_code
        varchar office_routed_from_district
        text office_override_reason
        bigint routed_office_id FK
        varchar routed_office_name
        bigint routed_branch_id FK
        varchar routed_branch_name
        varchar routed_branch_letter
        varchar routing_path
        bigint branch_chief_user_id FK
        bigint assigned_engineer_user_id FK
        varchar state
        varchar triage_disposition
        text notes
        bigint created_by_user_id FK
        datetime office_delegated_at
        datetime engineer_assigned_at
        datetime submitted_at
        datetime review_requested_at
        datetime approved_at
        datetime finalized_at
        datetime created_at
        datetime updated_at
    }
    incident_locations {
        bigint id PK
    }
    incidents {
        bigint id PK
    }
    org_branches {
        bigint id PK
    }
    org_offices {
        bigint id PK
    }
    submissions {
        bigint id PK
    }
    users {
        bigint id PK
    }
    assessments |o--o{ assessment_events : "assessment_id"
    assessments ||--o{ assessment_assignments : "assessment_id"
    assessments ||--o{ assessment_submissions : "assessment_id"
    incident_locations |o--o{ assessment_events : "target_location_id"
    incidents |o--o{ assessment_events : "target_incident_id"
    incidents ||--o{ assessment_events : "incident_id"
    incidents ||--o{ assessments : "incident_id"
    org_branches |o--o{ assessments : "routed_branch_id"
    org_offices |o--o{ assessments : "routed_office_id"
    submissions |o--o{ assessments : "submission_id"
    submissions ||--o{ assessment_submissions : "submission_id"
    users |o--o{ assessment_submissions : "created_by_user_id"
    users |o--o{ assessments : "assigned_engineer_user_id"
    users |o--o{ assessments : "branch_chief_user_id"
    users ||--o{ assessment_assignments : "assigned_by_user_id"
    users ||--o{ assessment_assignments : "user_id"
    users ||--o{ assessment_events : "actor_user_id"
    users ||--o{ assessments : "created_by_user_id"
```

## Submissions (GISA)

The GISA technical form, its sharing, editors and workflow history.

```mermaid
erDiagram
    submission_drone_surveys {
        bigint id PK
        bigint submission_id FK
        varchar label
        varchar source
        date captured_on
        bigint created_by_user_id FK
        datetime created_at
        datetime updated_at
        varchar dsm_filename
        varchar ortho_filename
        bigint dsm_attachment_id FK
        bigint ortho_attachment_id FK
        varchar source_crs
        double west
        double south
        double east
        double north
        integer cols
        integer grid_rows
        double resolution_m
        varchar patch_object_key
        integer patch_size_bytes
        varchar overlay_object_key
        varchar overlay_mime
        longtext overlay_corners_json
        double vertical_offset_m
        varchar offset_mode
        longtext stats_json
        longtext comparison_json
        longtext points_json
        bigint compare_with_survey_id FK
    }
    submission_editors {
        bigint submission_id PK,FK
        bigint user_id PK,FK
        bigint granted_by_user_id FK
        datetime created_at
    }
    submission_gisa {
        bigint submission_id PK,FK
        bigint location_id FK
        date report_date
        varchar district
        varchar county
        varchar route
        varchar post_mile
        varchar ea
        varchar project_id
        date date_incident_reported
        text district_contact
        decimal latitude
        decimal longitude
        varchar distribution_code
        text highway_status_cause
        varchar highway_status_code
        integer lanes_closed_count
        integer open_highway_traffic_lanes_count
        longtext pavement_ground_annotation_layout_json
        tinyint pavement_ground_cracks
        decimal crack_length_ft
        decimal crack_horizontal_in
        decimal crack_vertical_in
        decimal crack_depth_in
        decimal settlement_in
        decimal bulge_in
        tinyint indented_by_rocks
        tinyint failure_rock_fall
        tinyint failure_topple
        tinyint failure_slide
        tinyint failure_spread
        tinyint failure_flow
        tinyint failure_compound
        tinyint failure_erosion
        tinyint failure_surficial_failure
        tinyint failure_scoured_toe
        tinyint failure_washout
        text incident_type_description
        tinyint distribution_advancing
        tinyint distribution_retrogressive
        tinyint distribution_enlarging
        tinyint distribution_widening
        tinyint distribution_moving
        tinyint distribution_confined
        tinyint material_rock
        tinyint material_soil
        tinyint material_bedding
        tinyint material_joints
        tinyint material_fractures
        varchar material_pavement_type
        decimal est_soil_pct
        decimal est_rock_pct
        decimal est_clay_pct
        decimal est_silt_pct
        decimal est_sand_pct
        decimal est_gravel_pct
        decimal est_boulder_pct
        decimal est_debris_clay_silt_pct
        decimal est_debris_sand_pct
        decimal est_debris_gravel_pct
        decimal est_debris_boulder_pct
        tinyint water_dry
        tinyint water_moist
        tinyint water_wet
        tinyint water_flowing
        tinyint water_seep
        tinyint water_spring
        decimal vegetation_trees
        decimal vegetation_bushes_shrubs
        decimal vegetation_groundcover
        tinyint drainage_clogged_inlet
        tinyint drainage_compromised_drains
        tinyint drainage_surface_runoff
        tinyint drainage_torrent_surge_flood
        tinyint impact_impacted_adj_utilities
        tinyint impact_maybe_adj_utilities
        varchar impact_adj_utilities
        tinyint impact_impacted_adj_properties
        tinyint impact_maybe_adj_properties
        varchar impact_adj_properties
        tinyint impact_impacted_adj_structure
        tinyint impact_maybe_adj_structure
        varchar impact_adj_structure
        decimal measure_slope_height_ft
        decimal measure_original_slope_deg
        decimal measure_landslide_width_ft
        decimal measure_landslide_length_ft
        decimal measure_main_scarp_height_ft
        decimal measure_landslide_slope_deg
        decimal measure_roadway_length_ft
        decimal measure_roadway_width_ft
        text record_of_event_notes
        text maintenance_history_notes
        text geotechnical_assessment_notes
        text recommendations_notes
        text sketchpad_notes
        text observations_notes
        longtext geometry_json
        longtext elevation_terrain_grid_json
        varchar elevation_terrain_source
        datetime elevation_terrain_checked_at
        text elevation_terrain_error
        mediumtext observations_notes_html
        mediumtext geotechnical_assessment_notes_html
        mediumtext recommendations_notes_html
        mediumtext sketchpad_notes_html
        bigint updated_by_user_id FK
        integer revision
        datetime created_at
        datetime updated_at
        bigint road_inventory_dataset_version_id FK
        bigint road_inventory_segment_id FK
        longtext road_inventory_snapshot_json
        varchar road_inventory_match_method
        datetime road_inventory_checked_at
        longtext elevation_profile_json
        varchar elevation_profile_source
        datetime elevation_profile_checked_at
        varchar elevation_profile_classification
        float elevation_profile_confidence
        text elevation_profile_error
    }
    submission_gisa_actions {
        bigint submission_id PK,FK
        varchar action_group PK
        varchar action_code PK
        datetime created_at
    }
    submission_gisa_incident_types {
        bigint submission_id PK,FK
        varchar incident_type_code PK
        datetime created_at
    }
    submission_presence {
        bigint submission_id PK,FK
        varchar session_id PK
        bigint user_id FK
        varchar area
        varchar field
        varchar memo_keys
        datetime memo_active_at
        datetime seen_at
    }
    submission_share_reviews {
        bigint id PK
        bigint share_id FK
        varchar unit_type
        bigint unit_id
        varchar kind
        varchar decision
        bigint decided_by_user_id FK
        datetime decided_at
        varchar note
        datetime created_at
    }
    submission_shares {
        bigint id PK
        bigint submission_id FK
        bigint sharer_user_id FK
        bigint recipient_user_id FK
        varchar status
        datetime created_at
        datetime activated_at
        datetime ended_at
        bigint ended_by_user_id FK
        varchar end_note
    }
    submission_visibility {
        bigint submission_id PK,FK
        bigint user_id PK,FK
        bigint granted_by_user_id FK
        datetime created_at
    }
    submissions {
        bigint id PK
        bigint created_by_user_id FK
        varchar status
        varchar client_submission_uuid UK
        varchar title
        datetime submitted_at
        datetime reviewed_at
        bigint reviewed_by_user_id FK
        text review_comment
        datetime created_at
        datetime updated_at
    }
    workflow_events {
        bigint id PK
        bigint submission_id FK
        bigint actor_user_id FK
        varchar event_type
        varchar from_status
        varchar to_status
        text comment
        datetime created_at
    }
    attachments {
        bigint id PK
    }
    incident_locations {
        bigint id PK
    }
    road_inventory_datasets {
        bigint id PK
    }
    road_segments {
        bigint id PK
    }
    users {
        bigint id PK
    }
    attachments |o--o{ submission_drone_surveys : "dsm_attachment_id"
    attachments |o--o{ submission_drone_surveys : "ortho_attachment_id"
    incident_locations |o--o{ submission_gisa : "location_id"
    road_inventory_datasets |o--o{ submission_gisa : "road_inventory_dataset_version_id"
    road_segments |o--o{ submission_gisa : "road_inventory_segment_id"
    submission_drone_surveys |o--o{ submission_drone_surveys : "compare_with_survey_id"
    submission_shares ||--o{ submission_share_reviews : "share_id"
    submissions ||--o{ submission_drone_surveys : "submission_id"
    submissions ||--o{ submission_editors : "submission_id"
    submissions ||--o{ submission_gisa : "submission_id"
    submissions ||--o{ submission_gisa_actions : "submission_id"
    submissions ||--o{ submission_gisa_incident_types : "submission_id"
    submissions ||--o{ submission_presence : "submission_id"
    submissions ||--o{ submission_shares : "submission_id"
    submissions ||--o{ submission_visibility : "submission_id"
    submissions ||--o{ workflow_events : "submission_id"
    users |o--o{ submission_gisa : "updated_by_user_id"
    users |o--o{ submission_share_reviews : "decided_by_user_id"
    users |o--o{ submission_shares : "ended_by_user_id"
    users |o--o{ submissions : "reviewed_by_user_id"
    users ||--o{ submission_drone_surveys : "created_by_user_id"
    users ||--o{ submission_editors : "granted_by_user_id"
    users ||--o{ submission_editors : "user_id"
    users ||--o{ submission_presence : "user_id"
    users ||--o{ submission_shares : "recipient_user_id"
    users ||--o{ submission_shares : "sharer_user_id"
    users ||--o{ submission_visibility : "granted_by_user_id"
    users ||--o{ submission_visibility : "user_id"
    users ||--o{ submissions : "created_by_user_id"
    users ||--o{ workflow_events : "actor_user_id"
```

## Attachments

Photos and files (bytes in S3), capture metadata and corrections.

```mermaid
erDiagram
    attachment_capture_corrections {
        bigint id PK
        bigint attachment_id FK
        varchar client_correction_uuid UK
        bigint corrected_by_user_id FK
        tinyint location_is_override
        decimal latitude
        decimal longitude
        tinyint heading_is_override
        decimal camera_heading_deg
        datetime created_at
    }
    attachment_capture_metadata {
        bigint attachment_id PK,FK
        datetime captured_at
        decimal latitude
        decimal longitude
        decimal horizontal_accuracy_m
        decimal altitude_m
        decimal camera_heading_deg
        smallint camera_heading_accuracy_code
        varchar heading_reference
        varchar location_source
        varchar heading_source
        longtext metadata_json
        datetime created_at
        datetime updated_at
    }
    attachment_links {
        bigint id PK
        bigint submission_id FK
        bigint attachment_id FK
        varchar kind
        varchar section_key
        integer sort_order
        datetime created_at
    }
    attachments {
        bigint id PK
        bigint created_by_user_id FK
        varchar storage_provider
        varchar storage_bucket
        varchar storage_key
        varchar file_name
        varchar mime_type
        bigint file_size_bytes
        char sha256
        datetime captured_at
        datetime uploaded_at
        datetime created_at
    }
    submissions {
        bigint id PK
    }
    users {
        bigint id PK
    }
    attachments ||--o{ attachment_capture_corrections : "attachment_id"
    attachments ||--o{ attachment_capture_metadata : "attachment_id"
    attachments ||--o{ attachment_links : "attachment_id"
    submissions ||--o{ attachment_links : "submission_id"
    users ||--o{ attachment_capture_corrections : "corrected_by_user_id"
    users ||--o{ attachments : "created_by_user_id"
```

## Notifications

The notification feed, push devices and the email outbox.

```mermaid
erDiagram
    incident_notifications {
        bigint id PK
        bigint incident_id FK
        bigint recipient_user_id FK
        varchar channel
        varchar template_code
        longtext payload_json
        datetime delivered_at
        datetime created_at
        integer delivery_attempts
        varchar last_error
        datetime last_attempt_at
    }
    push_devices {
        bigint id PK
        bigint user_id FK
        varchar token UK
        varchar platform
        tinyint is_active
        datetime created_at
        datetime last_seen_at
    }
    user_notifications {
        bigint id PK
        bigint user_id FK
        varchar kind
        varchar title
        varchar body
        varchar link
        bigint incident_id
        bigint assessment_id
        varchar task_state
        bigint actor_user_id FK
        datetime created_at
        datetime read_at
        varchar push_state
    }
    incidents {
        bigint id PK
    }
    users {
        bigint id PK
    }
    incidents ||--o{ incident_notifications : "incident_id"
    users |o--o{ user_notifications : "actor_user_id"
    users ||--o{ incident_notifications : "recipient_user_id"
    users ||--o{ push_devices : "user_id"
    users ||--o{ user_notifications : "user_id"
```

## Maintenance workflows

District maintenance work definitions and runs.

```mermaid
erDiagram
    maintenance_workflow_events {
        bigint id PK
        varchar district
        bigint incident_id FK
        bigint actor_user_id
        varchar action
        integer step_index
        text notes
        longtext metadata_json
        datetime created_at
    }
    maintenance_workflow_runs {
        bigint incident_id PK,FK
        varchar district
        integer revision
        longtext definition_json
        longtext state_json
        integer version
        varchar outcome
        datetime updated_at
    }
    maintenance_workflows {
        varchar district PK
        integer revision
        longtext definition_json
        bigint updated_by_user_id
        datetime updated_at
    }
    incidents {
        bigint id PK
    }
    incidents |o--o{ maintenance_workflow_events : "incident_id"
    incidents ||--o{ maintenance_workflow_runs : "incident_id"
```

## Projects

Caltrans projects linked to incidents.

```mermaid
erDiagram
    caltrans_projects {
        bigint id PK
        varchar project_key UK
        varchar project_number
        varchar title
        text description
        varchar district
        varchar status
        varchar source_system
        varchar external_project_id
        longtext source_metadata_json
        datetime last_synced_at
        bigint created_by_user_id FK
        datetime created_at
        datetime updated_at
    }
    users {
        bigint id PK
    }
    users |o--o{ caltrans_projects : "created_by_user_id"
```

## Road inventory

Imported Caltrans road inventory datasets, segments and mobile packages.

```mermaid
erDiagram
    road_inventory_datasets {
        bigint id PK
        varchar version_tag
        varchar upload_filename
        date extract_date
        integer row_count
        integer skipped_count
        enum status
        varchar storage_key
        bigint uploaded_by
        datetime created_at
        datetime published_at
    }
    road_inventory_import_jobs {
        bigint id PK
        char job_uuid UK
        enum status
        varchar stage
        varchar message
        varchar upload_filename
        varchar requested_version_tag
        varchar storage_key
        bigint file_size_bytes
        bigint dataset_version_id
        integer row_count
        integer skipped_count
        longtext warnings_json
        text error_message
        bigint created_by
        datetime created_at
        datetime started_at
        datetime finished_at
        datetime updated_at
    }
    road_inventory_packages {
        bigint id PK
        bigint dataset_version_id FK
        enum package_type
        varchar storage_key
        bigint file_size_bytes
        char sha256
        datetime generated_at
    }
    road_segments {
        bigint id PK
        bigint dataset_version_id FK
        bigint thy_id
        varchar district_code
        varchar county_code
        varchar route_name
        varchar route_suffix_code
        varchar pm_prefix_code
        decimal begin_pm
        decimal end_pm
        varchar pm_suffix_code
        decimal length_miles
        tinyint left_lanes
        tinyint right_lanes
        varchar left_surface_type
        varchar right_surface_type
        decimal left_shoulder_width
        decimal right_shoulder_width
        varchar median_type
        decimal median_width
        varchar access_code
        varchar terrain_code
        smallint design_speed
        integer adt
        varchar landmark_short_desc
        varchar functional_class_code
        varchar maintenance_service_level_code
        varchar federal_aid_code
        varchar scenic_freeway_code
        date extract_date
        longtext raw_json
        datetime created_at
    }
    road_inventory_datasets ||--o{ road_inventory_packages : "dataset_version_id"
    road_inventory_datasets ||--o{ road_segments : "dataset_version_id"
```

## Terrain and offline scenes

Terrain cross sections and offline 3D scene packages and jobs.

```mermaid
erDiagram
    offline_scene_jobs {
        bigint id PK
        bigint submission_id FK
        bigint requested_by FK
        varchar status
        integer progress_pct
        varchar status_message
        double center_lat
        double center_lon
        double radius_m
        double min_lat
        double min_lon
        double max_lat
        double max_lon
        integer retry_count
        text error_details
        bigint result_package_id
        varchar result_package_version
        longtext usgs_source_metadata
        longtext basemap_source_metadata
        varchar worker_id
        varchar worker_log_ref
        datetime claimed_at
        datetime created_at
        datetime updated_at
    }
    offline_scene_orphaned_objects {
        bigint id PK
        bigint submission_id
        bigint job_id
        varchar minio_bucket
        varchar object_key
        char sha256
        bigint size_bytes
        varchar reason
        tinyint resolved
        bigint resolved_by
        varchar resolution_notes
        datetime created_at
        datetime resolved_at
    }
    offline_scene_packages {
        bigint id PK
        bigint submission_id FK
        varchar status
        varchar package_version
        varchar minio_bucket
        varchar object_key UK
        char sha256
        bigint size_bytes
        varchar package_format
        varchar object_version_id
        varchar object_etag
        double min_lat
        double min_lon
        double max_lat
        double max_lon
        double center_lat
        double center_lon
        double radius_m
        varchar elevation_source
        varchar elevation_dataset
        varchar elevation_version
        varchar elevation_resolution
        varchar basemap_or_imagery_source
        varchar content_signature
        datetime created_at
        datetime uploaded_at
        bigint uploaded_by FK
        datetime retired_at
        text notes
    }
    offline_scene_worker_heartbeats {
        varchar worker_id PK
        datetime last_seen
        datetime started_at
        bigint jobs_processed
        varchar last_stage
    }
    terrain_cross_section_points {
        bigint id PK
        bigint cross_section_id FK
        integer sequence_number
        decimal latitude
        decimal longitude
        double distance_m
        double elevation_m
        datetime created_at
    }
    terrain_cross_sections {
        bigint id PK
        varchar cross_section_key UK
        bigint caltrans_project_id FK
        varchar name
        text notes
        double preferred_spacing_m
        double actual_spacing_m
        varchar dem_source
        longtext profile_snapshot_json
        bigint created_by_user_id FK
        datetime created_at
        datetime updated_at
    }
    caltrans_projects {
        bigint id PK
    }
    submissions {
        bigint id PK
    }
    users {
        bigint id PK
    }
    caltrans_projects ||--o{ terrain_cross_sections : "caltrans_project_id"
    submissions ||--o{ offline_scene_jobs : "submission_id"
    submissions ||--o{ offline_scene_packages : "submission_id"
    terrain_cross_sections ||--o{ terrain_cross_section_points : "cross_section_id"
    users |o--o{ offline_scene_jobs : "requested_by"
    users |o--o{ offline_scene_packages : "uploaded_by"
    users ||--o{ terrain_cross_sections : "created_by_user_id"
```
