# Database schema reference

> **Generated** by `scripts/docs/generate_schema_docs.py` from a fully migrated database. Do not edit by hand. Diagrams: [entity-relationship diagrams](erd.md).

Keys: **PK** primary key, **FK** foreign key, **UK** unique.

## Identity and access

### `deployment_bootstrap`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `name` | varchar(64) | no |  | PK |
| `completed_at` | datetime | no | current_timestamp() |  |
| `user_id` | bigint | yes |  |  |

### `role_consolidation_audit`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `user_id` | bigint | no |  | PK |
| `old_role` | varchar(64) | no |  | PK |
| `assigned_at` | datetime | yes |  |  |
| `recorded_at` | datetime | no | current_timestamp() |  |

### `roles`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `name` | varchar(64) | no |  | UK |
| `description` | varchar(255) | yes |  |  |

Indexes:

- `name` on `name` (unique)

### `user_external_identities`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `user_id` | bigint | no |  | FK |
| `provider` | varchar(32) | no |  |  |
| `tenant_id` | char(36) | no |  |  |
| `object_id` | char(36) | no |  |  |
| `user_principal_name` | varchar(255) | yes |  |  |
| `email_at_link` | varchar(255) | yes |  |  |
| `linked_at` | datetime | no | current_timestamp() |  |
| `linked_by_user_id` | bigint | yes |  | FK |
| `last_login_at` | datetime | yes |  |  |

References:

- `linked_by_user_id` → `users.id` (on delete set null)
- `user_id` → `users.id` (on delete cascade)

Indexes:

- `fk_user_external_identities_linked_by` on `linked_by_user_id`
- `uq_user_external_identities_subject` on `provider, tenant_id, object_id` (unique)
- `uq_user_external_identities_user_provider` on `user_id, provider` (unique)

### `user_roles`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `user_id` | bigint | no |  | PK FK |
| `role_id` | bigint | no |  | PK FK |
| `assigned_at` | datetime | no | current_timestamp() |  |

References:

- `role_id` → `roles.id` (on delete cascade)
- `user_id` → `users.id` (on delete cascade)

Indexes:

- `fk_user_roles_role` on `role_id`

### `user_saved_layouts`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `user_id` | bigint | no |  | FK |
| `scope` | varchar(40) | no |  |  |
| `name` | varchar(80) | no |  |  |
| `layout_json` | longtext | no |  |  |
| `is_default` | tinyint | no | 0 |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |

References:

- `user_id` → `users.id` (on delete cascade)

Indexes:

- `uq_user_saved_layout_name` on `user_id, scope, name` (unique)

### `user_sessions`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `user_id` | bigint | no |  | FK |
| `token_hash` | char(64) | no |  | UK |
| `client` | varchar(16) | no |  |  |
| `auth_method` | varchar(16) | no |  |  |
| `created_at` | datetime | no |  |  |
| `last_seen_at` | datetime | no |  |  |
| `expires_at` | datetime | no |  |  |
| `revoked_at` | datetime | yes |  |  |
| `revoked_reason` | varchar(32) | yes |  |  |
| `user_agent` | varchar(255) | yes |  |  |
| `created_ip` | varchar(45) | yes |  |  |

References:

- `user_id` → `users.id` (on delete cascade)

Indexes:

- `ix_user_sessions_expiry` on `expires_at`
- `ix_user_sessions_user` on `user_id, revoked_at`
- `uq_user_sessions_token` on `token_hash` (unique)

### `users`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `email` | varchar(255) | no |  | UK |
| `full_name` | varchar(255) | no |  |  |
| `password_hash` | varchar(255) | yes |  |  |
| `metadata_json` | longtext | yes |  |  |
| `is_active` | tinyint | no | 1 |  |
| `last_login_at` | datetime | yes |  |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |

Indexes:

- `email` on `email` (unique)

## Organization

### `geotech_office_routing`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `district` | varchar(8) | no |  | UK |
| `office_code` | varchar(16) | no |  |  |
| `office_name` | varchar(128) | yes |  |  |
| `is_active` | tinyint | no | 1 |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |

Indexes:

- `idx_geotech_routing_office` on `office_code, is_active`
- `uk_geotech_routing_district` on `district` (unique)

### `org_branch_districts`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `branch_id` | bigint | no |  | FK |
| `district` | char(2) | no |  |  |
| `source` | varchar(16) | no | ADMIN |  |
| `notes` | varchar(255) | yes |  |  |
| `is_active` | tinyint | no | 1 |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |

References:

- `branch_id` → `org_branches.id` (on delete cascade)

Indexes:

- `idx_org_branch_districts_lookup` on `district, is_active`
- `uk_org_branch_district` on `branch_id, district` (unique)

### `org_branches`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `office_id` | bigint | no |  | FK |
| `parent_branch_id` | bigint | yes |  | FK |
| `unit_type` | varchar(16) | no | BRANCH |  |
| `letter` | varchar(4) | yes |  |  |
| `name` | varchar(160) | no |  |  |
| `home_city` | varchar(64) | yes |  |  |
| `home_district` | char(2) | yes |  |  |
| `home_location_label` | varchar(64) | yes |  |  |
| `chief_user_id` | bigint | yes |  | FK |
| `accepts_assignments` | tinyint | no | 1 |  |
| `is_active` | tinyint | no | 1 |  |
| `sort_order` | integer | no | 0 |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |
| `active_key` | varchar(32) | yes |  | UK |
| `active_unit_key` | varchar(224) | yes |  | UK |

References:

- `chief_user_id` → `users.id` (on delete set null)
- `office_id` → `org_offices.id`
- `parent_branch_id` → `org_branches.id`

Indexes:

- `fk_org_branch_chief` on `chief_user_id`
- `fk_org_branch_parent` on `parent_branch_id`
- `idx_org_branch_natural` on `office_id, unit_type, letter`
- `idx_org_branch_office_active` on `office_id, is_active, sort_order`
- `uk_org_branch_active_letter` on `active_key` (unique)
- `uk_org_branch_active_unit` on `active_unit_key` (unique)

### `org_classifications`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `rule_kind` | varchar(16) | no | CLASS |  |
| `class_code` | varchar(8) | no |  |  |
| `marker` | varchar(8) | no |  |  |
| `title_pattern` | varchar(96) | no |  |  |
| `level_code` | varchar(8) | no |  |  |
| `title` | varchar(96) | no |  |  |
| `eris_role` | varchar(64) | yes |  |  |
| `is_supervisor` | tinyint | no | 0 |  |
| `priority` | integer | no | 100 |  |
| `notes` | varchar(255) | yes |  |  |
| `is_active` | tinyint | no | 1 |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |

Indexes:

- `idx_org_classification_lookup` on `is_active, priority`
- `uk_org_classification` on `rule_kind, class_code, marker, title_pattern, level_code` (unique)

### `org_coordinator_coverage`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `district` | char(2) | no |  |  |
| `user_id` | bigint | no |  | FK |
| `is_primary` | tinyint | no | 1 |  |
| `is_active` | tinyint | no | 1 |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |

References:

- `user_id` → `users.id` (on delete cascade)

Indexes:

- `fk_org_coverage_user` on `user_id`
- `idx_org_coverage_lookup` on `district, is_active, is_primary`
- `uk_org_coverage` on `district, user_id` (unique)

### `org_district_crew`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `district` | char(2) | no |  |  |
| `user_id` | bigint | no |  | FK |
| `is_active` | tinyint | no | 1 |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |

References:

- `user_id` → `users.id` (on delete cascade)

Indexes:

- `idx_org_crew_user` on `user_id, is_active`
- `uk_org_crew` on `district, user_id` (unique)

