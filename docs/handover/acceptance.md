# Handoff acceptance record

Prepared **2026-11-13**. This is an uncompleted worksheet. Check a row only
after the receiving person has performed it and attached evidence. Keep secret
values, staff data, backup contents and tokens out of Git.

## Ownership and assigned infrastructure

| Item | Value / reference |
| --- | --- |
| ERIS business/project owner | Deh Jeng Jang |
| Outgoing maintainer departure | End of November 2026 |
| Technical successor and backup | Pending assignment |
| Caltrans IT service owner / support queue | Pending assignment |
| Agency repository URL / default branch | Pending transfer; current source `Alexeitor292/ERIS_REACT_native` |
| Staging host / OS / Podman / service account | Pending IT assignment |
| Staging browser HTTPS / files HTTPS | Pending IT assignment |
| Production host / OS / Podman / service account | Pending IT assignment |
| Production browser HTTPS / files HTTPS | Pending IT assignment |
| Entra tenant / web and mobile app IDs / registration owners | Pending identity team; record public IDs and secret-store references |
| Harbor project / Jenkins job / approved signing public key | Pending IT assignment |
| Backup target / retention / encryption / RPO / RTO | Pending IT decision |
| Apple/Intune/GIS/SMTP contacts and renewal calendar | Pending assignment |
| Change ticket / target cutover / rollback decision maker | Pending agreement |
| Source commit / package SHA-256 / accepted release digests | Populate from package manifest and release evidence |

## Receiving maintainer exercises

| Done | Exercise | Evidence: date, person, ticket/result |
| --- | --- | --- |
| [ ] | Verify package SHA-256, read handover/environment docs, obtain agency Git access | Pending |
| [ ] | On a fresh workstation, configure local env, seed/migrate, sign in and run API + web | Pending |
| [ ] | Explain incident → assessment → technical form → review/approval; roles from organization placement | Pending |
| [ ] | Run non-DB and DB tests, web tests/build, docs checks and native CI | Pending |
| [ ] | Make a small code/docs change on a branch; get it reviewed and built in the agency pipeline | Pending |

## IT staging and production gates

| Done | Gate | Evidence: date, person, ticket/result |
| --- | --- | --- |
| [ ] | Agency staging installed from approved source/images, separate secrets and data from production | Pending |
| [ ] | DNS, trusted TLS, same-origin API, signed files, firewall and egress proven from browser and phone | Pending |
| [ ] | Entra linked, unknown, unassigned and disabled identities tested; local login off | Pending |
| [ ] | Two linked active ERIS admins sign in; bootstrap removed; `handover-check` and `cert-check` pass | Pending |
| [ ] | Production-profile verification passes through public URLs | Pending |
| [ ] | Report, triage, assignment, form collaboration, review, approval, attachment and notification tests pass | Pending |
| [ ] | Native device install/update, MSAL, push, unsent-data handling and offline maps/sync accepted, or scope exclusion approved | Pending |
| [ ] | Matched backup verified, encrypted and off-host; another host restores it; recovery time/data consistency measured | Pending |
| [ ] | Approved release promotes identical signed digests from staging to production; rollback exercise passes | Pending |
| [ ] | Reboot persistence, alerts, logs, disk thresholds, backup/retry jobs and escalation exercised | Pending |
| [ ] | Owner approves go-live and any remaining work; production evidence and recovery point recorded | Pending |
| [ ] | Personal-server data disposition completed after acceptance; outgoing access removed/keys rotated | Pending |

## Acceptance decision

- Receiving technical maintainer / date: **Pending**
- IT service owner / date: **Pending**
- Deh Jeng Jang, project owner / date: **Pending**
- Accepted environment and release: **Pending**
- Remaining blockers / approved exceptions / due dates: link [work register](open-work.md) IDs.
- Interim hosting/custodian and expiry, if needed: **Pending explicit agreement**.

Source/documentation delivery and operational acceptance are separate milestones.
Do not infer a passing deployment from an archived source tree or automated unit tests.
