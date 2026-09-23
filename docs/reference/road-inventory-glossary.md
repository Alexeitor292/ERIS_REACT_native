# Road Inventory Glossary

## Why this glossary exists

The CA Highways road inventory dataset (Caltrans HICOMP / Highway Inventory) uses terse field names
and coded values that are opaque without domain knowledge. Examples:

- `THY_TERRAIN_CODE: "M"` → "Mountainous (M)"
- `county_code: "ALA"` → shown as "County: ALA" (Alameda)
- `left_lanes` / `right_lanes` → replaced by "LT Lanes / RT Lanes"
- `adt: 12400` → "ADT: 12400 veh/day"

This glossary provides human-readable labels, plain-English descriptions, value maps for coded
columns, and units for numeric columns. **Raw field names are always preserved** for traceability —
they appear in the expanded "Field meanings & raw values" section.

## Implementation files

| Location | Purpose |
|----------|---------|
| `mobile/src/roadInventory/roadInventoryGlossary.ts` | Full glossary + `explainRoadInventoryField()` helper |
| `web/src/utils/roadInventoryGlossary.ts` | Web-only mirror with `friendlyFieldLabel()`, `friendlyFieldValue()`, `fieldDescription()`, `terrainLabel()` |

## Field display rules

1. **Friendly label first** — use `label` from the glossary, not the raw key.
2. **Coded values** — show both the decoded name and the raw code: `"Mountainous (M)"`.
3. **Units** — append unit to numeric values: `"12400 veh/day"`, `"1.24 mi"`.
4. **Unknown fields** — convert `snake_case` / `UPPER_CASE_ACRONYM` to title case as a fallback label. The raw key is always shown alongside.
5. **Raw field visible** — in the expanded details view, every field shows `(raw_key)` beside its friendly label so nothing is hidden.

## THY_TERRAIN_CODE mapping

| Code | Label |
|------|-------|
| `F` | Flat |
| `R` | Rolling |
| `M` | Mountainous |
| `H` | Hilly |
| other | shown as raw value |

The field may appear as `terrain_code` or `THY_TERRAIN_CODE` depending on which CA Highways extract
version was used. Both keys map to the same value map.

## Key field definitions

| Raw field | Friendly label | Notes |
|-----------|---------------|-------|
| `district_code` | District | Caltrans districts 1–12 |
| `county_code` | County | 2–3 letter code (ALA, LA, ORA…) |
| `route_name` | Route | SHN route number including suffix |
| `route_suffix_code` | Route Suffix | E/N/S/W for directional couplets |
| `begin_pm` | Begin Postmile | Miles from route origin |
| `end_pm` | End Postmile | Miles from route origin |
| `terrain_code` / `THY_TERRAIN_CODE` | Terrain | F/R/M/H (see above) |
| `left_lanes` | LT Lanes | Through lanes, upstation direction |
| `right_lanes` | RT Lanes | Through lanes, downstation direction |
| `median_type` | Median Type | N=None, P=Painted, R=Raised, K=K-rail, B=Barrier, D=Depressed |
| `median_width` | Median Width | feet |
| `design_speed` | Design Speed | mph |
| `adt` | ADT | Annual Daily Traffic, vehicles/day |
| `length_miles` | Segment Length | miles |
| `landmark_short_desc` | Landmark | Nearby interchange, bridge, or community |
| `segment_id` | Segment ID | Internal RI segment ID |
| `dataset_version_id` | Dataset Version | Road inventory package version |
| `match_method` | Match Method | MOBILE_OFFLINE = matched from device-local package |
| `road_bearing_deg` | Road Bearing | Compass bearing (0–359°, clockwise from North) of the road in the upstation direction. **Not present in the current CA Highways tabular extract** — requires route geometry source. |

## How to add new field definitions

In `mobile/src/roadInventory/roadInventoryGlossary.ts` (and mirror in `web/src/utils/roadInventoryGlossary.ts`), add an entry to `FIELD_DEFS`:

```typescript
my_field_name: {
  label: "My Field Label",
  description: "Plain English explanation of what this field means.",
  unit: "ft",                       // optional
  valueMap: { A: "Option A", ... }, // optional: for coded columns
},
```

If a value map entry exists, `explainRoadInventoryField("my_field", "A")` returns:
```
{ displayValue: "Option A (A)", ... }
```

## UI behavior

- **Summary view** (always visible): county, route, postmile range, terrain (friendly), lanes, match method.
- **Expanded view** (tap "Field meanings & raw values"): all snapshot fields with friendly labels, descriptions, and raw keys.
- **Source attribution**: "Road inventory values from the published CA Highways dataset."

This ensures coordinators and engineers can read the data without needing to know CA Highways acronyms, while the raw field names remain accessible for GIS/data traceability.
