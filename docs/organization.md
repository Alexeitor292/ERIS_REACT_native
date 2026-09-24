# Organization model — administrator guide

Who is in which office and branch, which districts an office serves, who
coordinates each district and who is on its crew. **Where a person sits decides
their role**: nobody is given a work role any other way. All of it is data edited
on the **Organization** page of the web app, not constants in the code or rows
somebody writes in SQL.

Roles themselves are described in [roles-and-identity.md](roles-and-identity.md),
and how routing uses this data in [workflows.md](workflows.md).

---

## The vocabulary, in one table

| Term | What it is | Where it is edited |
|---|---|---|
| **Office** | A Geotechnical Services office — *Office of Geotechnical Design West*. Has a permanent ERIS **code** (`WEST`), a unit number (`59-315`), a home city and district, and the districts it serves. This is what an assessment is routed to. | Organization › GeoTech offices › *Edit office* / *New office* (administrators) |
| **Office tree** | One per office. The office chief(s) at the top; hanging from them the **senior specialists** (single leaves) and the **branches**; under each branch its chief and its staff. | Organization › GeoTech offices |
| **Branch** | A supervised group inside an office, led by a branch chief — "Branch C", or the printed name from the chart. | The office's tree: *+ Branch*, and the branch's ⋯ menu |
| **District lists** | For each Caltrans district, its **Maintenance Coordinators** (one marked Primary, notified first) and its **Maintenance Crew**. | Organization › Maintenance (administrators) |
| **Details** | Classification, position number, home city and district, and availability. Shown in pickers; never a role. | A person's card in the tree › *Details and availability* |

Two names per office, used deliberately: the **full name** ("Office of
Geotechnical Design West") appears on record headers and the routing snapshot;
the **short name**, the office's abbreviation ("OGDW"), appears in flow copy, banners, the
office selector and receipts. Fill both in.

## Where roles come from

| Where the person sits | Role |
|---|---|
| Top of an office tree | Office Chief |
| Leading a branch | Branch Chief |
| A leaf under the office chief | Senior Specialist |
| Under a branch | Staff |
| On a district's coordinator list | Maintenance Coordinator |
| On a district's crew list | Maintenance Crew |
| Nowhere | Guest (read-only) |

**No role is ever held without the place that gives it.** Somebody placed
nowhere is a Guest, whatever they held before (`20260930_roles_from_org`), until
an administrator, their office chief (in their office) or their branch chief (in
their branch) places them.

**Administrator** is the one role granted directly, on **Administration › Users**
(the switch in each row), and only by another administrator. It needs no place:
an administrator may sit in no tree at all (IT, for instance), or be anybody in
one, such as a branch chief who is also an administrator, and keeps both. Not
every chief is an administrator. The Users page otherwise only creates accounts,
resets passwords and enables or disables access; a new account is a Guest until
somebody places it.

**Every branch has a chief and every office an office chief.** A branch is
created with its chief, and an office with its office chief. A chief can be
replaced (the previous branch chief stays in the branch as staff) but never
simply removed, deactivated or moved away, and an office keeps at least one
office chief. Retiring a branch is the way to close it; its chief leaves with it.
The offices and branches seeded on a fresh install have no chief yet: they hold
nobody until theirs is named, and the page says so.

A person sits in at most one place across the office trees (they may also be on
district lists). Adding somebody who already sits elsewhere **moves** them, after
the page shows where they are now and asks. The role changes with the move, at
once: the next request they make is judged by it.

## Who may change what

| Who | May |
|---|---|
| **Administrator** | Everything, in every office: create and edit offices, name office chiefs, move people between offices, the maintenance lists, and who is an administrator. |
| **Office chief** | Their own office's tree: add senior specialists, add, rename and retire branches, name or replace branch chiefs, add staff to any branch, move people within the office, remove anybody except office chiefs. |
| **Branch chief** | Add staff to their own branch (people who sit nowhere yet) and remove them. Moving somebody from elsewhere in the office is the office chief's job. |

Everybody may edit their own details. Office chiefs see only their office's tree
("My office" in the menu); branch chiefs see it with only their branch editable
("My branch"). The page never shows a + where the viewer could not use it.

---

## Day-to-day maintenance

### Add an office

Organization › GeoTech offices › *New office* (administrators). Code, names,
unit number, home city and district, and the districts it serves.

**The code is set once and can never be changed.** Assessments and incidents are
joined to an office by that code, so changing it would orphan every record the
office already holds. Everything else is editable at any time with *Edit office*.
The office is created with its office chief, chosen in the same dialog.

A unit that must never receive incidents is not a **routing target** — ERIS seeds
Geotechnical Design Policies & Practices and Geotechnical Support that way. District
resolution skips those offices, and an office with no districts is never chosen.

### Move a district from one office to another

*Edit office* on the receiving office and turn the district on. If another active
office already serves it, ERIS refuses and **names the other office** — a district
has exactly one active GeoTech office, and silently stealing it would change
routing without anybody noticing. Turn it off in the current office first.
**Reports already routed keep the office they were sent to.**

### Build a branch

*+ Branch* in the office's tree: its chief (required), a letter (optional — two
active branches in one office cannot share one), a name (blank with a letter
reads "Branch C"), a home city and district. Then *+ Staff* on its rail.

