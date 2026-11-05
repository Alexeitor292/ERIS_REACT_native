# Map and elevation licensing

What ERIS needs from Esri and others to run in production, and the rules the code keeps to.
Researched on 2026-11-04 against Esri's public Master Agreement (revised 2026-08-14) and
Product-Specific Terms E300 (2025-11-13). **Caltrans's signed Esri agreement overrides these
and has not been reviewed.** The open questions below need a written answer from Esri or
CTDATA before any of this is treated as final.

## What production needs

| Item | How many | Grows with users? |
| --- | --- | --- |
| ArcGIS Maps SDK Lite license string, free from My Esri (called Runtime Lite for SDK 200.x; SDK 300 needs a new one). `ARCGIS_LICENSE_KEY` | 1 | No: "unlimited production deployments" |
| ArcGIS Online API keys: the website's (`VITE_ARCGIS_API_KEY`, restricted to its address) and the iPhone's (`ARCGIS_API_KEY`). Valid at most a year each | 2 | Usage only |
| Creator-level account with a custom role, to own the keys | 1, may be an existing one | No |
| Per-person ArcGIS accounts | 0, while the rules below hold | No |
| Paid SDK deployment packs | 0, while the rules below hold | No |
| ArcGIS Pro, to publish an offline basemap (`ARCGIS_MMPK_URL`) | 0, or 1 if publishing one | No |
| Google Maps Embed key for Street View, optional. Free and unlimited | 0 or 1 | No |

Enterprise's API key documentation does not list Esri's hosted location services, so the keys
come from ArcGIS Online.

## Rules the code keeps to

**Elevation that gets saved or kept comes from USGS, not Esri.** The Master Agreement (3.2.c)
does not allow scraping, downloading or storing Esri data outside Esri Content Packages. USGS
3DEP products are public domain with no use restrictions. It is also the best model available:
at 25 places checked across California on 2026-11-04, USGS had 1 m at 24 and about 10 m at the
other (Bishop), Esri was never finer, and Esri's 1 m entries were USGS data. Esri's Terrain 3D
stops at about 2 m. So:

- Terrain Cross Sections asks USGS directly for the heights at a path's points (`getSamples`,
  `readUsgsPoints`), which also says which source lies under each, so the screen reports what was
  really read. Its coverage colours are USGS's own catalog, drawn by USGS as an image: those shapes
  are too big to send to a browser. Check `demCoverageLayersMatch` before trusting layer numbers; a
  catalog's numbers can move, which once showed Sacramento's 1 m lidar as 10 m.
- Measuring reads USGS tiles from `GET /elevation-tiles/{row}/{col}` (`services/elevation_tiles.py`),
  about every metre, which keeps each one, and:

  - the website and the iPhone read the same tiles the same way (`elevationTile.ts`,
    `UsgsElevation.swift`), which is what makes their values match. Both test files hold the same
    real tile to the same height. Keep them in step.
  - the iPhone keeps tiles once read, and fetches the ground around assigned forms' sites ahead of
    time (`KeptElevationTiles.swift`), so measuring works with no signal.

Esri's World Elevation still shows on the website's 3D map, to look at, through the ArcGIS
library. Offline terrain packages are built from USGS. The Esri package worker
(`offline_scene_worker_esri`) is not what `eris-pod.sh` runs; turning it on needs review.

**Nothing Esri geocoded is stored.** Results may only be stored from a paid, token-authenticated
request with `forStorage=true`. County, route and district come from the Caltrans postmile layer.

**Esri attribution stays visible.** Leave `"attribution"` in any `view.ui.components` list, and
never hide the iPhone's. Where a map's widget is absent (the iPhone's satellite preview, a captured
image), write the credit out: "Powered by Esri" and the layer's copyright text.

**ERIS stays out of private Esri content, and Lite-level.** Master Agreement 2.6 requires each user
to sign in as a named user for content that is not publicly shared, and bars embedding a named
user's credential in an app. These would bring per-person licensing, or paid deployment packs
counted per app, install and user, so check before building any of them:

- reading private Caltrans layers;
- editing private feature services;
- using local raster or elevation files, or anything else on Esri's
  [license by API](https://developers.arcgis.com/swift/v200/license-and-deployment/license-by-api/) tables.

**OpenStreetMap's tile servers are for builds without a key only.** Their policy allows blocking
heavy use without notice and offers no guarantee, so a production website build must have a key.

## Open questions for Esri or CTDATA

1. Does Caltrans's signed agreement change any of this?
2. Can Caltrans's ArcGIS Online API keys serve an internal app whose users have no ArcGIS accounts,
   reading only Esri services and publicly shared layers?
3. Does that usage draw credits, and are there rate limits? Esri's help says Living Atlas basemaps
   and imagery need no credits; its developer docs say all API key usage is billed to the subscription.
4. Does a keyless World Imagery request need replacing? The iPhone's satellite preview makes one
   (`mapPreviewURL`).

## Sources

- [Esri Master Agreement](https://www.esri.com/content/dam/esrisites/en-us/media/legal/ma-full/ma-full.pdf)
- [Esri Product-Specific Terms E300](https://www.esri.com/content/dam/esrisites/en-us/media/legal/product-specific-terms-of-use/e300.pdf)
- [Use a license in your app, Swift 200.x](https://developers.arcgis.com/swift/v200/license-and-deployment/use-a-license-in-your-app/)
- [API key credentials, ArcGIS Online](https://developers.arcgis.com/documentation/security-and-authentication/api-key-authentication/api-key-credentials/online/)
- [Terrain 3D terms](https://www.arcgis.com/home/item.html?id=7029fb60158543ad845c7e1527af11e4)
- [Reverse geocode, storage rules](https://developers.arcgis.com/rest/geocode/reverse-geocode/)
- [USGS 3D Elevation Program](https://www.usgs.gov/3d-elevation-program)
- [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