### `org_office_districts`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `office_id` | bigint | no |  | FK |
| `org_type` | varchar(16) | no | GEOTECH | FK |
| `district` | char(2) | no |  |  |
| `is_primary` | tinyint | no | 1 |  |
| `is_active` | tinyint | no | 1 |  |
| `active_district_key` | varchar(24) | yes |  | UK |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |

References:

- `office_id, org_type` → `org_offices.id, org_type` (on delete cascade)

Indexes:

- `fk_org_office_districts_office` on `office_id, org_type`
- `idx_org_office_districts_lookup` on `org_type, district, is_active`
- `uk_org_district_active` on `active_district_key` (unique)
- `uk_org_office_district` on `office_id, district` (unique)

### `org_offices`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `code` | varchar(16) | no |  |  |
| `org_type` | varchar(16) | no | GEOTECH |  |
| `unit_number` | varchar(16) | yes |  |  |
| `name` | varchar(160) | no |  |  |
| `short_name` | varchar(64) | yes |  |  |
| `home_city` | varchar(64) | yes |  |  |
| `home_district` | char(2) | yes |  |  |
| `home_location_label` | varchar(64) | yes |  |  |
| `is_routing_target` | tinyint | no | 1 |  |
| `is_active` | tinyint | no | 1 |  |
| `sort_order` | integer | no | 0 |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |

Indexes:

- `idx_org_office_type_active` on `org_type, is_active`
- `uk_org_office_code` on `org_type, code` (unique)
- `uk_org_office_id_type` on `id, org_type` (unique)

### `org_user_profiles`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `user_id` | bigint | no |  | PK FK |
| `office_id` | bigint | yes |  | FK |
| `branch_id` | bigint | yes |  | FK |
| `tree_position` | varchar(24) | yes |  |  |
| `home_city` | varchar(64) | yes |  |  |
| `home_district` | char(2) | yes |  |  |
| `classification_code` | varchar(8) | yes |  |  |
| `classification_marker` | varchar(8) | yes |  |  |
| `position_number` | varchar(32) | yes |  |  |
| `job_title` | varchar(96) | yes |  |  |
| `level_code` | varchar(8) | yes |  |  |
| `supervisor_user_id` | bigint | yes |  | FK |
| `availability` | varchar(16) | no | AVAILABLE |  |
| `available_from` | date | yes |  |  |
| `available_until` | date | yes |  |  |
| `source` | varchar(16) | no | MANUAL |  |
| `notes` | varchar(255) | yes |  |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |

References:

- `branch_id` → `org_branches.id` (on delete set null)
- `office_id` → `org_offices.id` (on delete set null)
- `supervisor_user_id` → `users.id` (on delete set null)
- `user_id` → `users.id` (on delete cascade)

Indexes:

- `fk_org_profile_supervisor` on `supervisor_user_id`
- `idx_org_profile_branch` on `branch_id`
- `idx_org_profile_class` on `classification_code`
- `idx_org_profile_district` on `home_district`
- `idx_org_profile_office` on `office_id, branch_id`

## Incidents

### `event_group_events`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `event_group_id` | bigint | no |  | FK |
| `incident_id` | bigint | yes |  | FK |
| `actor_user_id` | bigint | yes |  | FK |
| `event_type` | varchar(64) | no |  |  |
| `notes` | text | yes |  |  |
| `metadata_json` | longtext | yes |  |  |
| `created_at` | datetime | no | current_timestamp() |  |

References:

- `actor_user_id` → `users.id` (on delete set null)
- `event_group_id` → `event_groups.id` (on delete cascade)
- `incident_id` → `incidents.id` (on delete set null)

Indexes:

- `fk_event_group_event_actor` on `actor_user_id`
- `idx_event_group_events_group_created` on `event_group_id, created_at`
- `idx_event_group_events_incident_created` on `incident_id, created_at`

### `event_groups`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `event_group_key` | varchar(64) | no |  | UK |
| `title` | varchar(255) | no |  |  |
| `description` | text | yes |  |  |
| `status` | varchar(24) | no | OPEN |  |
| `anchor_location_id` | bigint | yes |  | FK |
| `anchor_latitude` | decimal(10, 6) | no |  |  |
| `anchor_longitude` | decimal(10, 6) | no |  |  |
| `district` | varchar(64) | yes |  |  |
| `county` | varchar(64) | yes |  |  |
| `route` | varchar(64) | yes |  |  |
| `post_mile` | varchar(64) | yes |  |  |
| `created_from_incident_id` | bigint | yes |  | FK |
| `created_by_user_id` | bigint | no |  | FK |
| `source` | varchar(32) | no | COORDINATOR_CREATED |  |
| `closed_at` | datetime | yes |  |  |
| `closed_by_user_id` | bigint | yes |  | FK |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |

References:

- `anchor_location_id` → `incident_locations.id` (on delete set null)
- `closed_by_user_id` → `users.id` (on delete set null)
- `created_by_user_id` → `users.id`
- `created_from_incident_id` → `incidents.id` (on delete set null)

Indexes:

- `event_group_key` on `event_group_key` (unique)
- `fk_event_group_anchor_location` on `anchor_location_id`
- `fk_event_group_closed_by` on `closed_by_user_id`
- `fk_event_group_created_by` on `created_by_user_id`
- `idx_event_group_created_from_incident` on `created_from_incident_id`
- `idx_event_groups_geo` on `anchor_latitude, anchor_longitude`
- `idx_event_groups_route` on `district, county, route, post_mile`
- `idx_event_groups_status_updated` on `status, updated_at`

### `incident_assignments`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `incident_id` | bigint | no |  | FK |
| `assignee_user_id` | bigint | no |  | FK |
| `assigned_by_user_id` | bigint | no |  | FK |
| `assignment_stage` | varchar(32) | no | ENGINEER |  |
| `assignment_mode` | varchar(16) | no |  |  |
| `is_active` | tinyint | no | 1 |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |

References:

- `assigned_by_user_id` → `users.id`
- `assignee_user_id` → `users.id`
- `incident_id` → `incidents.id` (on delete cascade)

Indexes:

- `fk_inc_assign_assigned_by` on `assigned_by_user_id`
- `idx_inc_assign_assignee` on `assignee_user_id`
- `idx_inc_assign_incident_active` on `incident_id, is_active`
- `idx_inc_assign_stage` on `assignment_stage`

### `incident_attachments`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `incident_id` | bigint | no |  | FK |
| `attachment_id` | bigint | no |  | FK |
| `kind` | varchar(32) | no | PHOTO |  |
| `sort_order` | integer | no | 0 |  |
| `created_at` | datetime | no | current_timestamp() |  |

References:

- `attachment_id` → `attachments.id` (on delete cascade)
- `incident_id` → `incidents.id` (on delete cascade)

Indexes:

- `fk_incident_attachments_attachment` on `attachment_id`
- `idx_incident_attachments_incident` on `incident_id`
- `idx_incident_attachments_kind` on `kind`
- `uk_incident_attachment` on `incident_id, attachment_id` (unique)

### `incident_locations`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `display_name` | varchar(255) | yes |  |  |
| `district` | varchar(64) | yes |  |  |
| `county` | varchar(64) | yes |  |  |
| `route` | varchar(64) | yes |  |  |
| `post_mile_raw` | varchar(64) | yes |  |  |
| `post_mile_norm` | varchar(64) | yes |  |  |
| `latitude` | decimal(10, 6) | yes |  |  |
| `longitude` | decimal(10, 6) | yes |  |  |
| `is_active` | tinyint | no | 1 |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |

Indexes:

- `idx_incident_locations_geo` on `latitude, longitude`
- `idx_incident_locations_lookup` on `district, county, route, post_mile_norm`
- `uk_incident_location_identity` on `district, county, route, post_mile_norm` (unique)

