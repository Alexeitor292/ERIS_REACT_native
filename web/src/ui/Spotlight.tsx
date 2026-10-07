import { AnimatePresence, motion } from "framer-motion";
import { ChevronRight, ClipboardCheck, Layers, Search, TriangleAlert, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../api/client";
import { listAssessments } from "../api/assessments";

/**
 * Search across ERIS, Spotlight-style: a pill that opens with a soft
 * "blob" spring, the pages of the side navigation as round shortcuts beside
 * it, and results (pages, incidents, assessments, Incident Groups) that
 * fade in one after another. Ctrl/Cmd+K opens it; Escape closes it; the arrow
 * keys and Enter pick a result.
 */

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export type SpotlightPage = { label: string; to: string; icon: LucideIcon };

type Result = { key: string; icon: ReactNode; label: string; description: string; link: string; haystack: string };

const SVGFilter = () => (
  <svg width="0" height="0" aria-hidden className="absolute">
    <filter id="eris-blob">
      <feGaussianBlur stdDeviation="10" in="SourceGraphic" />
      <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -9" result="blob" />
      <feBlend in="SourceGraphic" in2="blob" />
    </filter>
  </svg>
);

function SpotlightPlaceholder({ text, className }: { text: string; className?: string }) {
  return (
    <motion.div layout className={cn("pointer-events-none absolute z-10 flex items-center", className)}>
      <AnimatePresence mode="popLayout">
        <motion.p
          key={`placeholder-${text}`}
          initial={{ opacity: 0, y: 10, filter: "blur(5px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -10, filter: "blur(5px)" }}
          transition={{ duration: 0.2, ease: "easeOut" }}
        >
          {text}
        </motion.p>
      </AnimatePresence>
    </motion.div>
  );
}

function ResultCard({ result, isLast, active }: { result: Result; isLast: boolean; active: boolean }) {
  return (
    <div
      className={cn(
        "group/card flex w-full items-center justify-start gap-3 rounded-xl px-2 py-2 text-[var(--ink)]",
        active ? "bg-[var(--panel)] shadow-md" : "hover:bg-[var(--panel)] hover:shadow-md",
        isLast && "rounded-b-3xl"
      )}
    >
      <div className="flex aspect-square size-8 items-center justify-center text-[var(--brand)] [&_svg]:size-6 [&_svg]:stroke-[1.5]">{result.icon}</div>
      <div className="flex min-w-0 flex-col text-left">
        <p className="truncate font-medium">{result.label}</p>
        <p className="truncate text-xs opacity-60">{result.description}</p>
      </div>
      <div className={cn("flex flex-1 items-center justify-end transition-opacity duration-200", active ? "opacity-100" : "opacity-0 group-hover/card:opacity-100")}>
        <ChevronRight className="size-6" />
      </div>
    </div>
  );
}

function useSearchIndex(open: boolean, pages: SpotlightPage[], records: boolean) {
  const [items, setItems] = useState<Result[]>([]);
  const loaded = useRef(false);
  useEffect(() => {
    if (!open || loaded.current) return;
    loaded.current = true;
    const pageResults: Result[] = pages.map((p) => ({
      key: `page-${p.to}`, icon: <p.icon />, label: p.label, description: "Go to page", link: p.to, haystack: p.label.toLowerCase(),
    }));
    setItems(pageResults);
    if (!records) return;
    Promise.allSettled([
      api<{ items: Array<{ id: number; title: string; description: string | null; route?: string | null; county?: string | null; status?: string }> }>("/incidents?limit=1000"),
      listAssessments({ limit: 1000 }),
      api<{ items: Array<{ id: number; title: string; description: string | null; event_group_key?: string; status?: string }> }>("/event-groups?status=ALL&limit=500"),
    ]).then(([incidents, assessments, groups]) => {
      const found: Result[] = [...pageResults];
      if (incidents.status === "fulfilled") {
        for (const i of incidents.value.items ?? []) {
          found.push({
            key: `incident-${i.id}`, icon: <TriangleAlert />, label: i.title || `Incident #${i.id}`,
            description: `Incident #${i.id}${i.status ? ` · ${i.status.replace(/_/g, " ").toLowerCase()}` : ""}${i.description ? ` · ${i.description.slice(0, 80)}` : ""}`,
            link: `/incidents/${i.id}`, haystack: `${i.title} ${i.description ?? ""} incident ${i.id} ${i.route ?? ""} ${i.county ?? ""}`.toLowerCase(),
          });
        }
      }
      if (assessments.status === "fulfilled") {
        for (const a of assessments.value.items ?? []) {
          const state = String(a.state ?? "").replace(/_/g, " ").toLowerCase();
          const office = a.routed_office_name ?? a.office_code ?? "";
          found.push({
            key: `assessment-${a.id}`, icon: <ClipboardCheck />, label: `Assessment #${a.id} · Incident #${a.incident_id}`,
            description: [state, office, a.assigned_user_name ?? ""].filter(Boolean).join(" · "),
            link: `/assessments/${a.id}`,
            haystack: `assessment ${a.id} incident ${a.incident_id} ${state} ${office} ${a.assigned_user_name ?? ""} ${a.branch_chief_name ?? ""}`.toLowerCase(),
          });
        }
      }
      if (groups.status === "fulfilled") {
        for (const g of groups.value.items ?? []) {
          found.push({
            key: `group-${g.id}`, icon: <Layers />, label: g.title || `Incident Group #${g.id}`,
            description: `Incident Group${g.event_group_key ? ` · ${g.event_group_key}` : ""}${g.status ? ` · ${g.status.toLowerCase()}` : ""}`,
            link: `/incident-groups/${g.id}`, haystack: `${g.title} ${g.description ?? ""} group ${g.event_group_key ?? ""} ${g.id}`.toLowerCase(),
          });
        }
      }
      setItems(found);
    });
  }, [open, pages, records]);
  return items;
}

export default function Spotlight({
  open,
  onClose,
  pages,
  searchRecords,
}: {
  open: boolean;
  onClose: () => void;
  /** The side navigation's pages: the first four are the round shortcuts. */
  pages: SpotlightPage[];
  /** Search incidents, assessments and groups too (operational users). */
  searchRecords: boolean;
}) {
  const navigate = useNavigate();
  const [hovered, setHovered] = useState(false);
  const [hoveredResult, setHoveredResult] = useState<number | null>(null);
  const [hoveredShortcut, setHoveredShortcut] = useState<number | null>(null);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const index = useSearchIndex(open, pages, searchRecords);
  const shortcuts = pages.slice(0, 4);

  const results = useMemo(() => {
    const terms = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    return index.filter((r) => terms.every((t) => r.haystack.includes(t))).slice(0, 12);
  }, [index, value]);

  useEffect(() => {
    if (open) {
      setValue("");
      setHoveredResult(null);
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  function go(link: string) {
    onClose();
    navigate(link);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") onClose();
    if (!results.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHoveredResult((i) => (i == null ? 0 : Math.min(results.length - 1, i + 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHoveredResult((i) => (i == null ? 0 : Math.max(0, i - 1)));
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(results[hoveredResult ?? 0].link);
    }
  }

  const placeholder =
    hoveredShortcut !== null ? shortcuts[hoveredShortcut]?.label ?? "Search ERIS"
      : hoveredResult !== null && results[hoveredResult] ? results[hoveredResult].label
      : "Search ERIS";

  return (
    <AnimatePresence mode="wait">
      {open && (
        <motion.div
          key="spotlight"
          initial={{ opacity: 0, filter: "blur(20px) url(#eris-blob)", scaleX: 1.3, scaleY: 1.1, y: -10 }}
          animate={{ opacity: 1, filter: "blur(0px) url(#eris-blob)", scaleX: 1, scaleY: 1, y: 0 }}
          exit={{ opacity: 0, filter: "blur(20px) url(#eris-blob)", scaleX: 1.3, scaleY: 1.1, y: 10 }}
          transition={{ stiffness: 550, damping: 50, type: "spring" }}
          className="fixed inset-0 z-[90] flex flex-col items-center justify-start px-4 pt-[18vh]"
          onClick={onClose}
          onKeyDown={onKeyDown}
          role="dialog"
          aria-modal="true"
          aria-label="Search ERIS"
        >
          <div aria-hidden className="absolute inset-0 bg-[color:color-mix(in_oklab,var(--bg)_55%,transparent)] backdrop-blur-[2px]" />
          <SVGFilter />
          <div
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => {
              setHovered(false);
              setHoveredShortcut(null);
            }}
            onClick={(e) => e.stopPropagation()}
            style={{ filter: "url(#eris-blob)" }}
            className={cn(
              "group relative z-20 flex w-full max-w-3xl items-start justify-end gap-4",
              "[&>div]:rounded-full [&>div]:bg-[var(--panel-soft)] [&>div]:text-[var(--ink)] [&>div]:backdrop-blur-xl",
              "[&_svg]:size-7 [&_svg]:stroke-[1.4]"
            )}
          >
            <AnimatePresence mode="popLayout">
              <motion.div
                key="search-input-container"
                layoutId="search-input-container"
                transition={{ layout: { duration: 0.5, type: "spring", bounce: 0.2 } }}
                style={{ borderRadius: "30px" }}
                className="relative z-10 flex h-full w-full flex-col items-center justify-start overflow-hidden border border-[var(--line)] shadow-lg"
              >
                <div className="flex h-16 w-full items-center justify-start gap-2 px-6">
                  <motion.div layoutId="search-icon" className="text-muted"><Search /></motion.div>
                  <div className="relative flex-1 text-2xl">
                    {hoveredResult !== null || !value ? (
                      <SpotlightPlaceholder
                        text={placeholder}
                        className={hoveredResult !== null && value ? "bg-[var(--panel)] text-[var(--ink)]" : "text-muted"}
                      />
                    ) : null}
                    <motion.input
                      ref={inputRef}
                      layout="position"
                      type="text"
                      value={value}
                      onChange={(e) => {
                        setValue(e.target.value);
                        setHoveredResult(null);
                      }}
                      aria-label="Search ERIS"
                      className="w-full bg-transparent text-[var(--ink)] outline-none"
                    />
                  </div>
                  <kbd className="hidden rounded border border-[var(--line)] px-1.5 py-0.5 text-[11px] font-medium text-muted sm:inline">Esc</kbd>
                </div>

                {value ? (
                  <motion.div
                    layout
                    onMouseLeave={() => setHoveredResult(null)}
                    className="flex max-h-96 w-full flex-col overflow-y-auto border-t border-[var(--line)] bg-[var(--panel-soft)] px-2 py-2"
                  >
                    {results.length ? (
                      results.map((result, i) => (
                        <motion.button
                          type="button"
                          key={result.key}
                          onMouseEnter={() => setHoveredResult(i)}
                          onClick={() => go(result.link)}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ delay: Math.min(i, 8) * 0.05, duration: 0.2, ease: "easeOut" }}
                          className="w-full overflow-hidden"
                        >
                          <ResultCard result={result} isLast={i === results.length - 1} active={hoveredResult === i} />
                        </motion.button>
                      ))
                    ) : (
                      <p className="px-3 py-3 text-sm text-muted">Nothing in ERIS matches “{value}”.</p>
                    )}
                  </motion.div>
                ) : null}
              </motion.div>
              {hovered &&
                !value &&
                shortcuts.map((shortcut, i) => (
                  <motion.div
                    key={`shortcut-${shortcut.to}`}
                    onMouseEnter={() => setHoveredShortcut(i)}
                    layout
                    initial={{ scale: 0.7, x: -1 * (64 * (i + 1)) }}
                    animate={{ scale: 1, x: 0 }}
                    exit={{ scale: 0.7, x: 16 * (shortcuts.length - i - 1) + 64 * (shortcuts.length - i - 1) }}
                    transition={{ duration: 0.8, type: "spring", bounce: 0.2, delay: i * 0.05 }}
                    className="cursor-pointer rounded-full"
                  >
                    <button
                      type="button"
                      onClick={() => go(shortcut.to)}
                      aria-label={shortcut.label}
                      className="rounded-full opacity-40 transition-[opacity,box-shadow] duration-200 hover:opacity-100 hover:shadow-lg"
                    >
                      <span className="flex aspect-square size-16 items-center justify-center"><shortcut.icon /></span>
                    </button>
                  </motion.div>
                ))}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
