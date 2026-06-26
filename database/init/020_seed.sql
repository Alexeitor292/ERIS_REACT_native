USE eris;

INSERT INTO roles (name, description) VALUES
('FIELD_WORKER', 'Can create and submit field reports'),
('MAINTENANCE', 'Can create maintenance incident reports'),
('MAINT_COORDINATOR', 'Can triage maintenance incidents and forward to office chiefs'),
('OFFICE_CHIEF', 'Can route incidents to branch chiefs'),
('BRANCH_CHIEF', 'Can assign incidents to engineers'),
('REVIEWER', 'Can review submitted reports'),
('ADMIN', 'Can manage users, forms, and approvals'),
-- Canonical Assessment-model roles (additive; legacy roles above still work
-- via app/roles.py aliasing). See migration 0008_assessment_domain.
('MAINTENANCE_FIELD_WORKER', 'Maintenance field worker: creates and follows own incident reports'),
('MAINTENANCE_COORDINATOR', 'Maintenance coordinator: triages incident reports and routes assessments'),
('GEOTECH_OFFICE_CHIEF', 'GeoTech office chief: delegates assessments to branch chiefs'),
('GEOTECH_BRANCH_CHIEF', 'GeoTech branch chief: assigns engineers to assessments'),
('GEOTECH_ENGINEER', 'GeoTech engineer: completes assessments / technical form')
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
  ('engineer@local', 'Local Engineer', '$argon2id$v=19$m=65536,t=3,p=4$yGtVqjzsQ7NhszqjjQ34XA$q1k5GP/lHkwSdhCYoGYRCfj1ytWu9mDmHhYgb5BCvPU', NULL, 1),
  ('reviewer@local', 'Local Reviewer', '$argon2id$v=19$m=65536,t=3,p=4$yGtVqjzsQ7NhszqjjQ34XA$q1k5GP/lHkwSdhCYoGYRCfj1ytWu9mDmHhYgb5BCvPU', NULL, 1)
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
  (u.email='reviewer@local' AND r.name='REVIEWER');