### `incident_routing_assignments`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `assignment_type` | varchar(32) | no |  |  |
| `district` | varchar(64) | yes |  |  |
| `office_code` | varchar(16) | yes |  |  |
| `user_id` | bigint | no |  | FK |
| `is_active` | tinyint | no | 1 |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |

References:

- `user_id` → `users.id` (on delete cascade)

Indexes:

- `fk_inc_route_user` on `user_id`
- `idx_inc_route_lookup` on `assignment_type, district, office_code, is_active`
- `uk_inc_route_unique` on `assignment_type, district, office_code, user_id` (unique)

### `incident_submission_links`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `incident_id` | bigint | no |  | PK FK |
| `submission_id` | bigint | no |  | FK UK |
| `linked_by_user_id` | bigint | no |  | FK |
| `created_at` | datetime | no | current_timestamp() |  |

References:

- `incident_id` → `incidents.id` (on delete cascade)
- `linked_by_user_id` → `users.id`
- `submission_id` → `submissions.id` (on delete cascade)

Indexes:

- `fk_inc_sub_linked_by` on `linked_by_user_id`
- `uk_incident_submission_submission` on `submission_id` (unique)

### `incidents`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `event_group_id` | bigint | yes |  | FK |
| `incident_key` | varchar(64) | yes |  | UK |
| `approved_at` | datetime | yes |  |  |
| `approved_by_user_id` | bigint | yes |  | FK |
| `project_id` | bigint | yes |  |  |
| `title` | varchar(255) | yes |  |  |
| `incident_type` | varchar(64) | yes |  |  |
| `description` | text | yes |  |  |
| `location_id` | bigint | yes |  | FK |
| `location_match_status` | varchar(24) | no | PENDING_REVIEW |  |
| `location_reviewed_by_user_id` | bigint | yes |  | FK |
| `location_reviewed_at` | datetime | yes |  |  |
| `location_match_metadata` | longtext | yes |  |  |
| `first_observed_at` | datetime | no |  |  |
| `first_occurred_at` | datetime | yes |  |  |
| `latitude` | decimal(10, 6) | no |  |  |
| `longitude` | decimal(10, 6) | no |  |  |
| `district` | varchar(64) | no |  |  |
| `county` | varchar(64) | no |  |  |
| `route` | varchar(64) | no |  |  |
| `post_mile` | varchar(64) | no |  |  |
| `office_code` | varchar(16) | yes |  |  |
| `current_stage` | varchar(32) | no | COORDINATOR_REVIEW |  |
| `status` | varchar(32) | no | NEW |  |
| `reporter_user_id` | bigint | no |  | FK |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |
| `resolved_at` | datetime | yes |  |  |
| `resolved_by_user_id` | bigint | yes |  | FK |
| `resolution_comment` | text | yes |  |  |
| `road_inventory_dataset_version_id` | bigint | yes |  | FK |
| `road_inventory_segment_id` | bigint | yes |  | FK |
| `road_inventory_snapshot_json` | longtext | yes |  |  |
| `road_inventory_match_method` | varchar(32) | yes |  |  |
| `road_inventory_checked_at` | datetime | yes |  |  |
| `triage_disposition` | varchar(32) | yes |  |  |
| `triage_decided_by_user_id` | bigint | yes |  | FK |
| `triage_decided_at` | datetime | yes |  |  |
| `triage_notes` | text | yes |  |  |
| `duplicate_of_incident_id` | bigint | yes |  | FK |
| `duplicate_of_location_id` | bigint | yes |  | FK |

References:

- `approved_by_user_id` → `users.id` (on delete set null)
- `duplicate_of_incident_id` → `incidents.id` (on delete set null)
- `duplicate_of_location_id` → `incident_locations.id` (on delete set null)
- `event_group_id` → `event_groups.id`
- `location_id` → `incident_locations.id` (on delete set null)
- `location_reviewed_by_user_id` → `users.id` (on delete set null)
- `reporter_user_id` → `users.id`
- `resolved_by_user_id` → `users.id` (on delete set null)
- `road_inventory_dataset_version_id` → `road_inventory_datasets.id` (on delete set null)
- `road_inventory_segment_id` → `road_segments.id` (on delete set null)
- `triage_decided_by_user_id` → `users.id` (on delete set null)

Indexes:

- `fk_incident_approved_by` on `approved_by_user_id`
- `fk_incident_location_reviewed_by` on `location_reviewed_by_user_id`
- `fk_incident_reporter` on `reporter_user_id`
- `fk_incident_resolved_by` on `resolved_by_user_id`
- `fk_incidents_duplicate_of_incident` on `duplicate_of_incident_id`
- `fk_incidents_duplicate_of_location` on `duplicate_of_location_id`
- `fk_incidents_triage_decided_by` on `triage_decided_by_user_id`
- `idx_incidents_approved_at` on `approved_at`
- `idx_incidents_created` on `created_at`
- `idx_incidents_event_group` on `event_group_id`
- `idx_incidents_geo` on `latitude, longitude`
- `idx_incidents_location` on `location_id`
- `idx_incidents_project` on `project_id`
- `idx_incidents_ri_dataset_version_id` on `road_inventory_dataset_version_id`
- `idx_incidents_ri_segment_id` on `road_inventory_segment_id`
- `idx_incidents_stage_status_created` on `current_stage, status, created_at`
- `idx_incidents_status` on `status`
- `idx_incidents_triage_disposition` on `triage_disposition`
- `uq_incidents_incident_key` on `incident_key` (unique)

## Assessments

### `assessment_assignments`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `assessment_id` | bigint | no |  | FK |
| `user_id` | bigint | no |  | FK |
| `assignment_role` | varchar(24) | no |  |  |
| `assigned_by_user_id` | bigint | no |  | FK |
| `is_active` | tinyint | no | 1 |  |
| `notes` | varchar(255) | yes |  |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |

References:

- `assessment_id` → `assessments.id` (on delete cascade)
- `assigned_by_user_id` → `users.id`
- `user_id` → `users.id` (on delete cascade)

Indexes:

- `fk_assessment_assign_assigned_by` on `assigned_by_user_id`
- `idx_assessment_assign_lookup` on `assessment_id, assignment_role, is_active`
- `idx_assessment_assign_user` on `user_id, is_active`

### `assessment_events`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `assessment_id` | bigint | yes |  | FK |
| `incident_id` | bigint | no |  | FK |
| `actor_user_id` | bigint | no |  | FK |
| `event_type` | varchar(48) | no |  |  |
| `disposition` | varchar(32) | yes |  |  |
| `from_state` | varchar(32) | yes |  |  |
| `to_state` | varchar(32) | yes |  |  |
| `notes` | text | yes |  |  |
| `target_incident_id` | bigint | yes |  | FK |
| `target_location_id` | bigint | yes |  | FK |
| `metadata_json` | longtext | yes |  |  |
| `created_at` | datetime | no | current_timestamp() |  |

References:

- `actor_user_id` → `users.id`
- `assessment_id` → `assessments.id` (on delete set null)
- `incident_id` → `incidents.id` (on delete cascade)
- `target_incident_id` → `incidents.id` (on delete set null)
- `target_location_id` → `incident_locations.id` (on delete set null)

Indexes:

- `fk_assessment_event_actor` on `actor_user_id`
- `fk_assessment_event_target_incident` on `target_incident_id`
- `fk_assessment_event_target_location` on `target_location_id`
- `idx_assessment_event_assessment` on `assessment_id, created_at`
- `idx_assessment_event_incident` on `incident_id, created_at`

### `assessment_submissions`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `assessment_id` | bigint | no |  | FK |
| `submission_id` | bigint | no |  | FK UK |
| `created_by_user_id` | bigint | yes |  | FK |
| `created_at` | datetime | no | current_timestamp() |  |

References:

- `assessment_id` → `assessments.id` (on delete cascade)
- `created_by_user_id` → `users.id` (on delete set null)
- `submission_id` → `submissions.id` (on delete cascade)

