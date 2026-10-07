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

   Once routed, the assessment shows the office chief who has it ("Handed to
   Maria") with a separate **Change branch chief** (or **Change Senior
   Specialist**) action. The Branch Chief likewise sees the assigned Staff
   member, with **Change Staff member**. Handing the assessment to the person
   who already has it is refused, with nothing recorded and nobody notified
   again.

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
   the author saves the draft. Hs stays a field measurement.

   **Drone surveys.** Under the 3D view, **Add a drone survey** takes the
   elevation model (DSM or DEM GeoTIFF) and, optionally, the orthomosaic
   exported from DroneDeploy, Pix4D or similar software. The browser reads the
   files (any projected or geographic coordinate system, heights in metres,
   feet or US survey feet) and keeps a lighter copy of the heights, up to
   1024 cells a side, for the flown area only. The original files are kept with the
   form's Measurements attachments when each is under 95 MB. The survey's heights are lined up with the terrain model
   on the ground around the drawn areas, which the flight did not change
   (drone software often reports ellipsoid heights, about 30 m off in
   California). The shift can be changed or turned off. In the 3D view the
   survey replaces World Elevation inside its outline only, with the
   orthomosaic draped over it; **Before** and **Now** switch between the
   terrain model and the survey. The terrain model has a date too: **Before** names
   the year its lidar was flown there, and **Measure** gives the full source
   ("USGS 3DEP 1 m lidar · flown Jan–Apr 2018"). When that lidar was flown
   after the survey, the form warns that "before" may already show the event
   and suggests comparing with an earlier survey instead. The location map shows the orthomosaic and the
   survey's outline, so the new affected area can be drawn over the flown
   ground. With a survey covering at least half of the area, **Measure**
   compares the two surfaces. α and H come from the terrain model (the ground
   before), and β, Ld and Wd from the survey (the ground now). It shows both
   slopes and heights side by side, the deepest drop and highest rise, the
   ground lost and gained in cubic yards, and a section down the fall line with
   the original ground dashed and the ground now solid. With two or more
   surveys, **compared with** picks the ground before. It is the terrain model
   by default, or an earlier survey; both surveys are lined up with the terrain
   model, so they compare on the same footing. **Before** in the 3D view then
   shows that survey, and the form warns (with **Swap**) when the survey used
   as before was flown after the one shown as now. The choice is kept with the
   survey, so everyone who opens the form (a reviewer, say) sees the comparison
   its author chose. The section is drawn at true scale whenever it fits, so a
   slope looks as steep as its angle; otherwise the caption says how much the
   heights are stretched or squeezed. The section runs down the fall line
   through the middle of the area, or along a line of your own: **Draw section
   line**, click its points in the 3D view (S1, S2, …) and **Finish**, as in
   the terrain cross-section tool. The line is kept with the comparison. Whichever
   line the section uses is drawn on the location map and in the 3D view: the
   default fall line dashed, from Top to Bottom, a drawn line solid, S1, S2, ….
   Pointing at the section reads the ground there (distance, before, now,
   change) and marks the spot in the 3D view. In the 3D view a survey's gaps
   that face the sea (photogrammetry cannot map water) are drawn at sea level,
   never with another model's ground. With an earlier survey shown as
   **Before**, land the event made since (where the earlier survey saw sea and
   the later one found ground) is painted as water. Other gaps, and ground
   beyond the flight, come from the terrain model, blended over the survey's
   last 12 m so the two never meet as a wall. Compared with an earlier
   survey, the ground before is the sea surface where that survey saw sea:
   captured points read "0.0 ft · sea", the section's before line runs at sea
   level (blue), and the ground lost and gained count the material now in the
   water from the surface. The seabed under it is unknown, so those gains are a
   lower bound, and the form says what share of the area was sea. The slope,
   its height and its length before come from surveyed ground only (water is
   not slope). **Capture points**
   records, at each click on the 3D view, the height of both surfaces there.
   Surveys, their shift, the captured points and the last comparison are kept
   with the form.

   The rest of the lower half has three parts:
   - **Actions:** checklists of immediate and follow-up actions.
   - **Memos:** one tab each for Observations, Geotechnical assessment,
     Recommendations and Sketch notes, written in a word processor with a
     Word-style ribbon (fonts, sizes, colors, styles, lists and checklists,
     indent and spacing, tables with merge and shading, symbols, find and
     replace, print). The server stores each memo
     sanitized, next to a plain-text copy used by the PDF and the mobile app.
     One more tab, **Record of incidents**, shows the site's history
     (`GET /submissions/{id}/site-history`, operational roles): every earlier
     report within 150 m, newest first. Incidents in the record are marked as a
     recurrence of the same type or a different type; reports that never
     entered it (closed at triage, awaiting triage) are marked as such. Under
     each one is its maintenance: what the crew reported, the coordinator's
     decision and notes, the immediate and follow-up actions on its technical
     forms, notes the maintenance team left in its history, and later reports
     closed as duplicates of it. The tab keeps a notes field.
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
Staff and Senior Specialists, reviews for whoever holds review authority, and
shares of technical forms for the branch and office chiefs who approve them or
are told about them.
"Act on it" opens the exact step. An assessment's page also shows whose turn it
is.

