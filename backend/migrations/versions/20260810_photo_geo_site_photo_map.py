# Add geospatial capture metadata for case photos.

from alembic import op

revision = '20260810_photo_geo'
down_revision = '0014_offline_scene_worker_hb'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("\n        CREATE TABLE IF NOT EXISTS attachment_capture_metadata (\n            attachment_id BIGINT PRIMARY KEY,\n            captured_at DATETIME NULL,\n            latitude DECIMAL(10,7) NULL,\n            longitude DECIMAL(10,7) NULL,\n            horizontal_accuracy_m DECIMAL(10,3) NULL,\n            altitude_m DECIMAL(10,3) NULL,\n            camera_heading_deg DECIMAL(7,3) NULL,\n            camera_heading_accuracy_code SMALLINT NULL,\n            heading_reference VARCHAR(24) NULL,\n            location_source VARCHAR(32) NULL,\n            heading_source VARCHAR(32) NULL,\n            metadata_json JSON NULL,\n            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n            CONSTRAINT fk_attachment_capture_metadata_attachment\n              FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE,\n            INDEX idx_attachment_capture_geo (latitude, longitude),\n            CONSTRAINT chk_attachment_capture_lat CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),\n            CONSTRAINT chk_attachment_capture_lon CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180)),\n            CONSTRAINT chk_attachment_capture_accuracy CHECK (horizontal_accuracy_m IS NULL OR horizontal_accuracy_m >= 0),\n            CONSTRAINT chk_attachment_capture_heading CHECK (camera_heading_deg IS NULL OR (camera_heading_deg >= 0 AND camera_heading_deg < 360)),\n            CONSTRAINT chk_attachment_capture_heading_accuracy CHECK (camera_heading_accuracy_code IS NULL OR (camera_heading_accuracy_code >= 0 AND camera_heading_accuracy_code <= 3)),\n            CONSTRAINT chk_attachment_capture_heading_ref CHECK (heading_reference IS NULL OR heading_reference IN ('TRUE_NORTH','MAGNETIC_NORTH','UNKNOWN')),\n            CONSTRAINT chk_attachment_capture_location_source CHECK (location_source IS NULL OR location_source IN ('DEVICE_AT_CAPTURE','EXIF_GPS','MANUAL','UNKNOWN')),\n            CONSTRAINT chk_attachment_capture_heading_source CHECK (heading_source IS NULL OR heading_source IN ('DEVICE_TRUE_HEADING','DEVICE_MAGNETIC_HEADING','EXIF_GPS_IMG_DIRECTION','MANUAL','UNKNOWN'))\n        ) ENGINE=InnoDB\n    ")


def downgrade() -> None:
    op.execute('DROP TABLE IF EXISTS attachment_capture_metadata')