Indexes:

- `fk_assessment_subs_created_by` on `created_by_user_id`
- `idx_assessment_subs_assessment` on `assessment_id, id`
- `uk_assessment_subs_submission` on `submission_id` (unique)

### `assessments`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `assessment_uuid` | varchar(64) | no |  | UK |
| `incident_id` | bigint | no |  | FK UK |
| `submission_id` | bigint | yes |  | FK |
| `district` | varchar(64) | yes |  |  |
| `office_code` | varchar(16) | yes |  |  |
| `office_routed_from_district` | varchar(8) | yes |  |  |
| `office_override_reason` | text | yes |  |  |
| `routed_office_id` | bigint | yes |  | FK |
| `routed_office_name` | varchar(160) | yes |  |  |
| `routed_branch_id` | bigint | yes |  | FK |
| `routed_branch_name` | varchar(160) | yes |  |  |
| `routed_branch_letter` | varchar(4) | yes |  |  |
| `routing_path` | varchar(24) | yes |  |  |
| `branch_chief_user_id` | bigint | yes |  | FK |
| `assigned_engineer_user_id` | bigint | yes |  | FK |
| `state` | varchar(32) | no | PENDING_OFFICE_DELEGATION |  |
| `triage_disposition` | varchar(32) | yes |  |  |
| `notes` | text | yes |  |  |
| `created_by_user_id` | bigint | no |  | FK |
| `office_delegated_at` | datetime | yes |  |  |
| `engineer_assigned_at` | datetime | yes |  |  |
| `submitted_at` | datetime | yes |  |  |
| `review_requested_at` | datetime | yes |  |  |
| `approved_at` | datetime | yes |  |  |
| `finalized_at` | datetime | yes |  |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |

References:

- `assigned_engineer_user_id` → `users.id` (on delete set null)
- `branch_chief_user_id` → `users.id` (on delete set null)
- `created_by_user_id` → `users.id`
- `incident_id` → `incidents.id` (on delete cascade)
- `routed_branch_id` → `org_branches.id` (on delete set null)
- `routed_office_id` → `org_offices.id` (on delete set null)
- `submission_id` → `submissions.id` (on delete set null)

Indexes:

- `assessment_uuid` on `assessment_uuid` (unique)
- `fk_assessment_created_by` on `created_by_user_id`
- `fk_assessment_routed_branch` on `routed_branch_id`
- `idx_assessment_branch_chief` on `branch_chief_user_id, state`
- `idx_assessment_engineer` on `assigned_engineer_user_id, state`
- `idx_assessment_office` on `office_code, state`
- `idx_assessment_routed_office` on `routed_office_id`
- `idx_assessment_routing` on `routing_path, state`
- `idx_assessment_state` on `state`
- `idx_assessment_submission` on `submission_id`
- `uk_assessment_incident` on `incident_id` (unique)

## Submissions (GISA)

### `submission_drone_surveys`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `submission_id` | bigint | no |  | FK |
| `label` | varchar(160) | yes |  |  |
| `source` | varchar(64) | yes |  |  |
| `captured_on` | date | yes |  |  |
| `created_by_user_id` | bigint | no |  | FK |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |
| `dsm_filename` | varchar(255) | yes |  |  |
| `ortho_filename` | varchar(255) | yes |  |  |
| `dsm_attachment_id` | bigint | yes |  | FK |
| `ortho_attachment_id` | bigint | yes |  | FK |
| `source_crs` | varchar(64) | yes |  |  |
| `west` | double | no |  |  |
| `south` | double | no |  |  |
| `east` | double | no |  |  |
| `north` | double | no |  |  |
| `cols` | integer | no |  |  |
| `grid_rows` | integer | no |  |  |
| `resolution_m` | double | yes |  |  |
| `patch_object_key` | varchar(255) | no |  |  |
| `patch_size_bytes` | integer | no |  |  |
| `overlay_object_key` | varchar(255) | yes |  |  |
| `overlay_mime` | varchar(64) | yes |  |  |
| `overlay_corners_json` | longtext | yes |  |  |
| `vertical_offset_m` | double | no | 0 |  |
| `offset_mode` | varchar(12) | no | AUTO |  |
| `stats_json` | longtext | yes |  |  |
| `comparison_json` | longtext | yes |  |  |
| `points_json` | longtext | yes |  |  |
| `compare_with_survey_id` | bigint | yes |  | FK |

References:

- `compare_with_survey_id` → `submission_drone_surveys.id` (on delete set null)
- `created_by_user_id` → `users.id`
- `dsm_attachment_id` → `attachments.id` (on delete set null)
- `ortho_attachment_id` → `attachments.id` (on delete set null)
- `submission_id` → `submissions.id` (on delete cascade)

Indexes:

- `fk_drone_survey_compare_with` on `compare_with_survey_id`
- `fk_drone_survey_creator` on `created_by_user_id`
- `fk_drone_survey_dsm` on `dsm_attachment_id`
- `fk_drone_survey_ortho` on `ortho_attachment_id`
- `idx_drone_survey_submission` on `submission_id, id`

### `submission_editors`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `submission_id` | bigint | no |  | PK FK |
| `user_id` | bigint | no |  | PK FK |
| `granted_by_user_id` | bigint | no |  | FK |
| `created_at` | datetime | no | current_timestamp() |  |

References:

- `granted_by_user_id` → `users.id`
- `submission_id` → `submissions.id` (on delete cascade)
- `user_id` → `users.id` (on delete cascade)

Indexes:

- `fk_edit_granted_by` on `granted_by_user_id`
- `idx_edit_user` on `user_id`

