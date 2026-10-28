"""Check every relative link and #anchor in the repository's Markdown files.

    python scripts/docs/check_links.py

Fails (exit 1) on a link to a missing file or a missing heading. External
(http/https/mailto) links are not fetched. Run by CI (.github/workflows/docs.yml).
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[2]
LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)|!\[[^\]]*\]\(([^)\s]+)\)")
FENCE = re.compile(r"^(```|~~~)")
SKIP = ("node_modules/", "mobile/android/", "mobile/ios/")


def slugify(heading: str) -> str:
    """GitHub's heading anchors."""
    text = re.sub(r"<[^>]+>", "", heading.strip().lower())
    text = re.sub(r"[`*_~\[\]()!'\"?,.:;/\\@#$%^&+={}|<>]", "", text)
    text = re.sub(r"[^\w\- ]", "", text)
    return text.replace(" ", "-")


def anchors(path: Path) -> set[str]:
    found: set[str] = set()
    counts: dict[str, int] = {}
    in_fence = False
    for line in path.read_text(encoding="utf-8").splitlines():
        if FENCE.match(line.strip()):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        heading = re.match(r"^#{1,6}\s+(.*?)\s*#*\s*$", line)
        if heading:
            slug = slugify(heading.group(1))
            count = counts.get(slug, 0)
            found.add(slug if count == 0 else f"{slug}-{count}")
            counts[slug] = count + 1
        for anchor in re.findall(r'<a\s+(?:name|id)="([^"]+)"', line):
            found.add(anchor)
    return found


def markdown_files() -> list[Path]:
    listed = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "*.md"],
                            cwd=ROOT, capture_output=True, text=True, check=True).stdout.split("\n")
    return [ROOT / p for p in listed if p and not p.startswith(SKIP) and (ROOT / p).exists()]


def main() -> int:
    problems: list[str] = []
    cache: dict[Path, set[str]] = {}
    for file in markdown_files():
        in_fence = False
        for number, line in enumerate(file.read_text(encoding="utf-8").splitlines(), 1):
            if FENCE.match(line.strip()):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            line = re.sub(r"`[^`]*`", "", line)
            for match in LINK.finditer(line):
                target = match.group(1) or match.group(2)
                if re.match(r"^[a-z][a-z0-9+.-]*:", target):
                    continue
                path_part, _, anchor = target.partition("#")
                destination = file if not path_part else (file.parent / unquote(path_part)).resolve()
                where = f"{file.relative_to(ROOT)}:{number}"
                if not destination.exists():
                    problems.append(f"{where}: missing {target}")
                    continue
                if anchor and destination.suffix == ".md":
                    found = cache.setdefault(destination, anchors(destination))
                    if anchor not in found:
                        problems.append(f"{where}: no heading #{anchor} in {destination.relative_to(ROOT)}")
    for problem in problems:
        print(problem)
    print(f"{len(problems)} broken link(s) in {len(markdown_files())} Markdown files")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
