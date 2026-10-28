"""Generate docs/data/erd.md and docs/data/schema-reference.md from a live,
fully migrated ERIS database, so the database documentation cannot drift.

The schema is database/init/010_schema.sql plus every Alembic migration, so
only a migrated database is authoritative. CI (.github/workflows/docs.yml)
builds one, runs this script and fails if the committed files differ.

    python scripts/docs/generate_schema_docs.py \
        --url mysql+pymysql://user:pass@127.0.0.1:3306/eris [--check]

Output is deterministic (sorted). Run it after any migration and commit the result.
"""
from __future__ import annotations

import argparse
import re
import sys
from collections import defaultdict
from pathlib import Path

from sqlalchemy import create_engine, inspect

ROOT = Path(__file__).resolve().parents[2]
ERD = ROOT / "docs" / "data" / "erd.md"
REFERENCE = ROOT / "docs" / "data" / "schema-reference.md"

# First matching rule wins. (domain, description, table-name patterns)
DOMAINS: list[tuple[str, str, list[str]]] = [
    ("Identity and access", "Accounts, roles, sessions, Entra links, first-admin marker.",
     [r"^users$", r"^roles$", r"^user_roles$", r"^user_sessions$", r"^user_external_identities$",
      r"^user_saved_layouts$", r"^deployment_bootstrap$", r"^role_consolidation_audit$"]),
    ("Organization", "GeoTech offices, branches, districts, coverage and where people sit.",
     [r"^org_", r"^geotech_office_routing$"]),
    ("Incidents", "Field reports, locations, routing, assignments and event groups.",
     [r"^incident(?!_notifications$)", r"^event_group"]),
    ("Assessments", "Technical assessments routed to Staff or Senior Specialists.",
     [r"^assessment"]),
    ("Submissions (GISA)", "The GISA technical form, its sharing, editors and workflow history.",
     [r"^submission", r"^workflow_events$"]),
    ("Attachments", "Photos and files (bytes in S3), capture metadata and corrections.",
     [r"^attachment"]),
    ("Notifications", "The notification feed, push devices and the email outbox.",
     [r"^user_notifications$", r"^push_devices$", r"^incident_notifications$", r"^email_", r"^notification"]),
    ("Maintenance workflows", "District maintenance work definitions and runs.",
     [r"^maintenance_"]),
    ("Projects", "Caltrans projects linked to incidents.",
     [r"^project", r"^caltrans_projects$"]),
    ("Road inventory", "Imported Caltrans road inventory datasets, segments and mobile packages.",
     [r"^road_"]),
    ("Terrain and offline scenes", "Terrain cross sections and offline 3D scene packages and jobs.",
     [r"^offline_scene", r"^terrain_"]),
]
OTHER = ("Other", "Tables not yet assigned to a domain (add a rule in generate_schema_docs.py).")
SKIP = {"alembic_version"}


def domain_of(table: str) -> str:
    for name, _description, patterns in DOMAINS:
        if any(re.search(pattern, table) for pattern in patterns):
            return name
    return OTHER[0]


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def mermaid_type(column_type: str) -> str:
    base = re.sub(r"\(.*", "", str(column_type)).strip().lower().split()[0]
    return re.sub(r"[^a-z0-9_]", "", base) or "value"


def table_comment(inspector, table: str) -> str:
    try:
        return (inspector.get_table_comment(table).get("text") or "").strip()
    except NotImplementedError:  # dialects without table comments (SQLite in tests)
        return ""