### `submission_gisa`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `submission_id` | bigint | no |  | PK FK |
| `location_id` | bigint | yes |  | FK |
| `report_date` | date | yes |  |  |
| `district` | varchar(64) | yes |  |  |
| `county` | varchar(64) | yes |  |  |
| `route` | varchar(64) | yes |  |  |
| `post_mile` | varchar(64) | yes |  |  |
| `ea` | varchar(16) | yes |  |  |
| `project_id` | varchar(32) | yes |  |  |
| `date_incident_reported` | date | yes |  |  |
| `district_contact` | text | yes |  |  |
| `latitude` | decimal(10, 6) | yes |  |  |
| `longitude` | decimal(10, 6) | yes |  |  |
| `distribution_code` | varchar(64) | yes |  |  |
| `highway_status_cause` | text | yes |  |  |
| `highway_status_code` | varchar(64) | yes |  |  |
| `lanes_closed_count` | integer | yes |  |  |
| `open_highway_traffic_lanes_count` | integer | yes |  |  |
| `pavement_ground_annotation_layout_json` | longtext | yes |  |  |
| `pavement_ground_cracks` | tinyint | no | 0 |  |
| `crack_length_ft` | decimal(10, 2) | yes |  |  |
| `crack_horizontal_in` | decimal(10, 2) | yes |  |  |
| `crack_vertical_in` | decimal(10, 2) | yes |  |  |
| `crack_depth_in` | decimal(10, 2) | yes |  |  |
| `settlement_in` | decimal(10, 2) | yes |  |  |
| `bulge_in` | decimal(10, 2) | yes |  |  |
| `indented_by_rocks` | tinyint | no | 0 |  |
| `failure_rock_fall` | tinyint | no | 0 |  |
| `failure_topple` | tinyint | no | 0 |  |
| `failure_slide` | tinyint | no | 0 |  |
| `failure_spread` | tinyint | no | 0 |  |
| `failure_flow` | tinyint | no | 0 |  |
| `failure_compound` | tinyint | no | 0 |  |
| `failure_erosion` | tinyint | no | 0 |  |
| `failure_surficial_failure` | tinyint | no | 0 |  |
| `failure_scoured_toe` | tinyint | no | 0 |  |
| `failure_washout` | tinyint | no | 0 |  |
| `incident_type_description` | text | yes |  |  |
| `distribution_advancing` | tinyint | no | 0 |  |
| `distribution_retrogressive` | tinyint | no | 0 |  |
| `distribution_enlarging` | tinyint | no | 0 |  |
| `distribution_widening` | tinyint | no | 0 |  |
| `distribution_moving` | tinyint | no | 0 |  |
| `distribution_confined` | tinyint | no | 0 |  |
| `material_rock` | tinyint | no | 0 |  |
| `material_soil` | tinyint | no | 0 |  |
| `material_bedding` | tinyint | no | 0 |  |
| `material_joints` | tinyint | no | 0 |  |
| `material_fractures` | tinyint | no | 0 |  |
| `material_pavement_type` | varchar(32) | yes |  |  |
| `est_soil_pct` | decimal(5, 2) | yes |  |  |
| `est_rock_pct` | decimal(5, 2) | yes |  |  |
| `est_clay_pct` | decimal(5, 2) | yes |  |  |
| `est_silt_pct` | decimal(5, 2) | yes |  |  |
| `est_sand_pct` | decimal(5, 2) | yes |  |  |
| `est_gravel_pct` | decimal(5, 2) | yes |  |  |
| `est_boulder_pct` | decimal(5, 2) | yes |  |  |
| `est_debris_clay_silt_pct` | decimal(5, 2) | yes |  |  |
| `est_debris_sand_pct` | decimal(5, 2) | yes |  |  |
| `est_debris_gravel_pct` | decimal(5, 2) | yes |  |  |
| `est_debris_boulder_pct` | decimal(5, 2) | yes |  |  |
| `water_dry` | tinyint | no | 0 |  |
| `water_moist` | tinyint | no | 0 |  |
| `water_wet` | tinyint | no | 0 |  |
| `water_flowing` | tinyint | no | 0 |  |
| `water_seep` | tinyint | no | 0 |  |
| `water_spring` | tinyint | no | 0 |  |
| `vegetation_trees` | decimal(5, 2) | yes |  |  |
| `vegetation_bushes_shrubs` | decimal(5, 2) | yes |  |  |
| `vegetation_groundcover` | decimal(5, 2) | yes |  |  |
| `drainage_clogged_inlet` | tinyint | no | 0 |  |
| `drainage_compromised_drains` | tinyint | no | 0 |  |
| `drainage_surface_runoff` | tinyint | no | 0 |  |
| `drainage_torrent_surge_flood` | tinyint | no | 0 |  |
| `impact_impacted_adj_utilities` | tinyint | no | 0 |  |
| `impact_maybe_adj_utilities` | tinyint | no | 0 |  |
| `impact_adj_utilities` | varchar(255) | yes |  |  |
| `impact_impacted_adj_properties` | tinyint | no | 0 |  |
| `impact_maybe_adj_properties` | tinyint | no | 0 |  |
| `impact_adj_properties` | varchar(255) | yes |  |  |
| `impact_impacted_adj_structure` | tinyint | no | 0 |  |
| `impact_maybe_adj_structure` | tinyint | no | 0 |  |
| `impact_adj_structure` | varchar(255) | yes |  |  |
| `measure_slope_height_ft` | decimal(10, 2) | yes |  |  |
| `measure_original_slope_deg` | decimal(10, 2) | yes |  |  |
| `measure_landslide_width_ft` | decimal(10, 2) | yes |  |  |
| `measure_landslide_length_ft` | decimal(10, 2) | yes |  |  |
| `measure_main_scarp_height_ft` | decimal(10, 2) | yes |  |  |
| `measure_landslide_slope_deg` | decimal(10, 2) | yes |  |  |
| `measure_roadway_length_ft` | decimal(10, 2) | yes |  |  |
| `measure_roadway_width_ft` | decimal(10, 2) | yes |  |  |
| `record_of_event_notes` | text | yes |  |  |
| `maintenance_history_notes` | text | yes |  |  |
| `geotechnical_assessment_notes` | text | yes |  |  |
| `recommendations_notes` | text | yes |  |  |
| `sketchpad_notes` | text | yes |  |  |
| `observations_notes` | text | yes |  |  |
| `geometry_json` | longtext | yes |  |  |
| `elevation_terrain_grid_json` | longtext | yes |  |  |
| `elevation_terrain_source` | varchar(64) | yes |  |  |
| `elevation_terrain_checked_at` | datetime | yes |  |  |
| `elevation_terrain_error` | text | yes |  |  |
| `observations_notes_html` | mediumtext | yes |  |  |
| `geotechnical_assessment_notes_html` | mediumtext | yes |  |  |
| `recommendations_notes_html` | mediumtext | yes |  |  |
| `sketchpad_notes_html` | mediumtext | yes |  |  |
| `updated_by_user_id` | bigint | yes |  | FK |
| `revision` | integer | no | 0 |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |
| `road_inventory_dataset_version_id` | bigint | yes |  | FK |
| `road_inventory_segment_id` | bigint | yes |  | FK |
| `road_inventory_snapshot_json` | longtext | yes |  |  |
| `road_inventory_match_method` | varchar(32) | yes |  |  |
| `road_inventory_checked_at` | datetime | yes |  |  |
| `elevation_profile_json` | longtext | yes |  |  |
| `elevation_profile_source` | varchar(64) | yes |  |  |
| `elevation_profile_checked_at` | datetime | yes |  |  |
| `elevation_profile_classification` | varchar(32) | yes |  |  |
| `elevation_profile_confidence` | float | yes |  |  |
| `elevation_profile_error` | text | yes |  |  |

References:

- `location_id` → `incident_locations.id` (on delete set null)
- `road_inventory_dataset_version_id` → `road_inventory_datasets.id` (on delete set null)
- `road_inventory_segment_id` → `road_segments.id` (on delete set null)
- `submission_id` → `submissions.id` (on delete cascade)
- `updated_by_user_id` → `users.id` (on delete set null)

Indexes:

- `fk_gisa_updated_by` on `updated_by_user_id`
- `idx_gisa_county` on `county`
- `idx_gisa_district` on `district`
- `idx_gisa_location` on `location_id`
- `idx_gisa_report_date` on `report_date`
- `idx_gisa_route` on `route`
- `idx_submission_gisa_ri_dataset_version_id` on `road_inventory_dataset_version_id`
- `idx_submission_gisa_ri_segment_id` on `road_inventory_segment_id`

### `submission_gisa_actions`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `submission_id` | bigint | no |  | PK FK |
| `action_group` | varchar(16) | no |  | PK |
| `action_code` | varchar(64) | no |  | PK |
| `created_at` | datetime | no | current_timestamp() |  |

References:

- `submission_id` → `submissions.id` (on delete cascade)

Indexes:

- `idx_gisa_actions_code` on `action_code`
- `idx_gisa_actions_group` on `action_group`

### `submission_gisa_incident_types`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `submission_id` | bigint | no |  | PK FK |
| `incident_type_code` | varchar(64) | no |  | PK |
| `created_at` | datetime | no | current_timestamp() |  |

References:

- `submission_id` → `submissions.id` (on delete cascade)

Indexes:

- `idx_gisa_inc_type` on `incident_type_code`

### `submission_presence`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `submission_id` | bigint | no |  | PK FK |
| `session_id` | varchar(64) | no |  | PK |
| `user_id` | bigint | no |  | FK |
| `area` | varchar(96) | yes |  |  |
| `field` | varchar(160) | yes |  |  |
| `memo_keys` | varchar(255) | yes |  |  |
| `memo_active_at` | datetime | yes |  |  |
| `seen_at` | datetime | no |  |  |

References:

