from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected exactly one {label}; found {count}")
    return text.replace(old, new, 1)


# main.py: mount Projects router.
path = Path("backend/app/main.py")
text = path.read_text(encoding="utf-8")
text = replace_once(
    text,
    'from .routes.incidents import router as incidents_router\n',
    'from .routes.incidents import router as incidents_router\nfrom .routes.projects import router as projects_router\n',
    "projects router import",
)
text = replace_once(
    text,
    'app.include_router(incidents_router)\n',
    'app.include_router(incidents_router)\napp.include_router(projects_router)\n',
    "projects router include",
)
path.write_text(text, encoding="utf-8")


# incidents.py: expose Project context and make intake unclassified.
path = Path("backend/app/routes/incidents.py")
text = path.read_text(encoding="utf-8")

text = replace_once(
    text,
    '              i.id, i.title, i.incident_type, i.description,\n',
    '              i.id, i.project_id, p.title AS project_title, p.status AS project_status, i.title, i.incident_type, i.description,\n',
    "incident detail select project columns",
)
text = replace_once(
    text,
    '            FROM incidents i\n            LEFT JOIN incident_assignments a\n',
    '            FROM incidents i\n            LEFT JOIN projects p ON p.id = i.project_id\n            LEFT JOIN incident_assignments a\n',
    "incident detail project join",
)
text = replace_once(
    text,
    '              i.id, i.title, i.incident_type, i.description,\n',
    '              i.id, i.project_id, p.title AS project_title, p.status AS project_status, i.title, i.incident_type, i.description,\n',
    "incident list select project columns",
)
text = replace_once(
    text,
    '            FROM incidents i\n            LEFT JOIN incident_assignments a\n',
    '            FROM incidents i\n            LEFT JOIN projects p ON p.id = i.project_id\n            LEFT JOIN incident_assignments a\n',
    "incident list project join",
)
text = replace_once(
    text,
    '        "id": int(row["id"]),\n        "title": row["title"],\n',
    '        "id": int(row["id"]),\n        "project_id": int(row["project_id"]) if row.get("project_id") is not None else None,\n        "project_title": row.get("project_title"),\n        "project_status": row.get("project_status"),\n        "title": row["title"],\n',
    "incident serializer project fields",
)

# New incidents must be unclassified regardless of a legacy client payload.
text = replace_once(
    text,
    '                :title, :incident_type, :description, NULL, \'PENDING_REVIEW\', :lat, :lon,\n',
    '                :title, NULL, :description, NULL, \'PENDING_REVIEW\', :lat, :lon,\n',
    "incident create unclassified value",
)
text = replace_once(
    text,
    '                "incident_type": (payload.incident_type or "").strip() or None,\n',
    '',
    "incident create type parameter",
)

# Maintenance revision must not classify/reclassify the incident.
text = replace_once(
    text,
    '                    incident_type = :incident_type,\n',
    '',
    "maintenance revision incident type update",
)
text = replace_once(
    text,
    '                "incident_type": (payload.incident_type or "").strip() or None,\n',
    '',
    "maintenance revision incident type parameter",
)

# Direct engineer assignment fails before the DB trigger with a clear Project error.
text = replace_once(
    text,
    '    if str(incident["status"]).upper() == "RESOLVED":\n        raise HTTPException(status_code=409, detail="Resolved incidents cannot be reassigned")\n    if require_unclaimed and incident["assignee_user_id"] is not None and int(incident["assignee_user_id"]) != assignee_user_id:\n',
    '    if str(incident["status"]).upper() == "RESOLVED":\n        raise HTTPException(status_code=409, detail="Resolved incidents cannot be reassigned")\n    if incident.get("project_id") is None:\n        raise HTTPException(status_code=409, detail="Associate the incident with a Project before assignment")\n    if require_unclaimed and incident["assignee_user_id"] is not None and int(incident["assignee_user_id"]) != assignee_user_id:\n',
    "engineer assignment project gate",
)

# Legacy coordinator-forward path also requires Project association.
text = replace_once(
    text,
    '    if incident["location_id"] is None:\n        raise HTTPException(\n            status_code=409,\n            detail="Select or create a location record before forwarding this incident.",\n        )\n\n    office_code = incident.get("office_code")\n',
    '    if incident.get("project_id") is None:\n        raise HTTPException(\n            status_code=409,\n            detail="Associate the incident with a Project before forwarding this incident.",\n        )\n    if incident["location_id"] is None:\n        raise HTTPException(\n            status_code=409,\n            detail="Select or create a location record before forwarding this incident.",\n        )\n\n    office_code = incident.get("office_code")\n',
    "coordinator forward project gate",
)

for forbidden in [
    '"incident_type": (payload.incident_type or "").strip() or None',
    'incident_type = :incident_type',
]:
    if forbidden in text:
        raise SystemExit(f"Legacy intake classification marker remains: {forbidden}")
path.write_text(text, encoding="utf-8")


# assessments.py: Project is required for outcomes that route or close an
# Incident. NEEDS_REPORTER_INFORMATION stays legal before Project choice.
path = Path("backend/app/routes/assessments.py")
text = path.read_text(encoding="utf-8")
needle = '''    if str(incident["current_stage"]).upper() != "COORDINATOR_REVIEW":
        raise HTTPException(
            status_code=409,
            detail="Triage is only allowed while the incident is in coordinator review",
        )

    disposition = payload.disposition
'''
replacement = '''    if str(incident["current_stage"]).upper() != "COORDINATOR_REVIEW":
        raise HTTPException(
            status_code=409,
            detail="Triage is only allowed while the incident is in coordinator review",
        )

    disposition = payload.disposition
    if incident.get("project_id") is None and disposition != "NEEDS_REPORTER_INFORMATION":
        raise HTTPException(
            status_code=409,
            detail="Associate the incident with a Project before recording this triage outcome",
        )
'''
text = replace_once(text, needle, replacement, "assessment triage project gate")
path.write_text(text, encoding="utf-8")


# projects.py: coordinator may inspect nearby context, but association to an
# existing Project must remain inside that coordinator's district authority.
path = Path("backend/app/routes/projects.py")
text = path.read_text(encoding="utf-8")
needle = '''            if str(target_row["status"]).upper() != "OPEN":
                raise HTTPException(status_code=409, detail="Only an open Project can accept an incident")
            target_project_id = int(payload.project_id)
'''
replacement = '''            if str(target_row["status"]).upper() != "OPEN":
                raise HTTPException(status_code=409, detail="Only an open Project can accept an incident")
            _ensure_manage_scope(user, dict(target_row))
            target_project_id = int(payload.project_id)
'''
text = replace_once(text, needle, replacement, "existing Project district authority")
path.write_text(text, encoding="utf-8")