def collect(url: str) -> dict:
    engine = create_engine(url)
    inspector = inspect(engine)
    tables = {}
    for table in sorted(set(inspector.get_table_names()) - SKIP):
        pk = set(inspector.get_pk_constraint(table).get("constrained_columns") or [])
        fks = inspector.get_foreign_keys(table)
        fk_columns = {col for fk in fks for col in fk.get("constrained_columns", [])}
        uniques = inspector.get_unique_constraints(table)
        indexes = inspector.get_indexes(table)
        unique_columns = {u["column_names"][0] for u in uniques if len(u.get("column_names") or []) == 1}
        unique_columns |= {i["column_names"][0] for i in indexes if i.get("unique") and len(i.get("column_names") or []) == 1}
        columns = []
        for column in inspector.get_columns(table):
            keys = []
            if column["name"] in pk:
                keys.append("PK")
            if column["name"] in fk_columns:
                keys.append("FK")
            if column["name"] in unique_columns and column["name"] not in pk:
                keys.append("UK")
            default = column.get("default")
            columns.append({
                "name": column["name"],
                "type": str(column["type"]),
                "nullable": bool(column.get("nullable", True)),
                "default": None if default is None else str(default).strip("'"),
                "keys": keys,
                "comment": (column.get("comment") or "").strip(),
            })
        tables[table] = {
            "columns": columns,
            "foreign_keys": sorted(
                [{"columns": fk.get("constrained_columns", []), "ref_table": fk["referred_table"],
                  "ref_columns": fk.get("referred_columns", []),
                  "on_delete": (fk.get("options") or {}).get("ondelete")} for fk in fks],
                key=lambda fk: (fk["columns"], fk["ref_table"])),
            "unique": sorted([u.get("column_names") or [] for u in uniques]),
            "indexes": sorted([(i["name"], i.get("column_names") or [], bool(i.get("unique"))) for i in indexes],
                              key=lambda item: item[0] or ""),
            "comment": table_comment(inspector, table),
            "domain": domain_of(table),
        }
    return tables


def cardinality(table: dict, fk: dict) -> str:
    """Child }o--|| parent, or }o--o| when the reference is optional."""
    nullable = all(c["nullable"] for c in table["columns"] if c["name"] in fk["columns"])
    return "}o--o|" if nullable else "}o--||"


def render_erd(tables: dict) -> str:
    domains = [(name, description) for name, description, _ in DOMAINS] + [OTHER]
    by_domain = defaultdict(list)
    for name, table in tables.items():
        by_domain[table["domain"]].append(name)
    lines = [
        "# Database entity-relationship diagrams",
        "",
        "> **Generated** by `scripts/docs/generate_schema_docs.py` from a fully migrated database. "
        "Do not edit by hand; CI fails when this file is stale. Column-level detail is in the "
        "[schema reference](schema-reference.md).",
        "",
        f"ERIS has **{len(tables)} tables** in MariaDB. File bytes (photos, PDFs, terrain packages) are in "
        "S3 object storage; tables hold only their bucket and key. One diagram per domain follows; a table "
        "from another domain appears with its key only, so the links between domains stay visible.",
        "",
        "## How the domains connect",
        "",
        "```mermaid",
        "flowchart LR",
    ]
    links = defaultdict(int)
    for name, table in tables.items():
        for fk in table["foreign_keys"]:
            parent = tables.get(fk["ref_table"])
            if parent and parent["domain"] != table["domain"]:
                links[(table["domain"], parent["domain"])] += 1
    present = [d for d, _ in domains if by_domain.get(d)]
    for domain in present:
        lines.append(f'    {slug(domain).replace("-", "_")}["{domain}<br/>{len(by_domain[domain])} tables"]')
    for (child, parent), count in sorted(links.items()):
        lines.append(f'    {slug(child).replace("-", "_")} -->|{count} FK| {slug(parent).replace("-", "_")}')
    lines += ["```", "", "An arrow points from the domain holding the foreign key to the domain it references.", ""]
    lines += ["## Contents", ""]
    lines += [f"- [{d}](#{slug(d)}) ({len(by_domain[d])} tables)" for d in present]
    lines.append("")
    for domain, description in domains:
        names = sorted(by_domain.get(domain, []))
        if not names:
            continue
        lines += [f"## {domain}", "", description, "", "```mermaid", "erDiagram"]
        external = set()
        relations = []
        for name in names:
            for fk in tables[name]["foreign_keys"]:
                if fk["ref_table"] not in names:
                    external.add(fk["ref_table"])
                label = ",".join(fk["columns"])
                relations.append(f'    {fk["ref_table"]} ||--o{{ {name} : "{label}"'
                                 if cardinality(tables[name], fk) == "}o--||"
                                 else f'    {fk["ref_table"]} |o--o{{ {name} : "{label}"')
        for name in names:
            lines.append(f"    {name} {{")
            for column in tables[name]["columns"]:
                keys = ",".join(column["keys"])
                lines.append(f'        {mermaid_type(column["type"])} {column["name"]}{" " + keys if keys else ""}')
            lines.append("    }")
        for name in sorted(external):
            if name in tables:
                pk = [c for c in tables[name]["columns"] if "PK" in c["keys"]] or tables[name]["columns"][:1]
                lines.append(f"    {name} {{")
                for column in pk:
                    lines.append(f'        {mermaid_type(column["type"])} {column["name"]} PK')
                lines.append("    }")
        lines += sorted(set(relations))
        lines += ["```", ""]
    return "\n".join(lines).rstrip() + "\n"