- `submission_id` → `submissions.id` (on delete cascade)
- `user_id` → `users.id` (on delete cascade)

Indexes:

- `fk_submission_presence_user` on `user_id`
- `idx_submission_presence_seen` on `submission_id, seen_at`

### `submission_share_reviews`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `share_id` | bigint | no |  | FK |
| `unit_type` | varchar(8) | no |  |  |
| `unit_id` | bigint | no |  |  |
| `kind` | varchar(8) | no |  |  |
| `decision` | varchar(16) | no | PENDING |  |
| `decided_by_user_id` | bigint | yes |  | FK |
| `decided_at` | datetime | yes |  |  |
| `note` | varchar(1000) | yes |  |  |
| `created_at` | datetime | no | current_timestamp() |  |

References:

- `decided_by_user_id` → `users.id` (on delete set null)
- `share_id` → `submission_shares.id` (on delete cascade)

Indexes:

- `fk_share_review_decider` on `decided_by_user_id`
- `idx_share_review_unit` on `unit_type, unit_id, decision`
- `uq_share_review_unit` on `share_id, unit_type, unit_id` (unique)

### `submission_shares`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `submission_id` | bigint | no |  | FK |
| `sharer_user_id` | bigint | no |  | FK |
| `recipient_user_id` | bigint | no |  | FK |
| `status` | varchar(16) | no | PENDING |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `activated_at` | datetime | yes |  |  |
| `ended_at` | datetime | yes |  |  |
| `ended_by_user_id` | bigint | yes |  | FK |
| `end_note` | varchar(1000) | yes |  |  |

References:

- `ended_by_user_id` → `users.id` (on delete set null)
- `recipient_user_id` → `users.id` (on delete cascade)
- `sharer_user_id` → `users.id`
- `submission_id` → `submissions.id` (on delete cascade)

Indexes:

- `fk_share_ended_by` on `ended_by_user_id`
- `fk_share_sharer` on `sharer_user_id`
- `idx_share_recipient` on `recipient_user_id, status`
- `idx_share_submission` on `submission_id, status`

### `submission_visibility`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `submission_id` | bigint | no |  | PK FK |
| `user_id` | bigint | no |  | PK FK |
| `granted_by_user_id` | bigint | no |  | FK |
| `created_at` | datetime | no | current_timestamp() |  |

References:

- `granted_by_user_id` → `users.id`
- `submission_id` → `submissions.id` (on delete cascade)
- `user_id` → `users.id` (on delete cascade)

Indexes:

- `fk_vis_granted_by` on `granted_by_user_id`
- `idx_vis_user` on `user_id`

### `submissions`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `created_by_user_id` | bigint | no |  | FK |
| `status` | varchar(32) | no | DRAFT |  |
| `client_submission_uuid` | varchar(64) | no |  | UK |
| `title` | varchar(255) | yes |  |  |
| `submitted_at` | datetime | yes |  |  |
| `reviewed_at` | datetime | yes |  |  |
| `reviewed_by_user_id` | bigint | yes |  | FK |
| `review_comment` | text | yes |  |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |

References:

- `created_by_user_id` → `users.id`
- `reviewed_by_user_id` → `users.id`

Indexes:

- `client_submission_uuid` on `client_submission_uuid` (unique)
- `fk_submissions_reviewed_by` on `reviewed_by_user_id`
- `idx_submissions_status` on `status`
- `idx_submissions_status_updated` on `status, updated_at`
- `idx_submissions_user` on `created_by_user_id`

### `workflow_events`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `submission_id` | bigint | no |  | FK |
| `actor_user_id` | bigint | no |  | FK |
| `event_type` | varchar(32) | no |  |  |
| `from_status` | varchar(32) | yes |  |  |
| `to_status` | varchar(32) | yes |  |  |
| `comment` | text | yes |  |  |
| `created_at` | datetime | no | current_timestamp() |  |

References:

- `actor_user_id` → `users.id`
- `submission_id` → `submissions.id` (on delete cascade)

Indexes:

- `fk_workflow_actor` on `actor_user_id`
- `idx_workflow_created` on `created_at`
- `idx_workflow_submission` on `submission_id`

## Attachments

### `attachment_capture_corrections`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `attachment_id` | bigint | no |  | FK |
| `client_correction_uuid` | varchar(64) | no |  | UK |
| `corrected_by_user_id` | bigint | no |  | FK |
| `location_is_override` | tinyint | no | 0 |  |
| `latitude` | decimal(10, 7) | yes |  |  |
| `longitude` | decimal(10, 7) | yes |  |  |
| `heading_is_override` | tinyint | no | 0 |  |
| `camera_heading_deg` | decimal(7, 3) | yes |  |  |
| `created_at` | datetime | no | current_timestamp() |  |

References:

- `attachment_id` → `attachments.id` (on delete cascade)
- `corrected_by_user_id` → `users.id`

Indexes:

- `fk_attachment_capture_correction_user` on `corrected_by_user_id`
- `idx_attachment_capture_correction_latest` on `attachment_id, id`
- `uk_attachment_capture_correction_client_uuid` on `client_correction_uuid` (unique)

### `attachment_capture_metadata`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `attachment_id` | bigint | no |  | PK FK |
| `captured_at` | datetime | yes |  |  |
| `latitude` | decimal(10, 7) | yes |  |  |
| `longitude` | decimal(10, 7) | yes |  |  |
| `horizontal_accuracy_m` | decimal(10, 3) | yes |  |  |
| `altitude_m` | decimal(10, 3) | yes |  |  |
| `camera_heading_deg` | decimal(7, 3) | yes |  |  |
| `camera_heading_accuracy_code` | smallint | yes |  |  |
| `heading_reference` | varchar(24) | yes |  |  |
| `location_source` | varchar(32) | yes |  |  |
| `heading_source` | varchar(32) | yes |  |  |
| `metadata_json` | longtext | yes |  |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |

References:

- `attachment_id` → `attachments.id` (on delete cascade)

Indexes:

- `idx_attachment_capture_geo` on `latitude, longitude`

### `attachment_links`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `submission_id` | bigint | no |  | FK |
| `attachment_id` | bigint | no |  | FK |
| `kind` | varchar(32) | no | PHOTO |  |
| `section_key` | varchar(64) | yes |  |  |
| `sort_order` | integer | no | 0 |  |
| `created_at` | datetime | no | current_timestamp() |  |

References:

- `attachment_id` → `attachments.id` (on delete cascade)
- `submission_id` → `submissions.id` (on delete cascade)

Indexes:

- `fk_attachment_links_attachment` on `attachment_id`
- `idx_attachment_links_kind` on `kind`
- `idx_attachment_links_section_key` on `section_key`
- `idx_attachment_links_submission` on `submission_id`
- `uk_submission_attachment` on `submission_id, attachment_id` (unique)

### `attachments`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `created_by_user_id` | bigint | no |  | FK |
| `storage_provider` | varchar(32) | no |  |  |
| `storage_bucket` | varchar(128) | no |  |  |
| `storage_key` | varchar(512) | no |  |  |
| `file_name` | varchar(255) | no |  |  |
| `mime_type` | varchar(128) | no |  |  |
| `file_size_bytes` | bigint | no |  |  |
| `sha256` | char(64) | yes |  |  |
| `captured_at` | datetime | yes |  |  |
| `uploaded_at` | datetime | yes |  |  |
| `created_at` | datetime | no | current_timestamp() |  |

References:

- `created_by_user_id` → `users.id`

Indexes:

- `idx_attachments_storage` on `storage_provider, storage_bucket`
- `idx_attachments_user` on `created_by_user_id`
- `uk_attachments_storage_object` on `storage_provider, storage_bucket, storage_key` (unique)

## Notifications

