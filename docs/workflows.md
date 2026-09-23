# Workflows

How work moves through ERIS: from a field report, through triage, into an Incident
Group and an assessment, to approval. Role names are those in
[roles-and-identity.md](roles-and-identity.md); organization data (offices,
branches, district coverage) is maintained as described in
[organization.md](organization.md).

## 1. Field report

A **Maintenance Crew** member, a **Staff** member or an administrator reports an
incident, on the phone or with **Report an incident** on the web. The location
can be given three ways: GPS (phone) or a point on a map (web), route and
postmile with county, or latitude and longitude. Each is converted to the others
through the public Caltrans postmile layer.

A new report is **provisional**: stage `COORDINATOR_REVIEW`, no ERIS number, not
in any Incident Group, and not part of the incident record, the Incident Groups page or
the Mission Center. Until triage, its reporter (or the coordinator, or an
administrator) may discard it.

## 2. Triage

The **Maintenance Coordinator** covering the report's district (or an
administrator) reviews it and makes one decision (`POST /incidents/{id}/triage`):

| Decision | Result |
| --- | --- |
| **Assessment required** | The report **enters the incident record**. The coordinator attaches it to an open Incident Group nearby, or starts a new one. The report receives its permanent ERIS number, an assessment is created for the GeoTech office that serves the district, and the stage becomes `OFFICE_CHIEF_REVIEW`. |
| **No assessment required** | Closed at triage (stage `RESOLVED`). Kept with its decision and history, but with no ERIS number and no Incident Group, and it never appears in the record or the Mission Center. |
| **Duplicate or linked** | Closed at triage the same way, linked to the report it duplicates. |
| **Needs reporter information** | Sent back to the reporter. It stays provisional, is taken out of any Incident Group, and returns to the coordinator when the reporter answers. |

Only "Assessment required" asks for an Incident Group. The database refuses to move
a report out of triage without an Incident Group and an ERIS number, except when it
is closed at triage, and refuses ever to change an ERIS number.

## 3. Incident Groups

An Incident Group gathers the reports caused by one event, such as a storm that
damaged several slopes on one route.

- A report belongs to **at most one** group. New groups are started from a
  report: during triage, or by an administrator moving a report. There is no
  separate "create group" action.
- Status is `OPEN`, `CLOSED` or `ARCHIVED`. Only an open group accepts reports. A
  coordinator (or administrator) closes a group once every report in it is
  resolved, and can reopen it. A group left with no reports is archived
  automatically.
- Coordinators and administrators edit a group's title and description. Moving a
  report that is already in the record to another group is for administrators
  only.
- The **Mission Center** shows every Incident Group holding at least one report in
  the record, with its reports on the map; selecting a group or a report zooms
  the map to fit it.

The older `/projects` endpoints still answer, as views over Incident Groups, for
older clients.

## 4. Assessments

Each assessment is routed to the GeoTech office that serves the report's
district (set on the **Organization** page). The office and branch names are frozen
on the assessment when it is routed, so renaming or restructuring the
organization never rewrites history.

```
PENDING_OFFICE_DELEGATION ──(branch route)──► PENDING_ENGINEER_ASSIGNMENT ──► DRAFT
          │                                                                     ▲
          └──────────(Senior Specialist route)──────────────────────────────────┘
DRAFT ──submit──► SUBMITTED ──approve──► APPROVED (final)
                      │
                      └──request revision──► REVISION_REQUESTED ──resubmit──► SUBMITTED
```

1. **The Office Chief routes it**, choosing one of two routes by hand. Nothing is
   pre-selected:
   - **Branch route:** hand it to a **Branch Chief** of the office (state
     `PENDING_ENGINEER_ASSIGNMENT`, incident stage `BRANCH_CHIEF_REVIEW`). The
     Branch Chief assigns a **Staff** member. Assigning outside the branch needs
     a recorded reason; assigning outside the office is refused.
   - **Senior Specialist route:** assign a **Senior Specialist** of the office
     directly.

   Either way the assessment moves to `DRAFT` and the incident to
   `ENGINEER_ASSIGNED`. The database refuses an assignee without the right role.
   Both pickers list the office's own people first. An account with no office
   recorded at all (created before office scoping) is still offered, so an old
   account cannot strand an assessment; one placed in another office never is.
   Office chiefs always need an office, since their authority covers it whole.