*Replace chief* on the chief's card names a new one; the previous chief stays
**in the branch, as staff** — take them out afterwards if that is wrong.

**Retire, never delete.** A branch with staff in it cannot be retired: move or
remove them first. Retiring takes its chief out with it (a guest until placed
again), stops it being offered as a destination, and leaves every assessment
already routed to it untouched.

### Keep the maintenance lists

Organization › Maintenance lists Districts 1 to 12. Open one for its
**Maintenance Coordinators** and **Maintenance Crew**, each with *Add*. A
district may have several coordinators; the first one added is **Primary**
(notified first) and *Make primary* changes it. A district with no coordinator is
flagged in red — *reports filed there notify nobody* — fix those first. Removing
somebody deactivates the row rather than deleting it, so who covered what last
quarter is still answerable.

### Availability and details

A person's card › *Details and availability*: availability (`Rotation out`,
`Acting elsewhere`, `Unavailable`) with a return date, which is **rendered beside
the name in every picker** and never used to hide or reorder anyone; and the
classification, position number, home city and district. The classification
records what the charts say; it never grants a role, because the charts
themselves show vacant supervisor positions filled out of class and multi-month
acting assignments.

### People not yet placed

The trees arrived after people already held roles. `20260926_org_tree` placed
everyone it could; `20260930_roles_from_org` then made every account's roles
exactly what its place gives (plus Administrator). Anybody still placed nowhere
is a Guest: find them with the + on the tree and place them.

---

## A restructuring never breaks history

This is the guarantee the model is built around, and it is worth understanding
before you move anything.

Every assessment freezes the office and branch **names as they read when it was
routed**, alongside the ids. So:

- **Renaming an office or a branch** changes every page that looks the name up
  live, and changes **nothing** on records already routed. An assessment routed
  to "Office of Geotechnical Design West · Branch C" still says exactly that.
- **Moving a district** changes where *new* reports go. Reports already routed
  keep the office they were sent to, and keep their reviewer.
- **Deactivating an office or a branch** removes it from the pickers and from
  new work. It does **not** revoke review authority on work already routed to
  it: the office chief of a deactivated office can still approve the assessments
  sitting in it. Nothing is stranded.
- **Nothing is ever deleted.** Offices and branches deactivate; coverage rows
  deactivate; the retired routing-assignment rows are kept. Every audit trail
  stays answerable.

The one thing that is genuinely permanent is an office's **code**, which is why
the form refuses to change it.

---

## What a Guest sees

`GUEST` is the read-only role for everyone else at Caltrans. Nobody grants it:
an account that sits in no office tree and on no district list is a guest.

- A guest reads the **approved record** — an assessment in `APPROVED` (or the
  legacy `FINALIZED`), with its incident, technical form, photos, site and
  history — **statewide**, and nothing else. Anything in flight is invisible:
  the record answers *not found*, so ids cannot be probed.
- Their web navigation is **Incidents, Assessments and Settings**, landing on
  Incidents. No My Work, no Mission Center, no Incident Groups, no Terrain, no
  administration, and no "Report an incident".
- There is no mobile guest surface. A guest who signs in to ERIS Mobile is told
  the app is for field and office staff and to use ERIS on the web.
- A guest is in **no** picker and **no** notification list, and holds no
  authority anywhere.
- Placing a guest anywhere ends their guest status: the place gives its role instead.

Three defaults ship as stated, and each is a settings or allow-list change rather
than a code change if the owner decides otherwise:

| Default | Consequence you will see |
|---|---|
| Guest read is **statewide**, not scoped | One guest account works everywhere; there is no per-district guest. |
| Incidents closed at triage with **no assessment are not public** (`PUBLIC_INCLUDES_CLOSED_WITHOUT_ASSESSMENT`, default off) | A guest's incident count is legitimately smaller than the operational one. That gap is expected, not a bug. |
| Guests **may** fetch photo bytes and attachment downloads of approved assessments | The record is readable whole, files included. |

---

## What is still an open question

These are decided as stated, not undecided-and-broken; they are listed so nobody
has to re-derive why ERIS behaves this way.

1. **Branch district coverage** is blank for every office because no chart states
   it. Whether to enter the geographically suggestive coverage for the West and
   South offices — labelled *Inferred* — is the owner's call. The North office
   cannot be inferred at all.
2. **Policy and Support** are seeded as non-routing units. Confirm, and say
   whether Support should appear in the admin UI before its chart exists.
3. **Assigning out of branch** is allowed with a recorded reason; assigning out
   of **office** is refused outright. A hard refusal on branch would be the first
   place the org model tells a chief covering a short-staffed branch "no".
4. **Dual membership and acting assignments with dates** are not modelled. The
   availability marking covers "temporarily elsewhere"; genuinely belonging to
   two branches would need membership rows with validity periods.
5. **Who supervises Maintenance Crew members, and whether that supervisor
   sees their crew's reports.** The model records a supervisor; no visibility
   rule uses it yet.