def render_reference(tables: dict) -> str:
    lines = [
        "# Database schema reference",
        "",
        "> **Generated** by `scripts/docs/generate_schema_docs.py` from a fully migrated database. "
        "Do not edit by hand. Diagrams: [entity-relationship diagrams](erd.md).",
        "",
        "Keys: **PK** primary key, **FK** foreign key, **UK** unique.",
        "",
    ]
    for domain in [d for d, _, _ in DOMAINS] + [OTHER[0]]:
        names = sorted(n for n, t in tables.items() if t["domain"] == domain)
        if not names:
            continue
        lines += [f"## {domain}", ""]
        for name in names:
            table = tables[name]
            lines += [f"### `{name}`", ""]
            if table["comment"]:
                lines += [table["comment"], ""]
            lines += ["| Column | Type | Null | Default | Key |", "| --- | --- | --- | --- | --- |"]
            for column in table["columns"]:
                default = (column["default"] or "").replace("|", "\\|")
                lines.append(f'| `{column["name"]}` | {column["type"].lower()} | {"yes" if column["nullable"] else "no"} '
                             f'| {default} | {" ".join(column["keys"])} |')
            if table["foreign_keys"]:
                lines += ["", "References:", ""]
                for fk in table["foreign_keys"]:
                    on_delete = f' (on delete {fk["on_delete"].lower()})' if fk["on_delete"] else ""
                    lines.append(f'- `{", ".join(fk["columns"])}` → `{fk["ref_table"]}.{", ".join(fk["ref_columns"])}`{on_delete}')
            extra = [i for i in table["indexes"] if i[0]]
            if extra:
                lines += ["", "Indexes:", ""]
                for index_name, columns, unique in extra:
                    lines.append(f'- `{index_name}` on `{", ".join(columns)}`{" (unique)" if unique else ""}')
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", required=True, help="SQLAlchemy URL of a fully migrated ERIS database")
    parser.add_argument("--check", action="store_true", help="fail if the committed files differ")
    args = parser.parse_args()
    tables = collect(args.url)
    outputs = {ERD: render_erd(tables), REFERENCE: render_reference(tables)}
    stale = []
    for path, content in outputs.items():
        current = path.read_text(encoding="utf-8") if path.exists() else ""
        if current != content:
            stale.append(path)
            if not args.check:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8", newline="\n")
    others = sorted(n for n, t in tables.items() if t["domain"] == OTHER[0])
    if others:
        print(f"Tables without a domain rule: {', '.join(others)}", file=sys.stderr)
    if args.check and stale:
        print("Stale schema docs (run scripts/docs/generate_schema_docs.py and commit): "
              + ", ".join(str(p.relative_to(ROOT)) for p in stale), file=sys.stderr)
        return 1
    print(f"{len(tables)} tables; {'up to date' if not stale else 'written: ' + ', '.join(p.name for p in stale)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
