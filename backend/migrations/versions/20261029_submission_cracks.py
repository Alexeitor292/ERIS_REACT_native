"""Cracks as their own records: submission_gisa_cracks.

Revision ID: 20261029_submission_cracks
Revises: 20261028_user_sessions
Create Date: 2026-10-29

GISA-001 asks to "map cracks": each crack's location, length, width,
horizontal and vertical displacement, depth and direction. The form held one
crack in four columns of ``submission_gisa``. Every crack is now its own row
with the same fields, its own photo and the labels drawn on that photo.

The upgrade moves each form's four crack values into its Crack 1, marks the
form "Pavement/Ground Cracks: Yes", and drops the four columns. A fresh
install (database/init/010_schema.sql) already has the table and not the
columns, so there it only checks. Idempotent: re-running changes nothing.

The downgrade puts the columns back and fills them from each form's first
crack; further cracks cannot be represented there and are dropped with the
table.
"""

from alembic import op
from sqlalchemy import text

revision = "20261029_submission_cracks"
down_revision = "20261028_user_sessions"
branch_labels = None
depends_on = None

OLD_COLUMNS = ("crack_length_ft", "crack_horizontal_in", "crack_vertical_in", "crack_depth_in")

# Kept identical to database/init/010_schema.sql (tests/test_crack_schema.py checks).
CREATE_CRACKS = """
CREATE TABLE IF NOT EXISTS submission_gisa_cracks (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    submission_id BIGINT NOT NULL,
    client_uuid CHAR(36) NOT NULL,
    sort_order INT NOT NULL,
    label VARCHAR(80) NULL,
    latitude DECIMAL(10,7) NULL,
    longitude DECIMAL(10,7) NULL,
    location_source VARCHAR(16) NULL,
    geometry_json JSON NULL,
    trend_deg DECIMAL(5,1) NULL,
    orientation VARCHAR(16) NULL,
    length_ft DECIMAL(10,2) NULL,
    width_in DECIMAL(10,2) NULL,
    horizontal_disp_in DECIMAL(10,2) NULL,
    vertical_disp_in DECIMAL(10,2) NULL,
    depth_in DECIMAL(10,2) NULL,
    notes TEXT NULL,
    photo_attachment_id BIGINT NULL,
    annotations_json JSON NULL,
    revision INT NOT NULL DEFAULT 1,
    created_by_user_id BIGINT NOT NULL,
    updated_by_user_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_gisa_crack_client_uuid UNIQUE (client_uuid),
    CONSTRAINT fk_gisa_crack_submission
      FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
    CONSTRAINT fk_gisa_crack_photo
      FOREIGN KEY (photo_attachment_id) REFERENCES attachments(id) ON DELETE SET NULL,
    CONSTRAINT fk_gisa_crack_creator
      FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_gisa_crack_editor
      FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_gisa_crack_submission (submission_id, sort_order, id),
    CONSTRAINT chk_gisa_crack_location_pair
      CHECK ((latitude IS NULL) = (longitude IS NULL)),
    CONSTRAINT chk_gisa_crack_lat CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),
    CONSTRAINT chk_gisa_crack_lon CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180)),
    CONSTRAINT chk_gisa_crack_location_source
      CHECK (location_source IS NULL OR location_source IN ('PHOTO', 'MAP', 'MANUAL')),
    CONSTRAINT chk_gisa_crack_trend CHECK (trend_deg IS NULL OR (trend_deg >= 0 AND trend_deg < 180)),
    CONSTRAINT chk_gisa_crack_orientation
      CHECK (orientation IS NULL OR orientation IN ('LONGITUDINAL', 'TRANSVERSE', 'DIAGONAL', 'ARCUATE', 'OTHER')),
    CONSTRAINT chk_gisa_crack_measures CHECK (
      (length_ft IS NULL OR length_ft >= 0) AND (width_in IS NULL OR width_in >= 0)
      AND (horizontal_disp_in IS NULL OR horizontal_disp_in >= 0)
      AND (vertical_disp_in IS NULL OR vertical_disp_in >= 0) AND (depth_in IS NULL OR depth_in >= 0))
) ENGINE=InnoDB
"""


def _gisa_columns(bind) -> set[str]:
    rows = bind.execute(text("""
        SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'submission_gisa'
    """)).scalars().all()
    return {str(name) for name in rows}


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(text(CREATE_CRACKS))
    move_old_crack_columns(bind)


def move_old_crack_columns(bind) -> None:
    """Each form's four crack values become its Crack 1; then the columns go.

    Separate from ``upgrade`` so tests/test_cracks_db.py can run it against
    columns it puts back, since a fresh schema has none to move.
    """
    present = [column for column in OLD_COLUMNS if column in _gisa_columns(bind)]
    if not present:
        return
    if len(present) == len(OLD_COLUMNS):
        any_value = " OR ".join(f"g.{column} IS NOT NULL" for column in OLD_COLUMNS)
        # A measured crack is a crack: Crack 1, by whoever owns the form.
        bind.execute(text(f"""
            INSERT INTO submission_gisa_cracks (
                submission_id, client_uuid, sort_order, length_ft, horizontal_disp_in,
                vertical_disp_in, depth_in, created_by_user_id, updated_by_user_id
            )
            SELECT g.submission_id, UUID(), 1, g.crack_length_ft, g.crack_horizontal_in,
                   g.crack_vertical_in, g.crack_depth_in, s.created_by_user_id, g.updated_by_user_id
            FROM submission_gisa g
            JOIN submissions s ON s.id = g.submission_id
            WHERE ({any_value})
              AND NOT EXISTS (SELECT 1 FROM submission_gisa_cracks c WHERE c.submission_id = g.submission_id)
        """))
        bind.execute(text(f"""
            UPDATE submission_gisa g SET g.pavement_ground_cracks = 1
            WHERE ({any_value}) AND g.pavement_ground_cracks <> 1
        """))
    bind.execute(text(
        "ALTER TABLE submission_gisa " + ", ".join(f"DROP COLUMN IF EXISTS {column}" for column in present)
    ))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text(
        "ALTER TABLE submission_gisa "
        + ", ".join(f"ADD COLUMN IF NOT EXISTS {column} DECIMAL(10,2) NULL" for column in OLD_COLUMNS)
    ))
    bind.execute(text("""
        UPDATE submission_gisa g
        JOIN submission_gisa_cracks c ON c.id = (
            SELECT c2.id FROM submission_gisa_cracks c2
            WHERE c2.submission_id = g.submission_id ORDER BY c2.sort_order, c2.id LIMIT 1
        )
        SET g.crack_length_ft = c.length_ft, g.crack_horizontal_in = c.horizontal_disp_in,
            g.crack_vertical_in = c.vertical_disp_in, g.crack_depth_in = c.depth_in
    """))
    bind.execute(text("DROP TABLE IF EXISTS submission_gisa_cracks"))
