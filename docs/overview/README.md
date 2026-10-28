# System overview

## What ERIS does

When a slope fails, a rock falls or an embankment washes out on a California
state highway, ERIS carries the case from the first field report to an approved
geotechnical assessment:

1. A **Maintenance Crew** member reports the incident from the field, with
   location, photos and a description.
2. The district's **Maintenance Coordinator** triages it: assessment needed,
   not needed, duplicate, or more information required.
3. If needed, an **assessment** is routed to the GeoTech office serving the
   district. The **Office Chief** routes it to a **Branch Chief** (who assigns a
   **Staff** member) or directly to a **Senior Specialist**.
4. The author fills the **GISA technical form**: site, measurements, 3D terrain,
   drone surveys, photos, actions and memos.
5. A chief reviews it and approves it or asks for revision. Approved records
   become readable statewide by **Guests**.

Everyone sees a **My Work** list of the steps waiting on them, and a
notification feed (with push on the iPhone app).

## Who uses it

```mermaid
flowchart LR
    crew(["Maintenance Crew"])
    coord(["Maintenance Coordinator"])
    oc(["Office Chief"])
    bc(["Branch Chief"])
    staff(["Staff / Senior Specialist"])
    guest(["Guest"])
    admin(["Administrator"])

    subgraph ERIS
        report["Report an incident"]
        triage["Triage reports"]
        groups["Manage Incident Groups"]
        route["Route assessments"]
        assign["Assign Staff"]
        form["Fill the GISA technical form"]
        review["Review and approve"]
        record["Read the approved record"]
        manage["Manage users and organization"]
    end

    crew --> report
    staff --> report
    coord --> triage
    coord --> groups
    oc --> route
    oc --> review
    bc --> assign
    bc --> review
    staff --> form
    guest --> record
    admin --> manage
```

Role details: [roles and permissions](../security/roles-and-permissions.md).
Step-by-step guides per role: [user guides](../user-guides/README.md).

## System context

ERIS and everything it talks to (C4 level 1):

```mermaid
flowchart TB
    users["Caltrans staff<br/>browsers and iPhones"]
    eris["ERIS<br/>web app, iPhone app, API, worker,<br/>database, object storage"]
    entra["Microsoft Entra ID<br/>identity, MFA, Conditional Access"]
    intune["Intune / Company Portal<br/>iPhone app delivery"]
    apns["Apple Push Notification service"]
    smtp["Caltrans SMTP relay<br/>(optional)"]
    gis["GIS services<br/>Caltrans postmiles and road layers,<br/>Esri basemaps and elevation, USGS 3DEP,<br/>NAIP, Census TIGERweb"]
    cicd["Jenkins + Harbor<br/>build, scan, sign, release"]
    backup["Caltrans backup target"]

    users -->|HTTPS| eris
    users -->|sign-in| entra
    eris -->|verify tokens| entra
    intune -->|installs the app| users
    eris -->|push alerts| apns
    apns --> users
    eris -->|email| smtp
    eris -->|maps, terrain, postmiles| gis
    users -->|maps| gis
    cicd -->|signed images| eris
    eris -->|matched backups| backup
```

## Main parts

| Part | Technology | Code | More |
| --- | --- | --- | --- |
| Web app | React 19, TypeScript, Tailwind, ArcGIS Maps SDK for JavaScript; served by nginx | `web/` | [Web guide](../development/web.md) |
| iPhone app | Swift, SwiftUI, MSAL (Entra), APNs | `ios/` (branch `claude/ios-swift-app`) | [iOS](../development/ios.md) |
| Expo app (reference) | React Native / Expo; being replaced by the Swift app | `mobile/` | [Expo app](../development/mobile-expo.md) |
| API | Python 3.12, FastAPI, SQLAlchemy (hand-written SQL), Alembic | `backend/app/` | [Backend guide](../development/backend.md) |
| Terrain worker | Same code base, GIS stack (rasterio, numpy) | `backend/app/worker/` | [Offline terrain](../architecture/offline-terrain.md) |
| Database | MariaDB 11, 61 tables | `database/`, `backend/migrations/` | [Data model](../data/README.md) |
| Object storage | SeaweedFS (S3 API): photos, files, PDFs, terrain packages | — | [Data model](../data/README.md#object-storage) |
| Deployment | One rootless Podman pod (Caltrans); Docker Compose (development) | `deploy/` | [Operations](../operations/README.md) |

## Capability map

```mermaid
mindmap
  root((ERIS))
    Field reporting
      GPS, postmile or map location
      Photos with position and heading
      Offline drafts on the phone
    Triage and groups
      Coordinator decisions
      Incident Groups and ERIS numbers
      Mission Center map
    Assessments
      Office and branch routing
      GISA technical form
      Review and approval
      Sharing and co-editing
    GIS
      3D terrain and drone surveys
      Measurements from elevation
      Road inventory and cross sections
      Offline 3D terrain packages
    Communication
      My Work
      Notification feed
      iPhone push and email
    Administration
      Users and Entra links
      Organization model
      Maintenance workflows
```

## Where to go next

- How the pieces fit: [architecture](../architecture/README.md)
- How a request travels: [request flows](../architecture/request-flows.md)
- How work moves: [workflows](../architecture/workflows.md)
- Words you will meet: [glossary](glossary.md)
