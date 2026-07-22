# ADR: Station-local divided-highway corridor pairing

Status: proposed (milestone `feat/divided-highway-corridors-tile-native-imagery`)

## Problem

TIGERweb packages a divided highway as **two** primary centerlines — one per
carriageway. The offline viewer therefore draws two yellow lines through a single
freeway corridor and offers two competing selection candidates, and a cross section
taken on one carriageway silently ignores the other half of the roadway.

Naively merging the two is wrong: the *same route* alternates between a shared corridor
(one median) and genuinely separate alignments (split grade, distinct canyons, frontage
splits, interchanges). Pairing must therefore be decided **locally along the route**, not
globally per feature or per route name.

## Decision

Add a deterministic, **worker-side** preprocessing pass over primary-road geometry that
decides pairing per *station* over a *moving longitudinal window*, and packages the result
as **additive** selection features. No mobile schema migration; legacy packages keep working.

### 1. Resample

Each candidate primary line is resampled at a fixed `sample_interval_m` (default **10 m**),
producing stations `(lon, lat, s, bearing)` where `s` is cumulative along-line distance and
`bearing` is the local tangent. Resampling is deterministic (walk the polyline, emit every
interval, always keep the final vertex), so the same input always yields the same stations.

### 2. Per-station partner (mutual nearest, axial, perpendicular)

For station `a_i` on feature `A`, consider every other **primary, non-ramp** feature `B`:

| Gate | Rule | Default |
| --- | --- | --- |
| Class | both `road_class == "primary"` (ERIS-generated, never provider MTFCC) | — |
| Ramp | `B` (or `A`) is a ramp → never pair | MTFCC `S1630` |
| Route | route/name metadata compatible **when present on both**; absent ⇒ permitted | — |
| Separation band | `min_separation_m ≤ d ≤ max_separation_m` | 4 m … 120 m |
| Axial bearing | `axial_diff(bearing_a, bearing_b) ≤ max_bearing_diff_deg`, computed **mod 180°** so antiparallel carriageways read as 0° | 20° |
| Offset geometry | the `a_i → b_j` offset must be ~**perpendicular** to the local tangent (within `max_offset_angle_dev_deg` of 90°), which rejects end-to-end/merge proximity | 35° |
| Mutual nearest | `b_j`'s nearest point on `A` must project back to `a_i` (within one sample step) | — |

`axial_diff(x, y) = min(m, 180 − m)` where `m = |x − y| mod 180`. This makes the test
invariant to **coordinate order** (a reversed carriageway is still paired) and to which
direction each carriageway is digitised.

### 2b. The eleven configured thresholds

Every threshold is a validated named setting, packaged in the manifest `pairing` block
exactly as applied, and unit-tested. `PairingParams.validate()` rejects a non-finite or
internally inconsistent set (e.g. `min_separation_m >= max_separation_m`,
`min_window_coverage` outside `(0, 1]`, a window shorter than 3 sample intervals).

| Setting | Default | Unit | Controls |
| --- | --- | --- | --- |
| `OFFLINE_SCENE_PAIR_SAMPLE_INTERVAL_M` | 10.0 | m | deterministic resampling step |
| `OFFLINE_SCENE_PAIR_WINDOW_M` | 120.0 | m | moving longitudinal window |
| `OFFLINE_SCENE_PAIR_MIN_SEPARATION_M` | 4.0 | m | below this the lines are duplicates |
| `OFFLINE_SCENE_PAIR_MAX_SEPARATION_M` | 120.0 | m | generous band; stability decides |
| `OFFLINE_SCENE_PAIR_MAX_BEARING_DIFF_DEG` | 20.0 | ° (mod 180) | axial alignment |
| `OFFLINE_SCENE_PAIR_MAX_OFFSET_ANGLE_DEV_DEG` | 35.0 | ° from 90° | offset must be perpendicular |
| `OFFLINE_SCENE_PAIR_SEP_STDEV_MAX_M` | 12.0 | m | separation stability |
| `OFFLINE_SCENE_PAIR_SEP_SLOPE_MAX` | 0.25 | m/m | rejects sharp divergence |
| `OFFLINE_SCENE_PAIR_MIN_WINDOW_COVERAGE` | 0.8 | fraction | window agreement |
| `OFFLINE_SCENE_PAIR_MIN_CORRIDOR_LENGTH_M` | 150.0 | m | rejects interchange-only proximity |
| `OFFLINE_SCENE_PAIR_MIDPOINT_TOLERANCE_M` | 3.0 | m | **midpoint_tolerance_m** — see below |

