# Organization model — administrator guide

Who is in which office and branch, which districts an office serves, who
coordinates each district, and what a civil-service classification implies about
an ERIS role. All of it is **data an administrator edits in ERIS**, not constants
in the code or rows somebody has to write by hand in SQL.

This guide is for the person doing the editing, under **Administration** in the
web app. Roles themselves are covered in
[roles-and-identity.md](roles-and-identity.md), and how routing uses this data in
[workflows.md](workflows.md).

---

## The vocabulary, in one table

| Term | What it is | Where it is edited |
|---|---|---|
| **Office** | A Geotechnical Services office — *Office of Geotechnical Design West*. Has a permanent ERIS **code** (`WEST`), a unit number (`59-315`), a home city and district, and the list of districts it serves. This is what an assessment is routed to. | Administration › **Offices** |
| **Branch** | A supervised group inside an office, led by a branch chief — "Branch C", or the printed name from the chart. | Administration › **Branches** |
| **Coverage** | Two different facts on one page: which office serves each district (read-only, set on Offices) and which coordinators triage each district's reports (editable). | Administration › **Coverage** |
| **Membership** | Where one person sits: their office, their branch, their home city and district, their classification and position number, and whether they are currently available. | Administration › **Users**, per account |
| **Classification** | A civil-service class code and its `(Sup)` / `(Spec)` marker. ERIS stores what each one **suggests**; it never grants a role from it. | Administration › **Users**, per account. The rules themselves are stored data with an admin API (`/admin/org/classifications`) but no page of their own yet. |

