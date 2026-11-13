import type { Me, Incident, Submission } from "../../../api/types";
import type { Assessment, AssessmentEvent } from "../../../api/assessments";
import type { WorkflowDetail, Step } from "../../../api/maintenanceWorkflows";
import gisaLookups from "./gisaLookups.json" with { type: "json" };

type Row = Record<string, unknown>;
const stamp = () => new Date().toISOString();
const roles = ["MAINTENANCE", "MAINTENANCE", "MAINTENANCE", "OFFICE_CHIEF", "BRANCH_CHIEF", "STAFF"];
export const PEOPLE: Me[] = ["Alex Reyes", "Morgan Lee", "Taylor Chen", "Jordan Patel", "Casey Nguyen", "Sam Rivera"].map((full_name, index) => ({
  id: index + 1, full_name, email: `demo.${index + 1}@example.invalid`, roles: [roles[index]], acting_options: [],
  metadata: { office_code: index > 2 ? "DEMO" : null, district: "04" },
  maintenance_districts: index < 3 ? [{ district: "04", report: true, manage: index === 2 }] : [],
  org: index > 2 ? { office_id: 1, office_code: "DEMO", office_name: "Demo Geotechnical Office", office_is_active: true, branch_id: index > 3 ? 1 : null, branch_letter: index > 3 ? "A" : null, branch_name: index > 3 ? "Demo Branch A" : null, home_city: "Oakland", home_district: "04", availability: "AVAILABLE", has_profile: true } : null,
}));
const steps: Step[] = [
  { name: "Supervisor review", kind: "REVIEW", duty_ids: ["supervisor"], notify_duty_ids: [], rule: "ANY", request_information: true, allow_maintenance: false, allow_geotech: false },
  { name: "District decision", kind: "DECISION", duty_ids: ["decision"], notify_duty_ids: [], rule: "ANY", request_information: true, allow_maintenance: true, allow_geotech: true },
];
export class MockRefusal extends Error { status: number; constructor(message: string, status = 409) { super(message); this.status = status; } }
export class MockDatabase {
  version = 0;
  actor = 0;
  incident: Incident | null = null;
  assessment: Assessment | null = null;
  group: Row | null = null;
  submission: Submission | null = null;
  gisa: Row = {};
  geometry: unknown = null;
  incidentTypes: string[] = [];
  actions = { immediate: [] as string[], follow_up: [] as string[] };
  attachments: Row[] = [];
  formAttachments: Row[] = [];
  assessmentEvents: AssessmentEvent[] = [];
  maintenanceEvents: WorkflowDetail["events"] = [];
  maintenanceIndex = 0;
  maintenanceVersion = 1;
  maintenanceOutcome: string | null = null;
  waitingReporter = false;
  notices: Row[] = [];
  mutations: Array<{ path: string; method: string; actor: number }> = [];
  unsupported: string[] = [];
  private urls: string[] = [];
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;
  changed() { this.version += 1; this.listeners.forEach((listener) => listener()); }
  get me() { return PEOPLE[this.actor]; }
  setActor(actor: number) { if (!PEOPLE[actor]) throw new MockRefusal("Unknown demo perspective."); this.actor = actor; this.changed(); }
  reset() {
    if (typeof document !== "undefined") document.querySelectorAll("[data-demo-location-ready]").forEach((element) => element.remove());
    this.urls.forEach((url) => URL.revokeObjectURL(url)); this.urls = [];
    this.actor = 0; this.incident = null; this.assessment = null; this.group = null; this.submission = null;
    this.gisa = {}; this.geometry = null; this.incidentTypes = []; this.actions = { immediate: [], follow_up: [] };
    this.attachments = []; this.formAttachments = []; this.assessmentEvents = []; this.maintenanceEvents = []; this.maintenanceIndex = 0;
    this.maintenanceVersion = 1; this.maintenanceOutcome = null; this.waitingReporter = false; this.notices = [];
    this.mutations = []; this.unsupported = []; this.changed();
  }
  require(check: unknown, message = "This action is not available at this stage of the demo."): asserts check { if (!check) throw new MockRefusal(message); }
  event(event_type: string, notes: unknown = null) {
    this.assessmentEvents.push({ id: this.assessmentEvents.length + 1, assessment_id: this.assessment?.id ?? null, incident_id: 1, actor_user_id: this.me.id, actor_name: this.me.full_name ?? null, actor_email: this.me.email, event_type, notes: typeof notes === "string" ? notes : null, disposition: null, from_state: null, to_state: this.assessment?.state ?? null, target_incident_id: null, target_location_id: null, created_at: stamp() });
    this.notices.push({ id: this.notices.length + 1, kind: event_type, title: event_type.replace(/_/g, " "), body: "A mock workflow action was recorded.", link: this.assessment ? "/my-work?assessment=1" : "/my-work?maintenance=1", actor: this.me.full_name, created_at: stamp(), read: false });
  }
  workflow(): WorkflowDetail {
    this.require(this.incident, "No report exists in this demo.");
    return { incident_id: 1, district: "04", revision: 1, version: this.maintenanceVersion,
      state: { step_index: this.maintenanceIndex, approved_user_ids: [], waiting_reporter: this.waitingReporter },
      step: steps[this.maintenanceIndex], steps, outcome: this.maintenanceOutcome,
      assigned: [PEOPLE[this.maintenanceIndex + 1]].map((p) => ({ id: p.id, full_name: p.full_name!, email: p.email, is_active: true })),
      events: this.maintenanceEvents, groups: this.group ? [{ id: 1, title: String(this.group.title) }] : [],
      can_act: this.actor === this.maintenanceIndex + 1 && !this.maintenanceOutcome && !this.waitingReporter,
      can_edit: this.actor === 0 && !this.maintenanceOutcome, can_resubmit: this.actor === 0 && this.waitingReporter, can_restart: false };
  }
  assessmentView() {
    if (!this.assessment) return null;
    return { ...this.assessment, can_review: this.actor === 4 && this.assessment.state === "SUBMITTED" };
  }
  detail() {
    return { assessment: this.assessmentView(), assignments: this.assessment?.assigned_user_id ? [{ id: 1, user_id: 6, assignment_role: "ENGINEER", assigned_by_user_id: 5, full_name: PEOPLE[5].full_name, email: PEOPLE[5].email, notes: null, is_authority: false, created_at: stamp() }] : [], events: this.assessmentEvents };
  }
  createSubmission() {
    this.require(this.assessment && this.incident);
    this.submission = { id: 1, created_by_user_id: 6, status: "DRAFT", client_submission_uuid: "demo-form-1", title: this.incident.title, district: "04", county: "SON", route: "116", post_mile: "12.4", created_at: stamp(), updated_at: stamp(), submitted_at: null };
    this.gisa = { id: 1, submission_id: 1, report_date: "2026-11-09", district: "04", county: "SON", route: "116", post_mile: "12.4", latitude: this.incident.latitude, longitude: this.incident.longitude, date_incident_reported: "2026-11-09", observations_notes: "", geotechnical_assessment_notes: "", recommendations_notes: "", updated_at: stamp(), revision: 1 };
    this.assessment.submission_id = 1; this.assessment.submission_ids = [1]; this.incident.linked_submission_id = 1;
  }
  submissionDetail() {
    this.require(this.submission, "No technical form exists in this demo.");
    return { submission: { ...this.submission, can_edit: this.actor === 5 && ["DRAFT", "REVISION_REQUESTED"].includes(this.assessment?.state ?? ""), can_manage_permissions: false, can_review: this.actor === 4 },
      gisa: this.gisa, incident_types: this.incidentTypes, actions: this.actions, photos: this.formAttachments.filter((a) => a.kind === "PHOTO"), attachments: this.formAttachments.filter((a) => a.kind !== "PHOTO"), workflow_events: [], cracks: [],
      context: { incident_id: 1, incident_title: this.incident?.title, event_group_id: 1, assessment_id: 1, assessment_state: this.assessment?.state, assessment_routing_path: "BRANCH", can_review: this.actor === 4 && this.assessment?.state === "SUBMITTED" } };
  }
  office = { id: 1, code: "DEMO", name: "Demo Geotechnical Office", short_name: "Demo office", org_type: "GEOTECH", unit_number: "0000", home_city: "Oakland", home_district: "04", is_active: true, is_routing_target: true, sort_order: 1, districts: ["04"], branches: [{ id: 1, name: "Demo Branch A", letter: "A", unit_type: "BRANCH", home_city: "Oakland", home_district: "04", accepts_assignments: true, is_active: true }] };
  tree() {
    const person = (index: number, position: string) => ({ ...PEOPLE[index], position, availability: "AVAILABLE", available_until: null });
    return { offices: [{ office: this.office, chiefs: [person(3, "OFFICE_CHIEF")], specialists: [], branches: [{ ...this.office.branches[0], chief: person(4, "BRANCH_CHIEF"), staff: [person(5, "STAFF")], can_manage: false }], can_manage: false, can_name_chiefs: false }], me: { id: this.me.id, is_admin: false, office_id: this.actor > 2 ? 1 : null, branch_id: this.actor > 3 ? 1 : null, office_code: this.actor > 2 ? "DEMO" : null, position: this.actor === 3 ? "OFFICE_CHIEF" : this.actor === 4 ? "BRANCH_CHIEF" : this.actor === 5 ? "STAFF" : null } };
  }
  options(index: number) {
    const p = PEOPLE[index];
    return { groups: [{ group_key: "branch-1", label: "Demo Branch A", branch_id: 1, branch_letter: "A", branch_name: "Demo Branch A", is_own_branch: true, is_active: true, accepts_assignments: true }], items: [{ ...p, metadata: p.metadata ?? {}, group_key: "branch-1", office_code: "DEMO", office_name: this.office.name, branch_id: 1, branch_letter: "A", branch_name: "Demo Branch A", home_city: "Oakland", home_district: "04", open_assessment_count: 0, awaiting_action_count: 0, availability: "AVAILABLE", available_from: null, available_until: null }] };
  }
  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const url = new URL(path, "https://demo.invalid"); const p = url.pathname;
    const method = (init.method ?? "GET").toUpperCase();
    const body: Row = typeof init.body === "string" && init.body ? JSON.parse(init.body) : {};
    const result = method === "GET" ? this.read(p, url.searchParams) : await this.write(p, method, body, init.body);
    if (method !== "GET" && !p.endsWith("/presence") && !p.startsWith("/notifications")) { this.mutations.push({ path: p, method, actor: this.actor }); this.changed(); }
    return structuredClone(result);
  }
  read(p: string, q: URLSearchParams): unknown {
    if (p === "/auth/me") return this.me;
    if (p === "/auth/config") return { local_login_enabled: false, entra_enabled: false };
    if (p === "/incidents") return { items: q.has("queue") ? [] : this.incident ? [this.incident] : [] };
    if (p === "/incidents/1") { this.require(this.incident, "Report not found in this demo."); return { incident: this.incident }; }
    if (p === "/maintenance-work/incidents") return { items: this.incident && this.actor < 3 ? [{ id: 1, title: this.incident.title, district: "04", outcome: this.maintenanceOutcome, step_name: steps[this.maintenanceIndex].name, waiting_reporter: this.waitingReporter, my_turn: this.actor === this.maintenanceIndex + 1 && !this.maintenanceOutcome }] : [] };
    if (p === "/maintenance-work/incidents/1") return this.workflow();
    if (p === "/assessments") {
      const queue = q.get("queue"), a = this.assessmentView();
      const visible = !queue || (this.actor === 3 && queue === "office_chief" && a?.state === "PENDING_OFFICE_DELEGATION") || (this.actor === 4 && queue === "branch_chief" && a?.state === "PENDING_ENGINEER_ASSIGNMENT") || (this.actor === 4 && queue === "branch_chief_review" && a?.state === "SUBMITTED") || (this.actor === 5 && queue === "assignee");
      return { items: a && visible ? [a] : [] };
    }
    if (p === "/assessments/1" || p === "/incidents/1/assessment") { this.require(this.assessment, "No assessment yet."); return this.detail(); }
    if (p.endsWith("/branch-options")) return this.options(4);
    if (p.startsWith("/admin/assessment-assignment-options/")) return this.options(5);
    if (p === "/assessments/routing/preview") return { district: "04", office_code: "DEMO", office_name: this.office.name, source: "routing_table" };
    if (p === "/submissions" || p === "/submissions/page") return { items: this.submission ? [this.submission] : [], has_more: false, next_cursor: null };
    if (p === "/submissions/1") return this.submissionDetail();
    if (p === "/submissions/1/geometry") return { submission_id: 1, geometry: this.geometry };
    if (p === "/submissions/1/shares") return { shares: [], grants: [], candidates: [] };
    if (p === "/submissions/1/photo-map") return { submission_id: 1, incident_id: 1, incident: this.incident, summary: { photos_total: 0, photos_geotagged: 0, photos_with_heading: 0, photos_unmapped: 0 }, photos: [] };
    if (p === "/submissions/1/drone-surveys" || p === "/submissions/1/cracks") return { items: [] };
    if (p === "/gisa/lookups") return gisaLookups;
    if (p === "/submissions/1/site-history") return { anchor: null, current_types: [], incidents: [] };
    if (p === "/org/offices") return { offices: [this.office] };
    if (p === "/org/tree") return this.tree();
    if (p === "/org/maintenance") return { districts: [{ district: "04", workflow_configured: true, people: PEOPLE.slice(0, 3), can_manage: false }] };
    if (p === "/org/people" || p === "/admin/users") return { items: PEOPLE.map((person) => ({ ...person, is_active: true, placement: { label: person.org?.office_name ?? "Demo district Maintenance", office_id: person.org?.office_id, branch_id: person.org?.branch_id }, is_admin: false })) };
    if (p === "/org/districts/04/office") return { district: "04", office: this.office, source: "routing_table" };
    if (p === "/maintenance-workflows") return { districts: [{ district: "04", revision: 1, can_manage: false, people: PEOPLE.slice(0, 3), definition: { manager_user_ids: [3], duties: [{ id: "report", name: "Field reporting", user_ids: [1], report: true, view_district: true, edit_report: true }, { id: "supervisor", name: "Supervisor review", user_ids: [2], report: true, view_district: true, edit_report: false }, { id: "decision", name: "District decision", user_ids: [3], report: true, view_district: true, edit_report: false }], steps, notify_duty_ids: [] } }] };
    if (p === "/district-contacts/04") return { district: "04", default_user_id: 3, can_edit: false, candidates: [{ id: 3, full_name: PEOPLE[2].full_name }] };
    if (p === "/notifications/unread") return { unread: this.notices.length };
    if (p === "/notifications") return { items: this.notices, unread: this.notices.length };
    if (p === "/delegations") return { given: [], received: [], acting_options: [] };
    if (p === "/event-groups") return { items: this.group ? [this.group] : [] };
    if (p === "/event-groups/1") { this.require(this.group); return { event_group: this.group, incidents: this.incident ? [this.incident] : [], events: [] }; }
    if (p === "/incidents/1/attachments") return { items: this.attachments };
    if (p === "/incidents/1/workflow-tree") return { incident_id: 1, path_type: this.assessment ? "ASSESSMENT_REQUIRED" : "PENDING_TRIAGE", overall_status: this.assessment?.state === "APPROVED" ? "COMPLETED" : "CURRENT", current_owner: null, assessment: this.assessment, linked_incident_id: null, linked_location_id: null, nodes: [] };
    if (p === "/me/layouts" || p === "/shares/reviews" || p.startsWith("/site-history") || p.startsWith("/road-inventory")) return { items: [] };
    if (p.startsWith("/attachments/") && p.endsWith("/download-url")) return { download_url: [...this.attachments, ...this.formAttachments].find((a) => a.id === Number(p.split("/")[2]))?.download_url };
    this.unsupported.push(`GET ${p}`); throw new MockRefusal(`This demo has no data for ${p}. No live request was made.`, 404);
  }
  async write(p: string, method: string, b: Row, raw: BodyInit | null | undefined): Promise<unknown> {
    if (p === "/incident-classifications/query") return { items: [] };
    if (p === "/notifications/read") return { unread: 0 };
    if (p.includes("/presence")) return { others: [], revision: Number(this.gisa.revision ?? 1), granted: [], denied: {}, saved_by: null, saved_at: null };
    if (p === "/incidents" && method === "POST") {
      this.require(this.actor === 0 && !this.incident);
      this.require(b.latitude && b.longitude && b.first_observed_at, "Locate the report and enter when it was first seen.");
      this.incident = { id: 1, title: "04-SON-116-12.4 · Demo slope failure", incident_type: null, description: String(b.description ?? ""), latitude: Number(b.latitude), longitude: Number(b.longitude), district: "04", county: "SON", route: "116", post_mile: "12.4", first_observed_at: String(b.first_observed_at), first_occurred_at: null, office_code: "DEMO", current_stage: "COORDINATOR_REVIEW", status: "NEW", maintenance_workflow: true, reporter_user_id: 1, reporter_name: PEOPLE[0].full_name, reporter_email: PEOPLE[0].email, incident_key: null, event_group_id: null, location_id: null, location_match_status: null, location_reviewed_by_user_id: null, location_reviewed_at: null, location_match_metadata: null, created_at: stamp(), updated_at: stamp(), resolved_at: null, resolved_by_user_id: null, resolution_comment: null, linked_submission_id: null, linked_submission_readable: true, road_inventory_context: null, assignment: null };
      this.maintenanceEvents.push({ id: 1, action: "REPORTED", notes: this.incident.description, actor_name: this.me.full_name!, created_at: stamp() }); this.event("REPORTED");
      return { incident: this.incident };
    }
    if (p === "/incidents/1/attachments" && raw instanceof FormData) {
      const file = raw.get("file"); this.require(file instanceof File, "Choose a sample file.");
      const url = URL.createObjectURL(file); this.urls.push(url);
      this.attachments.push({ id: this.attachments.length + 1, attachment_id: this.attachments.length + 1, incident_id: 1, file_name: file.name, mime_type: file.type, file_size_bytes: file.size, kind: file.type.startsWith("image/") ? "PHOTO" : "DOC", download_url: url, uploaded_at: stamp(), latitude: null, longitude: null, camera_heading_deg: null, location_source: null, captured_at: null, storage_key: `demo/${file.name}` });
      return { attachment: this.attachments[this.attachments.length - 1] };
    }
    if ((p === "/submissions/1/photos" || p === "/submissions/1/attachments") && raw instanceof FormData) {
      this.require(this.actor === 5 && this.submission && ["DRAFT", "REVISION_REQUESTED"].includes(this.assessment?.state ?? ""));
      const file = raw.get("file"); this.require(file instanceof File, "Choose a sample file.");
      const url = URL.createObjectURL(file); this.urls.push(url); const id = 100 + this.formAttachments.length;
      this.formAttachments.push({ id, attachment_id: id, file_name: file.name, mime_type: file.type, file_size_bytes: file.size, kind: file.type.startsWith("image/") ? "PHOTO" : "DOC", section_key: "observations_notes", sort_order: this.formAttachments.length, uploaded_at: stamp(), storage_bucket: null, storage_key: `demo/${file.name}`, download_url: url });
      return { attachment_id: id };
    }
    if (p === "/maintenance-work/incidents/1/actions") {
      const workflow = this.workflow(); this.require(b.version === workflow.version, "The report changed. Refresh the workflow."); this.require(String(b.notes ?? "").trim(), "Review notes are required."); this.require(workflow.can_act);
      if (b.action === "APPROVE") { this.require(this.actor === 1); this.maintenanceIndex = 1; }
      else if (b.action === "GEOTECH") {
        this.require(this.actor === 2 && this.incident); this.require(b.district_contact_user_id === 3, "Choose the sample District Contact.");
        this.maintenanceOutcome = "GEOTECH";
        this.group = { id: 1, title: String(b.new_group_title || "Demo storm event"), description: "Fictional training event", event_group_key: "DEMO-GROUP-001", status: "OPEN", anchor_location_id: null, anchor_latitude: this.incident.latitude, anchor_longitude: this.incident.longitude, centroid_latitude: this.incident.latitude, centroid_longitude: this.incident.longitude, district: "04", county: "SON", route: "116", post_mile: "12.4", created_from_incident_id: 1, created_by_user_id: 3, source: "TRIAGE", incident_count: 1, open_incident_count: 1, created_at: stamp(), updated_at: stamp(), closed_at: null, closed_by_user_id: null };
        Object.assign(this.incident, { incident_key: "DEMO-2026-001", event_group_id: 1, current_stage: "OFFICE_CHIEF_REVIEW", status: "IN_PROGRESS", triage_disposition: "ASSESSMENT_REQUIRED", triage_notes: b.notes, triage_decided_by_name: this.me.full_name, triage_decided_at: stamp(), district_contact_user_id: 3 });
        this.assessment = { id: 1, assessment_uuid: "demo-assessment-1", incident_id: 1, submission_id: null, submission_ids: [], district: "04", office_code: "DEMO", office_override_reason: null, routed_office_id: 1, routed_office_name: this.office.name, routed_branch_id: null, routed_branch_name: null, routed_branch_letter: null, routing_path: null, branch_chief_user_id: null, assigned_engineer_user_id: null, assigned_user_id: null, assigned_user_kind: null, can_review: false, review_owner: null, state: "PENDING_OFFICE_DELEGATION", triage_disposition: "ASSESSMENT_REQUIRED", notes: String(b.notes), created_by_user_id: 3, office_delegated_at: null, engineer_assigned_at: null, submitted_at: null, review_requested_at: null, approved_at: null, finalized_at: null, created_at: stamp(), updated_at: stamp() };
      } else throw new MockRefusal("Follow the guided assessment-referral scenario.");
      this.maintenanceVersion += 1; this.maintenanceEvents.push({ id: this.maintenanceEvents.length + 1, action: String(b.action), notes: String(b.notes), actor_name: this.me.full_name!, created_at: stamp() }); this.event(String(b.action), b.notes);
      return this.workflow();
    }
    if (p === "/assessments/1/delegate-branch") {
      this.require(this.actor === 3 && this.assessment?.state === "PENDING_OFFICE_DELEGATION" && b.branch_chief_user_id === 5);
      Object.assign(this.assessment, { routing_path: "BRANCH", state: "PENDING_ENGINEER_ASSIGNMENT", branch_chief_user_id: 5, branch_chief_name: PEOPLE[4].full_name, routed_branch_id: 1, routed_branch_name: "Demo Branch A", routed_branch_letter: "A", office_delegated_at: stamp(), review_owner: { kind: "BRANCH_CHIEF", user_id: 5, office_code: "DEMO" } });
      this.incident!.current_stage = "BRANCH_CHIEF_REVIEW"; this.event("DELEGATED", b.notes); return { assessment: this.assessmentView() };
    }
    if (p === "/assessments/1/assign-engineer") {
      this.require(this.actor === 4 && this.assessment?.state === "PENDING_ENGINEER_ASSIGNMENT" && b.engineer_user_id === 6);
      Object.assign(this.assessment, { state: "DRAFT", assigned_engineer_user_id: 6, assigned_user_id: 6, assigned_user_kind: "STAFF", assigned_user_name: PEOPLE[5].full_name, engineer_assigned_at: stamp() });
      this.incident!.current_stage = "ENGINEER_ASSIGNED"; this.createSubmission(); this.event("ASSIGNED", b.notes); return { assessment: this.assessmentView() };
    }
    if (p === "/submissions/1/gisa" || p === "/submissions/1/gisa/memos") {
      this.require(this.actor === 5 && ["DRAFT", "REVISION_REQUESTED"].includes(this.assessment?.state ?? ""));
      const { base: _base, ...fields } = b; Object.assign(this.gisa, fields, { revision: Number(this.gisa.revision ?? 1) + 1, updated_at: stamp() }); return this.submissionDetail();
    }
    if (p === "/submissions/1/gisa/incident-types") { this.incidentTypes = Array.isArray(b.items) ? b.items.map(String) : []; return { items: this.incidentTypes }; }
    if (p === "/submissions/1/gisa/actions") { this.actions = { immediate: Array.isArray(b.immediate) ? b.immediate.map(String) : [], follow_up: Array.isArray(b.follow_up) ? b.follow_up.map(String) : [] }; return this.actions; }
    if (p === "/submissions/1/geometry") { this.geometry = b.geometry ?? null; return { submission_id: 1, geometry: this.geometry }; }
    if (p === "/assessments/1/submit") {
      this.require(this.actor === 5 && ["DRAFT", "REVISION_REQUESTED"].includes(this.assessment?.state ?? "") && this.submission);
      this.assessment!.state = "SUBMITTED"; this.assessment!.submitted_at = stamp(); this.submission.status = "SUBMITTED"; this.submission.submitted_at = stamp(); this.event("SUBMITTED", b.notes); return { assessment: this.assessmentView() };
    }
    if (p === "/assessments/1/review") {
      this.require(this.actor === 4 && this.assessment?.state === "SUBMITTED" && this.submission);
      const approve = b.action === "APPROVE"; this.require(approve || b.action === "REQUEST_REVISION");
      this.assessment.state = approve ? "APPROVED" : "REVISION_REQUESTED"; this.submission.status = approve ? "APPROVED" : "DRAFT";
      if (approve) this.assessment.approved_at = stamp(); this.event(approve ? "APPROVED" : "REVISION_REQUESTED", b.notes);
      return { assessment: this.assessmentView(), state: this.assessment.state };
    }
    if (p === "/auth/logout") { this.reset(); return {}; }
    this.unsupported.push(`${method} ${p}`); throw new MockRefusal(`This demo action is unavailable: ${method} ${p}. No live request was made.`, 404);
  }
}
export const mockDatabase = new MockDatabase();
