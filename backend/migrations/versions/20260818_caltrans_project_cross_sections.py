"""Persist terrain cross sections under Caltrans Projects.

Revision ID: 20260818_xsection_projects
Revises: 20260818_event_group_approval
Create Date: 2026-08-18

This Project domain is intentionally separate from Incident Event Groups.
ERIS creates temporary/manual Project reference rows today. A future Caltrans
Project database adapter can populate the same reference table without changing
cross-section identities or their saved control points/profile snapshots.
"""

from alembic import op

revision = "20260818_xsection_projects"
down_revision = "20260818_event_group_approval"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE caltrans_projects (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          project_key VARCHAR(64) NOT NULL,
          project_number VARCHAR(128) NULL,
          title VARCHAR(255) NOT NULL,
          description TEXT NULL,
          district VARCHAR(64) NULL,
          status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
          source_system VARCHAR(32) NOT NULL DEFAULT 'ERIS_MANUAL',
          external_project_id VARCHAR(255) NULL,
          source_metadata_json JSON NULL,
          last_synced_at DATETIME NULL,
          created_by_user_id BIGINT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_caltrans_projects_key (project_key),
          UNIQUE KEY uk_caltrans_projects_external (source_system, external_project_id),
          INDEX idx_caltrans_projects_number (project_number),
          INDEX idx_caltrans_projects_status (status),
          INDEX idx_caltrans_projects_source (source_system),
          CONSTRAINT fk_caltrans_projects_created_by
            FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
          CONSTRAINT chk_caltrans_projects_status
            CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')),
          CONSTRAINT chk_caltrans_projects_source
            CHECK (source_system IN ('ERIS_MANUAL', 'CALTRANS_PROJECT_DB'))
        ) ENGINE=InnoDB
        """
    )

    op.execute(
        """
        CREATE TABLE terrain_cross_sections (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          cross_section_key VARCHAR(64) NOT NULL,
          caltrans_project_id BIGINT NOT NULL,
          name VARCHAR(255) NOT NULL,
          notes TEXT NULL,
          preferred_spacing_m DOUBLE NULL,
          actual_spacing_m DOUBLE NULL,
          dem_source VARCHAR(128) NOT NULL DEFAULT 'ARCGIS_WORLD_ELEVATION',
          profile_snapshot_json JSON NULL,
          created_by_user_id BIGINT NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_terrain_cross_sections_key (cross_section_key),
          INDEX idx_terrain_cross_sections_project (caltrans_project_id, updated_at),
          INDEX idx_terrain_cross_sections_created_by (created_by_user_id),
          CONSTRAINT fk_terrain_cross_sections_project
            FOREIGN KEY (caltrans_project_id) REFERENCES caltrans_projects(id) ON DELETE RESTRICT,
          CONSTRAINT fk_terrain_cross_sections_created_by
            FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
          CONSTRAINT chk_terrain_cross_sections_preferred_spacing
            CHECK (preferred_spacing_m IS NULL OR preferred_spacing_m > 0),
          CONSTRAINT chk_terrain_cross_sections_actual_spacing
            CHECK (actual_spacing_m IS NULL OR actual_spacing_m > 0)
        ) ENGINE=InnoDB
        """
    )

    op.execute(
        """
        CREATE TABLE terrain_cross_section_points (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          cross_section_id BIGINT NOT NULL,
          sequence_number INT NOT NULL,
          latitude DECIMAL(10,7) NOT NULL,
          longitude DECIMAL(10,7) NOT NULL,
          distance_m DOUBLE NULL,
          elevation_m DOUBLE NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uk_terrain_cross_section_point_sequence (cross_section_id, sequence_number),
          INDEX idx_terrain_cross_section_points_section (cross_section_id),
          CONSTRAINT fk_terrain_cross_section_points_section
            FOREIGN KEY (cross_section_id) REFERENCES terrain_cross_sections(id) ON DELETE CASCADE,
          CONSTRAINT chk_terrain_cross_section_points_sequence CHECK (sequence_number >= 1),
          CONSTRAINT chk_terrain_cross_section_points_lat CHECK (latitude >= -90 AND latitude <= 90),
          CONSTRAINT chk_terrain_cross_section_points_lon CHECK (longitude >= -180 AND longitude <= 180),
          CONSTRAINT chk_terrain_cross_section_points_distance CHECK (distance_m IS NULL OR distance_m >= 0)
        ) ENGINE=InnoDB
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE terrain_cross_section_points")
    op.execute("DROP TABLE terrain_cross_sections")
    op.execute("DROP TABLE caltrans_projects")