Two names per office, used deliberately: the **full name** ("Office of
Geotechnical Design West") appears on record headers, the routing snapshot and
every admin page; the **short name** ("West GeoTech Office") appears in flow
copy, banners and receipts ("Accept and send to West GeoTech Office"). Fill both
in when you create an office.

---

## Day-to-day maintenance

### Add an office

Administration › **Offices** › *New office*. Code, name, short
name, unit number, home city and district.

**The code is set once and can never be changed.** Assessments and incidents are
joined to an office by that code, so changing it would orphan every record the
office already holds. The form says so inline: *"Set once. Historical records are
joined on this code, so it cannot be changed afterwards."* Everything else —
name, short name, unit number, home city, districts, active flag — is editable at
any time.

A unit that must never receive incidents is marked **not a routing target** —
ERIS seeds Geotechnical Design Policies & Practices and Geotechnical Support that
way, because one is shaped inversely to the design offices and the other has no
chart yet. District resolution skips those offices outright, and an office with
no districts is never chosen either way.

### Move a district from one office to another

Open the receiving office and add the district to *Districts served*. If another
active office already serves it, ERIS refuses with a `409` that **names the other
office** — a district has exactly one active GeoTech office, and silently
stealing it would change routing without anybody noticing. Remove it from the
current office first, then add it.

Afterwards you get the receipt: *"Office of Geotechnical Design North now serves
District 02, District 03, District 05. **Reports already routed keep the office
they were sent to.**"* That second sentence is the important one — see
[History](#a-restructuring-never-breaks-history).

### Add or retire a branch

Administration › **Branches**, with an office chosen. A branch
carries a letter (optional — maintenance yards will not have one), a printed
name, a home city and district, its chief, and whether it is **offered in
pickers**. Turn that last flag off for a branch that exists on paper but is not
staffed: it still appears in the hand-off picker, rendered disabled with its
reason, rather than vanishing and leaving a chief wondering where it went.

**Deactivate, never delete.** Deactivating stops a branch being offered as a
destination and leaves every assessment already routed to it untouched, chief and
all. Anyone still recorded in that branch is not hidden — they appear in the
picker under their old branch heading, so nobody silently disappears from a
roster because a unit was retired. Move them, then retire the branch. Two
**active** branches in one office cannot share a letter; two inactive ones can,
which is what lets a "Branch D" be retired and a new "Branch D" created later.

### Record which districts a branch covers

Every branch-district row is labelled with where the fact came from:

| Label | Means |
|---|---|
| **From the chart** | The org chart states it. |
| **Inferred** | Somebody worked it out from where people sit. Geographically sensible, not confirmed. |
| **Entered** | An administrator knows it and typed it. |

ERIS ships with **no** branch coverage recorded, for any office, because no chart
states it. That is deliberate: the empty page says *"No district coverage
recorded for this branch. The org charts do not state it — enter it if you know
it."* Enter what you know and label a guess **Inferred**, so the next person can
tell the difference. Branch coverage does not affect routing — routing is by
**office** — it is there to make the pickers and the org pages readable.

### Assign district coordinators

Administration › **Coverage**. A coordinator may cover **several**
districts, and a district may have several coordinators; mark one **Primary** so
notifications have a deterministic first recipient.

The page flags any district with no active coordinator in red: *"Reports filed in
these districts notify nobody."* Fix those first — this is the one org gap that
silently drops work. Removing coverage deactivates the row rather than deleting
it, so who covered what last quarter is still answerable.

> Coverage used to live at `/incidents/routing/assignments`, which wrote a table
> nothing actually routed on. Those three endpoints now answer `410 Gone` and
> point here. The old rows are kept as history.

### Place a person in the organization

Administration › **Users** › the account's row. Office, Branch (offered only once
an office is chosen, and only meaningful for Staff and branch chiefs),
Classification, Position number, home city and district, and availability.

- A **Staff or branch-chief account with no branch is flagged in its row** —
  *"No branch — cannot be assigned correctly"* — and saving one asks you once
  before accepting it. It is a warning, not a block: an unbranched Staff member
  still works, they simply land in the picker's "Branch not recorded" group.
- **Availability** (`Rotation out`, `Acting elsewhere`, `Unavailable`) with a
  return date is *rendered beside the name in every picker* — "Rotation out —
  back 2/5/27" — and is never used to hide or reorder anyone. Deciding who is
  actually available is the chief's job, not the picker's.
- Office and branch changes take effect immediately, including for review
  authority on the Senior Specialist route.

### The classification suggestion

When you set a classification, ERIS shows the role that classification
*suggests*: *"Senior Transportation Engineer (Sup): this classification suggests
GeoTech Branch Chief. The account holds Staff — change the roles below if that is
wrong. **Saving here never changes them.**"* A classification ERIS recognises but
has no decided role for says so instead, with its note.

**It is a sentence, not an action.** Saving the organization record never changes
the account's roles; roles are granted only in *Edit roles*. This is on purpose —
the org charts themselves show vacant supervisor positions filled out of class
and multi-month acting assignments, so a classification and a role are allowed to
disagree, and an administrator must be able to make them disagree.

The rules themselves are data: fourteen concrete classes (3155 → Office Chief,
`(Sup)`-marked 3161/3751 → Branch Chief, `(Spec)`-marked seniors → Senior
Engineer, TE Civil / Engineering Geologist / TET / MREA → Staff) plus two general
patterns — *any `Senior <discipline>` marked `(Spec)`* and *any classification
marked `(Sup)` at level S09*. A new discipline is a row, not a code change. One
class, 5758 (Research Data Specialist II), is deliberately stored with **no**
role: one position is mid-reclassification and the owner has not decided.

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

`GUEST` is the read-only role for everyone else at Caltrans. Grant it from the
role checkboxes on the Users page like any other role.

- A guest reads the **approved record** — an assessment in `APPROVED` (or the
  legacy `FINALIZED`), with its incident, technical form, photos, site and
  history — **statewide**, and nothing else. Anything in flight is invisible:
  the record answers *not found*, so ids cannot be probed.
- Their web navigation is **Incidents, Assessments and Settings**, landing on
  Incidents. No My Work, no Mission Center, no Event Groups, no Terrain, no
  administration, and no "Report an incident".
- There is no mobile guest surface. A guest who signs in to ERIS Mobile is told
  the app is for field and office staff and to use ERIS on the web.
- A guest is in **no** picker and **no** notification list, and holds no
  authority anywhere.
- Granting Guest to somebody who already holds a work role changes nothing for
  them: the most permissive role wins, so a chief who is also a guest is still a
  chief.

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
