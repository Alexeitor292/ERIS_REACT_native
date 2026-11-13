# ERIS licensing and procurement picture

Prepared **November 13, 2026** for **Deh Jeng Jang**. Planning case: approximately
**300 mobile installations**; web-user count is not yet supplied. Caltrans already
has ArcGIS Enterprise/Online agreements, an Apple developer membership, and
Intune/Company Portal on the phones. Its Apple membership **type** and the exact
Esri entitlements have not been verified. Existing agreements must be checked
by Caltrans procurement/GIS administrators; this is a technical licensing
assessment, not a vendor quote or legal approval.

## Decision for the boss

**Do not order 300 paid Esri mobile licenses just because 300 people will use
ERIS.** For the current implementation, free **ArcGIS Maps SDK Lite** is the
appropriate candidate. Obtain one agency-owned **200.x-compatible Lite license
string**, deploy it to the 300 installations, and validate the exact offline
basemap under Lite. Esri states that Lite strings have no deployment-count limit.
Paid capability packs and per-user ArcGIS access are separate questions.
[Esri native licensing FAQ](https://developers.arcgis.com/swift/v200/faq/),
[obtaining a production license](https://developers.arcgis.com/swift/v200/license-and-deployment/get-a-license/).

The web SDK does not require 300 seat purchases either. It needs authorized Esri
services/content and an appropriate agency subscription. The main unresolved
costs are service usage, any private ArcGIS content access, and Apple distribution.
[JavaScript SDK terms](https://developers.arcgis.com/javascript/latest/licensing/).

## Quantity and cost planning

| Component | Quantity for current ERIS / 300 mobile installs | Purchase or existing coverage? |
| --- | --- | --- |
| Native SDK Lite | 1 agency-controlled license string; 300 installations | Free SDK deployment entitlement, subject to current scope and agreement |
| Paid Native Basic/Standard/Advanced packs | **0 planned** for current scope; conditional on package contents/features | If scope changes, quote the required level for every app installation, including applicable test installs |
| ArcGIS named users for ordinary ERIS access | **0 additional planned solely for ERIS**, conditional on public/authorized service use | Private ArcGIS organization content changes this; count unique people needing that content and reuse existing assignments |
| ArcGIS Online credential owner | At least 1 appropriately privileged Creator-or-higher account; appoint a second custodian | Use existing Caltrans entitlement if available; personal accounts are unsuitable |
| Esri API credentials | Recommended 4 separate credential sets: web/native × staging/production; development separately as needed | Keys are not purchased seats; usage is charged/credited to their owning subscription |
| ArcGIS Online/Enterprise subscription | Existing agency agreement, with ERIS approved and usage funded | No new ERIS ArcGIS Server installation required by this architecture |
| ArcGIS Pro authoring | 0 new if an existing GIS author publishes packages; otherwise 1 qualified author entitlement | Producing an approved offline basemap may require Pro; users do not all need Pro |
| ArcGIS Publisher for anonymous-use `.mmpk` authoring | 0 if no package is shipped or existing GIS author has coverage; otherwise 1 authoring extension entitlement | Required by Pro's Enable Anonymous Use option; not 300 Publisher licenses |
| Apple app developer membership | 1 agency organizational team | Existing membership may cover it; confirm standard vs Enterprise |
| Apple Business custom-app path | 1 agency organization/location integration plus about 300 app allocation licenses for a free ERIS app | Free app allocations; standard developer membership and review required; Intune connector setup needed |
| Alternative Enterprise IPA path | 1 Apple Developer Enterprise membership, if Apple approves this use | $299/year published US membership price; not 300 Apple memberships |
| Intune | Coverage for the 300 mobile users/devices per chosen licensing model | Existing coverage must be verified; no extra Intune license merely for adding one more app |
| Entra Conditional Access | P1/equivalent for each unique person covered by the policy; P2 for risk-based policy features | Check existing Microsoft agreement. Count overlapping web/mobile users once, not once per app |
| Optional Google Street View Embed | 0 or 1 Google Cloud project/billing setup, with separately restricted keys as needed | Embed requests currently have no usage charge; other Google APIs have different pricing |
| Runtime servers/DB/storage/React | No ERIS per-user license fee for the current community/open-source stack | Hosting, operations, supported OS/backups/security products may incur agency costs |
| Docker Desktop for developers | Number of developers who use Docker Desktop | Government use requires paid subscription; Linux Docker Engine/Podman licensing is separate |
| Git/CI/registry/security tooling | Agency plan, developer seats and build/storage usage as selected by IT | Jenkins/Harbor/community scanners need no per-ERIS-user seats; commercial hosting/support may cost |

API-key creation requires an ArcGIS Online Creator-or-higher user with the
specified custom-role privileges. Credential count above is an operational
recommendation, not an Esri license minimum. Each credential can have two keys
for rotation, so four credential sets does not mean only four active tokens.
[ArcGIS Online credential requirements](https://developers.arcgis.com/documentation/security-and-authentication/api-key-authentication/api-key-credentials/online/).

## Does Lite cover the mobile app?

The repository pins **ArcGIS Maps SDK for Swift 200.8.3** in `ios/project.yml`.
It uses ArcGIS maps, graphics overlays and `GeometryEditor` in
[`MapViews.swift`](../../ios/ERIS/Views/MapViews.swift). ERIS records and polygon
edits go to the ERIS FastAPI/MariaDB service. They are not edits to an ArcGIS
secured feature service or mobile geodatabase. The custom `.eristerrain` viewer
uses Apple's SceneKit in [`TerrainViews.swift`](../../ios/ERIS/Views/TerrainViews.swift).
That distinction is why drawing/editing an ERIS site does not automatically
require an Esri Basic editing license.

| Current use / possible change | Assessment |
| --- | --- |
| Online basemap display, site graphics, photo positions/directions, geometry sketching/calculations | Consistent with Lite; service/data access still needs its own authorization |
| Save ERIS forms/photos/polygons and synchronize ERIS's own offline queue | No paid ArcGIS editing level identified: this uses ERIS APIs, not ArcGIS feature edits |
| USGS-derived terrain grids and imagery rendered by SceneKit | Does not invoke Esri local raster/elevation APIs; preserve approved upstream data rights |
| Open an optional `.mmpk` basemap | Lite can open a package, **but its layers must also be Lite-compatible** |
| Put local TIFF/GeoTIFF rasters or raster elevation into ArcGIS layers, including inside `.mmpk`/`.mspk` | Can require **Standard**; do not approve Lite based on the package extension alone |
| Edit secured ArcGIS Online/Enterprise feature services or local mobile geodatabases | Generally **Basic or higher** and appropriate content/user authorization; Location Platform cases have separate rules |
| Offline network analysis, StreetMap Premium, utility-network advanced editing | Different paid levels/extensions; not current ERIS scope |

This is an inference from the actual API usage and Esri's
[license-by-API table](https://developers.arcgis.com/swift/v200/license-and-deployment/license-by-api/)
and [capability matrix](https://developers.arcgis.com/swift/v200/license-and-deployment/license-levels-and-capabilities/).
It must be validated with the exact production build/package. Lite supports
2D/3D and offline work; “offline” or “3D” alone does not imply a paid level.

**Additional offline-basemap gate:** ERIS does not currently sign users into an
ArcGIS portal. Pro's `.mmpk` publishing option **Enable Anonymous Use** requires
the **Publisher extension**; without that option, the tool's default expects a
named ArcGIS user. Have the GIS author provide a package that permits this
app's users, verify its layer types and test it under the actual Lite string.
Budget an existing/new **author's Publisher entitlement**, or use an approved
alternative package workflow; do not silently assume every `.mmpk` can be
opened by 300 Entra-only users. “Anonymous” here means no ArcGIS identity, even
though ERIS itself still requires sign-in.
[Create Mobile Map Package licensing](https://pro.arcgis.com/en/pro-app/3.3/tool-reference/data-management/create-mobile-map-package.htm).

Set `ARCGIS_RUNTIME_ENABLED=true`, `ARCGIS_LICENSE_KEY=<agency Lite string>`,
and a separately authorized `ARCGIS_API_KEY` in the server configuration.
`ARCGIS_MMPK_URL` is optional. The production app applies the license from
`/arcgis/runtime-config` and displays its resulting level. A map API key does
**not** license the native SDK. Staging currently uses developer licensing;
that is not production acceptance. SDK upgrades, including 300.x, require a
fresh licensing/lifecycle review.

Esri treats Runtime **100.x and 200.x license strings as compatible**; an older
string is not invalid merely because the SDK APIs changed. The separate
license-string boundary starts at 300.x. Confirm the actual level, expiry and
capabilities with the production SDK and package.
[Esri's license-string version rule](https://developers.arcgis.com/swift/license-and-deployment/use-a-license-in-your-app/).

## Web ArcGIS services and usage

The website is a static React/Vite application using `@arcgis/core`, served by
nginx. FastAPI handles application data; it is not an ArcGIS Server. Under
Esri's documented JavaScript SDK model, the SDK adds no separate purchase when
used with authorized Online/Enterprise services or Location Platform access.
This does not remove the need to pay for or qualify for the underlying content.
[JavaScript SDK licensing](https://developers.arcgis.com/javascript/latest/licensing/).

Caltrans GIS should choose and document the billing route:

- **Existing ArcGIS Online agreement:** agency-owned API credentials, approved
  privileges/hosts, applicable credits/service rights and usage monitoring.
  Obtain written confirmation for the exact basemap, World Imagery and
  Terrain 3D services; do not treat every endpoint as free or interchangeable.
- **Location Platform:** an alternate subscription with metered transactions,
  not a reason to buy 300 named users. Public list pricing currently includes
  2 million basemap tile requests per month then $0.15/1,000; the distinct
  session model includes 1,000 sessions then $4/1,000. These example rates are
  not an estimate for ERIS's current URLs or Caltrans's contract.
  [Current Location Platform pricing](https://location.arcgis.com/pricing/).

Measure staging requests before budgeting: map loads, zooming/imagery/elevation
tiles, service queries and offline-package downloads are different usage units.
For a tile-billed configuration, estimate requests as mobile activity plus web
activity plus testing; apply only the chosen service's applicable allowance and
rate. Never multiply “300 users” directly by a tile or session price.

Use origin-restricted `VITE_ARCGIS_API_KEY` in the web build; separate native
credentials at runtime. Keep Esri/source attribution visible. Browser keys
are public credentials and need least privileges, restrictions, rotation and
usage alerts. Do not embed a named user's password/token to access private data.

## Existing agreement and data restrictions

Esri's public Master Agreement is dated **August 14, 2026**; the public
Product-Specific Terms are now dated **November 10, 2026**, newer than the
earlier repository licensing note. The public agreement defers to a superseding
signed agreement. Private ArcGIS customer content can require individual named
user authentication; an Entra sign-in to ERIS alone does not grant that ArcGIS
entitlement. Obtain a written agency-specific answer rather than assuming
“we own Enterprise” grants every employee every capability.
[Master Agreement](https://www.esri.com/content/dam/esrisites/en-us/media/legal/ma-full/ma-full.pdf),
[E300 Product-Specific Terms](https://www.esri.com/content/dam/esrisites/en-us/media/legal/product-specific-terms-of-use/e300.pdf).

The current design saves measurement elevation from USGS, not Esri. Public
Caltrans/Census/USGS endpoints still have source terms, attribution and
availability constraints. Preserve offline/export rights for each layer;
publicly reachable does not establish unrestricted redistribution rights.
The older `offline_scene_worker_esri` implementation must not be enabled merely
because Lite licenses the client; review server processing and content rights
separately. E300 now also identifies service-identity licensing for programmatic
Enterprise access; GIS/procurement must determine whether any selected agency
services/jobs are covered. See [source-specific rules](../operations/map-licensing.md).

## Apple signing and Company Portal

**Intune does not turn a standard Apple Developer membership into an Enterprise
signing entitlement.** The existing runbooks assumed Enterprise `.ipa`
distribution; that assumption must be confirmed before 300-device rollout.

Two eligible paths to evaluate with IT:

1. **Custom app with the existing standard developer team:** submit a private
   custom app for Apple's review and make it available only to the agency's
   Apple organization. IT obtains free ERIS app allocations and syncs them to
   Intune for assignment. This requires Apple Business organization/content
   setup, currently reported absent. Apple Business now includes the former
   Apple Business Manager services and is free; Intune documentation may still
   call its integration ABM/VPP. The standard membership's published price is
   $99/year, already paid if current; eligible government organizations can
   request a waiver. This path needs a distribution/runbook update and a test.
   [Apple Business](https://www.apple.com/newsroom/2026/03/introducing-apple-business-a-new-all-in-one-platform-for-businesses-of-all-sizes/),
   [membership](https://developer.apple.com/programs/whats-included/),
   [government fee waiver](https://developer.apple.com/help/account/membership/fee-waivers/),
   [Intune volume/custom app management](https://learn.microsoft.com/en-us/intune/app-management/deployment/manage-vpp-apple).
2. **Enterprise in-house app:** if Caltrans has or obtains Apple Developer
   Enterprise approval, sign the in-house `.ipa` and distribute as an Intune
   line-of-business app. Published membership price is $299/year for the
   organization, not per device. Apple limits eligibility to organizations
   with at least 100 employees and eligible internal-use cases; approval is
   not automatic. Track profile/certificate renewals so installed apps keep
   launching. [Apple Enterprise program](https://developer.apple.com/programs/enterprise/).

Select one path. Ad hoc registration is limited to 100 devices per product
family per membership year; TestFlight builds expire after 90 days. Neither
is the production plan for the 300-device fleet.
[Apple device registration limits](https://developer.apple.com/help/account/devices/devices-overview/),
[TestFlight limits](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/).
The Campos Labs team,
TestFlight app and bundle ID must not become permanent agency dependencies.

## Microsoft and other recurring costs

Verify existing Intune coverage for every benefiting user/device. Company
Portal's presence is evidence of management, not proof of all license
assignments. For Entra, use the number of unique staff covered by Conditional
Access: P1 or an including suite for ordinary policies; P2 for risk-based
policies. Web and mobile access by one person do not inherently create two
Microsoft user-license requirements.
[Intune licensing](https://learn.microsoft.com/en-us/intune/fundamentals/licensing/unlicensed-admins),
[Entra licensing](https://learn.microsoft.com/en-us/entra/fundamentals/licensing).

Optional Street View uses **Google Maps Embed**, currently no-charge with a
valid API key and billing-enabled project. Avoid confusing it with separately
priced Maps JavaScript, Static Street View or tile APIs.
[Google Embed requirements](https://developers.google.com/maps/documentation/embed/quickstart).

Budget for two hosted environments, disk/object growth, backups, monitoring,
TLS/DNS and support. Linux/Podman does not require 300 user licenses. OS support,
commercial vulnerability tools, Git hosting/build minutes and enterprise registry
support depend on the platform IT selects. Existing personal Proxmox/Cloudflare
services are not mandatory production purchases. Xcode/macOS build hardware,
Apple membership and iPhone management remain operational dependencies.

Docker Desktop requires a paid subscription for government use. Count the
developers who actually use it, not all ERIS users. An approved Linux Engine or
Podman development setup is a different product/license choice.
[Docker Desktop terms](https://docs.docker.com/subscription-billing/desktop-license/).

## Open-source and proprietary notices

React and the community application stack do not impose ERIS seat fees.
Open-source notices and redistribution duties still apply. MariaDB community
server is GPL; its publisher permits internal and remote-service use without
a per-user fee. SeaweedFS 4.50 is Apache-2.0. Preserve notices and source-offer
obligations applicable to any delivered binaries/images, including their OS
packages. Inventory exact release versions/SBOMs rather than treating all
transitive packages as MIT.
[MariaDB licensing](https://mariadb.com/kb/en/licensing-faq/),
[SeaweedFS 4.50 license](https://github.com/seaweedfs/seaweedfs/blob/4.50/LICENSE).

The repository has no top-level `LICENSE` granting rights for ERIS's own code.
Deh Jeng Jang/Caltrans must decide ownership and permitted distribution; do not
invent an open-source grant. ArcGIS SDKs/data remain under Esri terms. The [package license metadata inventory](../reference/third-party-license-inventory.json)
lists the locked web packages, fresh worker Python packages and Swift package
origins. It is an inventory, not legal clearance; unknown/nonstandard licenses
need review and actual license texts/notices must accompany applicable delivery.
Maintain third-party notices and image SBOMs with the release. AI coding subscriptions are development
choices, not an ERIS runtime dependency.

## Questions to close before purchase/go-live

1. GIS/Esri: confirm **300 installations, free 200.x Lite string, no paid packs**
   for the actual API list and approved `.mmpk`; inspect every package layer.
2. GIS/procurement: confirm internal web/native API-key usage and any named-user
   or service-identity requirements under Caltrans's signed agreement; list
   existing entitlements available to ERIS and usage/credit budgets.
3. GIS: assign credential owner and backup custodian; approve four environment/
   client credential sets, expiry/rotation and service limits.
4. IT/Apple: verify the exact membership type and choose custom-app/Apple Business
   or approved Enterprise distribution; demonstrate install/update through Intune.
5. Microsoft licensing: verify the 300 mobile users/devices and all web users
   have required existing Intune/Conditional Access coverage.
6. Owner/procurement: approve code/data redistribution, notices, hosting/support
   costs and any optional services. Record answers in [handoff acceptance](../handover/acceptance.md).

**Budget position:** current code does not justify buying 300 paid mobile SDK
seats. Incremental Esri SDK cost can be $0 under the stated scope, while service
usage and contract-specific entitlements still require confirmation. There is
not enough verified contract/usage information to give a defensible total annual
dollar amount yet.
