-- ============================================================
-- PROJECTS (operational parent of one or more incidents)
-- ============================================================

CREATE TABLE IF NOT EXISTS projects (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    project_uuid VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    description TEXT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
    district VARCHAR(64) NULL,
    county VARCHAR(64) NULL,
    route VARCHAR(64) NULL,
    post_mile VARCHAR(64) NULL,
    latitude DECIMAL(10,6) NULL,
    longitude DECIMAL(10,6) NULL,
    created_from_incident_id BIGINT NULL,
    created_by_user_id BIGINT NOT NULL,
    closed_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_projects_created_from_incident FOREIGN KEY (created_from_incident_id)
      REFERENCES incidents(id) ON DELETE SET NULL,
    CONSTRAINT fk_projects_created_by FOREIGN KEY (created_by_user_id)
      REFERENCES users(id) ON DELETE RESTRICT,

    INDEX idx_projects_status (status),
    INDEX idx_projects_district_status (district, status),
    INDEX idx_projects_route_status (route, status),
    INDEX idx_projects_geo (latitude, longitude),
    CONSTRAINT chk_projects_status CHECK (status IN ('ACTIVE', 'CLOSED', 'ARCHIVED')),
    CONSTRAINT chk_projects_lat CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),
    CONSTRAINT chk_projects_lon CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180))
) ENGINE=InnoDB;

ALTER TABLE incidents
  ADD COLUMN project_id BIGINT NULL,
  ADD COLUMN project_assigned_by_user_id BIGINT NULL,
  ADD COLUMN project_assigned_at DATETIME NULL,
  ADD COLUMN project_association_notes TEXT NULL,
  ADD INDEX idx_incidents_project (project_id),
  ADD INDEX idx_incidents_project_stage (project_id, current_stage, status),
  ADD CONSTRAINT fk_incidents_project FOREIGN KEY (project_id)
    REFERENCES projects(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_incidents_project_assigned_by FOREIGN KEY (project_assigned_by_user_id)
    REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS project_events (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    project_id BIGINT NOT NULL,
    incident_id BIGINT NULL,
    actor_user_id BIGINT NOT NULL,
    event_type VARCHAR(48) NOT NULL,
    notes TEXT NULL,
    metadata_json JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_project_events_project FOREIGN KEY (project_id)
      REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_project_events_incident FOREIGN KEY (incident_id)
      REFERENCES incidents(id) ON DELETE SET NULL,
    CONSTRAINT fk_project_events_actor FOREIGN KEY (actor_user_id)
      REFERENCES users(id) ON DELETE RESTRICT,

    INDEX idx_project_events_project (project_id, created_at),
    INDEX idx_project_events_incident (incident_id, created_at),
    INDEX idx_project_events_type (event_type, created_at)
) ENGINE=InnoDB;
