import { useEffect, useState } from "react";

import {
  getWorkflowTree,
  type WorkflowNode,
  type WorkflowNodeStatus,
  type WorkflowTree,
} from "../api/workflowTree";

// Status visual config. Each status carries an icon glyph AND a text label so we
// never rely on color alone.
const STATUS: Record<
  WorkflowNodeStatus,
  { label: string; icon: string; cls: string; dot: string }
> = {
  COMPLETED: { label: "Completed", icon: "✓", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300", dot: "bg-emerald-400" },
  CURRENT: { label: "Current", icon: "►", cls: "border-sky-500/60 bg-sky-500/15 text-sky-200", dot: "bg-sky-400" },
  PENDING: { label: "Pending", icon: "○", cls: "border-[var(--line)] bg-[var(--panel-soft)] text-muted", dot: "bg-slate-500" },
  WAITING_ON_REPORTER: { label: "Waiting on reporter", icon: "⮌", cls: "border-amber-500/60 bg-amber-500/15 text-amber-200", dot: "bg-amber-400" },
  REVISION_REQUESTED: { label: "Revision requested", icon: "↺", cls: "border-red-500/50 bg-red-500/15 text-red-200", dot: "bg-red-400" },
  SKIPPED: { label: "Skipped", icon: "—", cls: "border-[var(--line)] bg-transparent text-muted opacity-60", dot: "bg-slate-600" },
  TERMINAL: { label: "Terminal", icon: "■", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200", dot: "bg-emerald-400" },
  UNASSIGNED: { label: "Unassigned", icon: "?", cls: "border-amber-500/60 bg-amber-500/10 text-amber-200", dot: "bg-amber-400" },
};

const PATH_LABEL: Record<string, string> = {
  PENDING_TRIAGE: "Awaiting triage",
  ASSESSMENT_REQUIRED: "Assessment required",
  NEEDS_REPORTER_INFORMATION: "Needs reporter information",
  NO_ASSESSMENT_REQUIRED: "No assessment required",
  DUPLICATE_OR_LINKED: "Linked / duplicate report",
};

function fmt(ts: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

function personLabel(node: WorkflowNode): string {
  if (node.user?.full_name) return node.user.full_name;
  if (node.user?.email) return node.user.email;
  if (node.status === "UNASSIGNED") return "Unassigned";
  if (node.status === "PENDING" || node.status === "SKIPPED") return "—";
  return node.role_title;
}

function NodeCard({ node, isCurrent }: { node: WorkflowNode; isCurrent: boolean }) {
  const [open, setOpen] = useState(false);
  const s = STATUS[node.status];
  const hasDetail = !!(node.notes || node.completed_at || node.user?.email || node.linked_incident_id);
  return (
    <div
      className={`flex-1 min-w-[180px] rounded-lg border p-3 transition ${s.cls} ${
        isCurrent ? "ring-2 ring-[var(--brand)] shadow-[0_6px_18px_rgba(31,94,255,0.25)]" : ""
      }`}
    >
      <button
        type="button"
        onClick={() => hasDetail && setOpen((o) => !o)}
        className="block w-full text-left"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${s.dot} text-black`}>
            {s.icon}
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-wide">{node.role_title}</span>
        </div>
        <div className="mt-1 text-sm font-medium leading-snug text-[var(--ink)]">{node.label}</div>
        <div className="mt-1 text-xs">
          <span className="font-semibold">{s.label}</span>
          <span className="text-muted"> · {personLabel(node)}</span>
        </div>
        {node.completed_at ? <div className="mt-0.5 text-[11px] text-muted">{fmt(node.completed_at)}</div> : null}
        {hasDetail ? <div className="mt-1 text-[11px] text-muted underline">{open ? "Hide details" : "Details"}</div> : null}
      </button>
      {open ? (
        <div className="mt-2 space-y-1 border-t border-[var(--line)] pt-2 text-xs text-[var(--ink)]">
          {node.user?.email ? <div className="text-muted">{node.user.email}</div> : null}
          {node.notes ? <div>{node.notes}</div> : null}
          {node.linked_incident_id ? <div className="text-muted">Linked incident #{node.linked_incident_id}</div> : null}
          {node.linked_location_id ? <div className="text-muted">Linked location #{node.linked_location_id}</div> : null}
          {node.event_type ? <div className="text-[11px] text-muted">event: {node.event_type}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function Connector() {
  return (
    <div className="flex shrink-0 items-center justify-center text-muted xl:px-1" aria-hidden>
      <span className="xl:hidden">↓</span>
      <span className="hidden xl:inline">→</span>
    </div>
  );
}

export function WorkflowTreeView({ tree }: { tree: WorkflowTree }) {
  const owner = tree.current_owner;
  const overall = STATUS[tree.overall_status];
  return (
    <div>
      {/* Current owner summary */}
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3">
        <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${overall.cls}`}>
          {overall.icon} {overall.label}
        </span>
        <span className="text-xs text-muted">Path: {PATH_LABEL[tree.path_type] ?? tree.path_type}</span>
        <div className="text-sm">
          <span className="text-muted">Current owner: </span>
          {owner ? (
            <span className="font-semibold">
              {owner.role_title}
              {owner.full_name ? ` — ${owner.full_name}` : owner.user_id == null ? " — Unassigned" : ""}
            </span>
          ) : (
            <span className="font-semibold">None (closed)</span>
          )}
        </div>
        {tree.assessment ? (
          <span className="ml-auto text-xs text-muted">
            Assessment: <span className="font-semibold text-[var(--ink)]">{tree.assessment.state}</span>
            {tree.assessment.office_code ? ` · Office ${tree.assessment.office_code}` : ""}
          </span>
        ) : null}
      </div>

      {tree.linked_incident_id || tree.linked_location_id ? (
        <div className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">
          Linked / duplicate report
          {tree.linked_incident_id ? ` → incident #${tree.linked_incident_id}` : ""}
          {tree.linked_location_id ? ` → location #${tree.linked_location_id}` : ""}
        </div>
      ) : null}

      {/* Responsive workflow: vertical on narrow, horizontal on xl */}
      <div className="flex flex-col items-stretch gap-2 xl:flex-row xl:flex-wrap xl:items-stretch">
        {tree.nodes.map((node, i) => (
          <div key={node.key} className="flex flex-col items-stretch xl:flex-row xl:items-stretch">
            <NodeCard node={node} isCurrent={owner?.node_key === node.key} />
            {i < tree.nodes.length - 1 ? <Connector /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export function WorkflowTreeModal({ incidentId, onClose }: { incidentId: number; onClose: () => void }) {
  const [tree, setTree] = useState<WorkflowTree | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getWorkflowTree(incidentId)
      .then((t) => alive && setTree(t))
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Failed to load workflow"));
    return () => {
      alive = false;
    };
  }, [incidentId]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/50 p-4" onClick={onClose}>
      <div
        className="mt-10 w-full max-w-[1400px] rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Incident #{incidentId} — Workflow</h2>
          <button onClick={onClose} className="rounded border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-1 text-sm hover:brightness-95">
            Close
          </button>
        </div>
        {error ? (
          <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>
        ) : tree ? (
          <WorkflowTreeView tree={tree} />
        ) : (
          <div className="text-sm text-muted">Loading workflow…</div>
        )}
      </div>
    </div>
  );
}
