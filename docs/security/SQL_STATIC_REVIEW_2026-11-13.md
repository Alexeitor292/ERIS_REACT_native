# Dynamic SQL review — 13 November 2026

The 98 Bandit B608 findings in `evidence/2026-11-13/bandit-final.json` were
reviewed against source commit `70b3147`. All are medium severity, low confidence.
No request-controlled SQL syntax was identified in these sites. The source still
uses bound values, and the findings remain visible in the full Bandit report;
there is no B608 suppression or scanner exclusion.

This is a source review of the flagged paths, not a penetration test or a promise
that the application has no unknown vulnerabilities. Caltrans IT should retain
the normal independent application assessment before production approval.

## Method and controls

Each interpolated expression was traced to its source: SQL literals, generated
parameter names, model fields, explicit column names, permission predicates and
their callers. Request text, user and database identifiers, search terms, limits,
districts, roles and dates are supplied separately to SQLAlchemy `execute` as
bound parameters. Variable identifier names require a separate source control;
escaping a value alone would not make an interpolated identifier safe.

The table inventories all 98 findings. Line numbers refer to the retained Bandit
report and reviewed source. A row's disposition applies only to those listed
sites, with the specific controls described in that row.

| Source under `backend/app/` | Report lines | Count | Reviewed source of SQL syntax and disposition |
| --- | --- | ---: | --- |
| `admin_users.py` | 291, 622, 632 | 3 | Organization join/office expressions are module constants; role tokens are generated named parameters. User/profile update columns are assigned from literal field names, while values are bound. No untrusted syntax identified. |
| `main.py` | 556, 992, 1018, 1035, 1485, 1495, 2259 | 7 | Optional lock/status clauses are literals. `form_access.readable_sql` is reviewed below. GISA columns originate from `GisaDraftPatch.model_dump`, then fixed linked-field normalizers; unknown client keys are not forwarded. Permission IDs generate placeholder names, not embedded values. No untrusted syntax identified. |
| `routes/assessments.py` | 260, 268, 284, 1113, 1293 | 5 | Column list and routing-state names are constants; IDs generate parameter tokens. Queue/workload predicates select fixed clauses; office/user/filter values are bound. No untrusted syntax identified. |
| `routes/cracks.py` | 339, 371 | 2 | `normalize_fields` rejects keys outside `EDITABLE`, then constructs output using literal keys/constant measure names. System columns are literal additions. Values use named parameters. No untrusted syntax identified. |
| `routes/drone_surveys.py` | 344 | 1 | Update assignments are selected from literal statements for supported properties. JSON/text/IDs remain bound. No untrusted syntax identified. |
| `routes/event_groups.py` | 329, 394 | 2 | Search/status predicates and title/description assignments are literals; status is enumerated and values are bound. No untrusted syntax identified. |
| `routes/incident_classification.py` | 139 | 1 | ID placeholders are generated from list indices; reporter restriction is a fixed optional clause. IDs and reporter are bound. No untrusted syntax identified. |
| `routes/incidents.py` | 373, 410, 517, 537, 615, 672, 797, 1498, 2040, 2148, 2615 | 11 | Timeline/public, mobile/role and routing filters are fixed server predicates. Organization expressions/terminal states are constants. Picker IDs generate placeholders. Road-inventory column/assignment fragments are literal alternatives. `public_visibility` and mobile-scope helpers were traced; values stay in params. No untrusted syntax identified. |
| `routes/mission_center_event_groups.py` | 30 | 1 | Optional pagination clause is literal; cursor is bound. No untrusted syntax identified. |
| `routes/mission_center_gis.py` | 45 | 1 | Optional project pagination clause is literal; cursor is bound. No untrusted syntax identified. |
| `routes/org.py` | 272, 301, 369, 388, 465, 605, 686, 789, 960, 1089, 1125, 1424 | 12 | Office/branch/district lists generate named placeholders. Active/type predicates are fixed fragments. Office, branch, classification and profile updates build dictionaries with explicit literal column names rather than accepting request key names; values are bound. No untrusted syntax identified. |
| `routes/projects.py` | 269, 334 | 2 | Search/status predicates and title/description assignments are literals. Status is enumerated; search and updates are bound. No untrusted syntax identified. |
| `routes/site_history.py` | 132, 170, 235 | 3 | Location/bounding-box predicates are literals with bound coordinates; readable predicate is the reviewed `form_access` helper. No untrusted syntax identified. |
| `routes/terrain_cross_sections.py` | 288 | 1 | Search/status predicates are literals; text, status and limit are bound. No untrusted syntax identified. |
| `routes/user_layouts.py` | 175 | 1 | Name/layout/default assignments are literals; JSON/text, layout ID and authenticated owner ID are bound. No untrusted syntax identified. |
| `services/delegations.py` | 130, 143, 204, 274, 299 | 5 | `_RUNNING` is a literal predicate, person-scope predicates are fixed alternatives, and the coverage table loop names exactly two literal tables. Values use ordinary or expanding bind parameters. No untrusted syntax identified. |
| `services/district_contact.py` | 48 | 1 | Loop selects exactly `org_coordinator_coverage` and `org_district_crew`; district is bound. No untrusted syntax identified. |
| `services/form_access.py` | 42, 57, 75, 86, 101 | 5 | SQL permissions combine literal owner, sharing, assignment and approval clauses. All current alias callers use the literal/default `s`; user and office values are bound. Internal alias trust boundary described below. No untrusted syntax identified. |
| `services/form_presence.py` | 47, 123 | 2 | `_ALIVE`/`_WRITING` interpolate fixed integer timing constants into fixed predicates. Session/user/submission values are bound. No untrusted syntax identified. |
| `services/maintenance_workflows.py` | 104, 110 | 2 | Only optional literal `FOR UPDATE` is concatenated; incident/district values are bound. No untrusted syntax identified. |
| `services/notification_feed.py` | 301 | 1 | Optional pagination/unread clauses are literal alternatives; authenticated user, cursor and limit are bound. No untrusted syntax identified. |
| `services/notifications.py` | 299 | 1 | Pending columns and retry predicates are constants. Optional notification-ID list generates named placeholders; values are bound. No untrusted syntax identified. |
| `services/offline_scene_jobs.py` | 91, 98, 110, 152, 170, 213, 341 | 7 | Column list and job-state sets are module constants. Dynamic updates bind values, with column names supplied by internal literal keyword callers only. Internal field-name trust boundary described below. No reachable untrusted syntax identified. |
| `services/org_directory.py` | 724 | 1 | Include-inactive selects one of two literal fragments. No untrusted syntax identified. |
| `services/org_tree.py` | 255, 271, 686, 786 | 4 | Table loop names two literal coverage tables. `_person_rows` receives a literal predicate from its current caller. Branch updates use literal assignments; detail updates filter against `DETAIL_FIELDS`. Values are bound. No untrusted syntax identified. |
| `services/public_visibility.py` | 100, 106, 135, 158, 189, 220 | 6 | Approval-state expression is a constant. Current aliases are literal `i`, `inc`, or the helper default; request IDs generate bind names or bound values. Internal alias trust boundary described below. No untrusted syntax identified. |
| `services/road_inventory_import_jobs.py` | 224 | 1 | Private `_update` binds values; every current call supplies literal keyword column names. No uploaded content supplies column names. Internal field-name trust boundary described below. No reachable untrusted syntax identified. |
| `services/sharing.py` | 164, 175, 245, 516, 579, 593 | 6 | Grant-table loop names two literal tables; optional lock, form columns and progress predicate are constants. Review-unit filters generate named placeholders; unit/user/share values are bound. No untrusted syntax identified. |
| `services/workflow_tree.py` | 76 | 1 | User IDs are normalized to integers and generate named placeholder tokens. Values are bound. No untrusted syntax identified. |
| `tools/create_admin.py` | 94 | 1 | Update assignments are literal alternatives; administrator input stays bound. No untrusted syntax identified. |
| `tools/prepare_database.py` | 19 | 1 | Preflight table loop names exactly four literal tables. No untrusted syntax identified. |
| **Total** | | **98** | **All retained B608 findings reviewed.** |

