import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { CalendarDays, MapPin, MessageSquareText, Repeat2, Shuffle, UserRound, Wrench } from "lucide-react";

import type { ActionRef, MaintenanceSide, SiteHistory, SiteIncident } from "../../api/siteHistory";
import {
  distanceLabel,
  hasMaintenanceRecord,
  OUTCOME_LABELS,
  RELATION_LABELS,
  recordStandingLabel,
  summarizeRecord,
  type SiteRelation,
} from "./memoContentModel";

const dateLabel = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "Date unknown";

// Mixed with the theme's own panel and ink colors, so they hold in light, dark and coastal.
const RELATION_TONES: Record<SiteRelation, string> = {
  SAME_TYPE:
    "border-[color:color-mix(in_oklab,#d97706_45%,var(--line))] bg-[color:color-mix(in_oklab,#f59e0b_14%,var(--panel))] text-[color:color-mix(in_oklab,#b45309_75%,var(--ink))]",
  DIFFERENT_TYPE:
    "border-[color:color-mix(in_oklab,#0284c7_45%,var(--line))] bg-[color:color-mix(in_oklab,#0ea5e9_12%,var(--panel))] text-[color:color-mix(in_oklab,#0369a1_75%,var(--ink))]",
  UNCLASSIFIED: "border-[var(--line)] bg-[var(--panel-soft)] text-muted",
};

export type SiteNotesField = { key: string; label: string; value: string; onChange: (value: string) => void };

type ViewProps = {
  history: SiteHistory | null;
  loading: boolean;
  error: string | null;
  editable: boolean;
  notes: SiteNotesField[];
};

function Scope({ history }: { history: SiteHistory | null }) {
  if (!history?.anchor) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted">
      <MapPin size={12} aria-hidden /> Within {history.anchor.radius_m} m of this site
    </span>
  );
}

function Notes({ field, editable }: { field: SiteNotesField; editable: boolean }) {
  return (
    <div className="mt-4">
      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted" htmlFor={`site-notes-${field.key}`}>
        {field.label}
      </label>
      <textarea
        id={`site-notes-${field.key}`}
        rows={3}
        readOnly={!editable}
        value={field.value}
        onChange={(event) => field.onChange(event.target.value)}
        placeholder={editable ? "Anything the list above does not show — records from other systems, conversations, site visits." : "No notes."}
        className="w-full rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm"
      />
    </div>
  );
}

function Status({ loading, error, empty }: { loading: boolean; error: string | null; empty: string | null }) {
  if (loading) return <div className="rounded-lg border border-dashed border-[var(--line)] p-6 text-center text-sm text-muted">Looking up this location…</div>;
  if (error) return <div className="rounded-lg border border-[var(--bad)] p-4 text-sm text-[var(--bad)]">{error}</div>;
  if (empty) return <div className="rounded-lg border border-dashed border-[var(--line)] p-6 text-center text-sm text-muted">{empty}</div>;
  return null;
}

/**
 * Record of incidents: every earlier report at this site, newest first, each
 * with its maintenance side underneath — what the crew reported, what the
 * coordinator decided, the actions taken, and the notes maintenance left.
 */
export function RecordOfIncidentsView(props: ViewProps) {
  const items = props.history?.incidents ?? [];
  const summary = summarizeRecord(items);
  const noSite = props.history && !props.history.anchor;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">
          {summary.total === 0 ? "No earlier incidents" : `${summary.total} earlier ${summary.total === 1 ? "incident" : "incidents"} here`}
        </span>
        {summary.recurrences ? <Chip tone="SAME_TYPE" icon={<Repeat2 size={12} />}>{summary.recurrences} {summary.recurrences === 1 ? "recurrence" : "recurrences"}</Chip> : null}
        {summary.differentType ? <Chip tone="DIFFERENT_TYPE" icon={<Shuffle size={12} />}>{summary.differentType} of a different type</Chip> : null}
        {summary.outsideRecord ? <Chip tone="UNCLASSIFIED">{summary.outsideRecord} not in the incident record</Chip> : null}
        <span className="ml-auto"><Scope history={props.history} /></span>
      </div>

      <Status
        loading={props.loading}
        error={props.error}
        empty={
          props.loading || props.error
            ? null
            : noSite
              ? "Record the site's location on the form to see what else has happened here."
              : items.length === 0
                ? "No earlier incidents or maintenance reports at this location."
                : null
        }
      />

      {items.length ? (
        <ol className="relative space-y-2 border-l-2 border-[var(--line)] pl-4">
          {items.map((item) => <IncidentItem key={item.incident_id} item={item} />)}
        </ol>
      ) : null}

      {props.notes.map((field) => <Notes key={field.key} field={field} editable={props.editable} />)}
    </div>
  );
}

