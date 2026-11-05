# Deployment topologies

Where each part of ERIS runs in each environment, which ports are open, and how
a change travels from a commit to production. How to launch each environment:
[operations](../operations/README.md).

## Environments at a glance

```mermaid
flowchart LR
    dev["Development<br/>a developer's machine<br/>mock accounts"]
    ci["CI<br/>GitHub Actions<br/>tests on every PR"]
    staging["Test / staging<br/>Caltrans Linux host<br/>same pod as production"]
    prod["Production<br/>Caltrans Linux host<br/>one Podman pod"]
    dev -->|pull request| ci
    ci -->|merge, Jenkins build| staging
    staging -->|approval, same digests| prod
```

| | Development | Test / staging | Production |
| --- | --- | --- | --- |
| Where | Laptop | Caltrans host (separate from production) | Caltrans host |
| Runtime | Docker Compose for MariaDB + SeaweedFS; API and web run directly | One rootless Podman pod | One rootless Podman pod |
| Images | Built locally or none | Signed digests from Jenkins/Harbor | The same signed digests, after approval |
| Sign-in | Mock accounts with passwords (`LOCAL_LOGIN_ENABLED=true`) | Entra test tenant or staging app registration | Entra only |
| Data | Disposable | Disposable, or a copy for rehearsals (authorized) | Live |
| Guide | [Getting started](../development/getting-started.md) | [Operations](../operations/README.md#test-staging) | [Caltrans Podman runbook](../operations/caltrans-podman.md) |

## Development

```mermaid
flowchart LR
    subgraph laptop["Developer machine"]
        vite["Vite dev server<br/>localhost:5173<br/>proxies /api"]
        uv["uvicorn --reload<br/>localhost:8000<br/>backend/app"]
        subgraph compose["Docker Compose (deploy/compose)"]
            mdb[("MariaDB<br/>:3306")]
            sfs[("SeaweedFS S3<br/>:9800")]
            adm["Adminer<br/>:8081"]
        end
        wk["Optional: terrain worker<br/>python -m app.worker.offline_scene_worker"]
    end
    browser["Browser"] --> vite
    vite -->|"/api → strip prefix"| uv
    uv --> mdb
    uv --> sfs
    wk --> mdb
    wk --> sfs
```

The Vite proxy keeps the browser on one origin, exactly like production, so the
HttpOnly session cookie works in development too.

## Caltrans production (and staging)

```mermaid
flowchart TB
    subgraph internet_side["Staff network"]
        users["Browsers and iPhones"]
    end
    subgraph edge["Caltrans edge (IT)"]
        dns["DNS: web hostname,<br/>file hostname"]
        gw["TLS gateway<br/>HTTPS 443, HSTS, WAF"]
    end
    subgraph host["Linux host: rootless Podman, service account"]
        subgraph pod["pod 'eris'"]
            web["eris-web :80"]
            api["eris-api :8000"]
            worker["eris-worker"]
            db[("eris-mariadb :3306")]
            s3[("eris-seaweedfs :8333")]
        end
        vol1[("volume eris-mariadb")]
        vol2[("volume eris-seaweedfs")]
        secrets["deploy/podman/secrets<br/>(Entra cert, APNs key; 700/600)"]
        policy["~/.config/containers/policy.json<br/>(cosign signatures required)"]
    end
    users --> dns --> gw
    gw -->|"127.0.0.1:8080 or private IP"| web
    gw -->|"127.0.0.1:9800 or private IP"| s3
    web --> api
    api --> db
    api --> s3
    worker --> db
    worker --> s3
    db --- vol1
    s3 --- vol2
    secrets -. read-only mount .- api
```

### Ports

| Port | Where | Exposed to | Purpose |
| --- | --- | --- | --- |
| 443 | TLS gateway | Staff network | `eris.<domain>` (web + `/api`) and `eris-files.<domain>` (signed files) |
| 8080 | Host (loopback or private IP) | The gateway only | Pod port 80: nginx, SPA and `/api` |
| 9800 | Host (loopback or private IP) | The gateway only | Pod port 8333: SeaweedFS S3 |
| 8000, 3306, 8333, 9333, 8888, 23646 | Inside the pod | Nothing | API, MariaDB, SeaweedFS internals (`verify-rehearsal.sh` fails if published) |

### Outbound traffic the host needs

| To | For | Required |
| --- | --- | --- |
| `login.microsoftonline.com` (or `.us`) | Entra sign-in, signing keys | Yes |
| Harbor | Pulling the five signed images | Yes |
| `api.push.apple.com:443` | iPhone push | If push is enabled |
| SMTP relay | Email notifications | If email is enabled |
| USGS, Esri, Caltrans GIS, Census | Terrain packages, elevation, postmiles | For those features |
| Backup target | Off-host backups | Yes |

## The release path

```mermaid
flowchart LR
    pr["Pull request"] --> gha["GitHub Actions<br/>ci.yml, docs.yml, ios.yml"]
    gha --> merge["Merge"]
    merge --> jb["Jenkins<br/>deploy/ci/Jenkinsfile.podman"]
    subgraph pipeline["Release pipeline"]
        build["Build api, worker, web<br/>+ tests"]
        gate["Trivy SBOM +<br/>vulnerability and secret gate"]
        push["Push to Harbor,<br/>record digests"]
        sign["cosign sign + attest SBOM<br/>(all five images)"]
    end
    jb --> build --> gate --> push --> sign
    sign --> stg["deploy-hook.sh on staging<br/>eris-pod.sh release"]
    stg --> approve{"Named approver<br/>in Jenkins"}
    approve --> prd["deploy-hook.sh on production<br/>eris-pod.sh release"]
```

Each `release` on a host pulls under the signature policy, takes a matched
backup, migrates, verifies, and rolls back by itself on failure
([runbook](../operations/caltrans-podman.md#releases-one-command-automatic-rollback)).

## Legacy and rehearsal stacks

- **Docker Compose server stack** (`deploy/compose/docker-compose.yml` +
  `docker-compose.proxmox.yml`): how ERIS ran before the Podman pod. Kept for
  development parity and history; documented in [Compose deployment](../operations/compose-deployment.md).
- **Campos Labs Proxmox rehearsal**: a rehearsal of the Caltrans pod on personal
  infrastructure, recorded in [history](../operations/history/proxmox-podman-cutover.md).
  Not a Caltrans environment; see the [handover checklist](../handover/README.md#before-the-original-author-leaves-checklist).