### `incident_notifications`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `incident_id` | bigint | no |  | FK |
| `recipient_user_id` | bigint | no |  | FK |
| `channel` | varchar(16) | no | IN_APP |  |
| `template_code` | varchar(64) | no |  |  |
| `payload_json` | longtext | yes |  |  |
| `delivered_at` | datetime | yes |  |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `delivery_attempts` | integer | no | 0 |  |
| `last_error` | varchar(255) | yes |  |  |
| `last_attempt_at` | datetime | yes |  |  |

References:

- `incident_id` → `incidents.id` (on delete cascade)
- `recipient_user_id` → `users.id` (on delete cascade)

Indexes:

- `idx_inc_notify_created` on `created_at`
- `idx_inc_notify_incident` on `incident_id`
- `idx_inc_notify_outbox` on `channel, delivered_at, last_attempt_at, id`
- `idx_inc_notify_recipient` on `recipient_user_id`

### `push_devices`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `user_id` | bigint | no |  | FK |
| `token` | varchar(255) | no |  | UK |
| `platform` | varchar(16) | yes |  |  |
| `is_active` | tinyint | no | 1 |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `last_seen_at` | datetime | no | current_timestamp() |  |

References:

- `user_id` → `users.id` (on delete cascade)

Indexes:

- `idx_push_device_user` on `user_id, is_active`
- `uq_push_device_token` on `token` (unique)

### `user_notifications`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `user_id` | bigint | no |  | FK |
| `kind` | varchar(48) | no |  |  |
| `title` | varchar(255) | no |  |  |
| `body` | varchar(1000) | yes |  |  |
| `link` | varchar(255) | yes |  |  |
| `incident_id` | bigint | yes |  |  |
| `assessment_id` | bigint | yes |  |  |
| `task_state` | varchar(40) | yes |  |  |
| `actor_user_id` | bigint | yes |  | FK |
| `created_at` | datetime | no | current_timestamp() |  |
| `read_at` | datetime | yes |  |  |
| `push_state` | varchar(12) | yes |  |  |

References:

- `actor_user_id` → `users.id` (on delete set null)
- `user_id` → `users.id` (on delete cascade)

Indexes:

- `fk_user_notification_actor` on `actor_user_id`
- `idx_user_notification_assessment` on `assessment_id`
- `idx_user_notification_feed` on `user_id, id`
- `idx_user_notification_push` on `push_state, created_at`
- `idx_user_notification_unread` on `user_id, read_at`

## Maintenance workflows

### `maintenance_workflow_events`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `district` | varchar(4) | no |  |  |
| `incident_id` | bigint | yes |  | FK |
| `actor_user_id` | bigint | no |  |  |
| `action` | varchar(48) | no |  |  |
| `step_index` | integer | yes |  |  |
| `notes` | text | yes |  |  |
| `metadata_json` | longtext | yes |  |  |
| `created_at` | datetime | no | current_timestamp() |  |

References:

- `incident_id` → `incidents.id` (on delete cascade)

Indexes:

- `idx_maintenance_events_incident` on `incident_id, id`

### `maintenance_workflow_runs`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `incident_id` | bigint | no |  | PK FK |
| `district` | varchar(4) | no |  |  |
| `revision` | integer | no |  |  |
| `definition_json` | longtext | no |  |  |
| `state_json` | longtext | no |  |  |
| `version` | integer | no | 1 |  |
| `outcome` | varchar(32) | yes |  |  |
| `updated_at` | datetime | no | current_timestamp() |  |

References:

- `incident_id` → `incidents.id` (on delete cascade)

Indexes:

- `idx_maintenance_runs_district` on `district, outcome`

### `maintenance_workflows`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `district` | varchar(4) | no |  | PK |
| `revision` | integer | no |  |  |
| `definition_json` | longtext | no |  |  |
| `updated_by_user_id` | bigint | no |  |  |
| `updated_at` | datetime | no | current_timestamp() |  |

## Projects

### `caltrans_projects`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `project_key` | varchar(64) | no |  | UK |
| `project_number` | varchar(128) | yes |  |  |
| `title` | varchar(255) | no |  |  |
| `description` | text | yes |  |  |
| `district` | varchar(64) | yes |  |  |
| `status` | varchar(32) | no | ACTIVE |  |
| `source_system` | varchar(32) | no | ERIS_MANUAL |  |
| `external_project_id` | varchar(255) | yes |  |  |
| `source_metadata_json` | longtext | yes |  |  |
| `last_synced_at` | datetime | yes |  |  |
| `created_by_user_id` | bigint | yes |  | FK |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |

References:

- `created_by_user_id` → `users.id` (on delete set null)

Indexes:

- `fk_caltrans_projects_created_by` on `created_by_user_id`
- `idx_caltrans_projects_number` on `project_number`
- `idx_caltrans_projects_source` on `source_system`
- `idx_caltrans_projects_status` on `status`
- `uk_caltrans_projects_external` on `source_system, external_project_id` (unique)
- `uk_caltrans_projects_key` on `project_key` (unique)

## Road inventory

### `road_inventory_datasets`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `version_tag` | varchar(64) | no |  |  |
| `upload_filename` | varchar(512) | no |  |  |
| `extract_date` | date | yes |  |  |
| `row_count` | integer | no | 0 |  |
| `skipped_count` | integer | no | 0 |  |
| `status` | enum | no | pending |  |
| `storage_key` | varchar(512) | yes |  |  |
| `uploaded_by` | bigint | no |  |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `published_at` | datetime | yes |  |  |

Indexes:

- `idx_rid_published` on `status, published_at`
- `idx_rid_status` on `status`

### `road_inventory_import_jobs`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `job_uuid` | char(36) | no |  | UK |
| `status` | enum | no | queued |  |
| `stage` | varchar(64) | no | queued |  |
| `message` | varchar(512) | yes |  |  |
| `upload_filename` | varchar(512) | no |  |  |
| `requested_version_tag` | varchar(64) | yes |  |  |
| `storage_key` | varchar(512) | yes |  |  |
| `file_size_bytes` | bigint | yes |  |  |
| `dataset_version_id` | bigint | yes |  |  |
| `row_count` | integer | no | 0 |  |
| `skipped_count` | integer | no | 0 |  |
| `warnings_json` | longtext | yes |  |  |
| `error_message` | text | yes |  |  |
| `created_by` | bigint | no |  |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `started_at` | datetime | yes |  |  |
| `finished_at` | datetime | yes |  |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |

Indexes:

- `idx_rij_created` on `created_at`
- `idx_rij_dataset` on `dataset_version_id`
- `idx_rij_status` on `status`
- `uq_rij_uuid` on `job_uuid` (unique)

### `road_inventory_packages`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `dataset_version_id` | bigint | no |  | FK |
| `package_type` | enum | no |  |  |
| `storage_key` | varchar(512) | no |  |  |
| `file_size_bytes` | bigint | no |  |  |
| `sha256` | char(64) | no |  |  |
| `generated_at` | datetime | no | current_timestamp() |  |

References:

- `dataset_version_id` → `road_inventory_datasets.id` (on delete cascade)

Indexes:

- `uq_rip_version_type` on `dataset_version_id, package_type` (unique)

