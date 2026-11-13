#!/usr/bin/env bash
# Full DB integration suite against the exact patched MariaDB image from CI.
# Disposable synthetic data only; never reads runtime env files or real DBs.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
[[ ! -e "$ROOT/backend/.env" && ! -L "$ROOT/backend/.env" ]] || {
  echo 'Run only in a clean CI checkout without backend/.env' >&2; exit 2;
}
evidence="${ERIS_TEST_EVIDENCE_DIR:?Set ERIS_TEST_EVIDENCE_DIR to a disposable CI evidence directory}"
image="${ERIS_TEST_DB_IMAGE:-localhost/eris/mariadb:candidate}"
commit="$(git -C "$ROOT" rev-parse HEAD)"
revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")"
[[ "$revision" == "$commit" ]] || { echo 'Candidate MariaDB source revision does not match checkout' >&2; exit 2; }
echo "Candidate MariaDB source: $commit"
docker image inspect --format 'Candidate MariaDB image: {{.Id}}' "$image"

container="eris-ci-db-${RANDOM}-$$"
owns_container=0
cleanup() { if [[ "$owns_container" == 1 ]]; then docker rm -fv "$container" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT
docker create --name "$container" -p 127.0.0.1:3306:3306 \
  -e MARIADB_ROOT_PASSWORD=eris-ci-disposable-root \
  -e MARIADB_DATABASE=eris -e MARIADB_USER=eris_user \
  -e MARIADB_PASSWORD=eris-ci-disposable-app "$image" >/dev/null
owns_container=1
docker start "$container" >/dev/null
ready=0
for _ in $(seq 1 90); do
  if docker exec "$container" healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[[ "$ready" == 1 ]] || { docker logs --tail 80 "$container"; echo 'Candidate MariaDB failed readiness' >&2; exit 1; }

# The host's Python 3.12 runner exercises the same constrained dependencies and
# schema/mock-account/migration/placement sequence as the general DB CI job.
python -m pip install -r "$ROOT/backend/requirements-worker.txt"
export ENV=dev DB_HOST=127.0.0.1 DB_PORT=3306 DB_NAME=eris DB_USER=eris_user
export DB_PASS=eris-ci-disposable-app JWT_SECRET=eris-ci-disposable-test-signing-key
export S3_ACCESS_KEY=ci_s3_access S3_SECRET_KEY=ci_s3_secret
sql() { docker exec -i -e MYSQL_PWD=eris-ci-disposable-root "$container" mariadb --protocol=socket -u root eris; }
sql < "$ROOT/database/init/010_schema.sql"
sql < "$ROOT/database/init/020_seed.sql"
sql < "$ROOT/database/dev/030_mock_accounts.sql"
cd "$ROOT/backend"
python -m alembic stamp 0001_baseline
python -m alembic upgrade head
python -m alembic current
sql < "$ROOT/database/dev/040_mock_placements.sql"
mkdir -p "$evidence"
python -m pytest tests/ -m db --tb=short --junitxml="$evidence/candidate-db.xml"
echo 'PASS candidate MariaDB: baseline upgrade and DB integration suite verified'
