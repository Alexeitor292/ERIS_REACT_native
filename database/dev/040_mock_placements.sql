-- MOCK ACCOUNTS' PLACES — development and test only. Run AFTER
-- `alembic upgrade head` (the org tables come from migrations), after
-- 030_mock_accounts.sql. NEVER load into a production database.
--
-- A role comes only from where a person sits (services/org_tree.py), so every
-- mock account with a work role sits somewhere real:
--   mock.office.chief       West office chief
--   mock.senior.specialist  West senior specialist
--   mock.branch.chief       chief of West Branch A
--   mock.staff, mock.staff.2  staff in West Branch A
--   mock.coordinator.d01/.d04  coordinators of districts 01 and 04
--   mock.maintenance.crew   crew of district 01
--   mock.admin              administrator, placed nowhere (administrators need no place)
--   mock.guest              nowhere: a guest
-- Idempotent.

SET @west := (SELECT id FROM org_offices WHERE code = 'WEST' AND org_type = 'GEOTECH' LIMIT 1);
SET @branch_a := (SELECT id FROM org_branches WHERE office_id = @west AND letter = 'A' AND is_active = 1 ORDER BY id LIMIT 1);

INSERT IGNORE INTO org_user_profiles (user_id, source)
SELECT id, 'MANUAL' FROM users WHERE email LIKE 'mock.%@dot.ca.gov';

UPDATE org_user_profiles p JOIN users u ON u.id = p.user_id
   SET p.office_id = @west, p.branch_id = NULL, p.tree_position = 'OFFICE_CHIEF'
 WHERE u.email = 'mock.office.chief@dot.ca.gov';
UPDATE org_user_profiles p JOIN users u ON u.id = p.user_id
   SET p.office_id = @west, p.branch_id = NULL, p.tree_position = 'SENIOR_SPECIALIST'
 WHERE u.email = 'mock.senior.specialist@dot.ca.gov';
UPDATE org_user_profiles p JOIN users u ON u.id = p.user_id
   SET p.office_id = @west, p.branch_id = @branch_a, p.tree_position = 'BRANCH_CHIEF'
 WHERE u.email = 'mock.branch.chief@dot.ca.gov';
UPDATE org_user_profiles p JOIN users u ON u.id = p.user_id
   SET p.office_id = @west, p.branch_id = @branch_a, p.tree_position = 'STAFF'
 WHERE u.email IN ('mock.staff@dot.ca.gov', 'mock.staff.2@dot.ca.gov');
UPDATE org_branches
   SET chief_user_id = (SELECT id FROM users WHERE email = 'mock.branch.chief@dot.ca.gov')
 WHERE id = @branch_a;

INSERT INTO org_coordinator_coverage (district, user_id, is_primary, is_active)
SELECT '01', id, 1, 1 FROM users WHERE email = 'mock.coordinator.d01@dot.ca.gov'
ON DUPLICATE KEY UPDATE is_active = 1;
INSERT INTO org_coordinator_coverage (district, user_id, is_primary, is_active)
SELECT '04', id, 1, 1 FROM users WHERE email = 'mock.coordinator.d04@dot.ca.gov'
ON DUPLICATE KEY UPDATE is_active = 1;
INSERT INTO org_district_crew (district, user_id, is_active)
SELECT '01', id, 1 FROM users WHERE email = 'mock.maintenance.crew@dot.ca.gov'
ON DUPLICATE KEY UPDATE is_active = 1;

-- Their roles, exactly as services/org_tree.derived_roles computes them.
DELETE ur FROM user_roles ur
  JOIN users u ON u.id = ur.user_id JOIN roles r ON r.id = ur.role_id
 WHERE u.email LIKE 'mock.%@dot.ca.gov' AND r.name <> 'ADMIN';
INSERT IGNORE INTO user_roles (user_id, role_id)
SELECT p.user_id, r.id FROM org_user_profiles p
  JOIN users u ON u.id = p.user_id JOIN roles r ON r.name = p.tree_position
 WHERE u.email LIKE 'mock.%@dot.ca.gov' AND p.office_id IS NOT NULL;
INSERT IGNORE INTO user_roles (user_id, role_id)
SELECT DISTINCT c.user_id, r.id FROM org_coordinator_coverage c
  JOIN users u ON u.id = c.user_id JOIN roles r ON r.name = 'MAINTENANCE_COORDINATOR'
 WHERE u.email LIKE 'mock.%@dot.ca.gov' AND c.is_active = 1;
INSERT IGNORE INTO user_roles (user_id, role_id)
SELECT DISTINCT c.user_id, r.id FROM org_district_crew c
  JOIN users u ON u.id = c.user_id JOIN roles r ON r.name = 'MAINTENANCE_CREW'
 WHERE u.email LIKE 'mock.%@dot.ca.gov' AND c.is_active = 1;
INSERT IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, r.id FROM users u JOIN roles r ON r.name = 'GUEST'
 WHERE u.email LIKE 'mock.%@dot.ca.gov' AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id);
