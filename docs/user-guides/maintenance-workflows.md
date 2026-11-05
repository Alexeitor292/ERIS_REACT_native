# District maintenance workflows

Maintenance duties are independent of personnel classifications or job titles.
An administrator creates a district's first workflow under **Organization →
Maintenance**, names its workflow managers, and assigns people to duties.
Named district managers and administrators can publish subsequent changes.

There is one **Maintenance** role. On its own it reads a person's own reports; what
more they can do comes from their part here, and being named in a workflow is what
gives them the role. A district with no workflow has no Maintenance reporting:
Staff and administrators can still report there, and an administrator decides.

## Configuring a district

The page shows each district's workflow as a tree you can drag around: who can
report, each review step, the final decision and its two outcomes. Add and remove
people where they appear, and use **+ Review step** to add a review. **Advanced
editor** opens the configuration panel, with separate sections for duties and
people, alerts, and managers, for shared duties and step-specific alerts.

- Create any number of named duties, with any number of registered active users
  in each. A person can hold several duties and work in multiple districts.
- Give each duty reporting, district report reading, or report editing access.
  Reporting alone grants access to the person's own reports. Reviewers and
  notification recipients can read the reports they receive. These permissions
  confer no GeoTech assessment or form editing rights.
- Choose notification duties for all workflow changes and/or individual steps.
  Notifications appear in the web/mobile notification feed; configured Expo push
  delivery uses the existing feed delivery service. New workflow notices do not
  send email or SMS.
- Add, name, reorder or remove intermediate review steps. Each step assigns
  duties and chooses whether one person or all distinct assigned people must
  agree. A person in two assigned duties counts once.
- End with a decision step, with one or more assigned people. Allow maintenance
  handling, GeoTech referral, or both. An intermediate step can optionally end
  with maintenance handling; only the final step can refer to GeoTech.
- Optionally let reviewers ask the reporter for more information.

Reports wait in **My Work**, the one queue every user has: each person sees
the reports at their step, and can also show the other reports they may read.
Administrators can show geotechnical work, maintenance work or both. Links to
the former Maintenance Work page (`/maintenance-work?incident=N`, as in earlier
notifications) open the report in My Work. Review notes are required. Unanimous
decision makers must agree on the same outcome and Incident Group. A GeoTech
referral uses the existing assessment creation, office routing and notification
logic. Maintenance handling ends maintenance review without creating an
assessment; it does not certify that a physical repair has been performed.

## Publication, changes and history

Each published configuration has a revision. A new report snapshots its
configuration and assigned people; publication applies to subsequent reports.
Old reports keep their assigned people even when new district duties change.
Managers can explicitly restart an open report using the current configuration
to replace assignments or recover a stalled review. Previous events stay in
history. Updating a report's description or adding evidence restarts review at
step one so previous approvals cannot silently cover changed content.

Report actions use a database row lock and a version check. Stale actions,
duplicate approvals, steps taken out of order and changes after a terminal
outcome are refused. Decisions, workflow state, history and notification intents
commit in the same transaction. The older triage actions cannot bypass an
open configured workflow. No job-title role is granted or changed.

## Deployment and validation

Apply the database migration before starting the updated API:

```powershell
cd backend
.venv/Scripts/alembic.exe upgrade head
```

Migration `20261007_maintenance_workflows` adds configuration, per-incident run,
and audit tables; it does not enroll any district automatically. Deploy the web
and mobile changes with the updated API. Existing accounts receive their
maintenance duties when their identity is refreshed or they sign in again.

`backend/tests/test_maintenance_workflows.py` exercises the actual service and
route SQL on SQLite, including authorization, ANY/ALL review, snapshots, explicit
restart, stale writes, notifications, legacy bypass protection and rollback at
GeoTech handoff. SQLite removes `FOR UPDATE`; production row-lock behavior and
the migration itself are checked separately by the MariaDB integration test
`backend/tests/test_maintenance_workflows_db.py`, including simultaneous votes,
maintenance closure, actual assessment handoff and notification persistence. Browser checks
use an isolated SQLite-backed preview with sample users and reports.
