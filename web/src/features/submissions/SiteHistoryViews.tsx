import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { CalendarDays, MapPin, Repeat2, Shuffle, UserRound, Wrench } from "lucide-react";

import type { MaintenanceRecord, RecordEvent, SiteHistory } from "../../api/siteHistory";
import {
  distanceLabel,
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

type ViewProps = {
  history: SiteHistory | null;
  loading: boolean;
  error: string | null;
  notes: string;
  onNotesChange: (value: string) => void;
  editable: boolean;
  notesLabel: string;
};

function Scope({ history }: { history: SiteHistory | null }) {
  if (!history?.anchor) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted">
      <MapPin size={12} aria-hidden /> Within {history.anchor.radius_m} m of this site
    </span>
  );
}

function Notes({ notes, onNotesChange, editable, notesLabel }: Pick<ViewProps, "notes" | "onNotesChange" | "editable" | "notesLabel">) {
  return (
    <div className="mt-4">
      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted" htmlFor={`site-notes-${notesLabel}`}>
        {notesLabel}
      </label>
      <textarea
        id={`site-notes-${notesLabel}`}
        rows={3}
        readOnly={!editable}
        value={notes}
        onChange={(event) => onNotesChange(event.target.value)}
        placeholder={editable ? "Anything the lists above do not show — records from other systems, conversations, site visits." : "No notes."}
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

export function RecordOfEventsView(props: ViewProps) {
  const items = props.history?.record_of_events ?? [];
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
                ? "Nothing else in the incident record at this location."
                : null
        }
      />

      {items.length ? (
        <ol className="relative space-y-2 border-l-2 border-[var(--line)] pl-4">
          {items.map((item) => <RecordItem key={item.incident_id} item={item} />)}
        </ol>
      ) : null}

      <Notes {...props} />
    </div>
  );
}

function RecordItem({ item }: { item: RecordEvent }) {
  return (
    <li className="relative rounded-lg border border-[var(--line)] bg-[var(--panel)] p-3">
      <span className="absolute -left-[23px] top-4 h-3 w-3 rounded-full border-2 border-[var(--panel)] bg-[var(--accent)]" aria-hidden />
      <div className="flex flex-wrap items-center gap-2">
        <Link to={`/incidents/${item.incident_id}`} className="text-sm font-semibold hover:underline">
          Incident #{item.incident_id}{item.title ? ` · ${item.title}` : ""}
        </Link>
        <Chip tone={item.relation}>{RELATION_LABELS[item.relation]}</Chip>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1"><CalendarDays size={12} aria-hidden />{dateLabel(item.observed_at)}</span>
        <span className="inline-flex items-center gap-1"><MapPin size={12} aria-hidden />{distanceLabel(item.distance_m, item.same_location)}</span>
        <span>{recordStandingLabel(item.stage, item.assessment?.state ?? null)}</span>
        {item.event_group ? (
          <Link to={`/incident-groups/${item.event_group.id}`} className="hover:underline">
            Incident Group: {item.event_group.title ?? `#${item.event_group.id}`}
          </Link>
        ) : null}
      </div>
      {item.types.length ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {item.types.map((type) => (
            <span key={type.code} className="rounded-md bg-[var(--panel-soft)] px-1.5 py-0.5 text-[11px]">{type.label}</span>
          ))}
        </div>
      ) : null}
    </li>
  );
}

export function MaintenanceHistoryView(props: ViewProps) {
  const items = props.history?.maintenance_history ?? [];
  const noSite = props.history && !props.history.anchor;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">
          {items.length === 0 ? "No maintenance reports" : `${items.length} maintenance ${items.length === 1 ? "report" : "reports"} here`}
        </span>
        <span className="ml-auto"><Scope history={props.history} /></span>
      </div>

      <Status
        loading={props.loading}
        error={props.error}
        empty={
          props.loading || props.error
            ? null
            : noSite
              ? "Record the site's location on the form to see its maintenance history."
              : items.length === 0
                ? "No maintenance reports at this location."
                : null
        }
      />

      {items.length ? (
        <ol className="relative space-y-2 border-l-2 border-[var(--line)] pl-4">
          {items.map((item) => <MaintenanceItem key={item.incident_id} item={item} />)}
        </ol>
      ) : null}

      <Notes {...props} />
    </div>
  );
}

function MaintenanceItem({ item }: { item: MaintenanceRecord }) {
  return (
    <li className="relative rounded-lg border border-[var(--line)] bg-[var(--panel)] p-3">
      <span className="absolute -left-[23px] top-4 flex h-3 w-3 items-center justify-center rounded-full border-2 border-[var(--panel)] bg-[var(--muted)]" aria-hidden />
      <div className="flex flex-wrap items-center gap-2">
        <Wrench size={14} className="text-muted" aria-hidden />
        <span className="text-sm font-semibold">{item.title ?? `Report #${item.incident_id}`}</span>
        {item.outcome ? (
          <span className="rounded-full border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-0.5 text-[11px] font-medium">
            {OUTCOME_LABELS[item.outcome] ?? item.outcome}
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1"><CalendarDays size={12} aria-hidden />{dateLabel(item.observed_at)}</span>
        <span className="inline-flex items-center gap-1"><MapPin size={12} aria-hidden />{distanceLabel(item.distance_m, item.same_location)}</span>
        {item.reported_by ? <span className="inline-flex items-center gap-1"><UserRound size={12} aria-hidden />{item.reported_by}</span> : null}
      </div>
      {item.description ? <p className="mt-2 text-sm">{item.description}</p> : null}
      {item.coordinator_notes || item.decided_by ? (
        <blockquote className="mt-2 border-l-2 border-[var(--accent)] pl-2 text-xs text-muted">
          {item.coordinator_notes ? <span className="text-[var(--ink)]">“{item.coordinator_notes}”</span> : null}
          {item.decided_by ? <span> — {item.decided_by}{item.decided_at ? `, ${dateLabel(item.decided_at)}` : ""}</span> : null}
        </blockquote>
      ) : null}
    </li>
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
