"""A drone survey remembers what it is compared with; forms store district and county codes.

Revision ID: 20261005_survey_baseline_codes
Revises: 20261004_notification_tasks
Create Date: 2026-10-05

1. ``submission_drone_surveys.compare_with_survey_id``: the survey of the same
   form this one is compared with (NULL: the terrain model). Everybody who
   opens the form sees the comparison its author chose. Surveys already
   measured against another survey take it from their saved comparison.
2. Technical forms saved from the web form stored the district and county as
   the form displays them ("5", "Monterey"). They are stored the way ERIS
   stores them everywhere ("05", "MON"); the API normalizes every save from now
   on, and this fixes the rows already written.

Idempotent: re-running changes nothing.
"""

from alembic import op
from sqlalchemy import text

revision = "20261005_survey_baseline_codes"
down_revision = "20261004_notification_tasks"
branch_labels = None
depends_on = None

# The 58 counties' Caltrans codes (frozen here; services/incident_name.py holds the live list).
_COUNTY_CODES = (
    "Alameda=ALA;Alpine=ALP;Amador=AMA;Butte=BUT;Calaveras=CAL;Colusa=COL;Contra Costa=CC;Del Norte=DN;"
    "El Dorado=ED;Fresno=FRE;Glenn=GLE;Humboldt=HUM;Imperial=IMP;Inyo=INY;Kern=KER;Kings=KIN;Lake=LAK;"
    "Lassen=LAS;Los Angeles=LA;Madera=MAD;Marin=MRN;Mariposa=MPA;Mendocino=MEN;Merced=MER;Modoc=MOD;Mono=MNO;"
    "Monterey=MON;Napa=NAP;Nevada=NEV;Orange=ORA;Placer=PLA;Plumas=PLU;Riverside=RIV;Sacramento=SAC;"
    "San Benito=SBT;San Bernardino=SBD;San Diego=SD;San Francisco=SF;San Joaquin=SJ;San Luis Obispo=SLO;"
    "San Mateo=SM;Santa Barbara=SB;Santa Clara=SCL;Santa Cruz=SCR;Shasta=SHA;Sierra=SIE;Siskiyou=SIS;"
    "Solano=SOL;Sonoma=SON;Stanislaus=STA;Sutter=SUT;Tehama=TEH;Trinity=TRI;Tulare=TUL;Tuolumne=TUO;"
    "Ventura=VEN;Yolo=YOL;Yuba=YUB"
)


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        text(
            """
            ALTER TABLE submission_drone_surveys
              ADD COLUMN IF NOT EXISTS compare_with_survey_id BIGINT NULL AFTER points_json
            """
        )
    )
    has_fk = bind.execute(
        text(
            """
            SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'submission_drone_surveys'
               AND CONSTRAINT_NAME = 'fk_drone_survey_compare_with'
            """
        )
    ).scalar()
    if not has_fk:
        bind.execute(
            text(
                """
                ALTER TABLE submission_drone_surveys
                  ADD CONSTRAINT fk_drone_survey_compare_with FOREIGN KEY (compare_with_survey_id)
                  REFERENCES submission_drone_surveys(id) ON DELETE SET NULL
                """
            )
        )

    # A survey last measured against another one keeps that as its comparison.
    bind.execute(
        text(
            """
            UPDATE submission_drone_surveys s
              JOIN submission_drone_surveys o
                ON o.id = CAST(JSON_UNQUOTE(JSON_EXTRACT(s.comparison_json, '$.baseline.survey_id')) AS UNSIGNED)
               AND o.submission_id = s.submission_id AND o.id <> s.id
               SET s.compare_with_survey_id = o.id
             WHERE s.compare_with_survey_id IS NULL
               AND JSON_UNQUOTE(JSON_EXTRACT(s.comparison_json, '$.baseline.kind')) = 'survey'
            """
        )
    )

    # District: one digit -> two ("5" -> "05"); "District 5" -> "05".
    bind.execute(
        text(
            """
            UPDATE submission_gisa
               SET district = LPAD(REGEXP_REPLACE(district, '[^0-9]', ''), 2, '0')
             WHERE district IS NOT NULL AND district <> ''
               AND REGEXP_REPLACE(district, '[^0-9]', '') <> ''
               AND district <> LPAD(REGEXP_REPLACE(district, '[^0-9]', ''), 2, '0')
            """
        )
    )
    # County: a name (with or without " County") -> its code.
    for pair in _COUNTY_CODES.split(";"):
        name, code = pair.split("=")
        bind.execute(
            text(
                """
                UPDATE submission_gisa SET county = :code
                 WHERE LOWER(TRIM(REGEXP_REPLACE(county, '[[:space:]]+[Cc]ounty$', ''))) = LOWER(:name)
                """
            ),
            {"code": code, "name": name},
        )


def downgrade() -> None:
    bind = op.get_bind()
    has_fk = bind.execute(
        text(
            """
            SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'submission_drone_surveys'
               AND CONSTRAINT_NAME = 'fk_drone_survey_compare_with'
            """
        )
    ).scalar()
    if has_fk:
        bind.execute(text("ALTER TABLE submission_drone_surveys DROP FOREIGN KEY fk_drone_survey_compare_with"))
    bind.execute(text("ALTER TABLE submission_drone_surveys DROP COLUMN IF EXISTS compare_with_survey_id"))
    # The district and county codes stay: they are what the rest of ERIS stores.
