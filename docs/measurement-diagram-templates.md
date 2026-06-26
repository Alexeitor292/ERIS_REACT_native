# Measurement Diagram Templates

Visual reference for the three landslide terrain templates used in the GISA measurement diagram.

---

## Orientation — canonical UPSTATION (always)

The measurement diagram and the live roadside slope profile are **always** rendered in the
**UPSTATION** orientation (looking toward increasing postmile). This is a fixed, canonical
orientation derived from the road's stationing direction — it is **not** a user choice:

- **LT** (Caltrans left) is always drawn on the **left**; **RT** on the **right**.
- There is **no DOWNSTATION / mirrored perspective and no view toggle** in the UI.
- The horizontal axis is the **cross-section axis (LT → RT)**. UPSTATION is the *viewing
  direction*, not the horizontal direction, so the diagram carries a single
  **`VIEWED LOOKING UPSTATION`** caption (the older horizontal `← DOWNSTATION` / `UPSTATION →`
  arrows were removed because they wrongly implied RT was geographically up-station).
- `LT`/`RT`, failure-side meaning, dimensions, terrain overlays, and the elevation render geometry
  are all defined relative to this single orientation, so they cannot be inverted by a toggle.

`road_bearing_deg` is used only by the backend to orient the elevation cross-section sampling
(what is left vs. right of the road); it is not a user-facing concept. See
`docs/elevation-profile-enrichment.md`.

---

## Coordinate model — world-space cross-section

The diagram is laid out in a **shared world-space** model (`buildCrossSectionSceneGeometry`,
pixel-independent and unit-tested), not in screen pixels:

- The horizontal domain is the **elevation transect in metres**, centred on the road at offset `0`
  (`[-halfSpanM, +halfSpanM]`). When a usable USGS profile exists, `halfSpanM` is the sampled
  half-width (e.g. 60 m); otherwise a schematic domain is synthesised so the road still doesn't
  dominate.
- **Road width is physical**: the road inventory lane/shoulder/median widths (feet) are summed and
  converted to metres (`× 0.3048`). The road therefore occupies only `roadWidthM / spanM` of the
  scene — e.g. a ~66 ft (≈20 m) road in a ±60 m transect is **~17%**, not the old ~80–95%.
- Every element — terrain silhouette, road deck, each lane/shoulder/median band, failure overlays,
  dimension labels, LT/RT chips — is positioned through one `xPx(offsetM)` transform.
- **Screen size controls pixels/detail only.** Because the road's share is a fraction of the scene,
  portrait and landscape render the *same physical proportions*; landscape simply adds pixels to the
  slopes and annotations. (The previous model sized the road as `screenWidth − 64px`, so it grew
  with the screen and squeezed the terrain into two fixed 32 px margins — that is the bug this
  replaces.)
- The renderer accepts **width and height**; fullscreen passes the measured landscape height so the
  scene uses the available space instead of centring a fixed-height strip.

### Terrain & road presentation

- The terrain silhouette uses the **real sampled elevation points** (centripetal Catmull-Rom crest
  through every sample) when usable, flattened across the road deck so the slopes meet the road
  edges cleanly with no artificial vertical walls. Fallback: classification-derived schematic.
- The road is a **thin deck at road grade** (a few px tall) with lane/shoulder/median bands, edge
  lines, and centerline — detailed but visually subordinate to the terrain (no 60 px slab).
- Vertical exaggeration is auto-fit and capped at 8×, independent of device width, and shown in the
  footer (`"3.0× V"`, or `"schematic"` when no real datum exists).

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

### Landslide Below Road

Internal template key: `LANDSLIDE_BELOW_ROAD_SLIPOUT` (kept for backward
compatibility; the user-facing label is always "Landslide Below Road").

**Reference**: V2-SLIPOUTMODEL(1).pdf (source filename retained)

Fill material supporting the road embankment has failed downhill on the low side. The road shoulder or travel lane hangs over the void left by the displaced material.