`midpoint_tolerance_m` is **behaviour-changing, not a numeric epsilon**: at metre scale it
decides whether a run is accepted or split, so it is a first-class configured threshold
rather than a hidden constant.

### 3. Moving longitudinal window (stability, not a distance cap)

A station is *paired* only if the window of `window_m` (default **120 m**) centred on it
satisfies **all** of:

- **Same partner** for ≥ `min_window_coverage` (default **0.8**) of the window's stations
  (mutual pairing is stable, not a one-sample coincidence);
- **Longitudinal overlap** — `B` actually spans the window (no end-of-line pairing);
- **Stable separation** — `stdev(d) ≤ sep_stdev_max_m` (default **12 m**) **and** the
  per-metre rate of change `|Δd/Δs| ≤ sep_slope_max` (default **0.25**);
- **Stable bearing** — the axial gate holds across the window;
- **Midpoint validity** — the derived midpoint stays between the carriageways.

> **This is the key design choice.** We deliberately do **not** use one small
> maximum-distance rule. A **wide but stable** grass/open median (say 45 m, `stdev ≈ 2 m`,
> slope ≈ 0) stays **one corridor**; a pair whose separation ramps 10 m → 60 m over 100 m
> (`slope ≈ 0.5`) is **split**, even though every sample is inside the distance band.
> Stability — not proximity — is what distinguishes a median from a divergence.

### 4. Runs, minimum length, splits

Consecutive paired stations sharing the same partner form a **run**. A run shorter than
`min_corridor_length_m` (default **150 m**) is discarded — this is what rejects
**brief interchange-only proximity** and parallel ramps that momentarily hug the mainline.

A corridor **splits** when: longitudinal overlap ends; separation changes rapidly (slope /
stdev gates); bearings diverge; the mutual partner changes; or the midpoint leaves the
interval between the carriageways. The same route may therefore legitimately transition
**paired → separate → paired**, and each paired run is emitted as its own corridor feature.

### 5. Derived midpoint centerline

For each station in a run, the midpoint is taken between `a_i` and the **projection of
`a_i` onto `B`'s polyline** (not merely the nearest resampled station), then validated:
`|dist(m, A) − dist(m, B)|` must stay within tolerance and both ≈ `d/2`. A midpoint that
escapes the interval splits the run rather than being emitted.

### 6. Deterministic de-duplication (A↔B mirror)

Pairing `A→B` and `B→A` describe the same corridor. Exactly one is emitted: only the
ordered pair `source_feature_id(A) < source_feature_id(B)` is materialised.

## Identity model

Two **distinct** identities, because one emitted feature is not one source road:

| Field | Prefix | Identifies | Cardinality |
| --- | --- | --- | --- |
| `source_feature_id` | `r…` | the COMPLETE original provider road | many emitted parts may share one |
| `feature_id` | `p…` / `c…` | THIS exact emitted feature/segment | globally unique — never shared |

**Formulas** (SHA-1, first 12 hex; no random UUIDs):

```
canonical_coords(coords)  = min(rounded_forward, rounded_reversed)      # 6 dp, lexicographic
source_feature_id  = "r" + h("geom|" + layer_context + "|" + canonical_coords(source))
                   # or "r" + h("pid|" + layer_context + "|" + provider_feature_id) when an
                   # authoritative provider id is present (preferred; none exist in TIGERweb today)
part_feature_id    = "p" + h("part|" + {source_feature_id, role, canonical_coords(part)})
corridor_feature_id= "c" + h("corr|" + {method, version, sorted(member_source_ids), canonical_coords(midpoint)})
```

`layer_context` = `{source_layer_id, kind, road_class}`, so identical geometry from
different provider layers can never collide onto one source identity.

**Coordinate-order invariance.** Identity must not depend on provider digitisation
direction. Two mechanisms:

1. `canonical_coords()` hashes the lexicographically smaller of the forward and reversed
   rounded sequences.
2. `canonical_orientation()` is applied **before resampling**, so a reversed source line
   cannot shift the station phase and thereby move every derived midpoint. (Without this,
   reversing the carriageway that happens to be the ordered-pair base shifted the derived
   geometry by one sample step and changed the corridor id.)

Consequently: reversing either or both carriageways leaves `source_feature_id`,
`corridor_feature_id`, `member_source_feature_ids` and `member_part_feature_ids`
unchanged. Rendering direction is deterministic (the canonical orientation), but identity
never depends on it.

