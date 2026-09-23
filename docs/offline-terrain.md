# Offline terrain, road inventory and cross sections

The GIS side of ERIS: offline 3D terrain packages for the phone, the road
inventory the phones download, elevation data on technical forms, and terrain
cross sections. Settings are in [configuration.md](configuration.md#offline-3d-terrain-packages);
step-by-step operator procedures, including hand-made `.mspk` packages, are in
[offline-scene-package-operator-runbook.md](offline-scene-package-operator-runbook.md).
The reasoning behind the design is in [decisions/](decisions/).

## Offline 3D terrain packages

A package lets a phone show the 3D terrain around a site with no signal.

**Flow:**

1. From a technical form on the phone, someone who can edit that form taps
   **Prepare offline 3D area** (`POST /submissions/{id}/gisa/offline-scene-package/generate`).
   A job is queued; if one is already running for that form, the request is
   refused (409).
2. The `offline-scene-worker` claims the job (`FOR UPDATE SKIP LOCKED`, so several
   workers never take the same job). It fetches USGS 3DEP elevation for an area
   around the site (radius 250 m up to `OFFLINE_SCENE_MAX_RADIUS_M`, 1500 m by
   default). It then adds road context from the configured source, and aerial
   imagery if enabled, and builds an `eristerrain` package.
3. The worker uploads it to the private `eris-offline-scenes` bucket
   (`submissions/{id}/{version}/scene.eristerrain`), checks its size and SHA-256,
   and registers it as `READY`. The previous READY package for that form is
   retired in the same step.
4. The phone downloads it through a short-lived signed link and verifies it.
   Each package records a signature of the form data it was built from (site,
   geometry, road and imagery settings), so the phone can tell when it is out of
   date.

Job states: `QUEUED`, then `FETCHING_USGS_3DEP`, `BUILDING_TERRAIN`,
`BUILDING_BASEMAP`, `PACKAGING`, `VERIFYING`, `UPLOADING`, `REGISTERING` and
`READY`; or `FAILED` or `CANCELLED`.

**Operations:**

- **Health:** `GET /ops/offline-scene/health` (administrators) reports the bucket,
  the queue and each worker's last heartbeat. Workers write a heartbeat at
  startup, after each job and while idle, but not during a job, so a single long
  job can briefly show no live worker.
- **Scaling:** run more `offline-scene-worker` replicas.
- **Retry and cancel:** a `FAILED` job can be retried, and any active job can be
  cancelled, from the phone (`.../job/retry`, `.../job/cancel`). There is no
  automatic retry.
- **Stuck jobs:** a running job whose record has not changed for
  `OFFLINE_SCENE_JOB_STALE_SECONDS` (15 minutes) is put back in the queue.
- **Orphaned uploads:** a job cancelled between upload and registration leaves
  its file recorded in `offline_scene_orphaned_objects`. Nothing cleans these up
  automatically; the health endpoint reports how many are unresolved.
- **Manual packages:** an administrator can register an externally built `.mspk`
  (`POST /admin/offline-scene-packages`); see the runbook.
- Retired packages stay in the bucket; nothing deletes them.

The Compose stack runs the standard worker
(`python -m app.worker.offline_scene_worker`). The worker image's default command
is the Esri variant, which needs `ARCGIS_RUNTIME_ENABLED=true` and an
`ARCGIS_API_KEY`.

The phone renders packages with native iOS SceneKit screens
(`mobile/plugins/arcgis-ios/`); there is no Android equivalent. The web app's
3D terrain views are separate, online scenes built on Esri World Elevation.

## Elevation on technical forms

Two on-demand tools on a technical form, available to anyone who can edit it:

- **Elevation profile** (`POST /submissions/{id}/gisa/elevation-profile`) samples
  USGS elevation (EPQS) across the road and classifies the terrain as left-high,
  right-high, bowl, crown or flat.
- **Terrain grid** (`POST /submissions/{id}/gisa/terrain-grid`) samples a
  road-aligned grid (11 × 11 points, 20 m apart by default). Only one grid
  builds at a time; a second request gets 503 and should retry.

Both results are stored on the form. The offline package builder also reads the terrain grid.

## Road inventory

Road inventory is the Caltrans roadway data (lanes, shoulders, widths by route
and postmile) that phones use offline to describe a site's road.

1. An administrator uploads the inventory spreadsheet (`.xlsx`) on
   **Administration › Road Inventory**. It is imported in the background into a
   new dataset version, as `pending`.
2. The administrator **publishes** that version; the previously published one
   becomes `superseded` and can be restored with **rollback**.
3. The administrator builds the **phone package** for the published version. It
   combines the inventory with the Caltrans postmile points and is stored in the
   `road-inventory` bucket.
4. Phones download the package (`GET /road-inventory/mobile-package/download`)
   and look up segments offline. Online, any signed-in non-Guest can query
   `GET /road-inventory/lookup`.

The technical form's roadway measurement reads the same published inventory
through `GET /road-inventory/roadway-context`: lanes, outside shoulders and
median from the named columns, and traveled way (`THY_LT/RT_TRAV_WAY_WIDTH_AMT`),
inside shoulders and highway group from the columns the import keeps in
`raw_json`. Left and right are relative to increasing postmile.

An import runs inside the API process. If the API restarts mid-import, the job
stays `processing` and the file must be uploaded again.

## Terrain cross sections

Under **Terrain Cross Sections** on the web, operational users create Caltrans
projects and draw cross sections for them on the 3D terrain. The elevation
profile is sampled in the browser and saved with the section. Sections can be
added and edited while their project is `ACTIVE`; there is no delete.
