-- Database-agnostic seed (no `USE <db>;`): the caller selects the target DB
-- (docker-entrypoint MARIADB_DATABASE, or `mysql <dbname> < 020_seed.sql`).
INSERT INTO roles (name, description) VALUES
('FIELD_WORKER', 'Can create and submit field reports'),
('MAINTENANCE', 'Can create maintenance incident reports'),
('MAINT_COORDINATOR', 'Can triage maintenance incidents and forward to office chiefs'),
('OFFICE_CHIEF', 'Can route incidents to branch chiefs'),
('BRANCH_CHIEF', 'Can assign incidents to Staff'),
('REVIEWER', 'Can review submitted reports'),
('ADMIN', 'Can manage users, forms, and approvals'),
-- Canonical Assessment-model roles (additive; legacy roles above still work
-- via app/roles.py aliasing). See migration 0008_assessment_domain.
('MAINTENANCE_FIELD_WORKER', 'Maintenance field worker: creates and follows own incident reports'),
('MAINTENANCE_COORDINATOR', 'Maintenance coordinator: triages incident reports and routes assessments'),
('GEOTECH_OFFICE_CHIEF', 'GeoTech office chief: delegates assessments to branch chiefs'),
('GEOTECH_BRANCH_CHIEF', 'GeoTech branch chief: assigns Staff to assessments'),
('GEOTECH_ENGINEER', 'GeoTech Staff: completes assessments / technical form'),
-- Routing v2 (migration 20260910_routing_v2): the office chief may assign a
-- senior engineer directly instead of handing off to a branch chief.
('GEOTECH_SENIOR_ENGINEER', 'GeoTech senior engineer: fills assessments assigned directly by the office chief'),
-- Org model (migration 20260911_org_model): read-only access to APPROVED
-- records for everyone else in Caltrans. Deliberately NOT an operational role —
-- OPERATIONAL_ROLES is state-blind, so a viewer added there would see every
-- draft in the state. Distinct from the legacy REVIEWER role, which keeps broad
-- operational read and is deprecated.
('CALTRANS_VIEWER', 'Viewer: read-only access to approved records')
ON DUPLICATE KEY UPDATE description = VALUES(description);

-- Example admin user (password: "password", hashed with argon2id)
INSERT INTO users (email, full_name, password_hash, is_active)
VALUES ('admin@local', 'Local Admin', '$argon2id$v=19$m=65536,t=3,p=4$yGtVqjzsQ7NhszqjjQ34XA$q1k5GP/lHkwSdhCYoGYRCfj1ytWu9mDmHhYgb5BCvPU', 1)
ON DUPLICATE KEY UPDATE
  full_name = VALUES(full_name),
  password_hash = VALUES(password_hash),
  is_active = VALUES(is_active);