2. **The author fills the technical form** (the GISA form: site, measurements,
   photos, sketches, actions, memos) and submits it (`SUBMITTED`). On the web
   the form's location map has a **Site areas** toolbar: draw areas as
   polygons or rectangles, click one to reshape, move, rotate or delete it, and
   see each area's size in square metres and acres. Areas save as the form's
   geometry the moment they change (one area as a GeoJSON Polygon, several as a
   MultiPolygon), the same geometry the mobile app draws. Below the GISA
   sheet, **Measurements** puts the 3D terrain beside the landslide sketch and
   its fields (H, α, Wd, Ld, Hs, β, Lr, Wr). **Measure** samples Esri World
   Elevation (the finest resolution that covers the whole area) inside a drawn
   area and in a band around it, in the browser. It then proposes β and α
   (planes fitted inside and around), Ld along the fall line, Wd across it, and
   H (the area's relief, 2nd to 98th percentile). **Measure road** rebuilds the
   highway from its centerline and the road inventory at the form's route and
   postmile (lanes, traveled way, shoulders and median), then proposes Lr (the
   centerline length the area covers, along the curve) and Wr (the widest
   roadway it covers at one station), with which lanes it reaches and a plan
   sketch. Without an inventory row it assumes two 12 ft lanes and says so.
   Proposals fill empty fields, or one field at a time. Nothing is saved until
   the author saves the draft. Hs stays a field measurement. The rest of the lower half has three
   parts:
   - **Actions:** checklists of immediate and follow-up actions.
   - **Memos:** one tab each for Observations, Geotechnical assessment,
     Recommendations and Sketch notes, written in a word processor with a
     Word-style ribbon (fonts, sizes, colors, styles, lists and checklists,
     indent and spacing, tables with merge and shading, symbols, find and
     replace, print). The server stores each memo
     sanitized, next to a plain-text copy used by the PDF and the mobile app.
     Two more tabs show the site's history (`GET /submissions/{id}/site-history`,
     operational roles): **Record of incidents** lists earlier incidents in the
     record within 150 m, marked as a recurrence of the same type or a
     different type; **Maintenance history** lists maintenance reports there
     that never entered the record, with the coordinator's decision. Both keep
     a notes field.
   - **Review and record:** where the form stands, the reviewer's note, its
     history and who it is shared with.
3. **The reviewer decides.** On the branch route that is the Branch Chief named
   on the assessment; on the Senior Specialist route, an Office Chief of the
   assessment's office. No other role and no assignment grants review authority.
   - **Approve:** the assessment is `APPROVED`, which is final. The district's
     coordinator is notified in the app and, if email is configured, by email.
     The record becomes readable by Guests.
   - **Request revision:** back to the author (`REVISION_REQUESTED`), who
     resubmits.
4. **The incident is resolved** by its assignee (the Staff member or Senior
   Specialist) or an administrator (stage `RESOLVED`).

An Office Chief, a Branch Chief or an administrator can add anyone operational
as **Consulted**, for information only. `FINALIZED` exists only on records
approved before routing v2; the finalize endpoint now answers 410.

## 5. My Work

**My Work** lists every step waiting on the signed-in person: triage for
coordinators, routing for Office Chiefs, assignment for Branch Chiefs, forms for
Staff and Senior Specialists, and reviews for whoever holds review authority.
"Act on it" opens the exact step. An assessment's page also shows whose turn it
is.

Each incident has a **workflow tree** (`GET /incidents/{id}/workflow-tree`)
showing every step from report to resolution, who owns it, and what happened.

## 6. Technical forms outside an assessment

Technical forms can also exist on their own, from before assessments. These go
`DRAFT` → `SUBMITTED` → `APPROVED` or `REJECTED`, and only an administrator
reviews them. A form attached to an assessment is always reviewed through the
assessment instead.

A form's author can grant named people **reader** or **editor** permits on that
one form (see [roles-and-identity.md](roles-and-identity.md#special-permits)).

On the web, the form's GISA sheet is a canvas: its cards flow across the full
width by default (about 400 px per column), each as tall as its content, and
can be dragged and resized. Every option is visible up front: picking a detail
picks what it belongs to (a rock structure makes the material rock, a soil
fraction makes it soil, a crack measurement records cracks, a seep or spring
records flowing water). Percentages, crack and deformation inches, the water
content scale and the slope angles are sliders, each with a box for exact
values. The browser remembers the last
arrangement. **Layouts** saves an arrangement by name on the person's account
(`/me/layouts`), so it follows them to any computer; the starred one is the
layout every form opens with.

## 7. Photos

Photos carry the phone's position and heading when they were taken. The **site
photo map** places them around the site. Anyone who can edit the form, and
the reporter of the incident a photo came from, can correct its position or
direction. Corrections are kept alongside the original and never overwrite it.
A copy of a photo can be downloaded with the corrected location written into
the file.

## 8. What Guests see

A Guest reads the approved record statewide: an assessment in `APPROVED` (or
`FINALIZED`), with its incident, technical form, photos, site and history.
Anything still in progress answers "not found". Reports closed at triage without
an assessment are not shown, unless
`PUBLIC_INCLUDES_CLOSED_WITHOUT_ASSESSMENT=true`.

## 9. Offline terrain, road inventory and cross sections

Technical-form authors can generate offline 3D terrain packages for a site;
administrators publish the road inventory the phones download; operational users
draw terrain cross sections for Caltrans projects. See
[offline-terrain.md](offline-terrain.md).
