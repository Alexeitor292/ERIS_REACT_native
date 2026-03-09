USE eris;
SET NAMES utf8mb4;

-- ============================================================
-- USERS / ROLES
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    email VARCHAR(255) NOT NULL UNIQUE,
    full_name VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    is_active TINYINT NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS roles (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(64) NOT NULL UNIQUE,
    description VARCHAR(255) NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS user_roles (
    user_id BIGINT NOT NULL,
    role_id BIGINT NOT NULL,
    assigned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, role_id),
    CONSTRAINT fk_user_roles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_user_roles_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- SUBMISSIONS (workflow + ownership + review cache)
-- ============================================================

CREATE TABLE IF NOT EXISTS submissions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    created_by_user_id BIGINT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'DRAFT', -- DRAFT | SUBMITTED | APPROVED | REJECTED
    client_submission_uuid VARCHAR(64) NOT NULL UNIQUE,
    title VARCHAR(255) NULL,
    submitted_at DATETIME NULL,

    reviewed_at DATETIME NULL,
    reviewed_by_user_id BIGINT NULL,
    review_comment TEXT NULL,

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_submissions_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_submissions_reviewed_by FOREIGN KEY (reviewed_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,

    INDEX idx_submissions_user (created_by_user_id),
    INDEX idx_submissions_status (status),
    INDEX idx_submissions_status_updated (status, updated_at),
    CONSTRAINT chk_submissions_status
      CHECK (status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'))
) ENGINE=InnoDB;

-- ============================================================
-- WORKFLOW EVENTS (audit trail)
-- ============================================================

CREATE TABLE IF NOT EXISTS workflow_events (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    submission_id BIGINT NOT NULL,
    actor_user_id BIGINT NOT NULL,
    event_type VARCHAR(32) NOT NULL, -- CREATE | SUBMIT | APPROVE | REJECT | COMMENT
    from_status VARCHAR(32) NULL,
    to_status VARCHAR(32) NULL,
    comment TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_workflow_submission FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
    CONSTRAINT fk_workflow_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    INDEX idx_workflow_submission (submission_id),
    INDEX idx_workflow_created (created_at),
    CONSTRAINT chk_workflow_event_type
      CHECK (event_type IN ('CREATE', 'SUBMIT', 'SUBMITTED', 'RESUBMIT', 'APPROVE', 'REJECT', 'COMMENT', 'COORDINATOR_NOTIFIED')),
    CONSTRAINT chk_workflow_from_status
      CHECK (from_status IS NULL OR from_status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED')),
    CONSTRAINT chk_workflow_to_status
      CHECK (to_status IS NULL OR to_status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'))
) ENGINE=InnoDB;

-- ============================================================
-- ATTACHMENTS (metadata only)
-- ============================================================

CREATE TABLE IF NOT EXISTS attachments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    created_by_user_id BIGINT NOT NULL,
    storage_provider VARCHAR(32) NOT NULL, -- minio | fileshare
    storage_bucket VARCHAR(128) NOT NULL DEFAULT '',
    storage_key VARCHAR(512) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(128) NOT NULL,
    file_size_bytes BIGINT NOT NULL,
    sha256 CHAR(64) NULL,
    captured_at DATETIME NULL,
    uploaded_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_attachments_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    INDEX idx_attachments_storage (storage_provider, storage_bucket),
    INDEX idx_attachments_user (created_by_user_id),
    UNIQUE KEY uk_attachments_storage_object (storage_provider, storage_bucket, storage_key),
    CONSTRAINT chk_attachments_provider
      CHECK (storage_provider IN ('minio', 'fileshare', 's3', 'azure_blob')),
    CONSTRAINT chk_attachments_file_size
      CHECK (file_size_bytes >= 0),
    CONSTRAINT chk_attachments_sha256_len
      CHECK (sha256 IS NULL OR CHAR_LENGTH(sha256) = 64)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS attachment_links (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    submission_id BIGINT NOT NULL,
    attachment_id BIGINT NOT NULL,
    kind VARCHAR(32) NOT NULL DEFAULT 'PHOTO', -- PHOTO | VIDEO | DOC | SKETCH | MAP_SNAPSHOT
    section_key VARCHAR(64) NULL,
    sort_order INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_attachment_links_submission FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
    CONSTRAINT fk_attachment_links_attachment FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE,
    UNIQUE KEY uk_submission_attachment (submission_id, attachment_id),
    INDEX idx_attachment_links_submission (submission_id),
    INDEX idx_attachment_links_kind (kind),
    INDEX idx_attachment_links_section_key (section_key),
    CONSTRAINT chk_attachment_links_kind
      CHECK (kind IN ('PHOTO', 'VIDEO', 'DOC', 'SKETCH', 'MAP_SNAPSHOT'))
) ENGINE=InnoDB;

-- ============================================================
-- INCIDENTS (maintenance intake + assignment workflow)
-- ============================================================

CREATE TABLE IF NOT EXISTS incident_locations (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    display_name VARCHAR(255) NULL,
    district VARCHAR(64) NULL,
    county VARCHAR(64) NULL,
    route VARCHAR(64) NULL,
    post_mile_raw VARCHAR(64) NULL,
    post_mile_norm VARCHAR(64) NULL,
    latitude DECIMAL(10,7) NULL,
    longitude DECIMAL(10,7) NULL,
    is_active TINYINT NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_incident_location_identity (district, county, route, post_mile_norm),
    INDEX idx_incident_locations_geo (latitude, longitude),
    INDEX idx_incident_locations_lookup (district, county, route, post_mile_norm),
    CONSTRAINT chk_incident_locations_lat
      CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),
    CONSTRAINT chk_incident_locations_lon
      CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS incidents (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    title VARCHAR(255) NULL,
    incident_type VARCHAR(64) NULL,
    description TEXT NULL,
    location_id BIGINT NULL,
    location_match_status VARCHAR(24) NOT NULL DEFAULT 'PENDING_REVIEW',
    location_reviewed_by_user_id BIGINT NULL,
    location_reviewed_at DATETIME NULL,
    location_match_metadata JSON NULL,
    first_observed_at DATETIME NOT NULL,
    first_occurred_at DATETIME NULL,
    latitude DECIMAL(10,7) NOT NULL,
    longitude DECIMAL(10,7) NOT NULL,
    district VARCHAR(64) NOT NULL,
    county VARCHAR(64) NOT NULL,
    route VARCHAR(64) NOT NULL,
    post_mile VARCHAR(64) NOT NULL,
    office_code VARCHAR(16) NULL,
    current_stage VARCHAR(32) NOT NULL DEFAULT 'COORDINATOR_REVIEW', -- COORDINATOR_REVIEW | OFFICE_CHIEF_REVIEW | BRANCH_CHIEF_REVIEW | ENGINEER_ASSIGNED | RESOLVED
    status VARCHAR(32) NOT NULL DEFAULT 'NEW', -- NEW | IN_PROGRESS | RESOLVED
    reporter_user_id BIGINT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    resolved_at DATETIME NULL,
    resolved_by_user_id BIGINT NULL,
    resolution_comment TEXT NULL,
    CONSTRAINT fk_incident_reporter FOREIGN KEY (reporter_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_incident_location FOREIGN KEY (location_id) REFERENCES incident_locations(id) ON DELETE SET NULL,
    CONSTRAINT fk_incident_location_reviewed_by FOREIGN KEY (location_reviewed_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_incident_resolved_by FOREIGN KEY (resolved_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_incidents_location (location_id),
    INDEX idx_incidents_status (status),
    INDEX idx_incidents_created (created_at),
    INDEX idx_incidents_geo (latitude, longitude),
    INDEX idx_incidents_stage_status_created (current_stage, status, created_at),
    CONSTRAINT chk_incidents_status
      CHECK (status IN ('NEW', 'IN_PROGRESS', 'RESOLVED')),
    CONSTRAINT chk_incidents_stage
      CHECK (current_stage IN ('COORDINATOR_REVIEW', 'OFFICE_CHIEF_REVIEW', 'BRANCH_CHIEF_REVIEW', 'ENGINEER_ASSIGNED', 'RESOLVED')),
    CONSTRAINT chk_incidents_location_match_status
      CHECK (location_match_status IN ('PENDING_REVIEW', 'MATCHED_EXISTING', 'NEW_LOCATION_CREATED', 'NEEDS_REVISION')),
    CONSTRAINT chk_incidents_lat
      CHECK (latitude >= -90 AND latitude <= 90),
    CONSTRAINT chk_incidents_lon
      CHECK (longitude >= -180 AND longitude <= 180)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS incident_attachments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    incident_id BIGINT NOT NULL,
    attachment_id BIGINT NOT NULL,
    kind VARCHAR(32) NOT NULL DEFAULT 'PHOTO', -- PHOTO | VIDEO | DOC | SKETCH
    sort_order INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_incident_attachments_incident FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE,
    CONSTRAINT fk_incident_attachments_attachment FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE,
    UNIQUE KEY uk_incident_attachment (incident_id, attachment_id),
    INDEX idx_incident_attachments_incident (incident_id),
    INDEX idx_incident_attachments_kind (kind),
    CONSTRAINT chk_incident_attachments_kind
      CHECK (kind IN ('PHOTO', 'VIDEO', 'DOC', 'SKETCH'))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS incident_assignments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    incident_id BIGINT NOT NULL,
    assignee_user_id BIGINT NOT NULL,
    assigned_by_user_id BIGINT NOT NULL,
    assignment_stage VARCHAR(32) NOT NULL DEFAULT 'ENGINEER', -- COORDINATOR | OFFICE_CHIEF | BRANCH_CHIEF | ENGINEER
    assignment_mode VARCHAR(16) NOT NULL, -- CLAIM | ASSIGN
    is_active TINYINT NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_inc_assign_incident FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE,
    CONSTRAINT fk_inc_assign_assignee FOREIGN KEY (assignee_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inc_assign_assigned_by FOREIGN KEY (assigned_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    INDEX idx_inc_assign_incident_active (incident_id, is_active),
    INDEX idx_inc_assign_assignee (assignee_user_id),
    INDEX idx_inc_assign_stage (assignment_stage),
    CONSTRAINT chk_inc_assign_stage
      CHECK (assignment_stage IN ('COORDINATOR', 'OFFICE_CHIEF', 'BRANCH_CHIEF', 'ENGINEER')),
    CONSTRAINT chk_inc_assign_mode
      CHECK (assignment_mode IN ('CLAIM', 'ASSIGN'))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS incident_routing_assignments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    assignment_type VARCHAR(32) NOT NULL, -- DISTRICT_COORDINATOR | OFFICE_CHIEF | BRANCH_CHIEF
    district VARCHAR(64) NULL,
    office_code VARCHAR(16) NULL,
    user_id BIGINT NOT NULL,
    is_active TINYINT NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_inc_route_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uk_inc_route_unique (assignment_type, district, office_code, user_id),
    INDEX idx_inc_route_lookup (assignment_type, district, office_code, is_active),
    CONSTRAINT chk_inc_route_assignment_type
      CHECK (assignment_type IN ('DISTRICT_COORDINATOR', 'OFFICE_CHIEF', 'BRANCH_CHIEF'))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS incident_notifications (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    incident_id BIGINT NOT NULL,
    recipient_user_id BIGINT NOT NULL,
    channel VARCHAR(16) NOT NULL DEFAULT 'IN_APP', -- IN_APP | EMAIL | SMS
    template_code VARCHAR(64) NOT NULL,
    payload_json JSON NULL,
    delivered_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_inc_notify_incident FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE,
    CONSTRAINT fk_inc_notify_recipient FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_inc_notify_incident (incident_id),
    INDEX idx_inc_notify_recipient (recipient_user_id),
    INDEX idx_inc_notify_created (created_at),
    CONSTRAINT chk_inc_notify_channel
      CHECK (channel IN ('IN_APP', 'EMAIL', 'SMS'))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS incident_submission_links (
    incident_id BIGINT NOT NULL,
    submission_id BIGINT NOT NULL,
    linked_by_user_id BIGINT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (incident_id),
    UNIQUE KEY uk_incident_submission_submission (submission_id),
    CONSTRAINT fk_inc_sub_link_incident FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE,
    CONSTRAINT fk_inc_sub_link_submission FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
    CONSTRAINT fk_inc_sub_linked_by FOREIGN KEY (linked_by_user_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ============================================================
-- SUBMISSION VISIBILITY (explicit per-user view grants)
-- ============================================================

CREATE TABLE IF NOT EXISTS submission_visibility (
    submission_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    granted_by_user_id BIGINT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (submission_id, user_id),
    CONSTRAINT fk_vis_submission FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
    CONSTRAINT fk_vis_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_vis_granted_by FOREIGN KEY (granted_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    INDEX idx_vis_user (user_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS submission_editors (
    submission_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    granted_by_user_id BIGINT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (submission_id, user_id),
    CONSTRAINT fk_edit_submission FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
    CONSTRAINT fk_edit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_edit_granted_by FOREIGN KEY (granted_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    INDEX idx_edit_user (user_id)
) ENGINE=InnoDB;


-- ============================================================
-- GISA DATA (1:1 + join tables)
--
-- Design intent for external reviewers (Caltrans / ESRI / Survey123):
-- - `submission_gisa` is a form-oriented 1:1 extension of `submissions`.
-- - High-frequency checklist observations are stored as explicit boolean-like
--   columns (TINYINT 0/1) for straightforward querying/reporting.
-- - Repeatable multi-select code lists are normalized into child tables:
--   `submission_gisa_incident_types` and `submission_gisa_actions`.
-- - This model intentionally balances relational clarity with pragmatic
--   API/form mapping stability.
-- ============================================================

CREATE TABLE IF NOT EXISTS submission_gisa (
    submission_id BIGINT NOT NULL PRIMARY KEY,

    -- Section A: Header / Administrative context
    -- NOTE: district/county/route/post_mile are stored as captured form values.
    -- Controlled-value validation (if required) is handled by application logic
    -- and/or upstream geocoding/reference datasets.
    report_date DATE NULL,
    district VARCHAR(64) NULL,
    county VARCHAR(64) NULL,
    route VARCHAR(64) NULL,
    post_mile VARCHAR(64) NULL,
    ea VARCHAR(16) NULL,
    project_id VARCHAR(32) NULL,
    date_incident_reported DATE NULL,
    district_contact TEXT NULL,

    -- Section B: Geospatial location (WGS84 decimal degrees)
    latitude DECIMAL(10,7) NULL,
    longitude DECIMAL(10,7) NULL,

    -- Section C: High-level classification / operations status
    -- NOTE: distribution_code and highway_status_code are code values from
    -- app/domain vocabularies (not DB-enforced enums in this draft).
    distribution_code VARCHAR(64) NULL,
    highway_status_code VARCHAR(64) NULL,
    lanes_closed_count INT NULL,
    open_highway_traffic_lanes_count INT NULL,

    -- Section D: Pavement / Ground condition metrics
    pavement_ground_cracks TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    crack_length_ft DECIMAL(10,2) NULL,
    crack_horizontal_in DECIMAL(10,2) NULL,
    crack_vertical_in DECIMAL(10,2) NULL,
    crack_depth_in DECIMAL(10,2) NULL,
    settlement_in DECIMAL(10,2) NULL,
    bulge_in DECIMAL(10,2) NULL,
    indented_by_rocks TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',

    -- Section E: Failure / Incident type flags
    failure_rock_fall TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    failure_topple TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    failure_slide TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    failure_spread TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    failure_flow TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    failure_compound TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    failure_erosion TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    failure_surficial_failure TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    failure_scoured_toe TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    failure_washout TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',

    -- Section F: Distribution movement flags
    distribution_advancing TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    distribution_retrogressive TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    distribution_enlarging TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    distribution_widening TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    distribution_moving TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    distribution_confined TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',

    -- Section G: Material flags (primary + rock sub-types)
    material_rock TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    material_soil TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    material_bedding TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    material_joints TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    material_fractures TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',

    -- Section H: Material composition percentages (0..100)
    -- NOTE: Percent fields are independently constrained to [0,100].
    -- They are not currently enforced to sum to 100 at DB level.
    est_soil_pct DECIMAL(5,2) NULL,
    est_clay_pct DECIMAL(5,2) NULL,
    est_silt_pct DECIMAL(5,2) NULL,
    est_sand_pct DECIMAL(5,2) NULL,
    est_gravel_pct DECIMAL(5,2) NULL,

    -- Section I: Water content/state flags
    water_dry TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    water_moist TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    water_wet TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    water_flowing TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    water_seep TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    water_spring TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',

    -- Section J: Vegetation coverage percentages (0..100)
    -- NOTE: Percent fields are independently constrained to [0,100].
    -- They are not currently enforced to sum to 100 at DB level.
    vegetation_trees DECIMAL(5,2) NULL,
    vegetation_bushes_shrubs DECIMAL(5,2) NULL,
    vegetation_groundcover DECIMAL(5,2) NULL,

    -- Section K: Drainage condition flags
    drainage_clogged_inlet TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    drainage_compromised_drains TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    drainage_surface_runoff TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    drainage_torrent_surge_flood TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',

    -- Section L: Adjacent impact flags + notes
    impact_impacted_adj_utilities TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    impact_maybe_adj_utilities TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    impact_adj_utilities VARCHAR(255) NULL,
    impact_impacted_adj_properties TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    impact_maybe_adj_properties TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    impact_adj_properties VARCHAR(255) NULL,
    impact_impacted_adj_structure TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    impact_maybe_adj_structure TINYINT NOT NULL DEFAULT 0 COMMENT 'Boolean (0=No, 1=Yes)',
    impact_adj_structure VARCHAR(255) NULL,

    -- Section M: Field measurements
    measure_slope_height_ft DECIMAL(10,2) NULL,
    measure_original_slope_deg DECIMAL(10,2) NULL,
    measure_landslide_width_ft DECIMAL(10,2) NULL,
    measure_landslide_length_ft DECIMAL(10,2) NULL,
    measure_main_scarp_height_ft DECIMAL(10,2) NULL,
    measure_landslide_slope_deg DECIMAL(10,2) NULL,
    measure_roadway_length_ft DECIMAL(10,2) NULL,
    measure_roadway_width_ft DECIMAL(10,2) NULL,

    -- Section N: Narrative notes
    record_of_event_notes TEXT NULL,
    maintenance_history_notes TEXT NULL,
    geotechnical_assessment_notes TEXT NULL,
    recommendations_notes TEXT NULL,
    sketchpad_notes TEXT NULL,

    -- Section O: Additional structured/unstructured capture
    -- geometry_json stores optional map geometry payload (GeoJSON or ArcGIS JSON,
    -- depending on client capture path); schema-level shape/type is not enforced.
    observations_notes TEXT NULL,
    geometry_json JSON NULL,

    -- Section P: Audit metadata
    updated_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_gisa_submission
      FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
    CONSTRAINT fk_gisa_updated_by
      FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL,

    INDEX idx_gisa_district (district),
    INDEX idx_gisa_county (county),
    INDEX idx_gisa_route (route),
    INDEX idx_gisa_report_date (report_date),
    CONSTRAINT chk_gisa_lat
      CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),
    CONSTRAINT chk_gisa_lon
      CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180)),
    CONSTRAINT chk_gisa_lanes_closed_count
      CHECK (lanes_closed_count IS NULL OR lanes_closed_count >= 0),
    CONSTRAINT chk_gisa_open_lanes_count
      CHECK (open_highway_traffic_lanes_count IS NULL OR open_highway_traffic_lanes_count >= 0),
    CONSTRAINT chk_gisa_est_soil_pct
      CHECK (est_soil_pct IS NULL OR (est_soil_pct >= 0 AND est_soil_pct <= 100)),
    CONSTRAINT chk_gisa_est_clay_pct
      CHECK (est_clay_pct IS NULL OR (est_clay_pct >= 0 AND est_clay_pct <= 100)),
    CONSTRAINT chk_gisa_est_silt_pct
      CHECK (est_silt_pct IS NULL OR (est_silt_pct >= 0 AND est_silt_pct <= 100)),
    CONSTRAINT chk_gisa_est_sand_pct
      CHECK (est_sand_pct IS NULL OR (est_sand_pct >= 0 AND est_sand_pct <= 100)),
    CONSTRAINT chk_gisa_est_gravel_pct
      CHECK (est_gravel_pct IS NULL OR (est_gravel_pct >= 0 AND est_gravel_pct <= 100)),
    CONSTRAINT chk_gisa_vegetation_trees_pct
      CHECK (vegetation_trees IS NULL OR (vegetation_trees >= 0 AND vegetation_trees <= 100)),
    CONSTRAINT chk_gisa_vegetation_bushes_shrubs_pct
      CHECK (vegetation_bushes_shrubs IS NULL OR (vegetation_bushes_shrubs >= 0 AND vegetation_bushes_shrubs <= 100)),
    CONSTRAINT chk_gisa_vegetation_groundcover_pct
      CHECK (vegetation_groundcover IS NULL OR (vegetation_groundcover >= 0 AND vegetation_groundcover <= 100))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS submission_gisa_incident_types (
    -- Normalized repeatable values:
    -- We store one row per selected incident type code instead of JSON/array data
    -- so relational constraints, deduplication, and indexed querying remain simple.
    -- Example query benefit: "find all submissions with incident_type_code = X".
    submission_id BIGINT NOT NULL,
    incident_type_code VARCHAR(64) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (submission_id, incident_type_code),
    CONSTRAINT fk_gisa_inc_submission
      FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
    INDEX idx_gisa_inc_type (incident_type_code)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS submission_gisa_actions (
    -- Normalized repeatable values:
    -- We store one row per action (by group/code) instead of JSON/array data
    -- to keep data relational, enforce uniqueness by PK, and support clean ETL/
    -- interoperability with external systems.
    submission_id BIGINT NOT NULL,
    action_group VARCHAR(16) NOT NULL, -- IMMEDIATE | FOLLOW_UP
    action_code VARCHAR(64) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (submission_id, action_group, action_code),
    CONSTRAINT fk_gisa_actions_submission
      FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
    INDEX idx_gisa_actions_group (action_group),
    INDEX idx_gisa_actions_code (action_code),
    CONSTRAINT chk_gisa_actions_group
      CHECK (action_group IN ('IMMEDIATE', 'FOLLOW_UP'))
) ENGINE=InnoDB;
