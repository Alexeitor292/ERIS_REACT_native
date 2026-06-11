# Measurement Diagram Templates

Visual reference for the three landslide terrain templates used in the GISA measurement diagram.

---

## Templates

### LANDSLIDE_THROUGH_ROAD

**Reference**: V2-THROUGHROADMODEL(1).pdf

The failure mass has displaced or destroyed the roadway across its full width. The road is structurally compromised where the landslide passes through.

- Overlay: hatched rectangle spanning the full road width
- Crack lines shown through the road block
- Measurement labels: W-M (landslide width), TLS (total length along slope), R&S (roadway width)
- Failure side selector: hidden (failure spans the full road)
- Auto terrain shape: FLAT (no elevation assumption)

---

### LANDSLIDE_ABOVE_ROAD

**Reference**: V2-ABOVEROADMODEL(1).pdf

Material from the high-side cut slope (uphill of the road) has failed and moved onto or across the road. The failure originates above the road elevation.

- Overlay: hatched wedge shape from the road edge up into the hillside terrain
- Natural slope line (green) and main scarp indicator (red dashed)
- Measurement labels: H-S (slope height), Φ-OS (original slope angle), H-HS (main scarp height)
- Failure side: LT, RT, or BOTH (which Caltrans stationing side the cut slope is on)
- Auto terrain shape inferred from failure side:
  - LT → LEFT_HIGH (cut slope on left)
  - RT → RIGHT_HIGH (cut slope on right)
  - BOTH → CROWN (cut slopes on both sides)

---

### LANDSLIDE_BELOW_ROAD_SLIPOUT

**Reference**: V2-SLIPOUTMODEL(1).pdf

Fill material supporting the road embankment has slipped downhill on the low side. The road shoulder or travel lane hangs over the void left by the slipped material.

- Overlay: hatched wedge from the road edge downward into the fill slope
- Fill slope line (green) with slope angle label
- Measurement labels: H-S (slope height), Φ-SS (landslide slope angle)
- Failure side: LT or RT (which side the fill embankment is failing)
- Auto terrain shape inferred from failure side (the non-slipout side is the cut/high side):
  - LT → RIGHT_HIGH (cut on right, fill/slipout on left)
  - RT → LEFT_HIGH (cut on left, fill/slipout on right)
  - BOTH → BOWL (fill on both sides — road on full embankment)

---

## Terrain Side Shapes

The terrain profile controls the shape of the ground surface drawn beside the road. Shapes are approximations — actual elevation data is not yet connected.

| Shape | Left side | Right side | Typical use |
|---|---|---|---|
| LEFT_HIGH | Cut slope (rises left) | Fill slope (drops right) | Above-road failure on LT |
| RIGHT_HIGH | Fill slope (drops left) | Cut slope (rises right) | Above-road failure on RT |
| BOWL | Fill slope | Fill slope | Road on full embankment |
| CROWN | Cut slope | Cut slope | Road in full cut section |
| FLAT | Level with road | Level with road | Through-road / unknown |

**Cut slope** (HIGH): terrain surface rises from the road edge toward the diagram top.  
**Fill slope** (LOW): terrain surface drops from the road bottom edge outward.  
**Flat**: terrain is level with the road surface on both sides.

---

## Auto-Inference Logic

### Template inference (from GISA failure type fields)

| Failure type fields checked | Inferred template |
|---|---|
| `failure_rock_fall`, `failure_topple`, `failure_flow` | ABOVE_ROAD |
| `failure_surficial_failure`, `failure_scoured_toe`, `failure_erosion`, `failure_washout` | BELOW_ROAD_SLIPOUT |
| `failure_slide`, `failure_spread`, `failure_compound`, or no match | THROUGH_ROAD |

Priority: first match wins (above > below > through).

### Terrain shape inference (from resolved template + failure side)

See the table in the Templates section above. Inference is applied when the Terrain selector is set to Auto.

---

## Data Sources

Each diagram section shows the data source in a badge and the source/assumption note row below the controls:

- **Road AUTO**: Source of truth is `road_inventory_context.snapshot` (lanes, shoulders, road width). Falls back to form fields then 24 ft / 2-lane default.
- **Template AUTO**: Conservative default — `LANDSLIDE_THROUGH_ROAD` — until GEO/map-derived landslide classification is available. Template is **not** inferred from failure_* form checkboxes.
- **Terrain AUTO**: Source of truth is `gisa.elevation_profile.classification` (USGS 3DEP/EPQS cross-section). Mapping: `LEFT_HIGH` → LEFT_HIGH, `RIGHT_HIGH` → RIGHT_HIGH, `BOWL` → BOWL, `CROWN` → CROWN, `FLAT` → FLAT, `UNKNOWN` or missing → FLAT (safe schematic).
- **Elevation**: Backend elevation profile enrichment active (migration 0007, USGS EPQS). Profile fetched on demand via `POST /submissions/{id}/gisa/elevation-profile`. See `docs/elevation-profile-enrichment.md`.
- **Manual overrides**: All three selectors (template, failure side, terrain) remain available and override AUTO when pressed.

---

## Manual Overrides

All three selectors (template, failure side, terrain shape) are local UI state only. They are not persisted to the backend. Each time the user opens the measurement diagram, the template and terrain reset to AUTO.

To manually override:
1. **Template row**: tap THROUGH / ABOVE / SLIPOUT instead of AUTO
2. **Failure side row**: tap LT SIDE / RT SIDE / BOTH (hidden for THROUGH_ROAD template)
3. **Terrain row**: tap L-High / R-High / Bowl / Crown / Flat instead of Auto

---

## Fullscreen diagram (mobile)

Tap the **⤢** button in the View row to open the diagram fullscreen.

The fullscreen modal:
- Uses the entire screen (SafeAreaView + StatusBar hidden).
- Unlocks device orientation — rotate to landscape for a wider cross-section view.
- Keeps all controls (template selector, terrain selector, view toggle) accessible.
- Shows a compact source note at the bottom.
- Tap **✕** to close; orientation re-locks to portrait.

**Rotation note:** `expo-screen-orientation` is installed in `package.json` but is not invoked at runtime because the native module (`ExpoScreenOrientation`) is not included in the current Expo Go / dev-client binary. The fullscreen modal works normally; rotation follows the OS/device lock. Orientation unlock can be re-enabled after a native client rebuild that includes the module.

---

## Future improvements

- Add GEO/map-derived landslide template classification (ABOVE / SLIPOUT / THROUGH) so Template AUTO can resolve from spatial evidence rather than defaulting to THROUGH
- Add scarp height annotation to terrain profile
- Support cut/fill depth callouts on terrain surface
