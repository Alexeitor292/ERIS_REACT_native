"""web/nginx.conf: every response carries the browser security headers.

nginx drops the server-level add_header directives in any location that has
add_header of its own, so each such location must repeat them all. This test
fails if a location adds a header and forgets the rest.
"""
import re
from pathlib import Path

NGINX = Path(__file__).resolve().parents[2] / "web" / "nginx.conf"
SECURITY_HEADERS = {
    "X-Content-Type-Options",
    "Referrer-Policy",
    "X-Frame-Options",
    "Content-Security-Policy",
    "Content-Security-Policy-Report-Only",
    "Permissions-Policy",
    "Cross-Origin-Opener-Policy",
}


def _blocks(text: str) -> tuple[str, dict[str, str]]:
    """The server-level directives and each location's body."""
    locations: dict[str, str] = {}
    server = []
    depth = 0
    current = None
    for line in text.splitlines():
        stripped = line.split("#", 1)[0].strip()
        if depth == 1 and stripped.startswith("location"):
            current = stripped.rstrip("{").strip()
            locations[current] = ""
        elif depth == 1 and current is None:
            server.append(stripped)
        elif current is not None:
            locations[current] += stripped + "\n"
        depth += stripped.count("{") - stripped.count("}")
        if depth == 1 and stripped == "}":
            current = None
    return "\n".join(server), locations


def _headers(body: str) -> set[str]:
    return set(re.findall(r"^add_header\s+([A-Za-z-]+)", body, re.M))


def test_the_server_sends_every_security_header():
    server, _ = _blocks(NGINX.read_text(encoding="utf-8"))
    assert SECURITY_HEADERS <= _headers(server)


def test_locations_with_their_own_headers_repeat_the_security_headers():
    _, locations = _blocks(NGINX.read_text(encoding="utf-8"))
    checked = 0
    for name, body in locations.items():
        own = _headers(body)
        if not own or "return 200" in body:  # /healthz: a plain-text probe
            continue
        checked += 1
        missing = SECURITY_HEADERS - own
        assert not missing, f"{name} drops {sorted(missing)}"
    assert checked, "expected at least the /index.html location"


def test_the_full_policy_keeps_scripts_to_this_site():
    text = NGINX.read_text(encoding="utf-8")
    policy = re.search(r'set \$eris_csp_report_only "([^"]+)"', text).group(1)
    directives = dict(part.strip().split(" ", 1) for part in policy.split(";"))
    assert directives["script-src"].split() == ["'self'", "'wasm-unsafe-eval'"]
    assert directives["object-src"] == "'none'"
    assert directives["base-uri"] == "'self'"
    assert directives["frame-ancestors"] == "'self'"
