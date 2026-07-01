# iPhone Airplane-Mode acceptance test — native offline 3D terrain

**Status: NOT YET PERFORMED.** This is the required physical-device gate before the
native offline 3D terrain feature can be called production-ready. It CANNOT be
claimed as passed without real on-device evidence (screen recording + notes).
Automated CI and simulator builds do not substitute for it.

## Preconditions

- An **iOS EAS development build** of the mobile app installed on a physical iPhone
  (the native ArcGIS/SceneKit module ships only in a dev/prod build, not Expo Go).
  Build: `cd mobile && eas build --platform ios --profile development`.
- Backend + worker + MinIO running with the private offline-scenes bucket
  provisioned by the `minio-init` service (zero manual steps).
- A submission that has: coordinates, uploaded incident **geometry**, and a **real
  resolved road bearing** (so the bearing overlay is truthful, not invented).

## Steps

1. Install the new EAS development build on the iPhone; sign in.
2. Open the submission → 3D Terrain panel → **Prepare offline 3D area**. Wait for
   the generation job to reach **READY** (USGS 3DEP → eristerrain package).
3. Tap **Download**; wait for **Downloaded** (byte size + package SHA-256 verified,
   bundle extracted + grid SHA-256 verified before READY).
4. Enable **Airplane Mode** AND turn **Wi-Fi off** (fully offline).
5. Tap **Open native 3D terrain**.

## Confirm (all must hold, offline)

- [ ] A real terrain **mesh** is visible (from the decoded height grid — not a flat plane).
- [ ] The **hillshade texture** is draped on the mesh.
- [ ] The **incident marker** is at the correct location.
- [ ] The uploaded **geometry overlay** is rendered and correctly placed on the mesh
      (Point/Line/Polygon as applicable), clipped to the package bounds.
- [ ] The **road-bearing** line appears (because a real bearing exists) and the
      **sample-extent** rectangle appears (because real grid points exist) — neither
      is shown when its backing data is absent.
- [ ] **Orbit, pan, zoom, tilt** all work.
- [ ] **North** restores north-up while keeping the incident framing.
- [ ] **Reset** re-frames the incident (or terrain center if the incident is outside
      the packaged bounds).
- [ ] **No network request** is made at any point (verify via a proxy/Charles before
      airplane mode, or confirm it works fully in airplane mode).
- [ ] **Delete** the package → the 3D area becomes unavailable until re-downloaded.
- [ ] Change the incident geometry/bearing server-side, reconnect → the panel shows
      an **update-available** state (content signature changed).

## Fail-closed checks (should degrade safely, never crash / never fake)

- [ ] A tampered/corrupt download fails verification and does NOT open (size / package
      SHA-256 / bundle CRC / grid SHA-256).
- [ ] A missing/short height grid or malformed manifest shows a clear error, not a crash.

## Evidence

Attach a screen recording of the airplane-mode session + notes (device model, iOS
version, build id, package version) to the PR before marking this gate passed.
