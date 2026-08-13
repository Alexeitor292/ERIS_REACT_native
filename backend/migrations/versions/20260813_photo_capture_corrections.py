# Add append-only manual correction history for photo capture metadata.

from alembic import op

revision = '20260813_photo_corr'
down_revision = '20260810_photo_geo'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS attachment_capture_corrections (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            attachment_id BIGINT NOT NULL,
            client_correction_uuid VARCHAR(64) NOT NULL,
            corrected_by_user_id BIGINT NOT NULL,
            location_is_override TINYINT NOT NULL DEFAULT 0,
            latitude DECIMAL(10,7) NULL,
            longitude DECIMAL(10,7) NULL,
            heading_is_override TINYINT NOT NULL DEFAULT 0,
            camera_heading_deg DECIMAL(7,3) NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_attachment_capture_correction_attachment
              FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE,
            CONSTRAINT fk_attachment_capture_correction_user
              FOREIGN KEY (corrected_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
            UNIQUE KEY uk_attachment_capture_correction_client_uuid (client_correction_uuid),
            INDEX idx_attachment_capture_correction_latest (attachment_id, id),
            CONSTRAINT chk_attachment_capture_correction_location_flag
              CHECK (location_is_override IN (0,1)),
            CONSTRAINT chk_attachment_capture_correction_heading_flag
              CHECK (heading_is_override IN (0,1)),
            CONSTRAINT chk_attachment_capture_correction_location_pair
              CHECK ((location_is_override = 0 AND latitude IS NULL AND longitude IS NULL)
                     OR (location_is_override = 1 AND latitude IS NOT NULL AND longitude IS NOT NULL)),
            CONSTRAINT chk_attachment_capture_correction_lat
              CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),
            CONSTRAINT chk_attachment_capture_correction_lon
              CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180)),
            CONSTRAINT chk_attachment_capture_correction_heading_state
              CHECK ((heading_is_override = 0 AND camera_heading_deg IS NULL)
                     OR (heading_is_override = 1 AND camera_heading_deg IS NOT NULL)),
            CONSTRAINT chk_attachment_capture_correction_heading
              CHECK (camera_heading_deg IS NULL OR (camera_heading_deg >= 0 AND camera_heading_deg < 360))
        ) ENGINE=InnoDB
    """)


def downgrade() -> None:
    op.execute('DROP TABLE IF EXISTS attachment_capture_corrections')
