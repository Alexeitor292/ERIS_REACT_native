from pathlib import Path

path = Path("mobile/app/(tabs)/incidents/index.tsx")
text = path.read_text(encoding="utf-8")

replacements = [
    (
        'import IncidentWorkflowTree from "@/src/components/IncidentWorkflowTree";\n',
        'import IncidentWorkflowTree from "@/src/components/IncidentWorkflowTree";\nimport IncidentProjectReviewModal from "@/src/components/IncidentProjectReviewModal";\nimport { getIncidentProjectContext } from "@/src/api/projects";\n',
    ),
    (
        '  const [assignIncidentId, setAssignIncidentId] = useState<number | null>(null);\n',
        '  const [assignIncidentId, setAssignIncidentId] = useState<number | null>(null);\n  const [projectReviewIncidentId, setProjectReviewIncidentId] = useState<number | null>(null);\n',
    ),
    (
        '    const notes = coordinatorComment.trim() || undefined;\n\n    // Per-disposition validation mirrors the server contract.\n',
        '''    const notes = coordinatorComment.trim() || undefined;\n\n    // Any coordinator outcome that advances/closes the Incident requires its\n    // Project parent first. Reporter-information revision intentionally remains\n    // available before Project choice because corrected geography may be needed\n    // to make the association decision.\n    if (triageDisposition !== "NEEDS_REPORTER_INFORMATION") {\n      try {\n        const projectContext = await getIncidentProjectContext(token, reviewIncident.id);\n        if (projectContext.requires_project_association) {\n          const incidentId = reviewIncident.id;\n          closeCoordinatorReview();\n          setProjectReviewIncidentId(incidentId);\n          Alert.alert(\n            "Project required",\n            "Choose an existing Project or create a new Project for this Incident before recording this triage decision.",\n          );\n          return;\n        }\n      } catch (e: any) {\n        if (!isSessionExpiredError(e)) setErr(String(e?.message ?? e));\n        return;\n      }\n    }\n\n    // Per-disposition validation mirrors the server contract.\n''',
    ),
    (
        '''                  {canCoordinatorReview && item.current_stage === "COORDINATOR_REVIEW" ? (\n                    <Pressable\n                      style={[styles.smallBtn, { borderColor: palette.border }]}\n                      onPress={() => openCoordinatorReview(item)}\n                    >\n                      <Text style={{ color: palette.text, fontWeight: "700" }}>Review Location</Text>\n                    </Pressable>\n                  ) : null}\n''',
        '''                  {canCoordinatorReview && item.current_stage === "COORDINATOR_REVIEW" ? (\n                    <>\n                      <Pressable\n                        style={[styles.smallBtn, { borderColor: palette.border }]}\n                        onPress={() => openCoordinatorReview(item)}\n                      >\n                        <Text style={{ color: palette.text, fontWeight: "700" }}>Review Location</Text>\n                      </Pressable>\n                      <Pressable\n                        style={[styles.smallBtn, { borderColor: palette.primary }]}\n                        onPress={() => setProjectReviewIncidentId(item.id)}\n                      >\n                        <Text style={{ color: palette.primary, fontWeight: "800" }}>Review Project</Text>\n                      </Pressable>\n                    </>\n                  ) : null}\n''',
    ),
    (
        '                  {isAdmin ? (\n',
        '                  {isAdmin && item.current_stage === "ENGINEER_ASSIGNED" ? (\n',
    ),
    (
        '                  {canResolve && !isMaintenanceWorkerMobile && item.status !== "RESOLVED" ? (\n',
        '                  {canResolve && !isMaintenanceWorkerMobile && item.status !== "RESOLVED" && item.current_stage !== "COORDINATOR_REVIEW" ? (\n',
    ),
    (
        '''      <Modal visible={assignIncidentId != null} transparent animationType="fade" onRequestClose={() => setAssignIncidentId(null)}>\n''',
        '''      <IncidentProjectReviewModal\n        incidentId={projectReviewIncidentId}\n        visible={projectReviewIncidentId != null}\n        onClose={() => setProjectReviewIncidentId(null)}\n        onAssociated={load}\n      />\n\n      <Modal visible={assignIncidentId != null} transparent animationType="fade" onRequestClose={() => setAssignIncidentId(null)}>\n''',
    ),
]

for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Guard failed: expected exactly one match, found {count}: {old[:100]!r}")
    text = text.replace(old, new, 1)

path.write_text(text, encoding="utf-8")