- Overlay: hatched wedge from the road edge downward into the fill slope
- Fill slope line (green) with slope angle label
- Measurement labels: H-S (slope height), Φ-SS (landslide slope angle)
- Failure side: LT or RT (which side the fill embankment is failing)
- Auto terrain shape inferred from failure side (the non-failure side is the cut/high side):
  - LT → RIGHT_HIGH (cut on right, below-road failure on left)
  - RT → LEFT_HIGH (cut on left, below-road failure on right)
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
| `failure_surficial_failure`, `failure_scoured_toe`, `failure_erosion`, `failure_washout` | Landslide Below Road |
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
  - **Mobile**: Field users can tap **Fetch / Refresh** in the Measurements section elevation profile panel to update the profile before using Terrain AUTO. Leave the Road bearing field blank to let the backend auto-derive bearing from postmile geometry.
  - **Web**: The elevation panel in the submission detail page provides the same Fetch / Refresh controls.
- **Manual overrides**: All three selectors (template, failure side, terrain) remain available and override AUTO when pressed.

---

## Manual Overrides

All three selectors (template, failure side, terrain shape) are local UI state only. They are not persisted to the backend. Each time the user opens the measurement diagram, the template and terrain reset to AUTO.

To manually override:
1. **Template row**: tap THROUGH / ABOVE / BELOW ROAD instead of AUTO
2. **Failure side row**: tap LT SIDE / RT SIDE / BOTH (hidden for THROUGH_ROAD template)
3. **Terrain row**: tap L-High / R-High / Bowl / Crown / Flat instead of Auto

---

## Fullscreen diagram (mobile)

Tap the **⤢** button (next to the `UPSTATION →` indicator and source badge) to open the diagram
fullscreen.

The fullscreen modal:
- Uses the entire screen (SafeAreaView + StatusBar hidden), with `supportedOrientations` set so iOS
  allows the modal to rotate.
- **Forces landscape** on open (via `expo-screen-orientation`) for a wider cross-section view, and
  restores the device's natural rotation on close.
- Keeps the template and terrain selectors accessible. There is no stationing-view toggle —
  orientation is always canonical UPSTATION.
- Shows a compact source note at the bottom.
- Tap **✕** to close.

### Screen rotation

Rotation was previously blocked by `expo.orientation: "portrait"` in `app.json`, which locks the
whole app to portrait (baked into the iOS `Info.plist` / Android manifest at build time). It is now
`"default"`, so the app follows the device rotation generally, and the fullscreen measurement view
additionally forces landscape.

**Native rebuild required:** the `app.json orientation` change is a native config change — it only
takes effect after a prebuild / new dev-client or EAS build (it is *not* picked up by a JS-only
reload). The runtime landscape lock uses `expo-screen-orientation`, whose native module also ships
with the custom dev-client/EAS build but is absent from stock Expo Go. All orientation calls are
guarded (`mobile/src/utils/screenOrientation.ts`), so on a binary without the module they no-op
gracefully and the diagram still works — it just won't auto-rotate until the app is rebuilt.

---

## Material-driven terrain visuals

Both the schematic cross-section and the live slope profile render terrain with an art-directed,
material-aware style instead of flat fills. The look is procedural (SVG gradients, patterns, and
layered fills) — no image assets, no 3D engine — so it stays cheap and maintainable on mobile.

Each terrain side is layered: **base gradient** (lit crest → shaded toe) → **ambient-occlusion
shadow** toward the toe → **material texture pattern** (soil speckle / rock fracture-hatch / mixed)
→ **moisture overlay** when wet, then **surface decorations** (vegetation clumps, rock/boulder
accents, seep/flow streaks). An atmospheric sky gradient sits behind the cut for depth.

All colours/patterns are produced by `buildTerrainPalette()` from the GISA form inputs. The exact
field → cue mapping (material, composition, moisture, vegetation, pavement) is documented in
`docs/elevation-profile-enrichment.md` → *Form-driven terrain appearance*. Annotations, dimension
labels, LT/RT chips, and failure overlays are drawn on top and remain the priority for legibility.

---

## Future improvements

- Add GEO/map-derived landslide template classification (ABOVE / BELOW ROAD / THROUGH) so Template AUTO can resolve from spatial evidence rather than defaulting to THROUGH
- Add scarp height annotation to terrain profile
- Support cut/fill depth callouts on terrain surface
- Add lightweight unit coverage for `buildTerrainAppearance` once a mobile test runner is in place