-- Dev users (password: "password")
INSERT INTO users (email, full_name, password_hash, metadata_json, is_active)
VALUES
  ('maintenance@local', 'Local Maintenance', '$argon2id$v=19$m=65536,t=3,p=4$yGtVqjzsQ7NhszqjjQ34XA$q1k5GP/lHkwSdhCYoGYRCfj1ytWu9mDmHhYgb5BCvPU', NULL, 1),
  ('coordinator@local', 'Local Coordinator', '$argon2id$v=19$m=65536,t=3,p=4$yGtVqjzsQ7NhszqjjQ34XA$q1k5GP/lHkwSdhCYoGYRCfj1ytWu9mDmHhYgb5BCvPU', JSON_OBJECT('district', '01'), 1),
  ('officechief@local', 'Local Office Chief', '$argon2id$v=19$m=65536,t=3,p=4$yGtVqjzsQ7NhszqjjQ34XA$q1k5GP/lHkwSdhCYoGYRCfj1ytWu9mDmHhYgb5BCvPU', JSON_OBJECT('office_code', 'WEST', 'office_location', 'West Office'), 1),
  ('branchchief@local', 'Local Branch Chief', '$argon2id$v=19$m=65536,t=3,p=4$yGtVqjzsQ7NhszqjjQ34XA$q1k5GP/lHkwSdhCYoGYRCfj1ytWu9mDmHhYgb5BCvPU', JSON_OBJECT('office_code', 'WEST', 'office_location', 'West Office'), 1),
  ('engineer@local', 'Local Staff', '$argon2id$v=19$m=65536,t=3,p=4$yGtVqjzsQ7NhszqjjQ34XA$q1k5GP/lHkwSdhCYoGYRCfj1ytWu9mDmHhYgb5BCvPU', NULL, 1),
  ('reviewer@local', 'Local Reviewer', '$argon2id$v=19$m=65536,t=3,p=4$yGtVqjzsQ7NhszqjjQ34XA$q1k5GP/lHkwSdhCYoGYRCfj1ytWu9mDmHhYgb5BCvPU', NULL, 1),
  -- Routing v2: office-scoped senior engineer. The picker filters strictly on
  -- office_code, so a senior engineer without one is not assignable.
  ('seniorengineer@local', 'Local Senior Engineer', '$argon2id$v=19$m=65536,t=3,p=4$yGtVqjzsQ7NhszqjjQ34XA$q1k5GP/lHkwSdhCYoGYRCfj1ytWu9mDmHhYgb5BCvPU', JSON_OBJECT('office_code', 'WEST', 'office_location', 'West Office'), 1),
  -- Routing v2: a coordinator in district 04. Every assessment fixture creates
  -- district-04 incidents while coordinator@local is district 01, so without
  -- this account the "approval notifies the coordinator" assertions would pass
  -- vacuously against an empty recipient list.
  ('coordinator04@local', 'Local Coordinator D04', '$argon2id$v=19$m=65536,t=3,p=4$yGtVqjzsQ7NhszqjjQ34XA$q1k5GP/lHkwSdhCYoGYRCfj1ytWu9mDmHhYgb5BCvPU', JSON_OBJECT('district', '04'), 1),
  -- Org model: a read-only viewer. No office and no district on purpose — a
  -- viewer's reach is statewide and is not narrowed by an org link, so an
  -- account with org metadata would hide a bug in the viewer's own scoping.
  ('viewer@local', 'Local Viewer', '$argon2id$v=19$m=65536,t=3,p=4$yGtVqjzsQ7NhszqjjQ34XA$q1k5GP/lHkwSdhCYoGYRCfj1ytWu9mDmHhYgb5BCvPU', NULL, 1)
ON DUPLICATE KEY UPDATE
  full_name = VALUES(full_name),
  password_hash = VALUES(password_hash),
  metadata_json = VALUES(metadata_json),
  is_active = VALUES(is_active);


-- Give admin all roles
INSERT IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u
JOIN roles r
WHERE u.email='admin@local' AND r.name IN (
  'ADMIN',
  'REVIEWER',
  'FIELD_WORKER',
  'MAINTENANCE',
  'MAINT_COORDINATOR',
  'OFFICE_CHIEF',
  'BRANCH_CHIEF'
);

-- Dev role mapping (one primary role each)
INSERT IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u
JOIN roles r
WHERE
  (u.email='maintenance@local' AND r.name='MAINTENANCE') OR
  (u.email='coordinator@local' AND r.name='MAINT_COORDINATOR') OR
  (u.email='officechief@local' AND r.name='OFFICE_CHIEF') OR
  (u.email='branchchief@local' AND r.name='BRANCH_CHIEF') OR
  (u.email='engineer@local' AND r.name='FIELD_WORKER') OR
  (u.email='reviewer@local' AND r.name='REVIEWER') OR
  (u.email='seniorengineer@local' AND r.name='GEOTECH_SENIOR_ENGINEER') OR
  (u.email='coordinator04@local' AND r.name='MAINT_COORDINATOR') OR
  (u.email='viewer@local' AND r.name='CALTRANS_VIEWER');


