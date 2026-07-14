"""Contract: every Compose service named in the operator runbook must actually exist.

PR #50 review caught the diagnostic commands telling operators to
`docker compose exec -T worker ...` — there is NO service called `worker`; the packaging
worker is `offline-scene-worker`. Every one of those commands would have failed in the
field. This test parses the REAL service names out of the Compose files and holds the
runbook to them, so the docs cannot drift from the deployment again.

Dependency-free on purpose: PyYAML is only a transitive dep of the backend, so the
service keys are read straight out of the Compose files' top-level `services:` block.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
COMPOSE_FILES = [REPO / "docker" / "docker-compose.yml", REPO / "docker" / "docker-compose.proxmox.yml"]
RUNBOOK = REPO / "docs" / "offline-scene-package-operator-runbook.md"
ADR = REPO / "docs" / "adr-offline-road-context-source.md"

WORKER_SERVICE = "offline-scene-worker"
# The service name the review found in the runbook. It does not exist.
PHANTOM_SERVICE = "worker"

# `docker compose <verb> [flags...] <service>` for the verbs that name a service.
SERVICE_VERBS = ("exec", "cp", "build", "up", "run", "restart", "logs", "pull", "scale")


def compose_service_names() -> set[str]:
    """Top-level keys of the `services:` block across the Compose files."""
    names: set[str] = set()
    for f in COMPOSE_FILES:
        in_services = False
        for line in f.read_text(encoding="utf-8").splitlines():
            if re.match(r"^services:\s*$", line):
                in_services = True
                continue
            if in_services:
                if re.match(r"^\S", line):          # a new top-level key ends the block
                    in_services = False
                    continue
                m = re.match(r"^  ([A-Za-z0-9._-]+):\s*$", line)
                if m:
                    names.add(m.group(1))
    return names


def code_blocks(md: Path) -> list[str]:
    return re.findall(r"```(?:sh|bash)?\n(.*?)```", md.read_text(encoding="utf-8"), re.S)


def compose_commands(md: Path) -> list[str]:
    """Every shell line in the doc that invokes docker compose (directly or via `$C`)."""
    out = []
    for block in code_blocks(md):
        for raw in block.splitlines():
            line = raw.strip()
            if line.startswith("#") or not line:
                continue
            if line.startswith("$C ") or "docker compose" in line:
                out.append(line)
    return out


class TestComposeServicesAreReal:
    def test_offline_scene_worker_exists_and_worker_does_not(self):
        names = compose_service_names()
        assert WORKER_SERVICE in names, f"expected {WORKER_SERVICE!r} in Compose services: {sorted(names)}"
        # The whole point: the short name is NOT a service. If someone ever adds it, this
        # test should be revisited deliberately rather than the docs quietly becoming right.
        assert PHANTOM_SERVICE not in names
        assert {"backend", "mariadb", "minio"} <= names   # sanity: we parsed a real block

    @pytest.mark.parametrize("doc", [RUNBOOK, ADR], ids=["runbook", "adr"])
    def test_no_doc_command_uses_the_phantom_worker_service(self, doc: Path):
        """No `docker compose <verb> ... worker ...` anywhere in the docs."""
        bad = []
        for line in compose_commands(doc):
            for verb in SERVICE_VERBS:
                # `exec -T worker`, `cp file worker:/tmp/x`, `build worker`, ...
                if re.search(rf"\b{verb}\b[^|]*?(?<![\w-])worker(?![\w-])", line):
                    bad.append(line)
        assert not bad, (
            "doc commands name the nonexistent Compose service 'worker' "
            f"(use '{WORKER_SERVICE}'):\n  " + "\n  ".join(bad)
        )

    def test_runbook_diagnostic_commands_use_the_real_worker_service(self):
        """The alignment-diagnostic section must drive the real packaging worker."""
        text = RUNBOOK.read_text(encoding="utf-8")
        assert "app.tools.offline_scene_alignment" in text, "diagnostic section missing"
        diag = [c for c in compose_commands(RUNBOOK)
                if "offline_scene_alignment" in c or "road-imagery-alignment" in c
                or "package.eristerrain" in c]
        assert diag, "no Compose commands found in the diagnostic section"
        # Every service-naming diagnostic command targets offline-scene-worker.
        targeted = [c for c in diag if any(re.search(rf"\b{v}\b", c) for v in ("exec", "cp"))]
        assert targeted, "diagnostic section runs nothing in a container"
        for c in targeted:
            assert WORKER_SERVICE in c, f"diagnostic command does not use {WORKER_SERVICE}: {c}"

    def test_every_service_named_in_doc_commands_actually_exists(self):
        """Catch ANY drifted service name, not just 'worker'."""
        names = compose_service_names()
        unknown = []
        for doc in (RUNBOOK, ADR):
            for line in compose_commands(doc):
                # `$C exec -T <svc>` / `$C cp src <svc>:/path` / `$C build <svc>`
                for m in re.finditer(r"\b(?:exec|cp|build|up|restart|logs)\b((?:\s+-\S+)*)\s+(\S+)", line):
                    tok = m.group(2).split(":")[0]
                    if not re.fullmatch(r"[a-z][a-z0-9._-]*", tok):
                        continue          # a path, flag value, or shell token — not a service
                    if tok in {"local", "python", "cat", "sh", "-d", "mariadb"}:
                        continue          # mariadb IS a service, but also a client binary
                    if tok not in names and "/" not in tok and "." not in tok:
                        unknown.append((doc.name, tok, line))
        assert not unknown, "doc commands reference unknown Compose services: " + str(unknown)
