"""Create a committed-source handoff archive; runtime secrets/backups travel separately."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import zipfile


ROOT = Path(__file__).resolve().parents[2]


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def restricted(path: str) -> bool:
    p = PurePosixPath(path)
    return (
        (p.name.startswith(".env") and not p.name.endswith(".example"))
        or (p.suffix == ".env" and not p.name.endswith(".example"))
        or p.suffix.lower() in {".key", ".pem", ".p8", ".p12", ".pfx", ".mobileprovision"}
        or "secrets" in p.parts
        or "backups" in p.parts
        or ".venv" in p.parts
        or "node_modules" in p.parts
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="New directory outside the repository")
    parser.add_argument("--include-history", action="store_true", help="Include a separately checksummed Git bundle of all refs; scan history for secrets first")
    args = parser.parse_args()
    out = args.output.resolve()
    if out == ROOT or ROOT in out.parents:
        parser.error("Output must be outside the repository")
    if out.exists():
        parser.error("Output already exists; choose a new directory")
    if git("status", "--porcelain", "--untracked-files=normal"):
        parser.error("Commit or resolve all source changes first; the package exports HEAD only")
    commit = git("rev-parse", "HEAD")
    paths = git("ls-tree", "-r", "--name-only", commit).splitlines()
    blocked = [p for p in paths if restricted(p)]
    if blocked:
        parser.error("Restricted tracked paths: " + ", ".join(blocked))
    out.mkdir(parents=True)
    archive = out / f"ERIS-source-{commit[:12]}.zip"
    subprocess.run(["git", "archive", "--format=zip", "--prefix=ERIS/",
                    f"--output={archive}", commit], cwd=ROOT, check=True)
    with zipfile.ZipFile(archive) as z:
        bad = z.testzip()
        if bad:
            raise RuntimeError(f"Archive CRC check failed: {bad}")
        files = [{"path": n, "sha256": hashlib.sha256(z.read(n)).hexdigest()}
                 for n in z.namelist() if not n.endswith("/")]
    with archive.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    manifest = {
        "format": "eris-source-handoff-v1",
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "source_commit": commit,
        "branch": git("branch", "--show-current"),
        "archive": archive.name,
        "archive_sha256": digest,
        "files": files,
        "scope": "Committed source and documentation; no Git history, runtime configuration, data or deployment approval",
    }
    sums = [f"{digest}  {archive.name}\n"]
    if args.include_history:
        bundle = out / "ERIS-history.bundle"
        subprocess.run(["git", "bundle", "create", str(bundle), "--all"], cwd=ROOT, check=True)
        subprocess.run(["git", "bundle", "verify", str(bundle)], cwd=ROOT, check=True,
                       stdout=subprocess.DEVNULL)
        with bundle.open("rb") as source:
            bundle_digest = hashlib.file_digest(source, "sha256").hexdigest()
        manifest["git_bundle"] = {"name": bundle.name, "sha256": bundle_digest}
        sums.append(f"{bundle_digest}  {bundle.name}\n")
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (out / "SHA256SUMS").write_text(
        "".join(sums) +
        f"{hashlib.sha256((out / 'manifest.json').read_bytes()).hexdigest()}  manifest.json\n",
        encoding="utf-8")
    (out / "START-HERE.txt").write_text(
        "ERIS handoff package\nOwner: Deh Jeng Jang\n\n"
        f"Source commit: {commit}\nVerify SHA256SUMS before extracting.\n"
        "Read ERIS/docs/handover/README.md, environment-setup.md, open-work.md,\n"
        "server-transfer.md and acceptance.md. Security findings are in ERIS/docs/security/.\n\n"
        "This is a source snapshot, not an operational backup or production approval.\n"
        "If included, ERIS-history.bundle contains Git history/refs; clone its named branch.\n"
        "Obtain agency repository access for collaboration and future development.\n"
        "Obtain secrets, matched DB/object backups, images and host configuration\n"
        "through the approved secure handoff channel (server-transfer.md).\n"
        "Caltrans IT hosting and acceptance remain required.\n", encoding="utf-8")
    print(f"Created {archive} ({len(files)} files)\nSHA256 {digest}")


if __name__ == "__main__":
    main()
