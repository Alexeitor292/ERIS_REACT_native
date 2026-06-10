"""
No-DB smoke tests — safe to run in CI without a live database or MinIO.
These verify that the app imports cleanly, core routes are registered,
the /health endpoint responds, and the Alembic migration scripts are intact.
"""
import inspect
import os


class TestHealth:
    def test_returns_ok(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json() == {"ok": True}


class TestAppImport:
    def test_app_importable(self):
        from app.main import app
        assert app is not None
        assert app.title == "ERIS React Native Prototype API"

    def test_check_migration_head_callable(self):
        from app.migrations_check import check_migration_head

        assert callable(check_migration_head)
        sig = inspect.signature(check_migration_head)
        required = [
            p for p in sig.parameters.values()
            if p.default is inspect.Parameter.empty
        ]
        assert len(required) == 0, "check_migration_head must take no required params"


class TestRouteRegistration:
    EXPECTED = {
        "/health",
        "/auth/login",
        "/submissions",
        "/incidents",
        "/gisa/lookups",
        "/arcgis/runtime-config",
        "/road-inventory/upload",
        "/road-inventory/manifest",
        "/road-inventory/lookup",
        "/road-inventory/import-jobs",
        "/road-inventory/import-jobs/{job_uuid}",
        "/road-inventory/versions/{dataset_version_id}/package",
        "/road-inventory/package",
    }

    def test_core_routes_registered(self):
        from app.main import app as eris_app

        registered = {r.path for r in eris_app.routes}
        missing = self.EXPECTED - registered
        assert not missing, f"Expected routes not registered: {missing}"


class TestAlembicScripts:
    @staticmethod
    def _script_dir():
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        backend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        cfg = Config(os.path.join(backend_dir, "alembic.ini"))
        cfg.set_main_option("script_location", os.path.join(backend_dir, "migrations"))
        return ScriptDirectory.from_config(cfg)

    def test_head_revision_exists(self):
        heads = self._script_dir().get_heads()
        assert heads, "No Alembic head revisions found in migration scripts"

    def test_package_type_is_head(self):
        heads = self._script_dir().get_heads()
        assert "0006_submission_gisa_ri_context" in heads, (
            f"0006_submission_gisa_ri_context not in heads: {heads}"
        )

    def test_baseline_in_chain(self):
        sd = self._script_dir()
        revisions = {r.revision for r in sd.walk_revisions()}
        assert "0001_baseline" in revisions, "0001_baseline missing from migration chain"