## Candidate eligibility — only real road centerlines

`roads.geojson` carries more than centerlines. `roads_geojson_from_context` **appends**
every applicable source into one list, so a package can simultaneously hold:

| `kind` | Origin | Candidate? |
| --- | --- | --- |
| `road_centerline` | TIGERweb / ArcGIS centerlines | **yes** |
| `road_inventory` | ERIS Road Inventory geometry | no — context |
| `submitted_road_geometry` | line-like submitted incident geometry | no — context |
| `road_bearing` | synthetic AOI-spanning bearing line | no — context |

**A feature may receive a non-null `selection_kind` only when `properties.kind ==
"road_centerline"`.** Anything else is retained, packaged and fully consumable for its
existing purpose (native still uses the bearing line for orientation fallback), but is
never promoted into a selectable road:

```json
{ "kind": "road_bearing", "bearing_deg": 90.0,
  "source_feature_id": "r…", "feature_id": "p…",
  "selection_kind": null, "selectable": false, "diagnostic": false }
```

Context features get a `context:<original kind>` role discriminator in their
`part_feature_id`, so a context feature can never collide with a selectable or diagnostic
part derived from the same source geometry. They are excluded from `selection_kinds` /
`selection_kind_counts` **and** from `diagnostic_kinds` / `diagnostic_kind_counts`.

## Centerline classification

| Input (`kind == road_centerline`) | Result |
| --- | --- |
| ramp (`MTFCC == S1630`) | `selection_kind = ramp` |
| primary, non-ramp, **paired** run | paired portion → diagnostics `carriageway_member`; unpaired portions → `individual_carriageway` |
| primary, non-ramp, **no valid paired run anywhere** | `selection_kind = individual_carriageway` |
| secondary / local / unclassified | `selection_kind = ordinary_road` |

> **`individual_carriageway` means: an unpaired primary-road centerline segment.**
> It makes **no** claim of authoritative travel direction, one-way status, compass
> direction, or that an opposite carriageway exists outside the package. It exists so
> geographically separated directional roadways stay individually selectable without being
> falsely merged. A secondary or local road is **never** an `individual_carriageway`.

## Packaged schema (additive)

Every packaged road feature gains ERIS-trusted, unspoofable fields:

- `source_feature_id` — the complete original road (source-derived features only);
- `feature_id` — this exact emitted feature (globally unique);
- `selection_kind` — **exactly four** selectable values, or `null`;
- `selectable`, `diagnostic` — booleans.

**Selectable vs diagnostic are separate namespaces.** `selection_kind` describes only
user-selectable candidates:

`divided_highway_corridor` | `individual_carriageway` | `ordinary_road` | `ramp`

A raw paired carriageway segment is diagnostics-only and must never expand that enum:

```json
{ "selection_kind": null, "diagnostic_kind": "carriageway_member",
  "selectable": false, "diagnostic": true }
```

The manifest reports them separately: `selection_kinds` / `selection_kind_counts` (the four)
and `diagnostic_kinds` / `diagnostic_kind_counts`. `carriageway_member` never appears in the
selectable enum or its counts.

