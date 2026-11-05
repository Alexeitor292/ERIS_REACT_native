"""One-off: move the 2026-10 docs into the audience-based layout and rewrite
every relative link that pointed at a moved file. Kept for the record."""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

MOVES = {
    "docs/architecture.md": "docs/architecture/README.md",
    "docs/workflows.md": "docs/architecture/workflows.md",
    "docs/offline-terrain.md": "docs/architecture/offline-terrain.md",
    "docs/storage-migration.md": "docs/data/storage-migration.md",
    "docs/roles-and-identity.md": "docs/security/roles-and-permissions.md",
    "docs/development.md": "docs/development/getting-started.md",
    "docs/ios-native-app.md": "docs/development/ios.md",
    "docs/caltrans-podman.md": "docs/operations/caltrans-podman.md",
    "docs/deployment.md": "docs/operations/compose-deployment.md",
    "docs/configuration.md": "docs/operations/configuration.md",
    "docs/offline-scene-package-operator-runbook.md": "docs/operations/offline-scene-packages.md",
    "docs/proxmox-caltrans-rehearsal.md": "docs/operations/history/proxmox-caltrans-rehearsal.md",
    "docs/proxmox-podman-cutover.md": "docs/operations/history/proxmox-podman-cutover.md",
    "docs/proxmox-stage-status.md": "docs/operations/history/proxmox-stage-status.md",
    "docs/organization.md": "docs/user-guides/administration.md",
    "docs/maintenance-workflows.md": "docs/user-guides/maintenance-workflows.md",
    "docs/caltrans-it-deployment-brief.md": "docs/caltrans/it-deployment-brief.md",
    "docs/caltrans-readiness-audit.md": "docs/caltrans/readiness-audit.md",
    "output/pdf/eris-caltrans-it-briefing.pdf": "docs/caltrans/eris-caltrans-it-briefing.pdf",
    "scripts/build_caltrans_it_briefing.py": "scripts/docs/build_it_briefing_pdf.py",
    "docker/docker-compose.yml": "deploy/compose/docker-compose.yml",
    "docker/docker-compose.proxmox.yml": "deploy/compose/docker-compose.proxmox.yml",
    "docker/.env.example": "deploy/compose/.env.example",
    "docker/.env.proxmox.example": "deploy/compose/.env.proxmox.example",
    "Jenkinsfile.podman": "deploy/ci/Jenkinsfile.podman",
}
DIR_MOVES = {"docker": "deploy/compose", "output/pdf": "docs/caltrans"}
LINK = re.compile(r"(\]\()([^)\s]+)(\))")
SKIP_DIRS = {"node_modules", ".git", ".venv", "dist", "build", ".build", "DerivedData"}


def tracked_files() -> list[str]:
    return subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()


def new_path(old: str) -> str:
    if old in MOVES:
        return MOVES[old]
    for src, dst in DIR_MOVES.items():
        if old == src or old.startswith(src + "/"):
            return dst + old[len(src):]
    return old


def rewrite_markdown(new_file: str, old_file: str, text: str) -> str:
    old_dir = os.path.dirname(old_file)
    new_dir = os.path.dirname(new_file)

    def fix(match: re.Match) -> str:
        target = match.group(2)
        if re.match(r"^[a-z]+:", target) or target.startswith("#") or target.startswith("/"):
            return match.group(0)
        path, _, anchor = target.partition("#")
        if not path:
            return match.group(0)
        resolved = os.path.normpath(os.path.join(old_dir, path)).replace("\\", "/")
        moved = new_path(resolved)
        relative = os.path.relpath(moved, new_dir or ".").replace("\\", "/")
        return f"{match.group(1)}{relative}{'#' + anchor if anchor else ''}{match.group(3)}"

    return LINK.sub(fix, text)


def main() -> int:
    files = tracked_files()
    renames = {f: new_path(f) for f in files if new_path(f) != f}
    for old, new in sorted(renames.items()):
        (ROOT / new).parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "mv", old, new], cwd=ROOT, check=True)
    inverse = {new: old for old, new in renames.items()}
    for path in subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split():
        if any(part in SKIP_DIRS for part in Path(path).parts):
            continue
        file = ROOT / path
        if path.endswith(".md"):
            text = file.read_text(encoding="utf-8")
            updated = rewrite_markdown(path, inverse.get(path, path), text)
        elif file.suffix in {".py", ".ts", ".tsx", ".sh", ".yml", ".yaml", ".js", ".ps1", ".example", ""} \
                or path.endswith(".env.example") or path.endswith("Jenkinsfile.podman"):
            try:
                text = file.read_text(encoding="utf-8")
            except (UnicodeDecodeError, IsADirectoryError):
                continue
            updated = text
            # Repository-root-relative mentions in code and config.
            for old, new in sorted(MOVES.items(), key=lambda item: -len(item[0])):
                updated = updated.replace(old, new)
        else:
            continue
        if updated != text:
            file.write_text(updated, encoding="utf-8", newline="")
            print("updated", path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
