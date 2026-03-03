USE eris;

INSERT INTO roles (name, description) VALUES
('FIELD_WORKER', 'Can create and submit field reports'),
('REVIEWER', 'Can review submitted reports'),
('ADMIN', 'Can manage users, forms, and approvals')
ON DUPLICATE KEY UPDATE description = VALUES(description);

-- Example admin user (password: "password", hashed with argon2id)
INSERT INTO users (email, full_name, password_hash, is_active)
VALUES ('admin@local', 'Local Admin', '$argon2id$v=19$m=65536,t=3,p=4$yGtVqjzsQ7NhszqjjQ34XA$q1k5GP/lHkwSdhCYoGYRCfj1ytWu9mDmHhYgb5BCvPU', 1)
ON DUPLICATE KEY UPDATE
  full_name = VALUES(full_name),
  password_hash = VALUES(password_hash),
  is_active = VALUES(is_active);


-- Give admin all roles
INSERT IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u
JOIN roles r
WHERE u.email='admin@local' AND r.name IN ('ADMIN', 'REVIEWER', 'FIELD_WORKER');
