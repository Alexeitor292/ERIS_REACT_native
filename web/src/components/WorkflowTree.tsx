import { useEffect, useState } from "react";

import {
  getWorkflowTree,
  type WorkflowNode,
  type WorkflowNodeStatus,
  type WorkflowTree,
} from "../api/workflowTree";
import ModalDialog from "../ui/ModalDialog";
import { assessmentStateLabel } from "../features/assessments/assessmentModel";

// Tones come from the theme tokens so every node reads in the light, dark and
// coastal themes alike. The palette this replaced (text-emerald-300, text-sky-200,
// text-amber-200 …) was tuned for a dark background and was close to invisible
// on the light theme.
const TONE = {
  good: "border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_9%,var(--panel))]",
  brand: "border-[color:color-mix(in_oklab,var(--brand)_55%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--panel))]",
  warn: "border-[color:color-mix(in_oklab,var(--warn)_55%,transparent)] bg-[color:color-mix(in_oklab,var(--warn)_10%,var(--panel))]",
  bad: "border-[color:color-mix(in_oklab,var(--bad)_50%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_9%,var(--panel))]",
  quiet: "border-[var(--line)] bg-[var(--panel-soft)]",
} as const;

const STATUS: Record<WorkflowNodeStatus, { label: string; icon: string; cls: string; dot: string }> = {
  COMPLETED: { label: "Done", icon: "✓", cls: TONE.good, dot: "bg-[var(--good)] text-white" },
  CURRENT: { label: "Now", icon: "►", cls: TONE.brand, dot: "bg-[var(--brand)] text-white" },
  PENDING: { label: "Not started yet", icon: "○", cls: TONE.quiet, dot: "bg-[var(--line)] text-[var(--ink)]" },
  WAITING_ON_REPORTER: { label: "Waiting on the reporter", icon: "⮌", cls: TONE.warn, dot: "bg-[var(--warn)] text-white" },
  REVISION_REQUESTED: { label: "Returned for changes", icon: "↺", cls: TONE.bad, dot: "bg-[var(--bad)] text-white" },
  SKIPPED: { label: "Not needed", icon: "—", cls: `${TONE.quiet} opacity-70`, dot: "bg-[var(--line)] text-[var(--ink)]" },
  TERMINAL: { label: "Closed here", icon: "■", cls: TONE.quiet, dot: "bg-[var(--muted)] text-white" },
  UNASSIGNED: { label: "Needs someone assigned", icon: "?", cls: TONE.warn, dot: "bg-[var(--warn)] text-white" },
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
    <div className={`flex-1 min-w-[180px] rounded-lg border p-3 transition ${s.cls} ${isCurrent ? "ring-2 ring-[var(--brand)] shadow-[0_6px_18px_rgba(31,94,255,0.25)]" : ""}`}>
      <button type="button" onClick={() => hasDetail && setOpen((o) => !o)} className="block w-full text-left" aria-expanded={open}>
        <div className="flex items-center gap-2">
          <span aria-hidden className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${s.dot}`}>{s.icon}</span>
          <span className="text-[11px] font-semibold uppercase tracking-wide">{node.role_title}</span>
        </div>
        <div className="mt-1 text-sm font-medium leading-snug text-[var(--ink)]">{node.label}</div>
        <div className="mt-1 text-xs"><span className="font-semibold">{s.label}</span><span className="text-muted"> · {personLabel(node)}</span></div>
        {node.completed_at ? <div className="mt-0.5 text-[11px] text-muted">{fmt(node.completed_at)}</div> : null}
        {hasDetail ? <div className="mt-1 text-[11px] text-muted underline">{open ? "Hide details" : "Details"}</div> : null}
      </button>
      {open ? (
        <div className="mt-2 space-y-1 border-t border-[var(--line)] pt-2 text-xs text-[var(--ink)]">
          {node.user?.email ? <div className="text-muted">{node.user.email}</div> : null}
          {node.notes ? <div>{node.notes}</div> : null}
          {node.linked_incident_id ? <div className="text-muted">Linked incident #{node.linked_incident_id}</div> : null}
          {node.linked_location_id ? <div className="text-muted">Linked location #{node.linked_location_id}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function Connector() {
  return <div className="flex shrink-0 items-center justify-center text-muted xl:px-1" aria-hidden><span className="xl:hidden">↓</span><span className="hidden xl:inline">→</span></div>;
}

export function WorkflowTreeView({ tree }: { tree: WorkflowTree }) {
  const owner = tree.current_owner;
  const overall = STATUS[tree.overall_status];
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3">
        <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${overall.cls}`}>{overall.icon} {overall.label}</span>
        <span className="text-xs text-muted">Path: {PATH_LABEL[tree.path_type] ?? tree.path_type}</span>
        <div className="text-sm">
          <span className="text-muted">Current owner: </span>
          {owner ? <span className="font-semibold">{owner.role_title}{owner.full_name ? ` — ${owner.full_name}` : owner.user_id == null ? " — Unassigned" : ""}</span> : <span className="font-semibold">None (closed)</span>}
        </div>
        {tree.assessment ? <span className="ml-auto text-xs text-muted">Assessment: <span className="font-semibold text-[var(--ink)]">{assessmentStateLabel(tree.assessment.state)}</span></span> : null}
      </div>

      {tree.linked_incident_id || tree.linked_location_id ? (
        <div className="mb-3 rounded border border-[color:color-mix(in_oklab,var(--warn)_50%,transparent)] bg-[color:color-mix(in_oklab,var(--warn)_10%,var(--panel))] p-2 text-xs">
          Linked / duplicate report{tree.linked_incident_id ? ` → incident #${tree.linked_incident_id}` : ""}{tree.linked_location_id ? ` → location #${tree.linked_location_id}` : ""}
        </div>
      ) : null}

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
    return () => { alive = false; };
  }, [incidentId]);

  return (
    <ModalDialog
      titleId="workflow-tree-dialog-title"
      busy={false}
      onClose={onClose}
      overlayClassName="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/50 p-4"
      panelClassName="mt-10 w-full max-w-[1400px] rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 shadow-xl"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 id="workflow-tree-dialog-title" className="text-lg font-semibold">Incident #{incidentId} — Workflow</h2>
        <button data-dialog-initial-focus="true" type="button" onClick={onClose} className="rounded border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-1 text-sm hover:brightness-95">Close</button>
      </div>
      {error ? <div role="alert" className="rounded border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] p-3 text-sm text-[var(--bad)]">{error}</div> : tree ? <WorkflowTreeView tree={tree} /> : <div className="text-sm text-muted">Loading workflow…</div>}
    </ModalDialog>
  );
}