-- ---------------------------------------------------------------------------
-- Organization structure (org model, design §10)
-- ---------------------------------------------------------------------------
-- STRUCTURE ONLY: five offices, the twelve districts they serve and the
-- seventeen branches. No chief, no member, and no real employee name from any
-- chart appears in any row (owner decision 6) — roles are never bound to named
-- people. org_branch_districts is deliberately left EMPTY: no chart states
-- branch-to-district coverage for any office, so the first row entered will be
-- somebody's judgement and belongs to an admin, labelled INFERRED.
--
-- WHY THE GUARD: the org_* tables are created by Alembic revision
-- 20260911_org_model, and on BOTH fresh-install paths this file runs BEFORE that
-- revision — the MariaDB docker-entrypoint loads database/init/*.sql at first
-- start, and CI loads 010 + 020 and only then runs `alembic stamp 0001_baseline
-- && alembic upgrade head`. Unguarded, a fresh `docker compose up` would die on
-- "Table 'eris.org_offices' doesn't exist" before the backend ever started. The
-- procedure makes this section a silent no-op in that window (the revision seeds
-- exactly these rows) and effective when the file is re-applied to an
-- already-migrated database, which is the documented dev re-seed.
--
-- Every insert is an anti-join on the same stable natural key the revision uses
-- — offices (org_type, code), office districts (office_id, district), branches
-- (office_id, unit_type, letter) — never the generated uniqueness columns, whose
-- value is NULL on a deactivated row. So re-running never duplicates a row and
-- never overwrites an admin's edit.
DELIMITER //
DROP PROCEDURE IF EXISTS eris_seed_org_structure//
CREATE PROCEDURE eris_seed_org_structure()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'org_offices'
  ) THEN

    INSERT INTO org_offices
      (code, org_type, unit_number, name, short_name, home_city, home_district,
       home_location_label, is_routing_target, is_active, sort_order)
    SELECT s.code, 'GEOTECH', s.unit_number, s.name, s.short_name, s.home_city,
           s.home_district, s.home_location_label, s.is_routing_target, 1, s.sort_order
      FROM (
        SELECT 'WEST' AS code, '59-315' AS unit_number,
               'Office of Geotechnical Design West' AS name,
               'West GeoTech Office' AS short_name,
               'Oakland' AS home_city, '04' AS home_district,
               NULL AS home_location_label, 1 AS is_routing_target, 10 AS sort_order
        UNION ALL SELECT 'NORTH', '59-323', 'Office of Geotechnical Design North',
               'North GeoTech Office', 'Sacramento', NULL, 'Translab', 1, 20
        UNION ALL SELECT 'SOUTH', '59-324', 'Office of Geotechnical Design South',
               'South GeoTech Office', 'Los Angeles', '07', NULL, 1, 30
        -- POLICY is shaped inversely to the three design offices and SUPPORT has
        -- no chart at all, so neither is offered for a district incident.
        UNION ALL SELECT 'POLICY', '59-325',
               'Office of Geotechnical Design Policies & Practices',
               NULL, 'Sacramento', NULL, 'Translab', 0, 40
        UNION ALL SELECT 'SUPPORT', '59-316', 'Office of Geotechnical Support',
               NULL, 'Sacramento', NULL, 'Translab', 0, 50
      ) s
      LEFT JOIN org_offices o ON o.org_type = 'GEOTECH' AND o.code = s.code
     WHERE o.id IS NULL;

    INSERT INTO org_office_districts (office_id, org_type, district, is_primary, is_active)
    SELECT o.id, 'GEOTECH', s.district, 1, 1
      FROM (
        SELECT 'WEST' AS office_code, '01' AS district
        UNION ALL SELECT 'WEST', '04'
        UNION ALL SELECT 'WEST', '05'
        UNION ALL SELECT 'NORTH', '02'
        UNION ALL SELECT 'NORTH', '03'
        UNION ALL SELECT 'NORTH', '06'
        UNION ALL SELECT 'NORTH', '09'
        UNION ALL SELECT 'NORTH', '10'
        UNION ALL SELECT 'SOUTH', '07'
        UNION ALL SELECT 'SOUTH', '08'
        UNION ALL SELECT 'SOUTH', '11'
        UNION ALL SELECT 'SOUTH', '12'
      ) s
      JOIN org_offices o ON o.org_type = 'GEOTECH' AND o.code = s.office_code
      LEFT JOIN org_office_districts d ON d.office_id = o.id AND d.district = s.district
     WHERE d.id IS NULL;

    -- Seventeen branches: WEST 6 + NORTH 4 + SOUTH 5 + POLICY 2 + SUPPORT 0.
    -- `name` is the PRINTED name per office and the letter is stored separately,
    -- because the printed label is not a stable key. SOUTH Branch E is proposed
    -- and unstaffed, so accepts_assignments = 0 keeps it out of every picker
    -- while the structure stays complete.
    INSERT INTO org_branches
      (office_id, parent_branch_id, unit_type, letter, name, home_city, home_district,
       home_location_label, chief_user_id, accepts_assignments, is_active, sort_order)
    SELECT o.id, NULL, 'BRANCH', s.letter, s.name, s.home_city, s.home_district,
           s.home_location_label, NULL, s.accepts_assignments, 1, s.sort_order
      FROM (
        SELECT 'WEST' AS office_code, 'A' AS letter, 'Branch A' AS name,
               'Oakland' AS home_city, '04' AS home_district,
               NULL AS home_location_label, 1 AS accepts_assignments, 1 AS sort_order
        UNION ALL SELECT 'WEST', 'B', 'Branch B', 'Oakland', '04', NULL, 1, 2
        UNION ALL SELECT 'WEST', 'C', 'Branch C', 'Oakland', '04', NULL, 1, 3
        UNION ALL SELECT 'WEST', 'D', 'Branch D', 'Oakland', '04', NULL, 1, 4
        UNION ALL SELECT 'WEST', 'E', 'Branch E', 'San Luis Obispo', '05', NULL, 1, 5
        UNION ALL SELECT 'WEST', 'F', 'Branch F', 'Eureka', '01', NULL, 1, 6
        UNION ALL SELECT 'NORTH', 'A', 'Districts Branch A', 'Sacramento', NULL, 'Translab', 1, 1
        UNION ALL SELECT 'NORTH', 'B', 'Districts Branch B', 'Sacramento', NULL, 'Translab', 1, 2
        UNION ALL SELECT 'NORTH', 'C', 'Districts Branch C', 'Sacramento', NULL, 'Translab', 1, 3
        UNION ALL SELECT 'NORTH', 'D', 'Districts Branch D', 'Sacramento', NULL, 'Translab', 1, 4
        UNION ALL SELECT 'SOUTH', 'A', 'Branch A', 'Los Angeles', '07', NULL, 1, 1
        UNION ALL SELECT 'SOUTH', 'B', 'Branch B', 'San Diego', '11', NULL, 1, 2
        UNION ALL SELECT 'SOUTH', 'C', 'Branch C', 'Santa Ana', '12', NULL, 1, 3
        UNION ALL SELECT 'SOUTH', 'D', 'Branch D', 'Los Angeles', '07', NULL, 1, 4
        UNION ALL SELECT 'SOUTH', 'E', 'Branch E', 'San Bernardino', '08', NULL, 0, 5
        UNION ALL SELECT 'POLICY', 'A',
               'Structure Foundation & Roadway Geotechnical Design Branch A',
               'Sacramento', NULL, 'Translab', 1, 1
        UNION ALL SELECT 'POLICY', 'B',
               'Structure Foundation & Roadway Geotechnical Design Branch B',
               'Sacramento', NULL, 'Translab', 1, 2
      ) s
      JOIN org_offices o ON o.org_type = 'GEOTECH' AND o.code = s.office_code
      LEFT JOIN org_branches b
        ON b.office_id = o.id AND b.unit_type = 'BRANCH' AND b.letter = s.letter
     WHERE b.id IS NULL;

  END IF;
END//
DELIMITER ;
CALL eris_seed_org_structure();
DROP PROCEDURE IF EXISTS eris_seed_org_structure;
