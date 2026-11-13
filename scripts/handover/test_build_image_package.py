"""Small real tar fixtures exercise the handoff archive's trust boundaries."""
from __future__ import annotations

import hashlib
import io
import json
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

try:
    from . import build_image_package as package
except ImportError:
    import build_image_package as package


COMMIT = "a" * 40
OTHER = "b" * 40


def encoded(value):
    return json.dumps(value, sort_keys=True).encode()


def identity(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def blob_path(value):
    return "blobs/sha256/" + value.split(":", 1)[1]


class ImagePackageTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.folder = Path(self.work.name) / "candidate-api"
        self.folder.mkdir()

    def candidate(self, mode="oci", archive_revision=COMMIT):
        name = self.folder.name.removeprefix("candidate-")
        tag = f"localhost/eris/{name}:candidate"
        layer = b"a tiny synthetic image layer\n"
        config = encoded({"architecture": "amd64", "os": "linux",
                          "config": {"Labels": {"org.opencontainers.image.revision": archive_revision}},
                          "rootfs": {"type": "layers", "diff_ids": [identity(layer)]}})
        config_id = identity(config)
        config_path = blob_path(config_id) if mode == "oci" else config_id[7:] + ".json"
        layer_path = blob_path(identity(layer)) if mode == "oci" else "layer/layer.tar"
        self.members = {config_path: config, layer_path: layer}
        manifest = [{"Config": config_path, "RepoTags": [tag], "Layers": [layer_path]}]
        self.members["manifest.json"] = encoded(manifest)
        if mode == "oci":
            def descriptor(data, media_type):
                value = identity(data)
                self.members[blob_path(value)] = data
                return {"digest": value, "size": len(data), "mediaType": media_type}

            image_manifest = encoded({"schemaVersion": 2,
                                      "config": descriptor(config, "application/vnd.oci.image.config.v1+json"),
                                      "layers": [descriptor(layer, "application/vnd.oci.image.layer.v1.tar")]})
            arch = descriptor(image_manifest, "application/vnd.oci.image.manifest.v1+json")
            arch["platform"] = {"os": "linux", "architecture": "amd64"}
            # Match Docker/containerd's nested index rather than accepting an
            # unverified digest string in the outer index.
            index_blob = encoded({"schemaVersion": 2, "manifests": [arch]})
            root = descriptor(index_blob, "application/vnd.oci.image.index.v1+json")
            root["annotations"] = {"io.containerd.image.name": tag}
            self.members["index.json"] = encoded({"schemaVersion": 2, "manifests": [root]})
            image_id = root["digest"]
        else:
            image_id = config_id
        self.layer_path = layer_path
        self.write_archive()
        (self.folder / "source-commit.txt").write_text(COMMIT)
        (self.folder / "image-id.txt").write_text(image_id)
        self.report = {"CreatedAt": "2026-11-13T12:00:00Z", "Metadata": {
            "ImageID": image_id, "OS": {"Family": "alpine", "Name": "3.24.3"},
            "ImageConfig": {"config": {"Labels": {"org.opencontainers.image.revision": COMMIT}}}},
            "Results": [{"Target": "api (alpine 3.24.3)", "Class": "os-pkgs", "Type": "alpine"}]}
        self.sbom = {"bomFormat": "CycloneDX", "components": [{"name": "synthetic-package"}],
                     "metadata": {"component": {"properties": [
                         {"name": "aquasecurity:trivy:ImageID", "value": image_id},
                         {"name": "aquasecurity:trivy:Labels:org.opencontainers.image.revision", "value": COMMIT}]}}}
        self.write_reports()

    def write_archive(self):
        name = self.folder.name.removeprefix("candidate-")
        with tarfile.open(self.folder / f"{name}.tar.gz", "w:gz") as image:
            for path, data in self.members.items():
                member = tarfile.TarInfo(path)
                member.size = len(data)
                image.addfile(member, io.BytesIO(data))

    def write_reports(self):
        (self.folder / "scan.json").write_text(json.dumps(self.report))
        (self.folder / "sbom.cdx.json").write_text(json.dumps(self.sbom))

    def inspect(self):
        return package.inspect_candidate(self.folder, "api", COMMIT)

    def test_clean_nested_oci_archive_is_accepted(self):
        self.candidate()
        result = self.inspect()
        self.assertEqual(result["name"], "api")
        self.assertEqual(result["vulnerabilities"], 0)
        self.assertEqual(result["secrets"], 0)

    def test_clean_classic_docker_archive_is_accepted(self):
        self.candidate(mode="classic")
        self.assertEqual(self.inspect()["image_id"], (self.folder / "image-id.txt").read_text())

    def test_mixed_source_commit_is_rejected(self):
        self.candidate()
        (self.folder / "source-commit.txt").write_text(OTHER)
        with self.assertRaisesRegex(ValueError, "source commit mismatch"):
            self.inspect()

    def test_report_identity_and_revision_are_bound_to_candidate(self):
        for field in ("identity", "revision"):
            with self.subTest(field=field):
                self.candidate()
                if field == "identity":
                    self.report["Metadata"]["ImageID"] = "sha256:" + "c" * 64
                else:
                    self.report["Metadata"]["ImageConfig"]["config"]["Labels"]["org.opencontainers.image.revision"] = OTHER
                self.write_reports()
                with self.assertRaisesRegex(ValueError, "report .* mismatch"):
                    self.inspect()

    def test_any_vulnerability_or_embedded_secret_is_rejected(self):
        for field, finding in (("Vulnerabilities", {"VulnerabilityID": "CVE-synthetic", "Severity": "LOW"}),
                               ("Secrets", {"RuleID": "synthetic-secret", "Severity": "HIGH"})):
            with self.subTest(field=field):
                self.candidate()
                self.report["Results"][0][field] = [finding]
                self.write_reports()
                with self.assertRaisesRegex(ValueError, "gate has findings"):
                    self.inspect()

    def test_missing_package_scan_and_unsupported_os_are_rejected(self):
        for field in ("scan", "eosl"):
            with self.subTest(field=field):
                self.candidate()
                if field == "scan":
                    self.report["Results"] = [{"Target": "unrelated text file"}]
                else:
                    self.report["Metadata"]["OS"]["EOSL"] = True
                self.write_reports()
                with self.assertRaisesRegex(ValueError, "missing OS/package|unsupported runtime OS"):
                    self.inspect()

    def test_mixed_sbom_is_rejected(self):
        self.candidate()
        self.sbom["metadata"]["component"]["properties"][0]["value"] = "sha256:" + "c" * 64
        self.write_reports()
        with self.assertRaisesRegex(ValueError, "SBOM identity/revision mismatch"):
            self.inspect()

    def test_archive_revision_mismatch_is_rejected(self):
        self.candidate(archive_revision=OTHER)
        with self.assertRaisesRegex(ValueError, "archive revision mismatch"):
            self.inspect()

    def test_wrong_tag_is_rejected(self):
        self.candidate()
        manifest = json.loads(self.members["manifest.json"])
        manifest[0]["RepoTags"] = ["localhost/eris/wrong:candidate"]
        self.members["manifest.json"] = encoded(manifest)
        self.write_archive()
        with self.assertRaisesRegex(ValueError, "archive tag mismatch"):
            self.inspect()

    def test_forged_index_digest_is_rejected(self):
        self.candidate()
        index = json.loads(self.members["index.json"])
        old = index["manifests"][0]["digest"]
        forged = "sha256:" + "c" * 64
        self.members[blob_path(forged)] = self.members.pop(blob_path(old))
        index["manifests"][0]["digest"] = forged
        self.members["index.json"] = encoded(index)
        (self.folder / "image-id.txt").write_text(forged)
        self.report["Metadata"]["ImageID"] = forged
        self.sbom["metadata"]["component"]["properties"][0]["value"] = forged
        self.write_reports()
        self.write_archive()
        with self.assertRaisesRegex(ValueError, "archive blob digest mismatch"):
            self.inspect()

    def test_modified_or_missing_layer_is_rejected(self):
        for mode in ("oci", "classic"):
            for action in ("modify", "remove"):
                with self.subTest(mode=mode, action=action):
                    self.candidate(mode=mode)
                    if action == "modify":
                        self.members[self.layer_path] = b"X" + self.members[self.layer_path][1:]
                    else:
                        del self.members[self.layer_path]
                    self.write_archive()
                    with self.assertRaisesRegex(ValueError, "archive (blob|layer)|missing regular archive"):
                        self.inspect()

    def test_restricted_tracked_source_is_refused_before_output(self):
        output = Path(self.work.name) / "output"
        argv = ["build_image_package.py", "--candidates", self.work.name,
                "--output", str(output), "--source-commit", COMMIT,
                "--rehearsal-log", str(Path(self.work.name) / "not-read"),
                "--signature-log", str(Path(self.work.name) / "not-read-signature"),
                "--database-evidence", str(Path(self.work.name) / "not-read-database")]
        with patch("sys.argv", argv), patch.object(package.subprocess, "check_output", side_effect=[COMMIT, "backend/.env\0"]), redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as failure:
                package.main()
        self.assertEqual(failure.exception.code, 2)
        self.assertFalse(output.exists())

    def test_package_contains_only_five_verified_candidates_and_checksums(self):
        for name in package.NAMES:
            self.folder = Path(self.work.name) / f"candidate-{name}"
            self.folder.mkdir(exist_ok=True)
            self.candidate()
            (self.folder / "runtime.env").write_text("DISPOSABLE=must-not-be-packaged")
        output = Path(self.work.name) / "output"
        log = Path(self.work.name) / "rehearsal.log"
        log.write_text(package.RECOVERY_MARKER + "\n")
        signature_log = Path(self.work.name) / "signature.log"
        signature_log.write_text(package.SIGNATURE_MARKER + "\n")
        db_id = (Path(self.work.name) / "candidate-mariadb" / "image-id.txt").read_text()
        database = self.database_evidence(db_id)
        argv = ["build_image_package.py", "--candidates", self.work.name,
                "--output", str(output), "--source-commit", COMMIT, "--rehearsal-log", str(log),
                "--signature-log", str(signature_log), "--database-evidence", str(database)]

        def export_source(command, **kwargs):
            self.assertEqual(command[:2], ["git", "archive"])
            destination = next(value.removeprefix("--output=") for value in command if value.startswith("--output="))
            Path(destination).write_bytes(b"synthetic committed source archive")

        with patch("sys.argv", argv), patch.object(package.subprocess, "check_output", side_effect=[COMMIT, "README.md\0"]), patch.object(package.subprocess, "run", side_effect=export_source), redirect_stdout(io.StringIO()):
            package.main()
        manifest = json.loads((output / "manifest.json").read_text())
        self.assertEqual([record["name"] for record in manifest["images"]], list(package.NAMES))
        self.assertEqual(manifest["source_commit"], COMMIT)
        self.assertEqual(manifest["database_integration"]["executed"], 2)
        self.assertEqual((output / "database-integration" / "candidate-db.xml").read_bytes(), (database / "candidate-db.xml").read_bytes())
        self.assertEqual((output / "signature-rehearsal.log").read_text(), signature_log.read_text())
        for name in package.NAMES:
            self.assertEqual({path.name for path in (output / "images" / name).iterdir()}, set(package.candidate_files(name)))
        lines = (output / "SHA256SUMS").read_text().splitlines()
        self.assertEqual(len(lines), len([p for p in output.rglob("*") if p.is_file()]) - 1)
        for line in lines:
            expected, relative = line.split("  ", 1)
            self.assertEqual(package.digest(output / relative), expected)

    def test_missing_or_incomplete_signature_evidence_is_refused(self):
        output = Path(self.work.name) / "output"
        recovery = Path(self.work.name) / "recovery.log"
        recovery.write_text(package.RECOVERY_MARKER + "\n")
        signature = Path(self.work.name) / "signature.log"
        argv = ["build_image_package.py", "--candidates", self.work.name, "--output", str(output),
                "--source-commit", COMMIT, "--rehearsal-log", str(recovery), "--signature-log", str(signature),
                "--database-evidence", str(Path(self.work.name) / "not-read-database")]
        for content in (None, "FAIL signature enforcement\n", "prefix " + package.SIGNATURE_MARKER + "\n"):
            with self.subTest(content=content):
                if content is not None:
                    signature.write_text(content)
                with patch("sys.argv", argv), patch.object(package.subprocess, "check_output", side_effect=[COMMIT, "README.md\0"]), redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit) as failure:
                        package.main()
                self.assertEqual(failure.exception.code, 2)
                self.assertFalse(output.exists())

    def test_failed_or_prefixed_recovery_log_is_refused(self):
        output = Path(self.work.name) / "output"
        recovery = Path(self.work.name) / "recovery.log"
        argv = ["build_image_package.py", "--candidates", self.work.name, "--output", str(output),
                "--source-commit", COMMIT, "--rehearsal-log", str(recovery),
                "--signature-log", str(Path(self.work.name) / "not-read-signature"),
                "--database-evidence", str(Path(self.work.name) / "not-read-database")]
        for content in ("", "FAIL did not reach marker: " + package.RECOVERY_MARKER, "prefix " + package.RECOVERY_MARKER):
            with self.subTest(content=content):
                recovery.write_text(content + "\n")
                with patch("sys.argv", argv), patch.object(package.subprocess, "check_output", side_effect=[COMMIT, "README.md\0"]), redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit) as failure:
                        package.main()
                self.assertEqual(failure.exception.code, 2)
                self.assertFalse(output.exists())

    def database_evidence(self, image_id="sha256:" + "c" * 64):
        folder = Path(self.work.name) / "database"
        folder.mkdir(exist_ok=True)
        (folder / "candidate-db.log").write_text(f"progress: \u2581\nCandidate MariaDB source: {COMMIT}\nCandidate MariaDB image: {image_id}\n{package.DATABASE_MARKER}\n", encoding="utf-8")
        (folder / "candidate-db.xml").write_text('<testsuites><testsuite tests="2" errors="0" failures="0" skipped="0" /></testsuites>')
        return folder

    def test_failed_empty_and_all_skipped_db_reports_are_rejected(self):
        folder = self.database_evidence()
        for tests, errors, failures, skipped in ((2, 1, 0, 0), (2, 0, 1, 0), (0, 0, 0, 0), (2, 0, 0, 2)):
            with self.subTest(tests=tests, errors=errors, failures=failures, skipped=skipped):
                (folder / "candidate-db.xml").write_text(f'<testsuites><testsuite tests="{tests}" errors="{errors}" failures="{failures}" skipped="{skipped}" /></testsuites>')
                with self.assertRaisesRegex(ValueError, "JUnit report"):
                    package.inspect_database_evidence(folder, COMMIT, "sha256:" + "c" * 64)

    def test_db_report_requires_matching_source_and_image_markers(self):
        folder = self.database_evidence()
        for commit, image in ((OTHER, "sha256:" + "c" * 64), (COMMIT, "sha256:" + "d" * 64)):
            with self.subTest(commit=commit, image=image):
                with self.assertRaisesRegex(ValueError, "matching source/image/success"):
                    package.inspect_database_evidence(folder, commit, image)


if __name__ == "__main__":
    unittest.main()
