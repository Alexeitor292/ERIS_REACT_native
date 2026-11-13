# Remaining work register

Status as of **2026-11-13**. Project owner: **Deh Jeng Jang**. Named technical
successor, IT service owner, and hosting assignments remain **unassigned**.
The outgoing maintainer plans to leave Caltrans at the end of November 2026.
This is the current register; the [October audit](../caltrans/readiness-audit.md)
and [deployment history](../operations/history/) describe earlier evidence.
An implementation or passing unit test does not establish deployment acceptance.

P0 means required for independent ownership / safe cutover; P1 means required
before production acceptance; P2 is follow-on work to scope with the owner.
All rows are open unless linked evidence below says otherwise.

| ID | Priority | Work / current gap | Accountable role | Completion evidence |
| --- | --- | --- | --- | --- |
| H01 | P0 | Approach Caltrans IT; assign technical successor, service owner and staging host. Production host, DNS and dates are not assigned | Deh Jeng Jang + IT | Named owners, accepted IT request, staging/prod worksheet completed |
| H02 | P0 | Move source ownership from personal `Alexeitor292/ERIS_REACT_native` to an agency-controlled Git service; retain history, branches, issues, CI and access | Owner + Git administrator | Successor clones, pushes a branch and runs CI without outgoing maintainer's account |
| H03 | P0 | Move staging and its evidence off personal Proxmox/Cloudflare/Caddy; reconcile current state before migration | IT + outgoing maintainer | [Transfer runbook](server-transfer.md) completed; data verified on replacement host |
| H04 | P0 | Deliver matched DB/object/config backup, image digests and secure secret inventory; prove recovery | IT | Checksummed encrypted backup restored on another host, elapsed recovery time recorded |
| H05 | P0 | Transfer personal access dependencies, establish two ERIS admins, rotate credentials, remove outgoing access after acceptance | IT + ERIS administrators | Secret-store custody confirmed, `handover-check` passes, access review signed |
| H06 | P1 | Configure Entra web/native registrations, certificate, user links, assignment and Conditional Access; confirm session policy | Identity/security + IT | Linked/unlinked/unassigned/disabled account tests and certificate rotation recorded |
| H07 | P1 | Create Jenkins job/credentials and Harbor project, mirrors, cosign policy, scan rules and forced-command deployment access | Release/platform team | Real pipeline builds/scans/signs all five images; host verifies pulls; staged release/failed-release rollback evidence |
| H08 | P1 | Approve DNS/TLS, gateway headers, firewall/egress and limits; exercise full CSP currently in report-only mode | Network/security + developer | Both HTTPS hostnames pass production verification; maps, surveys, Street View and previews work under approved CSP |
| H09 | P1 | Set backup schedule, off-host encryption/retention, disk/health/queue alerts, log destination, RPO/RTO and support escalation | IT + owner | Scheduled jobs/alerts proven; restore drill meets agreed targets |
| H10 | P1 | Validate native iOS on enrolled Caltrans hardware, Entra/MSAL broker, push, offline queue/conflicts and maps; replace personal staging signing/URL | iOS maintainer + identity/Intune teams | Device matrix and Intune install/update signed off; renewal dates and Apple account custody recorded |
| H11 | P1 | Complete workflow acceptance with representative Maintenance/GeoTech users; run DB integration/fresh migration suite on disposable MariaDB | Developer + business testers | Report → triage → routing → authoring → approval; attachments and persistence; CI/test results attached |
| H12 | P1 | Resolve production map licensing/keys and authorized offline GIS sources, egress and caching rights | Owner + GIS/licensing + IT | Approved source/key inventory; browser maps and native offline package accepted |
| H13 | P1 | Decide SMTP/APNs scope and configure delivery, retry operations and monitoring | Owner + messaging/Apple administrators | Delivery and failure/retry tests, or explicit accepted feature exclusion |
| H14 | P1 | Repeat independent setup using only the delivered package/docs | Successor + IT | [Acceptance record](acceptance.md) completed; missing steps corrected in Git |
| H15 | P2 | Scope native road-slice, inspection and corridor tools; Mission Center browsing is intentionally absent from current native app | Owner + iOS maintainer | Written scope decision; required work tracked and tested (do not promise Expo feature parity) |
| H16 | P2 | Review attachment lifecycle: native gallery cannot delete files because the server currently provides no removal operation | Owner + developer | Retention/audit decision, then authorized implementation and tests if needed |
| H17 | P2 | Decide whether to retain and host the isolated guided demo after transfer | Owner + IT | Demo URL/owner or disabled login invitation; isolation checks pass if retained |
| H18 | P1 | Close the security review and scan the five exact production images; complete static-finding triage and environment testing | Developer + Caltrans security | [Security review](../security/review-2026-11-13.md) gates and exceptions accepted; no unsupported zero-risk claim |
| H19 | P1 | Confirm 300-installation Lite entitlement and optional basemap/Publisher rights; verify Apple membership and distribution path | Owner + GIS/procurement + Apple/Intune team | [Licensing bill of materials](../caltrans/licensing-bill-of-materials.md) questions answered in writing |

## Current implementation facts

- Native Swift is the supported mobile project in `ios/`; React Native/Expo was
  intentionally removed from the working tree. Preserve the old app in Git
  history for reference; do not attempt to build it as the supported client.
- [Native port status](../../ios/README.md#port-status) records implemented
  features and device tests still needed. Several major screens are ported;
  the October audit's statement that Swift is a future rewrite is historical.
- Scripts implement release rollback, private bucket bootstrap, backup/restore,
  certificate checks and administrator handover checks. Stubs exercise script
  behavior; real Caltrans services still require acceptance.
- `ios/project.yml` currently contains Campos Labs Debug/Staging team, bundle
  ID and server URL, and a placeholder production server. Change and regenerate
  the Xcode project before agency distribution.
- A GitHub connector search on 2026-11-13 returned no open issues or pull
  requests for this repository. That result is not a substitute for this
  register; recheck under the agency account at transfer and record access limits.

## Suggested sequence through November

1. **November 13–20:** owner submits IT request; name successor and host/identity/
   Git/Apple contacts; inventory existing server and create recovery set (H01–H05).
2. **November 20–27:** install agency staging, configure identity/pipeline/network,
   run device, workflow and recovery acceptance (H06–H13).
3. **Before departure:** successor performs the independent handoff exercise;
   owner signs accepted items and explicitly retains unresolved blockers (H14).
   Retire personal hosting only after accepted recovery/cutover evidence.

These are proposed working windows, not agreed IT delivery dates. If hosting
cannot be ready by departure, the owner must approve an interim custodian,
hosting arrangement, data custody, support contact and expiry date. Do not
represent the source package alone as a deployed or production-approved system.
