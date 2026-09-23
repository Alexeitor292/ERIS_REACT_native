-- DEVELOPMENT DATABASES ONLY. Never run against production.
--
-- Moves a dev or test database seeded before 2026-09-23 from the old "@local"
-- accounts to the "mock.…@dot.ca.gov" accounts database/init/020_seed.sql now
-- creates. The accounts are RENAMED in place, not re-created: incidents,
-- assessments and events already point at their ids.
--
-- Run after `alembic upgrade head` (so the roles are already consolidated) and
-- before re-applying 020_seed.sql. Safe to run twice: a second run matches
-- nothing.
--
--   mysql <dbname> < database/dev/rename_local_accounts.sql

UPDATE users SET email = 'mock.admin@dot.ca.gov',             full_name = 'Mock Administrator'     WHERE email = 'admin@local';
UPDATE users SET email = 'mock.maintenance.crew@dot.ca.gov',  full_name = 'Mock Maintenance Crew'  WHERE email = 'maintenance@local';
UPDATE users SET email = 'mock.coordinator.d01@dot.ca.gov',   full_name = 'Mock Coordinator D01'   WHERE email = 'coordinator@local';
UPDATE users SET email = 'mock.coordinator.d04@dot.ca.gov',   full_name = 'Mock Coordinator D04'   WHERE email = 'coordinator04@local';
UPDATE users SET email = 'mock.office.chief@dot.ca.gov',      full_name = 'Mock Office Chief'      WHERE email = 'officechief@local';
UPDATE users SET email = 'mock.branch.chief@dot.ca.gov',      full_name = 'Mock Branch Chief'      WHERE email = 'branchchief@local';
UPDATE users SET email = 'mock.senior.specialist@dot.ca.gov', full_name = 'Mock Senior Specialist' WHERE email = 'seniorengineer@local';
UPDATE users SET email = 'mock.staff@dot.ca.gov',             full_name = 'Mock Staff'             WHERE email = 'engineer@local';
UPDATE users SET email = 'mock.guest@dot.ca.gov',             full_name = 'Mock Guest'             WHERE email = 'viewer@local';
-- The retired Reviewer: the role migration left this account a Guest.
UPDATE users SET email = 'mock.guest.former.reviewer@dot.ca.gov', full_name = 'Mock Guest (former Reviewer)' WHERE email = 'reviewer@local';

-- The administrator holds only ADMIN, as a fresh seed gives it. The old seed
-- granted it every role, which let any test signed in as it slip past a
-- missing guard.
DELETE ur
  FROM user_roles ur
  JOIN users u ON u.id = ur.user_id
  JOIN roles r ON r.id = ur.role_id
 WHERE u.email = 'mock.admin@dot.ca.gov'
   AND r.name <> 'ADMIN';
