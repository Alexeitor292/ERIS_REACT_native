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
    sort_order INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_attachment_links_submission FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
    CONSTRAINT fk_attachment_links_attachment FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE,
    UNIQUE KEY uk_submission_attachment (submission_id, attachment_id),
    INDEX idx_attachment_links_submission (submission_id),
    INDEX idx_attachment_links_kind (kind)
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
-- GISA LOOKUP TABLES (FK-enforced controlled vocabularies)
-- ============================================================

CREATE TABLE IF NOT EXISTS gisa_incident_type_lut (
    code VARCHAR(64) PRIMARY KEY,       -- e.g. ROCK_FALL
    label VARCHAR(128) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS gisa_distribution_lut (
    code VARCHAR(64) PRIMARY KEY,       -- e.g. ADVANCING
    label VARCHAR(128) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS gisa_highway_status_lut (
    code VARCHAR(64) PRIMARY KEY,       -- e.g. OPEN
    label VARCHAR(128) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS gisa_action_lut (
    code VARCHAR(64) PRIMARY KEY,       -- e.g. PLACE_K_RAIL
    label VARCHAR(255) NOT NULL,
    action_group VARCHAR(16) NOT NULL,  -- IMMEDIATE | FOLLOW_UP
    sort_order INT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

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
    district_contact VARCHAR(255) NULL,

    latitude DECIMAL(10,7) NULL,
    longitude DECIMAL(10,7) NULL,

    distribution_code VARCHAR(64) NULL,
    highway_status_code VARCHAR(64) NULL,
    lanes_closed_count INT NULL,

    pavement_ground_cracks TINYINT NOT NULL DEFAULT 0,
    crack_length_ft DECIMAL(10,2) NULL,
    crack_horizontal_in DECIMAL(10,2) NULL,
    crack_vertical_in DECIMAL(10,2) NULL,
    crack_depth_in DECIMAL(10,2) NULL,
    settlement_in DECIMAL(10,2) NULL,
    bulge_in DECIMAL(10,2) NULL,
    indented_by_rocks TINYINT NOT NULL DEFAULT 0,

    observations_notes TEXT NULL,
    geometry_json JSON NULL,

    updated_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_gisa_submission
      FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
    CONSTRAINT fk_gisa_updated_by
      FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT fk_gisa_distribution
      FOREIGN KEY (distribution_code) REFERENCES gisa_distribution_lut(code) ON DELETE RESTRICT,
    CONSTRAINT fk_gisa_highway_status
      FOREIGN KEY (highway_status_code) REFERENCES gisa_highway_status_lut(code) ON DELETE RESTRICT,

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
    CONSTRAINT fk_gisa_inc_lut
      FOREIGN KEY (incident_type_code) REFERENCES gisa_incident_type_lut(code) ON DELETE RESTRICT,
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
    CONSTRAINT fk_gisa_actions_lut
      FOREIGN KEY (action_code) REFERENCES gisa_action_lut(code) ON DELETE RESTRICT,
    INDEX idx_gisa_actions_group (action_group),
    INDEX idx_gisa_actions_code (action_code)
) ENGINE=InnoDB;

-- ============================================================
-- SEED LOOKUP VALUES (GISA001 parity)
-- ============================================================

INSERT IGNORE INTO gisa_incident_type_lut (code, label, sort_order) VALUES
('ROCK_FALL','Rock Fall',10),
('TOPPLE','Topple',20),
('SLIDE','Slide',30),
('SPREAD','Spread',40),
('FLOW','Flow',50),
('COMPOUND','Compound',60),
('EROSION','Erosion',70),
('SURFICIAL_SLOUGHING','Surficial Sloughing',80),
('SCOURED_TOE','Scoured Toe',90),
('WASHOUT','Washout',100);

INSERT IGNORE INTO gisa_distribution_lut (code, label, sort_order) VALUES
('ADVANCING','Advancing',10),
('RETROGRESSING','Retrogressing',20),
('ENLARGING','Enlarging',30),
('WIDENING','Widening',40),
('MOVING','Moving',50),
('CONFINED','Confined',60);

INSERT IGNORE INTO gisa_highway_status_lut (code, label, sort_order) VALUES
('OPEN','Open',10),
('SHOULDER_CLOSED','Shoulder Closed',20),
('LANES_CLOSED','Lane(s) Closed',30),
('ONE_WAY_CLOSED','One-way Closed',40),
('TWO_WAY_CLOSED','Two-way Closed',50);

-- Actions: keep codes stable for analytics
INSERT IGNORE INTO gisa_action_lut (code, label, action_group, sort_order) VALUES
('OPEN_HIGHWAY_TRAFFIC','Open highway traffic','IMMEDIATE',10),
('CLOSE_HIGHWAY_SHOULDER','Close highway shoulder','IMMEDIATE',20),
('CLOSE_ONE_DIRECTION','Close highway one direction','IMMEDIATE',30),
('CLOSE_BOTH_DIRECTIONS','Close highway both directions','IMMEDIATE',40),
('REMOVE_DEBRIS','Remove landslide debris','IMMEDIATE',50),
('PLACE_K_RAIL','Place K-rail or fence','IMMEDIATE',60),
('COVER_SLOPE_PLASTIC','Cover slope with plastic','IMMEDIATE',70),
('DIVERT_SURFACE_WATER','Divert surface water','IMMEDIATE',80),
('REMOVE_CULVERT_BLOCKAGE','Remove culvert blockage','IMMEDIATE',90),
('DEWATER','Dewater','IMMEDIATE',100),
('TEMP_SHORING','Construct temporary shoring','IMMEDIATE',110),
('BUTTRESS_TOE','Buttress toe','IMMEDIATE',120),

('ROUTINE_VISUAL_MONITOR','Routine visual monitor','FOLLOW_UP',10),
('RECONSTRUCT_SLOPE','Reconstruct slope','FOLLOW_UP',20),
('EROSION_CONTROL','Install erosion control','FOLLOW_UP',30),
('GEOLOGIC_MAPPING','Perform geologic mapping','FOLLOW_UP',40),
('SUBSURFACE_EXPLORATION','Perform subsurface exploration','FOLLOW_UP',50),
('DETAILED_DESIGN_PLANS','Detailed design & plans','FOLLOW_UP',60);