function IncidentItem({ item }: { item: SiteIncident }) {
  const name = item.title ? ` · ${item.title}` : "";
  return (
    <li className="relative rounded-lg border border-[var(--line)] bg-[var(--panel)] p-3">
      <span
        className={`absolute -left-[23px] top-4 h-3 w-3 rounded-full border-2 border-[var(--panel)] ${item.in_record ? "bg-[var(--accent)]" : "bg-[var(--muted)]"}`}
        aria-hidden
      />
      <div className="flex flex-wrap items-center gap-2">
        {item.in_record ? (
          <Link to={`/incidents/${item.incident_id}`} className="text-sm font-semibold hover:underline">
            Incident #{item.incident_id}{name}
          </Link>
        ) : (
          <span className="text-sm font-semibold">Report #{item.incident_id}{name}</span>
        )}
        {item.in_record ? (
          <Chip tone={item.relation}>{RELATION_LABELS[item.relation]}</Chip>
        ) : item.outcome ? (
          <span className="rounded-full border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-0.5 text-[11px] font-medium">
            {OUTCOME_LABELS[item.outcome] ?? item.outcome}
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1"><CalendarDays size={12} aria-hidden />{dateLabel(item.observed_at)}</span>
        <span className="inline-flex items-center gap-1"><MapPin size={12} aria-hidden />{distanceLabel(item.distance_m, item.same_location)}</span>
        <span>{item.in_record ? recordStandingLabel(item.stage, item.assessment?.state ?? null) : "Not in the incident record"}</span>
        {item.event_group ? (
          <Link to={`/incident-groups/${item.event_group.id}`} className="hover:underline">
            Incident Group: {item.event_group.title ?? `#${item.event_group.id}`}
          </Link>
        ) : null}
      </div>
      {item.in_record && item.types.length ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {item.types.map((type) => (
            <span key={type.code} className="rounded-md bg-[var(--panel-soft)] px-1.5 py-0.5 text-[11px]">{type.label}</span>
          ))}
        </div>
      ) : null}
      <Maintenance side={item.maintenance} />
    </li>
  );
}

/** The maintenance side of one incident, as a sub-section of its entry. */
function Maintenance({ side }: { side: MaintenanceSide }) {
  const { report, triage } = side;
  return (
    <section className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3" aria-label="Maintenance">
      <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <Wrench size={12} aria-hidden /> Maintenance
      </h4>
      <dl className="grid gap-2.5 text-sm">
        <Row label="Reported">
          <span className="text-xs text-muted">
            {report.reported_by ? <span className="inline-flex items-center gap-1"><UserRound size={12} aria-hidden />{report.reported_by}</span> : "Reporter unknown"}
            {report.reported_at ? `, ${dateLabel(report.reported_at)}` : ""}
          </span>
          {report.description ? <p className="mt-0.5">{report.description}</p> : null}
        </Row>
        {triage ? (
          <Row label="Coordinator">
            <span className="font-medium">{OUTCOME_LABELS[triage.disposition ?? ""] ?? triage.disposition}</span>
            {triage.notes ? <Quote text={triage.notes} by={triage.decided_by} at={triage.decided_at} /> : null}
            {!triage.notes && triage.decided_by ? <span className="text-xs text-muted"> — {triage.decided_by}{triage.decided_at ? `, ${dateLabel(triage.decided_at)}` : ""}</span> : null}
          </Row>
        ) : null}
        {side.immediate_actions.length ? <Row label="Immediate actions"><Actions items={side.immediate_actions} /></Row> : null}
        {side.follow_up_actions.length ? <Row label="Follow-up actions"><Actions items={side.follow_up_actions} /></Row> : null}
        {side.notes.length ? (
          <Row label="Maintenance notes">
            <div className="grid gap-1.5">
              {side.notes.map((note, index) => <Quote key={index} text={note.text ?? ""} by={note.by} at={note.at} />)}
            </div>
          </Row>
        ) : null}
        {side.also_reported.length ? (
          <Row label="Also reported">
            <ul className="grid gap-1.5">
              {side.also_reported.map((dup) => (
                <li key={dup.incident_id} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-1.5">
                  <div className="text-xs text-muted">
                    Report #{dup.incident_id} · {dateLabel(dup.observed_at)}{dup.reported_by ? ` · ${dup.reported_by}` : ""}
                  </div>
                  {dup.description ? <p className="mt-0.5 text-sm">{dup.description}</p> : null}
                  {dup.coordinator_notes ? <Quote text={dup.coordinator_notes} by={dup.decided_by} at={dup.decided_at} /> : null}
                </li>
              ))}
            </ul>
          </Row>
        ) : null}
      </dl>
      {!hasMaintenanceRecord(side) ? <p className="mt-2 text-xs text-muted">No actions or notes from maintenance yet.</p> : null}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-xs font-semibold text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function Actions({ items }: { items: ActionRef[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((action) => (
        <span key={action.code} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-1.5 py-0.5 text-[11px]">{action.label}</span>
      ))}
    </div>
  );
}

function Quote({ text, by, at }: { text: string; by: string | null; at: string | null }) {
  return (
    <blockquote className="mt-1 flex gap-1.5 border-l-2 border-[var(--accent)] pl-2 text-xs text-muted">
      <MessageSquareText size={12} className="mt-0.5 shrink-0" aria-hidden />
      <span>
        <span className="text-[var(--ink)]">“{text}”</span>
        {by ? <span> — {by}{at ? `, ${dateLabel(at)}` : ""}</span> : null}
      </span>
    </blockquote>
  );
}

function Chip({ tone, icon, children }: { tone: SiteRelation; icon?: ReactNode; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${RELATION_TONES[tone]}`}>
      {icon}
      {children}
    </span>
  );
}
