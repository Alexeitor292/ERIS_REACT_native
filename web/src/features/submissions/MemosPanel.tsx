import { useEffect, useState, type ReactNode } from "react";
import { BookOpenText, ClipboardCheck, Eye, History, Lightbulb, Maximize2, PencilRuler, Wrench, X } from "lucide-react";

import { getSiteHistory, type SiteHistory } from "../../api/siteHistory";
import type { RichMemoKey } from "./memoContentModel";
import RichMemoEditor from "./RichMemoEditor";
import { MaintenanceHistoryView, RecordOfEventsView } from "./SiteHistoryViews";

type HistoryKey = "record_of_event_notes" | "maintenance_history_notes";
export type MemoTabKey = RichMemoKey | HistoryKey;

type Tab = {
  key: MemoTabKey;
  label: string;
  icon: ReactNode;
  kind: "document" | "record" | "maintenance";
  description: string;
  placeholder?: string;
};

const TABS: Tab[] = [
  {
    key: "observations_notes",
    label: "Observations",
    icon: <Eye size={15} />,
    kind: "document",
    description: "What you saw at the site: conditions, extent, anything unusual.",
    placeholder: "Describe what you observed on site…",
  },
  {
    key: "geotechnical_assessment_notes",
    label: "Geotechnical assessment",
    icon: <ClipboardCheck size={15} />,
    kind: "document",
    description: "Your judgement of the failure, its cause and the risk. Required before the form can be submitted.",
    placeholder: "Write the geotechnical assessment…",
  },
  {
    key: "recommendations_notes",
    label: "Recommendations",
    icon: <Lightbulb size={15} />,
    kind: "document",
    description: "What should be done, by whom, and how urgently.",
    placeholder: "Write your recommendations…",
  },
  {
    key: "sketchpad_notes",
    label: "Sketch notes",
    icon: <PencilRuler size={15} />,
    kind: "document",
    description: "Notes that go with the site sketch.",
    placeholder: "Notes for the sketch…",
  },
  {
    key: "record_of_event_notes",
    label: "Record of events",
    icon: <History size={15} />,
    kind: "record",
    description: "Earlier incidents at this location in the incident record: recurrences of this failure, and other types.",
  },
  {
    key: "maintenance_history_notes",
    label: "Maintenance history",
    icon: <Wrench size={15} />,
    kind: "maintenance",
    description: "What maintenance crews reported here, and what was decided.",
  },
];

type Props = {
  submissionId: number;
  memos: Record<RichMemoKey, string>;
  onMemoChange: (key: RichMemoKey, html: string) => void;
  notes: Record<HistoryKey, string>;
  onNotesChange: (key: HistoryKey, value: string) => void;
  editable: boolean;
  /** Site history needs an operational role; Guests and the Maintenance Crew only see the notes. */
  showSiteHistory: boolean;
  attachmentCount: (key: MemoTabKey) => number;
  onOpenAttachments: (key: MemoTabKey, label: string) => void;
  attachmentsButton: (count: number, onClick: () => void) => ReactNode;
};

/**
 * The form's memos: one dedicated view per memo behind a single tab bar. The
 * written memos are full documents; Record of events and Maintenance history
 * show what the system knows about the site, with room for notes.
 */
export default function MemosPanel(props: Props) {
  const [active, setActive] = useState<MemoTabKey>("observations_notes");
  const [focus, setFocus] = useState(false);
  const [history, setHistory] = useState<SiteHistory | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const tab = TABS.find((item) => item.key === active) ?? TABS[0];
  const needsHistory = tab.kind !== "document" && props.showSiteHistory;

  useEffect(() => {
    if (!needsHistory || history || historyLoading || historyError) return;
    setHistoryLoading(true);
    getSiteHistory(props.submissionId)
      .then(setHistory)
      .catch((error: unknown) => setHistoryError(error instanceof Error ? error.message : "Could not load this location's history."))
      .finally(() => setHistoryLoading(false));
  }, [needsHistory, history, historyLoading, historyError, props.submissionId]);

  useEffect(() => {
    if (!focus) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFocus(false);
    };
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, [focus]);

  const counts: Partial<Record<MemoTabKey, number>> = history
    ? { record_of_event_notes: history.record_of_events.length, maintenance_history_notes: history.maintenance_history.length }
    : {};

  const body = (tall: boolean) => {
    if (tab.kind === "document") {
      const key = tab.key as RichMemoKey;
      return (
        <RichMemoEditor
          key={key}
          value={props.memos[key]}
          onChange={(html) => props.onMemoChange(key, html)}
          editable={props.editable}
          placeholder={tab.placeholder ?? ""}
          documentTitle={tab.label}
          tall={tall}
        />
      );
    }
    const key = tab.key as HistoryKey;
    const view = {
      history: props.showSiteHistory ? history : null,
      loading: props.showSiteHistory && historyLoading,
      error: props.showSiteHistory ? historyError : null,
      notes: props.notes[key],
      onNotesChange: (value: string) => props.onNotesChange(key, value),
      editable: props.editable,
      notesLabel: tab.kind === "record" ? "Notes on earlier events" : "Notes on maintenance",
    };
    return tab.kind === "record" ? <RecordOfEventsView {...view} /> : <MaintenanceHistoryView {...view} />;
  };

  const header = (
    <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <span className="text-[var(--accent)]">{tab.icon}</span>
          {tab.label}
        </h3>
        <p className="text-xs text-muted">{tab.description}</p>
      </div>
      <div className="flex items-center gap-2">
        {props.attachmentsButton(props.attachmentCount(tab.key), () => props.onOpenAttachments(tab.key, tab.label))}
        {tab.kind === "document" ? (
          <button
            type="button"
            onClick={() => setFocus(!focus)}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2.5 py-1.5 text-xs font-medium hover:brightness-95"
            title={focus ? "Close the full-screen view (Esc)" : "Open this memo full screen"}
          >
            {focus ? <X size={13} aria-hidden /> : <Maximize2 size={13} aria-hidden />}
            {focus ? "Close" : "Full screen"}
          </button>
        ) : null}
      </div>
    </div>
  );

  return (
    <div>
      <div role="tablist" aria-label="Memos" className="eris-memo-tabs mb-4 flex gap-1 overflow-x-auto rounded-full border border-[var(--line)] bg-[var(--panel-soft)] p-1">
        {TABS.map((item) => {
          const selected = item.key === active;
          const count = counts[item.key];
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={(event) => {
                setActive(item.key);
                event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
              }}
              className={`flex min-w-max flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                selected ? "bg-[var(--accent)] text-white shadow-sm" : "text-[var(--ink)] hover:bg-[var(--panel)]"
              }`}
            >
              {item.icon}
              {item.label}
              {count ? (
                <span className={`rounded-full px-1.5 text-[10px] font-semibold ${selected ? "bg-white/25" : "bg-[var(--panel)]"}`}>{count}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" aria-label={tab.label}>
        {header}
        {focus && tab.kind === "document" ? (
          <div className="rounded-xl border border-dashed border-[var(--line)] p-6 text-center text-sm text-muted">
            <BookOpenText size={18} className="mx-auto mb-1" aria-hidden />
            Open in full screen.
          </div>
        ) : (
          body(false)
        )}
      </div>

      {focus && tab.kind === "document" ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-[var(--bg)]" role="dialog" aria-modal="true" aria-label={tab.label}>
          <div className="mx-auto flex w-full max-w-5xl min-h-0 flex-1 flex-col p-4">
            {header}
            <div className="min-h-0 flex-1 overflow-y-auto">{body(true)}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
