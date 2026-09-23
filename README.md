# ERIS — Emergency Response Information System

ERIS is how Caltrans Geotechnical Services and district Maintenance handle slope,
embankment and drainage incidents on the state highway system:

1. A Maintenance Crew member reports an incident from the field.
2. The district's Maintenance Coordinator triages it.
3. The GeoTech office routes an assessment to a Staff member or Senior
   Specialist, who fills the technical form.
4. A chief reviews and approves the assessment.

| Part | Folder | Stack |
| --- | --- | --- |
| API and terrain worker | `backend/` | Python 3.12, FastAPI, MariaDB, MinIO |
| Web app | `web/` | React, ArcGIS Maps SDK for JavaScript |
| Mobile app | `mobile/` | Expo / React Native, ArcGIS Runtime for iOS |
| Database schema | `database/`, `backend/migrations/` | MariaDB 11, Alembic |
| Server stack | `docker/` | Docker Compose |

## Quick start (development)

```bash
cd docker && cp .env.example .env && docker compose up -d      # MariaDB + MinIO
# load database/dev/030_mock_accounts.sql, then from backend/:
alembic stamp 0001_baseline && alembic upgrade head && ./run.sh
# from web/:
npm ci && npm run dev                                           # http://localhost:5173
```

The full steps, including the Windows commands, are in
[docs/development.md](docs/development.md).

## Documentation

Start at [docs/README.md](docs/README.md).
