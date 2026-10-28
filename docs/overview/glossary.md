# Glossary

Domain and technical terms used in ERIS, its code and these documents.

## Caltrans and engineering terms

| Term | Meaning |
| --- | --- |
| **Caltrans** | California Department of Transportation. |
| **District** | One of Caltrans's 12 regional districts (D01–D12). Coordinators cover districts; offices serve districts. |
| **County** | Three-letter county code used in postmiles (for example `ALA`, `PLA`). |
| **Route** | State highway route number, stored as three digits (`080`, `005`). |
| **Postmile (PM)** | Caltrans's linear reference along a route within a county, with optional prefix (for example `R` realigned) and suffix (`L`/`R` for divided lanes): `R12.35L`. ERIS stores two decimals. |
| **SHN** | State Highway Network. ERIS converts between coordinates and postmiles with Caltrans's public "SHN Postmiles Tenth" layer. |
| **GeoTech** | Caltrans Geotechnical Services: the offices and branches that assess slopes and embankments. |
| **GISA** | The geotechnical incident site assessment: the technical form an author fills in ERIS. Fields: [GISA data dictionary](../reference/gisa-data-dictionary.md). |
| **Road inventory** | Caltrans highway inventory data (lanes, shoulders, medians) imported into ERIS and packaged for phones. Terms: [road inventory glossary](../reference/road-inventory-glossary.md). |
| **3DEP** | USGS 3D Elevation Program: the lidar-based elevation ERIS uses for terrain. |
| **DEM / DSM** | Digital elevation model (bare earth) / digital surface model (with objects). Drone surveys provide either. |
| **NAIP** | USDA National Agriculture Imagery Program aerial imagery. |

## ERIS workflow terms

| Term | Meaning |
| --- | --- |
| **Incident** (report) | A field report. Provisional until triage; enters the record with an ERIS number when an assessment is required. |
| **ERIS number** | The permanent incident identifier assigned at triage. Never changes. |
| **Triage** | The coordinator's decision on a new report: assessment required, not required, duplicate, or needs reporter information. |
| **Incident Group** (event group) | Reports caused by one event (for example a storm on one route). The older API calls them *projects*. |
| **Mission Center** | The map of every Incident Group with reports in the record. |
| **Assessment** | The GeoTech work item for an incident: routed, assigned, authored, reviewed. States in [workflows](../architecture/workflows.md#4-assessments). |
| **Branch route / Senior Specialist route** | The two ways an Office Chief routes an assessment: through a Branch Chief who assigns Staff, or directly to a Senior Specialist. |
| **Submission** | A GISA technical form record (with photos, actions, memos). |
| **Consulted** | Someone added to an assessment for information only. |
| **My Work** | The list of steps waiting on the signed-in person. |
| **Workflow tree** | Per-incident view of every step from report to resolution. |
| **Organization model** | Offices, branches, districts, and where each person sits. Roles follow from where a person sits. |
| **Maintenance workflow** | A district's definition of maintenance work steps, run per incident. |
| **Offline scene package** | A bounded 3D terrain bundle (`eristerrain` or `.mspk`) a phone downloads for offline use. |

## Roles

| Role code | Name | In short |
| --- | --- | --- |
| `MAINTENANCE_CREW` | Maintenance Crew | Reports incidents from the field |
| `MAINTENANCE_COORDINATOR` | Maintenance Coordinator | Triages reports for the districts they cover |
| `OFFICE_CHIEF` | Office Chief | Routes and (on the Senior Specialist route) reviews assessments |
| `BRANCH_CHIEF` | Branch Chief | Assigns Staff and reviews branch-route assessments |
| `STAFF` | Staff | Authors technical forms |
| `SENIOR_SPECIALIST` | Senior Specialist | Authors technical forms on the direct route |
| `GUEST` | Guest | Reads approved records only |
| `ADMIN` | Administrator | Everything, plus users and organization |

## Technical terms

| Term | Meaning |
| --- | --- |
| **Entra ID** | Microsoft's identity service (formerly Azure AD). ERIS signs people in with it; it never grants ERIS roles. |
| **Object ID** | A person's permanent Entra identifier. ERIS links accounts by tenant ID + object ID, never by email. |
| **OIDC, PKCE** | OpenID Connect sign-in protocol; Proof Key for Code Exchange, which protects the authorization code. |
| **Client assertion / certificate credential** | How the ERIS API proves its identity to Entra: a JWT signed with a private key, instead of a shared secret. |
| **MSAL** | Microsoft Authentication Library; the iPhone app signs in with it through Microsoft Authenticator. |
| **Session** | ERIS's own server-side sign-in record. Browsers hold it in an HttpOnly cookie, the iPhone as a bearer token. |
| **CSRF token** | The value every browser write must echo in `X-CSRF-Token`, so another site cannot act as the user. |
| **Pod** | A Podman group of containers sharing one network namespace; ERIS production is one pod of five containers. |
| **Harbor** | Caltrans's container registry. |
| **SBOM** | Software bill of materials: the list of every package in an image (CycloneDX format). |
| **Trivy / cosign** | The vulnerability scanner and image signer the release pipeline uses. |
| **Digest** | A content hash that identifies an exact image (`name@sha256:…`); production pins digests, never tags. |
| **Presigned URL** | A short-lived (about 15 min) S3 link that carries its own signature, so file bytes skip the API. |
| **Alembic** | The database migration tool; every schema change is a revision. |
| **APNs** | Apple Push Notification service. |
| **Intune / Company Portal** | Microsoft device management; Caltrans delivers the ERIS iPhone app through it. |
