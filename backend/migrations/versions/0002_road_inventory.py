"""add road inventory tables

Revision ID: 0002_road_inventory
Revises: 0001_baseline
Create Date: 2026-06-09

Adds three tables for the Caltrans road inventory reference-data pipeline:

  road_inventory_datasets  — one row per uploaded Excel file; tracks lifecycle
                             (pending → published → superseded). Only one row
                             may have status='published' at a time.

  road_segments            — normalized rows parsed from the THY_* spreadsheet.
                             FK to road_inventory_datasets.  Indexed for the
                             county + route + postmile range query used by
                             lookup and mobile enrichment.

  road_inventory_packages  — MinIO keys for generated mobile-download packages
                             (SQLite gzip). One row per (dataset_version, type).
                             Package generation is deferred to Phase 2.

county_code stores the raw 3-letter Caltrans code (e.g. 'ORA', 'SAC') as found
in THY_COUNTY_CODE.  district_code stores the string district number ('01'–'12').
"""

from alembic import op
import sqlalchemy as sa

revision = "0002_road_inventory"
down_revision = "0001_baseline"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS road_inventory_datasets (
            id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            version_tag    VARCHAR(64)  NOT NULL,
            upload_filename VARCHAR(512) NOT NULL,
            extract_date   DATE         NULL,
            row_count      INT UNSIGNED NOT NULL DEFAULT 0,
            skipped_count  INT UNSIGNED NOT NULL DEFAULT 0,
            status         ENUM('pending','published','superseded') NOT NULL DEFAULT 'pending',
            storage_key    VARCHAR(512) NULL,
            uploaded_by    BIGINT       NOT NULL,
            created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            published_at   DATETIME     NULL,
            INDEX idx_rid_status (status),
            INDEX idx_rid_published (status, published_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS road_segments (
            id                              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            dataset_version_id              BIGINT UNSIGNED NOT NULL,
            thy_id                          BIGINT          NULL,
            district_code                   VARCHAR(8)      NULL,
            county_code                     VARCHAR(8)      NOT NULL,
            route_name                      VARCHAR(16)     NOT NULL,
            route_suffix_code               VARCHAR(4)      NULL,
            pm_prefix_code                  VARCHAR(4)      NULL,
            begin_pm                        DECIMAL(10,4)   NOT NULL,
            end_pm                          DECIMAL(10,4)   NOT NULL,
            pm_suffix_code                  VARCHAR(4)      NULL,
            length_miles                    DECIMAL(10,4)   NULL,
            left_lanes                      TINYINT UNSIGNED NULL,
            right_lanes                     TINYINT UNSIGNED NULL,
            left_surface_type               VARCHAR(8)      NULL,
            right_surface_type              VARCHAR(8)      NULL,
            left_shoulder_width             DECIMAL(6,2)    NULL,
            right_shoulder_width            DECIMAL(6,2)    NULL,
            median_type                     VARCHAR(8)      NULL,
            median_width                    DECIMAL(6,2)    NULL,
            access_code                     VARCHAR(4)      NULL,
            terrain_code                    VARCHAR(4)      NULL,
            design_speed                    SMALLINT        NULL,
            adt                             INT UNSIGNED    NULL,
            landmark_short_desc             VARCHAR(255)    NULL,
            functional_class_code           VARCHAR(8)      NULL,
            maintenance_service_level_code  VARCHAR(8)      NULL,
            federal_aid_code                VARCHAR(8)      NULL,
            scenic_freeway_code             VARCHAR(8)      NULL,
            extract_date                    DATE            NULL,
            raw_json                        JSON            NULL,
            created_at                      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_rs_lookup (dataset_version_id, county_code, route_name, begin_pm, end_pm),
            INDEX idx_rs_district (dataset_version_id, district_code, county_code, route_name),
            CONSTRAINT fk_rs_dataset FOREIGN KEY (dataset_version_id)
                REFERENCES road_inventory_datasets(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS road_inventory_packages (
            id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            dataset_version_id BIGINT UNSIGNED NOT NULL,
            package_type       ENUM('sqlite_gz') NOT NULL,
            storage_key        VARCHAR(512)     NOT NULL,
            file_size_bytes    BIGINT UNSIGNED  NOT NULL,
            sha256             CHAR(64)         NOT NULL,
            generated_at       DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_rip_version_type (dataset_version_id, package_type),
            CONSTRAINT fk_rip_dataset FOREIGN KEY (dataset_version_id)
                REFERENCES road_inventory_datasets(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS road_inventory_packages")
    op.execute("DROP TABLE IF EXISTS road_segments")
    op.execute("DROP TABLE IF EXISTS road_inventory_datasets")