### `road_segments`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `dataset_version_id` | bigint | no |  | FK |
| `thy_id` | bigint | yes |  |  |
| `district_code` | varchar(8) | yes |  |  |
| `county_code` | varchar(8) | no |  |  |
| `route_name` | varchar(16) | no |  |  |
| `route_suffix_code` | varchar(4) | yes |  |  |
| `pm_prefix_code` | varchar(4) | yes |  |  |
| `begin_pm` | decimal(10, 4) | no |  |  |
| `end_pm` | decimal(10, 4) | no |  |  |
| `pm_suffix_code` | varchar(4) | yes |  |  |
| `length_miles` | decimal(10, 4) | yes |  |  |
| `left_lanes` | tinyint | yes |  |  |
| `right_lanes` | tinyint | yes |  |  |
| `left_surface_type` | varchar(8) | yes |  |  |
| `right_surface_type` | varchar(8) | yes |  |  |
| `left_shoulder_width` | decimal(6, 2) | yes |  |  |
| `right_shoulder_width` | decimal(6, 2) | yes |  |  |
| `median_type` | varchar(8) | yes |  |  |
| `median_width` | decimal(6, 2) | yes |  |  |
| `access_code` | varchar(4) | yes |  |  |
| `terrain_code` | varchar(4) | yes |  |  |
| `design_speed` | smallint | yes |  |  |
| `adt` | integer | yes |  |  |
| `landmark_short_desc` | varchar(255) | yes |  |  |
| `functional_class_code` | varchar(8) | yes |  |  |
| `maintenance_service_level_code` | varchar(8) | yes |  |  |
| `federal_aid_code` | varchar(8) | yes |  |  |
| `scenic_freeway_code` | varchar(8) | yes |  |  |
| `extract_date` | date | yes |  |  |
| `raw_json` | longtext | yes |  |  |
| `created_at` | datetime | no | current_timestamp() |  |

References:

- `dataset_version_id` → `road_inventory_datasets.id` (on delete cascade)

Indexes:

- `idx_rs_district` on `dataset_version_id, district_code, county_code, route_name`
- `idx_rs_lookup` on `dataset_version_id, county_code, route_name, begin_pm, end_pm`

## Terrain and offline scenes

### `offline_scene_jobs`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `submission_id` | bigint | no |  | FK |
| `requested_by` | bigint | yes |  | FK |
| `status` | varchar(32) | no | QUEUED |  |
| `progress_pct` | integer | no | 0 |  |
| `status_message` | varchar(255) | yes |  |  |
| `center_lat` | double | yes |  |  |
| `center_lon` | double | yes |  |  |
| `radius_m` | double | yes |  |  |
| `min_lat` | double | yes |  |  |
| `min_lon` | double | yes |  |  |
| `max_lat` | double | yes |  |  |
| `max_lon` | double | yes |  |  |
| `retry_count` | integer | no | 0 |  |
| `error_details` | text | yes |  |  |
| `result_package_id` | bigint | yes |  |  |
| `result_package_version` | varchar(64) | yes |  |  |
| `usgs_source_metadata` | longtext | yes |  |  |
| `basemap_source_metadata` | longtext | yes |  |  |
| `worker_id` | varchar(64) | yes |  |  |
| `worker_log_ref` | varchar(255) | yes |  |  |
| `claimed_at` | datetime | yes |  |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |

References:

- `requested_by` → `users.id` (on delete set null)
- `submission_id` → `submissions.id` (on delete cascade)

Indexes:

- `fk_osj_requested_by` on `requested_by`
- `idx_osj_status` on `status`
- `idx_osj_submission_status` on `submission_id, status`

### `offline_scene_orphaned_objects`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `submission_id` | bigint | no |  |  |
| `job_id` | bigint | yes |  |  |
| `minio_bucket` | varchar(255) | no |  |  |
| `object_key` | varchar(1024) | no |  |  |
| `sha256` | char(64) | yes |  |  |
| `size_bytes` | bigint | yes |  |  |
| `reason` | varchar(255) | no | cancelled_before_registration |  |
| `resolved` | tinyint | no | 0 |  |
| `resolved_by` | bigint | yes |  |  |
| `resolution_notes` | varchar(512) | yes |  |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `resolved_at` | datetime | yes |  |  |

Indexes:

- `idx_osoo_job` on `job_id`
- `idx_osoo_resolved` on `resolved`
- `idx_osoo_submission` on `submission_id`

### `offline_scene_packages`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `submission_id` | bigint | no |  | FK |
| `status` | varchar(16) | no | READY |  |
| `package_version` | varchar(64) | no |  |  |
| `minio_bucket` | varchar(128) | no |  |  |
| `object_key` | varchar(512) | no |  | UK |
| `sha256` | char(64) | no |  |  |
| `size_bytes` | bigint | no |  |  |
| `package_format` | varchar(32) | no | mspk |  |
| `object_version_id` | varchar(128) | yes |  |  |
| `object_etag` | varchar(128) | yes |  |  |
| `min_lat` | double | no |  |  |
| `min_lon` | double | no |  |  |
| `max_lat` | double | no |  |  |
| `max_lon` | double | no |  |  |
| `center_lat` | double | no |  |  |
| `center_lon` | double | no |  |  |
| `radius_m` | double | no |  |  |
| `elevation_source` | varchar(64) | no | USGS_3DEP |  |
| `elevation_dataset` | varchar(128) | yes |  |  |
| `elevation_version` | varchar(64) | yes |  |  |
| `elevation_resolution` | varchar(64) | yes |  |  |
| `basemap_or_imagery_source` | varchar(255) | yes |  |  |
| `content_signature` | varchar(64) | no |  |  |
| `created_at` | datetime | no | current_timestamp() |  |
| `uploaded_at` | datetime | yes |  |  |
| `uploaded_by` | bigint | yes |  | FK |
| `retired_at` | datetime | yes |  |  |
| `notes` | text | yes |  |  |

References:

- `submission_id` → `submissions.id` (on delete cascade)
- `uploaded_by` → `users.id` (on delete set null)

Indexes:

- `fk_osp_uploaded_by` on `uploaded_by`
- `idx_osp_submission_status` on `submission_id, status`
- `uq_osp_object_key` on `object_key` (unique)
- `uq_osp_submission_version` on `submission_id, package_version` (unique)

### `offline_scene_worker_heartbeats`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `worker_id` | varchar(64) | no |  | PK |
| `last_seen` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |
| `started_at` | datetime | no | current_timestamp() |  |
| `jobs_processed` | bigint | no | 0 |  |
| `last_stage` | varchar(48) | yes |  |  |

Indexes:

- `idx_oswh_last_seen` on `last_seen`

### `terrain_cross_section_points`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `cross_section_id` | bigint | no |  | FK |
| `sequence_number` | integer | no |  |  |
| `latitude` | decimal(10, 7) | no |  |  |
| `longitude` | decimal(10, 7) | no |  |  |
| `distance_m` | double | yes |  |  |
| `elevation_m` | double | yes |  |  |
| `created_at` | datetime | no | current_timestamp() |  |

References:

- `cross_section_id` → `terrain_cross_sections.id` (on delete cascade)

Indexes:

- `idx_terrain_cross_section_points_section` on `cross_section_id`
- `uk_terrain_cross_section_point_sequence` on `cross_section_id, sequence_number` (unique)

### `terrain_cross_sections`

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | bigint | no |  | PK |
| `cross_section_key` | varchar(64) | no |  | UK |
| `caltrans_project_id` | bigint | no |  | FK |
| `name` | varchar(255) | no |  |  |
| `notes` | text | yes |  |  |
| `preferred_spacing_m` | double | yes |  |  |
| `actual_spacing_m` | double | yes |  |  |
| `dem_source` | varchar(128) | no | ARCGIS_WORLD_ELEVATION |  |
| `profile_snapshot_json` | longtext | yes |  |  |
| `created_by_user_id` | bigint | no |  | FK |
| `created_at` | datetime | no | current_timestamp() |  |
| `updated_at` | datetime | no | current_timestamp() ON UPDATE current_timestamp() |  |

References:

- `caltrans_project_id` → `caltrans_projects.id`
- `created_by_user_id` → `users.id`

Indexes:

- `idx_terrain_cross_sections_created_by` on `created_by_user_id`
- `idx_terrain_cross_sections_project` on `caltrans_project_id, updated_at`
- `uk_terrain_cross_sections_key` on `cross_section_key` (unique)
