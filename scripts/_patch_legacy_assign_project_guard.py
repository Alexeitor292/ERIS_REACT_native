from pathlib import Path

path = Path("backend/app/routes/incidents.py")
text = path.read_text(encoding="utf-8")

old = '''@router.post("/incidents/{incident_id}/assign")
def assign_incident(
    payload: IncidentAssignRequest,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"])),
):
    try:
'''
new = '''@router.post("/incidents/{incident_id}/assign")
def assign_incident(
    payload: IncidentAssignRequest,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"])),
):
    # Backward-compatible endpoint for older Admin clients. Fail at the API
    # boundary with a controlled workflow response instead of leaking the
    # MariaDB trigger/SQL text when a pre-Project Incident is assigned.
    project_row = db.execute(
        text("SELECT project_id FROM incidents WHERE id = :iid LIMIT 1"),
        {"iid": incident_id},
    ).mappings().first()
    if not project_row:
        raise HTTPException(status_code=404, detail="Incident not found")
    if project_row["project_id"] is None:
        raise HTTPException(
            status_code=409,
            detail="Choose or create a Project for this Incident before engineering assignment.",
        )

    try:
'''

count = text.count(old)
if count != 1:
    raise SystemExit(f"Guard failed: expected exactly one legacy assign route, found {count}")

path.write_text(text.replace(old, new, 1), encoding="utf-8")
