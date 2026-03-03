USE eris;

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
    INDEX idx_submissions_status (status)
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
    INDEX idx_workflow_created (created_at)
) ENGINE=InnoDB;

-- ============================================================
-- ATTACHMENTS (metadata only)
-- ============================================================

CREATE TABLE IF NOT EXISTS attachments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    created_by_user_id BIGINT NOT NULL,
    storage_provider VARCHAR(32) NOT NULL, -- minio | fileshare
    storage_bucket VARCHAR(128) NULL,
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
    INDEX idx_attachments_user (created_by_user_id)
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
    INDEX idx_attachment_links_section_key (section_key)
) ENGINE=InnoDB;

-- ============================================================
-- INCIDENTS (maintenance intake + assignment workflow)
-- ============================================================

CREATE TABLE IF NOT EXISTS incidents (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    title VARCHAR(255) NOT NULL,
    incident_type VARCHAR(64) NULL,
    description TEXT NULL,
    latitude DECIMAL(10,7) NOT NULL,
    longitude DECIMAL(10,7) NOT NULL,
    district VARCHAR(64) NULL,
    county VARCHAR(64) NULL,
    route VARCHAR(64) NULL,
    post_mile VARCHAR(64) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'NEW', -- NEW | IN_PROGRESS | RESOLVED
    reporter_user_id BIGINT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    resolved_at DATETIME NULL,
    resolved_by_user_id BIGINT NULL,
    resolution_comment TEXT NULL,
    CONSTRAINT fk_incident_reporter FOREIGN KEY (reporter_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_incident_resolved_by FOREIGN KEY (resolved_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_incidents_status (status),
    INDEX idx_incidents_created (created_at),
    INDEX idx_incidents_geo (latitude, longitude)
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
    INDEX idx_incident_attachments_kind (kind)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS incident_assignments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    incident_id BIGINT NOT NULL,
    assignee_user_id BIGINT NOT NULL,
    assigned_by_user_id BIGINT NOT NULL,
    assignment_mode VARCHAR(16) NOT NULL, -- CLAIM | ASSIGN
    is_active TINYINT NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_inc_assign_incident FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE,
    CONSTRAINT fk_inc_assign_assignee FOREIGN KEY (assignee_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inc_assign_assigned_by FOREIGN KEY (assigned_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    INDEX idx_inc_assign_incident_active (incident_id, is_active),
    INDEX idx_inc_assign_assignee (assignee_user_id)
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
-- CLEAN: remove any legacy table if it exists
-- ============================================================

DROP TABLE IF EXISTS submission_forms;

-- ============================================================
-- GISA DATA (1:1 + join tables)
-- ============================================================

CREATE TABLE IF NOT EXISTS submission_gisa (
    submission_id BIGINT NOT NULL PRIMARY KEY,

    report_date DATE NULL,
    district VARCHAR(64) NULL,
    county VARCHAR(64) NULL,
    route VARCHAR(64) NULL,
    post_mile VARCHAR(64) NULL,
    ea VARCHAR(16) NULL,
    project_id VARCHAR(32) NULL,
    date_incident_reported DATE NULL,
    district_contact TEXT NULL,

    latitude DECIMAL(10,7) NULL,
    longitude DECIMAL(10,7) NULL,

    distribution_code VARCHAR(64) NULL,
    highway_status_code VARCHAR(64) NULL,
    lanes_closed_count INT NULL,
    open_highway_traffic_lanes_count INT NULL,

    pavement_ground_cracks TINYINT NOT NULL DEFAULT 0,
    crack_length_ft DECIMAL(10,2) NULL,
    crack_horizontal_in DECIMAL(10,2) NULL,
    crack_vertical_in DECIMAL(10,2) NULL,
    crack_depth_in DECIMAL(10,2) NULL,
    settlement_in DECIMAL(10,2) NULL,
    bulge_in DECIMAL(10,2) NULL,
    indented_by_rocks TINYINT NOT NULL DEFAULT 0,

    failure_rock_fall TINYINT NOT NULL DEFAULT 0,
    failure_topple TINYINT NOT NULL DEFAULT 0,
    failure_slide TINYINT NOT NULL DEFAULT 0,
    failure_spread TINYINT NOT NULL DEFAULT 0,
    failure_flow TINYINT NOT NULL DEFAULT 0,
    failure_compound TINYINT NOT NULL DEFAULT 0,
    failure_erosion TINYINT NOT NULL DEFAULT 0,
    failure_surficial_failure TINYINT NOT NULL DEFAULT 0,
    failure_scoured_toe TINYINT NOT NULL DEFAULT 0,
    failure_washout TINYINT NOT NULL DEFAULT 0,

    distribution_advancing TINYINT NOT NULL DEFAULT 0,
    distribution_retrogressive TINYINT NOT NULL DEFAULT 0,
    distribution_enlarging TINYINT NOT NULL DEFAULT 0,
    distribution_widening TINYINT NOT NULL DEFAULT 0,
    distribution_moving TINYINT NOT NULL DEFAULT 0,
    distribution_confined TINYINT NOT NULL DEFAULT 0,

    material_rock TINYINT NOT NULL DEFAULT 0,
    material_soil TINYINT NOT NULL DEFAULT 0,
    material_bedding TINYINT NOT NULL DEFAULT 0,
    material_joints TINYINT NOT NULL DEFAULT 0,
    material_fractures TINYINT NOT NULL DEFAULT 0,

    est_soil_pct DECIMAL(5,2) NULL,
    est_clay_pct DECIMAL(5,2) NULL,
    est_silt_pct DECIMAL(5,2) NULL,
    est_sand_pct DECIMAL(5,2) NULL,
    est_gravel_pct DECIMAL(5,2) NULL,

    water_dry TINYINT NOT NULL DEFAULT 0,
    water_moist TINYINT NOT NULL DEFAULT 0,
    water_wet TINYINT NOT NULL DEFAULT 0,
    water_flowing TINYINT NOT NULL DEFAULT 0,
    water_seep TINYINT NOT NULL DEFAULT 0,
    water_spring TINYINT NOT NULL DEFAULT 0,

    vegetation_trees VARCHAR(255) NULL,
    vegetation_bushes_shrubs VARCHAR(255) NULL,
    vegetation_groundcover VARCHAR(255) NULL,

    drainage_clogged_inlet TINYINT NOT NULL DEFAULT 0,
    drainage_compromised_drains TINYINT NOT NULL DEFAULT 0,
    drainage_surface_runoff TINYINT NOT NULL DEFAULT 0,
    drainage_torrent_surge_flood TINYINT NOT NULL DEFAULT 0,

    impact_impacted_adj_utilities TINYINT NOT NULL DEFAULT 0,
    impact_maybe_adj_utilities TINYINT NOT NULL DEFAULT 0,
    impact_adj_utilities VARCHAR(255) NULL,
    impact_impacted_adj_properties TINYINT NOT NULL DEFAULT 0,
    impact_maybe_adj_properties TINYINT NOT NULL DEFAULT 0,
    impact_adj_properties VARCHAR(255) NULL,
    impact_impacted_adj_structure TINYINT NOT NULL DEFAULT 0,
    impact_maybe_adj_structure TINYINT NOT NULL DEFAULT 0,
    impact_adj_structure VARCHAR(255) NULL,

    measure_slope_height_ft DECIMAL(10,2) NULL,
    measure_original_slope_deg DECIMAL(10,2) NULL,
    measure_landslide_width_ft DECIMAL(10,2) NULL,
    measure_landslide_length_ft DECIMAL(10,2) NULL,
    measure_main_scarp_height_ft DECIMAL(10,2) NULL,
    measure_landslide_slope_deg DECIMAL(10,2) NULL,
    measure_roadway_length_ft DECIMAL(10,2) NULL,
    measure_roadway_width_ft DECIMAL(10,2) NULL,

    record_of_event_notes TEXT NULL,
    maintenance_history_notes TEXT NULL,
    geotechnical_assessment_notes TEXT NULL,
    recommendations_notes TEXT NULL,
    sketchpad_notes TEXT NULL,

    observations_notes TEXT NULL,
    geometry_json JSON NULL,

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
    INDEX idx_gisa_report_date (report_date)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS submission_gisa_incident_types (
    submission_id BIGINT NOT NULL,
    incident_type_code VARCHAR(64) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (submission_id, incident_type_code),
    CONSTRAINT fk_gisa_inc_submission
      FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
    INDEX idx_gisa_inc_type (incident_type_code)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS submission_gisa_actions (
    submission_id BIGINT NOT NULL,
    action_group VARCHAR(16) NOT NULL, -- IMMEDIATE | FOLLOW_UP
    action_code VARCHAR(64) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (submission_id, action_group, action_code),
    CONSTRAINT fk_gisa_actions_submission
      FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
    INDEX idx_gisa_actions_group (action_group),
    INDEX idx_gisa_actions_code (action_code)
) ENGINE=InnoDB;

-- ============================================================
-- LOOKUP VALUES ARE SERVED BY BACKEND CODE
-- ============================================================
