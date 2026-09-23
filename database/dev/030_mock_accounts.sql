-- MOCK ACCOUNTS — development and test only (password: "password").
--
-- NEVER load this file into a production database. It lives outside
-- database/init on purpose: that directory is MariaDB's first-boot init, which
-- production shares, so it carries roles and organization structure only. A
-- production database gets its first administrator from
-- `python -m app.tools.create_admin` instead.
--
-- Load it after database/init/020_seed.sql (it grants the roles that file
-- creates) and, on a fresh database, before `alembic upgrade head`: revision
-- 20260911_org_model builds org profiles and coordinator coverage from the
-- accounts it finds. Database-agnostic, like the init files: the caller
-- selects the target DB. Idempotent.
--
-- Every address is a "mock." mailbox at dot.ca.gov so it cannot be mistaken
-- for, or collide with, a real Caltrans employee, and the notification service
-- never hands a mock address to a live relay. No real name appears here.
INSERT INTO users (email, full_name, password_hash, metadata_json, is_active)
VALUES
  ('mock.admin@dot.ca.gov', 'Mock Administrator', '$argon2id$v=19$m=65536,t=3,p=4$yGtVqjzsQ7NhszqjjQ34XA$q1k5GP/lHkwSdhCYoGYRCfj1ytWu9mDmHhYgb5BCvPU', NULL, 1),
  ('mock.maintenance.crew@dot.ca.gov', 'Mock Maintenance Crew', '$argon2id$v=19$m=65536,t=3,p=4$yGtVqjzsQ7NhszqjjQ34XA$q1k5GP/lHkwSdhCYoGYRCfj1ytWu9mDmHhYgb5BCvPU', NULL, 1),
  ('mock.coordinator.d01@dot.ca.gov', 'Mock Coordinator D01', '$argon2id$v=19$m=65536,t=3,p=4$yGtVqjzsQ7NhszqjjQ34XA$q1k5GP/lHkwSdhCYoGYRCfj1ytWu9mDmHhYgb5BCvPU', JSON_OBJECT('district', '01'), 1),
  -- Every assessment fixture creates district-04 incidents while the D01
  -- coordinator covers district 01, so without this account the "approval
  -- notifies the coordinator" assertions would pass vacuously against an empty
  -- recipient list.
  ('mock.coordinator.d04@dot.ca.gov', 'Mock Coordinator D04', '$argon2id$v=19$m=65536,t=3,p=4$yGtVqjzsQ7NhszqjjQ34XA$q1k5GP/lHkwSdhCYoGYRCfj1ytWu9mDmHhYgb5BCvPU', JSON_OBJECT('district', '04'), 1),
  ('mock.office.chief@dot.ca.gov', 'Mock Office Chief', '$argon2id$v=19$m=65536,t=3,p=4$yGtVqjzsQ7NhszqjjQ34XA$q1k5GP/lHkwSdhCYoGYRCfj1ytWu9mDmHhYgb5BCvPU', JSON_OBJECT('office_code', 'WEST', 'office_location', 'West Office'), 1),
  ('mock.branch.chief@dot.ca.gov', 'Mock Branch Chief', '$argon2id$v=19$m=65536,t=3,p=4$yGtVqjzsQ7NhszqjjQ34XA$q1k5GP/lHkwSdhCYoGYRCfj1ytWu9mDmHhYgb5BCvPU', JSON_OBJECT('office_code', 'WEST', 'office_location', 'West Office'), 1),
  -- Office-scoped: the Senior Specialist picker filters strictly on office_code,
  -- so a Senior Specialist without one is not assignable.
  ('mock.senior.specialist@dot.ca.gov', 'Mock Senior Specialist', '$argon2id$v=19$m=65536,t=3,p=4$yGtVqjzsQ7NhszqjjQ34XA$q1k5GP/lHkwSdhCYoGYRCfj1ytWu9mDmHhYgb5BCvPU', JSON_OBJECT('office_code', 'WEST', 'office_location', 'West Office'), 1),
  ('mock.staff@dot.ca.gov', 'Mock Staff', '$argon2id$v=19$m=65536,t=3,p=4$yGtVqjzsQ7NhszqjjQ34XA$q1k5GP/lHkwSdhCYoGYRCfj1ytWu9mDmHhYgb5BCvPU', NULL, 1),
  -- A second Staff member: an operational account with no authority over
  -- another Staff member's assessment, which the tests need as a bystander.
  ('mock.staff.2@dot.ca.gov', 'Mock Staff 2', '$argon2id$v=19$m=65536,t=3,p=4$yGtVqjzsQ7NhszqjjQ34XA$q1k5GP/lHkwSdhCYoGYRCfj1ytWu9mDmHhYgb5BCvPU', NULL, 1),
  -- No office and no district on purpose: a guest's reach is statewide and is
  -- not narrowed by an org link, so org metadata here would hide a bug in the
  -- guest's own scoping.
  ('mock.guest@dot.ca.gov', 'Mock Guest', '$argon2id$v=19$m=65536,t=3,p=4$yGtVqjzsQ7NhszqjjQ34XA$q1k5GP/lHkwSdhCYoGYRCfj1ytWu9mDmHhYgb5BCvPU', NULL, 1)
ON DUPLICATE KEY UPDATE
  full_name = VALUES(full_name),
  password_hash = VALUES(password_hash),
  metadata_json = VALUES(metadata_json),
  is_active = VALUES(is_active);

-- One role each. The administrator holds only ADMIN: administration is not a
-- work role, and an account that could act as every role would hide a missing
-- guard in any test that signs in as it.
INSERT IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u
JOIN roles r
WHERE
  (u.email='mock.admin@dot.ca.gov' AND r.name='ADMIN') OR
  (u.email='mock.maintenance.crew@dot.ca.gov' AND r.name='MAINTENANCE_CREW') OR
  (u.email='mock.coordinator.d01@dot.ca.gov' AND r.name='MAINTENANCE_COORDINATOR') OR
  (u.email='mock.coordinator.d04@dot.ca.gov' AND r.name='MAINTENANCE_COORDINATOR') OR
  (u.email='mock.office.chief@dot.ca.gov' AND r.name='OFFICE_CHIEF') OR
  (u.email='mock.branch.chief@dot.ca.gov' AND r.name='BRANCH_CHIEF') OR
  (u.email='mock.senior.specialist@dot.ca.gov' AND r.name='SENIOR_SPECIALIST') OR
  (u.email='mock.staff@dot.ca.gov' AND r.name='STAFF') OR
  (u.email='mock.staff.2@dot.ca.gov' AND r.name='STAFF') OR
  (u.email='mock.guest@dot.ca.gov' AND r.name='GUEST');
