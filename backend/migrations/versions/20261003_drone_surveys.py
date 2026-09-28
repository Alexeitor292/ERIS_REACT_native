"""Drone surveys on a technical form: a new elevation patch over the terrain model.

Revision ID: 20261003_drone_surveys
Revises: 20261002_office_abbreviations
Create Date: 2026-10-03

A drone flight (DroneDeploy, Pix4D, Metashape, Site Scan...) exports an
elevation model (DSM/DEM GeoTIFF) and an orthomosaic. The engineer's browser
reads them and saves, per survey:

* the elevation as a compact longitude/latitude grid over the captured area
  (the "patch", an object in storage), laid over the terrain model only where
  the drone flew, so the rest of the elevation model is kept;
* the orthomosaic as an image draped over the same area, with its four corners;
* the vertical offset applied to line the drone heights up with the terrain
  model on stable ground (drone heights are often on another datum);
* the last before/after comparison of an affected area (original ground from
  the terrain model, new ground from the drone) and the points captured on both.

The original files are kept as attachments of the form when they are small
enough to upload (``dsm_attachment_id``, ``ortho_attachment_id``).

Idempotent: re-running changes nothing.
"""

from alembic import op
from sqlalchemy import text

revision = "20261003_drone_surveys"
down_revision = "20261002_office_abbreviations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.get_bind().execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS submission_drone_surveys (
              id BIGINT PRIMARY KEY AUTO_INCREMENT,
              submission_id BIGINT NOT NULL,
              label VARCHAR(160) NULL,
              source VARCHAR(64) NULL,
              captured_on DATE NULL,
              created_by_user_id BIGINT NOT NULL,
              created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              dsm_filename VARCHAR(255) NULL,
              ortho_filename VARCHAR(255) NULL,
              dsm_attachment_id BIGINT NULL,
              ortho_attachment_id BIGINT NULL,
              source_crs VARCHAR(64) NULL,
              west DOUBLE NOT NULL,
              south DOUBLE NOT NULL,
              east DOUBLE NOT NULL,
              north DOUBLE NOT NULL,
              cols INT NOT NULL,
              grid_rows INT NOT NULL,
              resolution_m DOUBLE NULL,
              patch_object_key VARCHAR(255) NOT NULL,
              patch_size_bytes INT NOT NULL,
              overlay_object_key VARCHAR(255) NULL,
              overlay_mime VARCHAR(64) NULL,
              overlay_corners_json JSON NULL,
              vertical_offset_m DOUBLE NOT NULL DEFAULT 0,
              offset_mode VARCHAR(12) NOT NULL DEFAULT 'AUTO',
              stats_json JSON NULL,
              comparison_json JSON NULL,
              points_json JSON NULL,
              CONSTRAINT fk_drone_survey_submission FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
              CONSTRAINT fk_drone_survey_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
              CONSTRAINT fk_drone_survey_dsm FOREIGN KEY (dsm_attachment_id) REFERENCES attachments(id) ON DELETE SET NULL,
              CONSTRAINT fk_drone_survey_ortho FOREIGN KEY (ortho_attachment_id) REFERENCES attachments(id) ON DELETE SET NULL,
              INDEX idx_drone_survey_submission (submission_id, id),
              CONSTRAINT chk_drone_survey_offset_mode CHECK (offset_mode IN ('AUTO', 'MANUAL', 'NONE'))
            ) ENGINE=InnoDB
            """
        )
    )


def downgrade() -> None:
    op.get_bind().execute(text("DROP TABLE IF EXISTS submission_drone_surveys"))
