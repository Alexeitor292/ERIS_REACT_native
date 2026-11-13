"""Bundle five verified CI image candidates and committed source for IT review."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

try:
    from .build_package import restricted
except ImportError:  # Direct script execution.
    from build_package import restricted

ROOT = Path(__file__).resolve().parents[2]
NAMES = ("api", "worker", "web", "mariadb", "seaweedfs")
SHA256 = re.compile(r"sha256:[a-f0-9]{64}")


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def inspect_archive(archive: Path, name: str, commit: str, identity: str) -> None:
    """Verify Docker-save config IDs and containerd OCI index IDs by content.

    An index entry alone is not evidence of identity: hash every reachable
    descriptor and connect the tagged image's config and layers to that graph.
    No archive member is extracted to the filesystem.
    """
    tag = f"localhost/eris/{name}:candidate"
    with tarfile.open(archive, "r:gz") as image:
        members = {}
        for member in image:
            if member.name in members:
                raise ValueError(f"{name}: duplicate archive member")
            members[member.name] = member

        def member_stream(path: str):
            member = members.get(path)
            if member is None or not member.isfile():
                raise ValueError(f"{name}: missing regular archive member {path}")
            return image.extractfile(member)

        def document(path: str) -> dict | list:
            # Config/index documents are small; layer blobs are hashed as streams.
            if path not in members or members[path].size > 16 * 1024 * 1024:
                raise ValueError(f"{name}: invalid archive metadata size")
            with member_stream(path) as stream:
                return json.load(stream)

        manifest = document("manifest.json")
        if len(manifest) != 1 or tag not in manifest[0]["RepoTags"]:
            raise ValueError(f"{name}: archive tag mismatch")
        config_path = manifest[0]["Config"]
        config = document(config_path)
        with member_stream(config_path) as stream:
            config_id = "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest()
        if config["config"]["Labels"]["org.opencontainers.image.revision"] != commit:
            raise ValueError(f"{name}: archive revision mismatch")
        if config.get("os") != "linux" or config.get("architecture") != "amd64":
            raise ValueError(f"{name}: archive must be linux/amd64")
        layer_paths = manifest[0]["Layers"]
        if "index.json" in members:
            index = document("index.json")
            roots = index["manifests"]
            if len(roots) != 1 or identity not in {roots[0]["digest"], config_id}:
                raise ValueError(f"{name}: archive image identity mismatch")
            declared_tag = roots[0].get("annotations", {}).get("io.containerd.image.name", tag)
            if declared_tag != tag:
                raise ValueError(f"{name}: archive OCI tag mismatch")
            verified = set()
            image_manifests = []

            def verify_descriptor(descriptor: dict, metadata: bool = False):
                value = descriptor["digest"]
                if not SHA256.fullmatch(value):
                    raise ValueError(f"{name}: unsupported archive blob digest")
                path = "blobs/sha256/" + value.split(":", 1)[1]
                member = members.get(path)
                if member is None or member.size != descriptor["size"]:
                    raise ValueError(f"{name}: archive blob size mismatch")
                if value not in verified:
                    with member_stream(path) as stream:
                        if "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest() != value:
                            raise ValueError(f"{name}: archive blob digest mismatch")
                    verified.add(value)
                if not metadata:
                    return
                item = document(path)
                if "manifests" in item:
                    for child in item["manifests"]:
                        verify_descriptor(child, metadata=True)
                elif "config" in item and "layers" in item:
                    verify_descriptor(item["config"])
                    for layer in item["layers"]:
                        verify_descriptor(layer)
                    image_manifests.append(item)
                else:
                    raise ValueError(f"{name}: invalid archive image manifest")

            verify_descriptor(roots[0], metadata=True)
            if not any(item["config"]["digest"] == config_id and
                       ["blobs/sha256/" + layer["digest"].split(":", 1)[1] for layer in item["layers"]] == layer_paths
                       for item in image_manifests):
                raise ValueError(f"{name}: tagged config/layers are absent from the verified index")
        else:
            if identity != config_id:
                raise ValueError(f"{name}: archive image identity mismatch")
            diff_ids = config["rootfs"]["diff_ids"]
            if len(layer_paths) != len(diff_ids):
                raise ValueError(f"{name}: archive layer count mismatch")
            for path, expected in zip(layer_paths, diff_ids):
                with member_stream(path) as stream:
                    if "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest() != expected:
                        raise ValueError(f"{name}: archive layer digest mismatch")


def inspect_candidate(folder: Path, name: str, commit: str) -> dict:
    """Reject stale/mixed reports, findings, or an archive of a different image."""
    for file in candidate_files(name):
        path = folder / file
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"{name}: candidate evidence must be regular files")
    if (folder / "source-commit.txt").read_text().strip() != commit:
        raise ValueError(f"{name}: source commit mismatch")
    identity = (folder / "image-id.txt").read_text().strip()
    if not SHA256.fullmatch(identity):
        raise ValueError(f"{name}: malformed image identity")
    report = json.loads((folder / "scan.json").read_text())
    metadata = report["Metadata"]
    if metadata["ImageID"] != identity:
        raise ValueError(f"{name}: report image identity mismatch")
    if not metadata.get("OS", {}).get("Family") or not any(
        result.get("Class") == "os-pkgs" and result.get("Type") for result in report.get("Results", [])
    ):
        raise ValueError(f"{name}: missing OS/package scan results")
    if metadata.get("OS", {}).get("EOSL"):
        raise ValueError(f"{name}: unsupported runtime OS")
    if metadata["ImageConfig"]["config"]["Labels"]["org.opencontainers.image.revision"] != commit:
        raise ValueError(f"{name}: report revision mismatch")
    for result in report["Results"]:
        if result.get("Vulnerabilities") or result.get("Secrets"):
            raise ValueError(f"{name}: vulnerability/secret gate has findings")
    sbom = json.loads((folder / "sbom.cdx.json").read_text())
    if sbom.get("bomFormat") != "CycloneDX" or not sbom.get("components"):
        raise ValueError(f"{name}: missing package SBOM")
    properties = {p["name"]: p["value"] for p in sbom.get("metadata", {}).get("component", {}).get("properties", [])}
    if (properties.get("aquasecurity:trivy:ImageID") != identity or
            properties.get("aquasecurity:trivy:Labels:org.opencontainers.image.revision") != commit):
        raise ValueError(f"{name}: SBOM identity/revision mismatch")
    archive = folder / f"{name}.tar.gz"
    inspect_archive(archive, name, commit, identity)
    return {"name": name, "image_id": identity, "created_at": report["CreatedAt"],
            "scanner": report.get("Trivy"), "os": metadata["OS"],
            "vulnerabilities": 0, "secrets": 0}


def candidate_files(name: str) -> tuple[str, ...]:
    return (f"{name}.tar.gz", "source-commit.txt", "image-id.txt", "scan.json", "sbom.cdx.json")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidates", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="New directory outside the repository")
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--rehearsal-log", type=Path, required=True)
    args = parser.parse_args()
    commit = args.source_commit
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        parser.error("A full Git commit is required")
    out = args.output.resolve()
    if out.exists() or out == ROOT or ROOT in out.parents:
        parser.error("Output must be a new directory outside the repository")
    checked_commit = subprocess.check_output(["git", "rev-parse", f"{commit}^{{commit}}"], cwd=ROOT, text=True).strip()
    if checked_commit != commit:
        parser.error("Source commit is not available")
    paths = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", "-z", commit], cwd=ROOT, text=True).split("\0")
    blocked = [path for path in paths if restricted(path)]
    if blocked:
        parser.error("Restricted tracked paths: " + ", ".join(blocked))
    log = args.rehearsal_log.read_text()
    if "PASS matched backup restored into fresh volumes:" not in log:
        parser.error("Successful five-image recovery evidence is required")
    records = [inspect_candidate(args.candidates / f"candidate-{name}", name, commit) for name in NAMES]
    out.mkdir(parents=True)
    for name in NAMES:
        destination = out / "images" / name
        destination.mkdir(parents=True)
        # Package only verified evidence. Unrelated files in the input directory
        # must never bring runtime env files or credentials into this artifact.
        for file in candidate_files(name):
            shutil.copyfile(args.candidates / f"candidate-{name}" / file, destination / file)
    shutil.copyfile(args.rehearsal_log, out / "rootless-rehearsal.log")
    source = out / f"ERIS-source-{commit[:12]}.zip"
    subprocess.run(["git", "archive", "--format=zip", "--prefix=ERIS/", f"--output={source}", commit], cwd=ROOT, check=True)
    manifest = {"format": "eris-image-handoff-candidate-v1", "source_commit": commit,
                "created_utc": datetime.now(timezone.utc).isoformat(), "images": records,
                "scope": "linux/amd64 image candidates and source; synthetic rootless recovery verified; agency configuration, signatures, identity/device acceptance and production approval remain required"}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (out / "START-HERE.txt").write_text(
        "ERIS image handoff candidate\nOwner: Deh Jeng Jang\n\n"
        f"Source commit: {commit}\nPlatform: linux/amd64\n"
        "Verify every entry with: sha256sum -c SHA256SUMS\n"
        "Extract ERIS-source-*.zip and read ERIS/docs/handover/image-package.md.\n"
        "Each images/<name>/ directory has its archive, exact image identity, scan and SBOM.\n"
        "On an isolated Linux test account, load each image with:\n"
        "  gzip -dc images/<name>/<name>.tar.gz | podman load\n"
        "Use the documented five-image rehearsal; runtime env files/keys/data are not included.\n\n"
        "These generic test builds contain no agency web map key or signed iOS IPA.\n"
        "Build the agency-configured web image, scan all final images again, then publish,\n"
        "sign and verify all five Harbor digests using deploy/ci/publish-release.sh.\n"
        "Do not disable the production signature/digest gates to deploy local candidate tags.\n"
        "Complete agency Entra, HTTPS, recovery and enrolled-iPhone acceptance before go-live.\n",
        encoding="utf-8")
    files = sorted(p for p in out.rglob("*") if p.is_file())
    (out / "SHA256SUMS").write_text("".join(f"{digest(p)}  {p.relative_to(out).as_posix()}\n" for p in files), encoding="utf-8")
    print(f"Created {out}: five clean image candidates, source and recovery evidence")


if __name__ == "__main__":
    main()
