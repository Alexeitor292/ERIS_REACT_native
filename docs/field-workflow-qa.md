# Field Workflow QA Checklist

Manual end-to-end verification steps for the road inventory context path from incident creation through GISA diagram.

---

## 1. Admin: Upload and publish dataset

- [ ] Log in as admin on the web app
- [ ] Go to **Road Inventory** admin page
- [ ] Upload a valid XLSX dataset
- [ ] Confirm the upload creates a version entry in the Versions table
- [ ] Click **Publish** on the uploaded version
- [ ] Confirm the published banner appears with version tag, segment count, and publish date

---

## 2. Admin: Generate mobile package

- [ ] With the published version active, click **Generate Mobile Package**
- [ ] Wait for generation to complete
- [ ] Confirm the package section shows **Mobile package ready** with size, generated date, and SHA-256
- [ ] Confirm the **Download** link appears (optional: download and verify file integrity)

---

## 3. Mobile: Sync package

- [ ] Open the ERIS mobile app
- [ ] Go to **Me → Road Inventory**
- [ ] Tap **Sync Now** (or equivalent sync action)
- [ ] Confirm the sync completes and shows the version tag matching what was published
- [ ] Confirm the road inventory offline status indicator on the incident form changes from amber to showing the version tag

---

## 4. Mobile: Create incident with road inventory match

Use this known test sample:

| Field | Value |
|---|---|
| District | 12 |
| County | ORA |
| Route | 001 |
| Post Mile | 0.17 |

- [ ] Open **Create Incident**
- [ ] Enter the sample District / County / Route / Post Mile values above
- [ ] Confirm the **Road Inventory Match** card appears automatically (or tap **Check Road Inventory**)
- [ ] Confirm the card shows: county, route, postmile range, lanes, surface type
- [ ] Confirm the note "This context will be saved with the incident." is visible
- [ ] Complete remaining required fields (date, lat/lon)
- [ ] Tap **Create Incident**
- [ ] Confirm incident is created successfully

---

## 5. Mobile: Verify saved RI context in incident list

- [ ] Go to the **Incidents** tab (or tracking screen)
- [ ] Find the newly created incident
- [ ] Confirm a green **RI context saved · Dataset X · Seg Y** line appears under the stage
- [ ] If no road inventory context exists on an incident, confirm no RI line appears

---

## 6. Mobile: Verify incident detail (edit screen)

- [ ] Tap the incident to open the detail/edit view
- [ ] Confirm the **Saved Road Inventory Context** card is visible with dataset version ID, segment ID, and match method
- [ ] Confirm this card is read-only and does not interfere with form editing

---

## 7. Coordinator: Link location and forward

- [ ] Log in as coordinator (or admin) on mobile or web
- [ ] Open the incident
- [ ] In the coordinator review panel, tap/click **Create New Location** (or link to existing)
- [ ] Tap/click **Forward to Office Chief**
- [ ] Confirm the forward succeeds and a linked GISA draft ID appears in the response alert

---

## 8. Mobile: Open linked GISA draft

- [ ] From the incident list, tap **Open Linked Draft #N**
- [ ] Confirm the GISA draft opens at `/(tabs)/submissions/[id]`

---

## 9. Mobile: Verify GISA road inventory card

- [ ] In the GISA draft, scroll to the **Measurements** section
- [ ] Confirm the **Road inventory context active** card appears with:
  - Dataset ID
  - Segment ID
  - County (from snapshot)
  - Route (from snapshot)
  - PM range (from snapshot)
  - Source / match method
- [ ] Confirm the **Diagram source: Road inventory snapshot** label appears above the diagram

---

## 10. Mobile: Verify measurement diagram uses snapshot

- [ ] Confirm the `MeasurementDiagramRenderer` is rendered below the RI context card
- [ ] Confirm the road cross-section diagram reflects the snapshot roadway geometry (lane count, width) rather than defaults
- [ ] Try switching templates (Landslide to Cut-slope, etc.) and confirm diagram updates
- [ ] Try changing the Failure Side selector (LT / RT / Both) and confirm overlays update correctly

---

## 11. Web: Verify GISA road inventory context

- [ ] Open the same submission on the web app (`/submissions/[id]`)
- [ ] Scroll to or locate the **Measurements** card
- [ ] Confirm the green **Road inventory context** section appears with:
  - Dataset ID
  - Segment ID
  - County, Route (if in snapshot)
  - PM range (if in snapshot)
  - Method and checked date
  - "Diagram built from road inventory snapshot" note
- [ ] Confirm no errors or layout breaks on the page

---

## 12. Fallback: No road inventory context

- [ ] Create an incident without road inventory context (e.g., clear the form before RI lookup finishes, or use a postmile with no match)
- [ ] Forward it to create a GISA draft
- [ ] Open the GISA draft on mobile
- [ ] Confirm the Measurements section shows: "No road inventory context attached. Diagram uses form / default roadway assumptions."
- [ ] Confirm the **Diagram source: Form / default assumptions** label appears
- [ ] Confirm the diagram still renders using default roadway geometry
- [ ] Confirm the GISA form can still be filled and submitted without errors

---

## 13. GISA patch does not wipe RI context

- [ ] On a submission with RI context, edit any GISA field (e.g., observations notes)
- [ ] Save the draft
- [ ] Reload and confirm the RI context card still shows the same dataset ID and segment ID
