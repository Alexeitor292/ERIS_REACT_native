# ERIS documentation

| Document | Read it to |
| --- | --- |
| [architecture.md](architecture.md) | Understand the parts of ERIS, how a request is handled, the data model, and what each role sees in the web and mobile apps. |
| [workflows.md](workflows.md) | Follow a report from the field through triage, Incident Groups and the assessment to approval. |
| [roles-and-identity.md](roles-and-identity.md) | See the eight roles, the per-record permits, sign-in and Entra ID readiness, and the mock accounts. |
| [organization.md](organization.md) | Maintain offices, branches, district coverage and where people sit (administrators). |
| [configuration.md](configuration.md) | Look up any setting of the backend, worker, server stack, web or mobile app. |
| [development.md](development.md) | Run ERIS on your machine, run the tests, and change the database schema. |
| [deployment.md](deployment.md) | Install, update, back up and roll back a staging or production server, set up HTTPS, and release the mobile app. |
| [caltrans-it-deployment-brief.md](caltrans-it-deployment-brief.md) | Bring diagrams, stack/data/security facts, decisions, handouts, and anticipated questions to a Caltrans IT call. |
| [ERIS Caltrans IT PDF briefing](../output/pdf/eris-caltrans-it-briefing.pdf) | Send or print the four-page call handout. |
| [caltrans-podman.md](caltrans-podman.md) | Install and operate the proposed single-Podman-pod Caltrans deployment. |
| [ios-native-app.md](ios-native-app.md) | Build the native Swift ERIS iOS app: MSAL sign-in, the API contract, what to port, and acceptance on the Caltrans Mac mini. |
| [caltrans-readiness-audit.md](caltrans-readiness-audit.md) | See which deployment gaps were closed on 2026-10-28, which remain open, and how each was tested. |
| [offline-terrain.md](offline-terrain.md) | Understand and operate offline 3D terrain packages, the road inventory, and terrain cross sections. |
| [offline-scene-package-operator-runbook.md](offline-scene-package-operator-runbook.md) | Follow the operator procedures for terrain packages, including hand-made `.mspk` packages. |
| [reference/gisa-data-dictionary.md](reference/gisa-data-dictionary.md) | Look up a field of the GISA technical form. |
| [reference/road-inventory-glossary.md](reference/road-inventory-glossary.md) | Look up a road inventory term. |
| [decisions/](decisions/README.md) | Read why the offline terrain and road-context designs are the way they are. |

The API's own reference is generated from the code: open `/docs` on a
development backend (for example http://127.0.0.1:8000/docs).