**Notifications.** Every step that lands on somebody also goes to their
notification feed: a report to triage, an assessment to route, assign, fill in,
review or revise, an approval, and every share of a technical form (approvals to
give, notices to read, and how it went for the sharer and the recipient). The
web portal shows it under the bell at the top of every page, with a full list at
*Notifications*; the mobile app shows the same feed under its bell, and phones
get it as push notifications once push is set up (see
[configuration.md](configuration.md#push-notifications-mobile-app)). Selecting a
notice opens the page where it is acted on and marks it read. Nobody is told
about their own action. Notices read by the incident's name. A notice asking
for a step (triage, route, assign, fill in, review, revise) knows when the step
has been taken, by its reader or anybody else. From then on it is marked
**Done** with who did what and when (for example "You handed it to a branch
chief · 5 min ago"), and it no longer counts toward the unread badge.

Each incident has a **workflow tree** (`GET /incidents/{id}/workflow-tree`)
showing every step from report to resolution, who owns it, and what happened.

## 6. Technical forms outside an assessment

Technical forms can also exist on their own, from before assessments. These go
`DRAFT` → `SUBMITTED` → `APPROVED` or `REJECTED`, and only an administrator
reviews them. A form attached to an assessment is always reviewed through the
assessment instead.

Until its assessment is approved, a technical form opens only to the people
working on it: its owner, the chiefs on its route, whoever is assigned, and
administrators (see [roles-and-identity.md](roles-and-identity.md)). Anyone
can still see that the assessment exists and where it stands.

A form's owner can **share** it with named people, who can then view and edit
it. Branch chiefs approve shares into or out of their branch, and office chiefs
are told when one leaves their office or involves a Senior Specialist (see
[roles-and-identity.md](roles-and-identity.md#special-permits)). The **Sharing**
card shows, before sharing, what it would take, and afterwards where each share
stands.

Several people can have one form open at once (its author and the people it is
shared with, say):
- **Who is where.** A line at the top names everyone else in the form. The card
  or section each of them is in is outlined in their colour, with a circle of
  their initials in its corner, and so is the field they are in.
- **Saves send only what you changed.** When someone else saves, their changes
  appear in your copy wherever you have not typed.
- **Conflicts are yours to settle.** If you both changed the same field, ERIS
  shows both versions and you choose which one each field keeps. Nothing is
  overwritten without a choice.
- **Memos lock while someone writes.** A memo someone is writing (Observations,
  Geotechnical assessment, Recommendations, Sketch notes) is read-only for
  everyone else, with their name on it. It opens again once they save, leave
  the form, or stop typing for 10 minutes.

The mobile app saves as before, without these checks.

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

On the web, every section of the GISA sheet (Distribution, Incident Type, Material, Highway Status, Pavement / Ground Status, Vegetation on Slope, Water / Drainage, Water Content, Measurements) and every memo has **Attach**: photos, videos and documents (PDF, Word, Excel, KMZ and the like, up to 95 MB each) are filed under that section, for anyone who can edit the form. Photos keep the location and direction in their EXIF.

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

Every ArcGIS map and 3D view says, in its lower-left corner, where the terrain
at the middle of the view comes from and when it was flown ("Terrain here: USGS
3DEP 1 m lidar · flown Jan–Apr 2018"), with a link to the source's metadata. It
updates when the view stops moving. Inside the United States the answer comes
from the USGS 3DEP Elevation Index (the lidar project behind the 1 m DEM, else
the 1/3 arc-second DEM). Elsewhere it comes from Esri World Elevation's data
extents, which date only a whole dataset, so the label gives its years.

Technical-form authors can generate offline 3D terrain packages for a site;
administrators publish the road inventory the phones download; operational users
draw terrain cross sections for Caltrans projects. See
[offline-terrain.md](offline-terrain.md).