Carriageways are **split by run**: one diagnostics member part per paired run (so a
corridor's `member_part_feature_ids` resolve 1:1), plus selectable `individual_carriageway`
remainders — keeping paired↔unpaired transitions geographically continuous.

### Provider metadata — one contract for every candidate

Every selectable kind carries the same fields **inline**: `NAME`, `BASENAME`, `MTFCC`,
`RTTYP`, `source_layer_id`. Native never reads route metadata from one place for a corridor
and another for an individual carriageway.

For a **derived corridor**, a field is exposed inline only when both members carry a
compatible (case/whitespace-normalised) value. When the members **disagree**, or either
**lacks** the field, it is **omitted** — never fabricated. Per-member values are preserved
in `member_provider_metadata` for diagnostics.

### `divided_highway_corridor`

```json
{
  "kind": "road_centerline",
  "road_class": "primary",
  "road_class_label": "Primary road / highway",
  "selection_kind": "divided_highway_corridor",
  "selectable": true,
  "diagnostic": false,
  "feature_id": "c6e415a839876",
  "member_source_feature_ids": ["r8129076df999", "r8343c6f29897"],
  "member_part_feature_ids": ["p48759f527711", "p1a74c6a56045"],
  "member_geometry": { "a": [[-121.5, 38.5]], "b": [[-121.5, 38.50018]] },
  "member_geometry_kind": "observed_source_centerlines_clipped_to_run",
  "member_provider_metadata": [{ "NAME": "US-50", "…": "…" }, { "NAME": "US-50", "…": "…" }],
  "separation_m": { "min": 20.04, "max": 20.04, "mean": 20.04, "median": 20.04, "stdev": 0.0, "samples": 58 },
  "corridor_length_m": 570.0,
  "orientation_deg": 90.0,
  "orientation_source": "geometry_derived",
  "pairing": { "method": "station_local_mutual_nearest", "version": 1, "sample_interval_m": 10.0, "window_m": 120.0 },
  "NAME": "US-50", "BASENAME": "US-50", "MTFCC": "S1100", "RTTYP": "U", "source_layer_id": 2
}
```

`member_geometry` is **the observed source centrelines clipped to this run** — not the
complete source road, and not resampled. `member_geometry_kind` states this explicitly so
the semantics are never ambiguous.

`orientation_source` is **never** `road_inventory` unless ERIS Road Inventory actually
supplies the bearing — geometry-derived orientation makes no authoritative direction claim,
and the app must not label carriageways upstation/downstation from it.

## Manifest counts — explicit semantics

The emitted collection mixes derived corridors, selectable source parts, duplicate
diagnostics members and non-selectable context features, so one "feature_count" would be
ambiguous. The roads layer therefore reports an **exact partition**:

| Key | Meaning |
| --- | --- |
| `feature_count` | total GeoJSON features actually serialized in `roads.geojson` |
| `source_feature_count` | original source/context features **before** the pairing rewrite |
| `selectable_feature_count` | emitted features with `selectable == true` and a valid `selection_kind` |
| `diagnostic_feature_count` | emitted features with `diagnostic == true` |
| `context_feature_count` | emitted features that are neither selectable nor diagnostic |

Invariants (all tested):

```
feature_count == selectable_feature_count + diagnostic_feature_count + context_feature_count
sum(selection_kind_counts)  == selectable_feature_count
sum(diagnostic_kind_counts) == diagnostic_feature_count
divided_corridor_count      == number of divided_highway_corridor features ACTUALLY emitted
                               (not tentative Corridor objects found before member-part
                                materialisation)
```

`road_class_counts` is computed from the **ORIGINAL source features**, before splitting and
corridor derivation — so one source carriageway is never counted several times. The
additional `selectable_road_class_counts` describes the emitted selectable candidates;
`road_class_counts` is never silently redefined as a derived-part count.

## Deterministic serialization

Emitted features are sorted by **(role rank, `feature_id`)** — corridor(0), individual(1),
ordinary(2), ramp(3), diagnostics(4), context(5) — before `roads.geojson` is serialized. Manifest
arrays are sorted and count dictionaries are built in sorted key order.

Given semantically identical input features in any list order, the emitted
FeatureCollection is **deeply equal** and its production JSON bytes are **identical**.
Provider response order can no longer change the package hash.

## Ramp contract

- A ramp is identified by the provider `MTFCC` = `S1630`. `selection_kind` is an
  **ERIS-derived** field that may consult MTFCC; it **never** changes the trusted
  `road_class` (a ramp off a freeway keeps `road_class: "primary"`).
- **Ramps never participate in divided-carriageway pairing** — they are excluded from
  candidate discovery, so a ramp running parallel to the mainline is never paired.
- `ramp` is a distinct selectable kind.
- **Future native candidate ranking must not allow a ramp to displace an eligible mainline
  divided corridor merely because both carry `road_class: "primary"`.** (Ranking is native
  work and is deliberately out of scope for this checkpoint.)

## Truthfulness boundaries

- Median **type** is never fabricated. Without an authoritative median category the interval
  between the observed centerlines is labelled **"Median / separation area"** only.
- **Measured centerline separation** (observed) is reported separately from **assumed**
  lane/shoulder/median widths (DEFAULT template), and the blocking DEFAULT-layout
  acknowledgment is preserved.
- Pairing is a geometric inference over generalized TIGER geometry: it is context, not a
  survey. `pairing.method`/`version` are packaged so a corridor can always be traced back
  to the algorithm that produced it.

## Consequences

- One yellow line per shared corridor; individual yellow lines only where the roadways are
  genuinely separate; raw centerlines still available in a diagnostics layer.
- A corridor selection yields one cross section spanning **both** carriageways and the whole
  separation area; an unpaired roadway yields a section for that roadway only (never an
  invented opposite carriageway).
- Legacy packages (no `selection_kind`) render and select exactly as before.