## Internal trust boundaries to preserve

`offline_scene_jobs.update_job` / `update_job_if_active` and private
`road_inventory_import_jobs._update` interpolate `**fields` keys as columns.
Their current callers use programmer-written keyword names. They must never
receive `**request_body`, imported file keys, or other externally supplied keys.
If a future caller needs that behavior, add an explicit column allowlist at the
helper boundary first. Their values are bound today; that does not validate a
future arbitrary key.

`form_access.readable_sql`, `public_visibility.public_incident_sql` and the
public-scope helpers accept SQL aliases; `org_tree._person_rows` accepts a SQL
predicate. These are internal composition functions, with literal callers in
the reviewed tree. Do not connect these syntax arguments to request parameters.
Changes to those call sites require another review.

## Regression evidence

`backend/tests/test_sql_parameterization.py`: **19 passed** locally on
13 November 2026. It calls the real project, event-group and cross-section query
builders and compiles statements for MySQL, checking that quote/comment/UNION/
DROP payloads stay in bound parameters. It also verifies invalid status rejection,
crack column-name rejection and GISA schema filtering of injected identifiers.
These are representative adversarial regressions; the table's other dispositions
come from source and caller tracing, not an assertion that 19 tests cover every
query behavior.

Re-run the full Bandit report after source changes and compare findings with this
inventory. Keep the high-severity/high-confidence CI gate and the complete report
artifact. Revisit any new interpolation site, changed predicate builder or new
caller that crosses the internal trust boundaries above.
