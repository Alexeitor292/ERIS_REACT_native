import { AnimatePresence, motion } from "framer-motion";
import {
  Building2,
  ChevronRight,
  ClipboardCheck,
  FileText,
  GitBranch,
  Layers,
  Search,
  TriangleAlert,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../api/client";
import { listAssessments } from "../api/assessments";
import type { MaintenancePayload, TreePayload, TreePerson } from "../api/orgTree";
import { districtWords, search, type SearchEntry, type SearchKind } from "./searchModel";

/**
 * Search in the top bar. At rest a pill; clicked, it widens and the side
 * menu's first pages split off it as small bubbles (the gooey "blob" filter);
 * typed into, results drop down from it. It finds pages, people and where
 * they sit, offices and branches, incidents, assessments, Incident Groups and
 * technical forms (searchModel.ts decides what matches). Ctrl/Cmd+K focuses it.
 */

export type SearchPage = { label: string; to: string; icon: LucideIcon };

const KIND: Record<SearchKind, { label: string; icon: LucideIcon }> = {
  page: { label: "Page", icon: ChevronRight },
  person: { label: "Person", icon: UserRound },
  office: { label: "Office", icon: Building2 },
  branch: { label: "Branch", icon: GitBranch },
  incident: { label: "Incident", icon: TriangleAlert },
  assessment: { label: "Assessment", icon: ClipboardCheck },
  group: { label: "Incident Group", icon: Layers },
  form: { label: "Technical form", icon: FileText },
};

const POSITION: Record<string, string> = {
  OFFICE_CHIEF: "Office Chief",
  SENIOR_SPECIALIST: "Senior Specialist",
  BRANCH_CHIEF: "Branch Chief",
  STAFF: "Staff",
};

const human = (value: string | null | undefined) => String(value ?? "").replace(/_/g, " ").toLowerCase();

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

type IncidentRow = {
  id: number; title: string; description: string | null; incident_key?: string | null; status?: string; current_stage?: string;
  district: string | null; county: string | null; route: string | null; post_mile: string | null; reporter_name?: string | null; reporter_email?: string | null;
};
type GroupRow = { id: number; title: string; description: string | null; event_group_key?: string; status?: string };
type FormRow = { id: number; title?: string | null; status: string; district?: string | null; county?: string | null; route?: string | null; post_mile?: string | null };

function useSearchIndex(active: boolean, pages: SearchPage[], records: boolean): SearchEntry[] {
  const [entries, setEntries] = useState<SearchEntry[]>([]);
  const loaded = useRef(false);
  useEffect(() => {
    if (!active || loaded.current) return;
    loaded.current = true;
    const found: SearchEntry[] = pages.map((p) => ({
      key: `page-${p.to}`, kind: "page", label: p.label, description: "Go to page", link: p.to,
      fields: [{ text: p.label, weight: 3 }, { text: p.to.replace(/\//g, " "), weight: 1 }, { text: p.to === "/settings" ? "profile theme dark light preferences account" : "", weight: 1 }],
    }));
    setEntries([...found]);

    const people = new Map<number, SearchEntry>();
    const addPerson = (person: { id: number; full_name: string; email: string }, role: string, where: string, link: string) => {
      const existing = people.get(person.id);
      if (existing) {
        existing.description += ` · ${role}${where ? `, ${where}` : ""}`;
        existing.fields.push({ text: `${role} ${where}`, weight: 1 });
        return;
      }
      people.set(person.id, {
        key: `person-${person.id}`, kind: "person", label: person.full_name || person.email,
        description: `${role}${where ? ` · ${where}` : ""}`, link,
        fields: [{ text: person.full_name, weight: 3 }, { text: person.email, weight: 2 }, { text: `${role} ${where}`, weight: 1 }],
      });
    };

    const loads: Array<Promise<void>> = [
      api<TreePayload>("/org/tree").then((tree) => {
        for (const o of tree.offices) {
          const officeName = o.office.short_name || o.office.name;
          const link = `/organization?office=${o.office.id}`;
          found.push({
            key: `office-${o.office.id}`, kind: "office", label: o.office.name,
            description: [o.office.code, o.office.unit_number, o.office.districts.length ? `serves ${o.office.districts.map(Number).join(", ")}` : ""].filter(Boolean).join(" · "),
            link,
            fields: [{ text: o.office.name, weight: 3 }, { text: `${o.office.short_name ?? ""} ${o.office.code} ${o.office.unit_number ?? ""}`, weight: 2 }, { text: `${o.office.home_city ?? ""} ${o.office.districts.map(districtWords).join(" ")}`, weight: 1 }],
          });
          const place = (p: TreePerson, where: string) => addPerson(p, POSITION[p.position ?? ""] ?? "Staff", where, link);
          o.chiefs.forEach((p) => place(p, officeName));
          o.specialists.forEach((p) => place(p, officeName));
          for (const b of o.branches) {
            const branchName = b.letter ? `Branch ${b.letter}` : b.name;
            found.push({
              key: `branch-${b.id}`, kind: "branch", label: `${branchName} · ${officeName}`,
              description: [b.name !== branchName ? b.name : "", b.chief ? `Chief ${b.chief.full_name}` : "", `${b.staff.length} staff`].filter(Boolean).join(" · "),
              link,
              fields: [{ text: `${branchName} ${b.name}`, weight: 3 }, { text: officeName, weight: 1 }, { text: `${b.home_city ?? ""} ${districtWords(b.home_district)}`, weight: 1 }],
            });
            if (b.chief) place(b.chief, `${branchName}, ${officeName}`);
            b.staff.forEach((p) => place(p, `${branchName}, ${officeName}`));
          }
        }
      }),
      api<MaintenancePayload>("/org/maintenance").then((lists) => {
        for (const d of lists.districts) {
          const where = `District ${Number(d.district)}`;
          d.coordinators.forEach((p) => addPerson(p, "Maintenance Coordinator", where, "/organization?tab=maintenance"));
          d.crew.forEach((p) => addPerson(p, "Maintenance Crew", where, "/organization?tab=maintenance"));
        }
      }),
    ];
    let incidents: IncidentRow[] = [];
    loads.push(
        api<{ items: IncidentRow[] }>("/incidents?limit=1000").then((r) => {
          incidents = r.items ?? [];
          for (const i of incidents) {
            const place = [i.county, i.route ? `route ${i.route}` : "", i.post_mile ? `PM ${i.post_mile}` : ""].filter(Boolean).join(" ");
            found.push({
              key: `incident-${i.id}`, kind: "incident", label: i.title || `Incident #${i.id}`,
              description: [`#${i.id}`, human(i.current_stage || i.status), i.reporter_name ? `reported by ${i.reporter_name}` : ""].filter(Boolean).join(" · "),
              link: `/incidents/${i.id}`,
              fields: [
                { text: `${i.title} ${i.incident_key ?? ""}`, weight: 3 },
                { text: `${i.reporter_name ?? ""} ${i.reporter_email ?? ""}`, weight: 2 },
                { text: `incident ${i.id} ${place} ${districtWords(i.district)} ${human(i.status)} ${human(i.current_stage)}`, weight: 1.5 },
                { text: i.description, weight: 1 },
              ],
            });
          }
        }),
    );
    if (records) {
      loads.push(
        api<{ items: GroupRow[] }>("/event-groups?status=ALL&limit=500").then((r) => {
          for (const g of r.items ?? []) {
            found.push({
              key: `group-${g.id}`, kind: "group", label: g.title || `Incident Group #${g.id}`,
              description: [g.event_group_key, human(g.status)].filter(Boolean).join(" · "), link: `/incident-groups/${g.id}`,
              fields: [{ text: `${g.title} ${g.event_group_key ?? ""}`, weight: 3 }, { text: `group ${g.id}`, weight: 1.5 }, { text: g.description, weight: 1 }],
            });
          }
        }),
        api<{ items: FormRow[] }>("/submissions/page?limit=200").then((r) => {
          for (const f of r.items ?? []) {
            found.push({
              key: `form-${f.id}`, kind: "form", label: f.title || `Technical form #${f.id}`,
              description: [`#${f.id}`, human(f.status)].join(" · "), link: `/submissions/${f.id}`,
              fields: [{ text: f.title, weight: 3 }, { text: `form ${f.id} ${f.county ?? ""} route ${f.route ?? ""} ${f.post_mile ?? ""} ${districtWords(f.district)} ${human(f.status)}`, weight: 1.5 }],
            });
          }
        }),
      );
    }
    void Promise.allSettled(loads).then(async () => {
      if (records) {
        // Assessments read best by their incident's title.
        try {
          const byIncident = new Map(incidents.map((i) => [i.id, i]));
          for (const a of (await listAssessments({ limit: 1000 })).items ?? []) {
            const incident = byIncident.get(a.incident_id);
            const office = a.routed_office_name ?? a.office_code ?? "";
            found.push({
              key: `assessment-${a.id}`, kind: "assessment", label: `Assessment #${a.id}${incident ? ` · ${incident.title}` : ""}`,
              description: [human(a.state), office, a.assigned_user_name ? `assigned to ${a.assigned_user_name}` : "", a.branch_chief_name ? `chief ${a.branch_chief_name}` : ""].filter(Boolean).join(" · "),
              link: `/assessments/${a.id}`,
              fields: [
                { text: `assessment ${a.id} ${incident?.title ?? ""}`, weight: 3 },
                { text: `${a.assigned_user_name ?? ""} ${a.branch_chief_name ?? ""}`, weight: 2 },
                { text: `incident ${a.incident_id} ${office} ${a.routed_branch_name ?? ""} ${human(a.state)}`, weight: 1.5 },
              ],
            });
          }
        } catch {
          // Search what loaded.
        }
      }
      setEntries([...found, ...people.values()]);
    });
  }, [active, pages, records]);
  return entries;
}

const SVGFilter = () => (
  <svg width="0" height="0" aria-hidden className="absolute">
    <filter id="eris-blob">
      <feGaussianBlur stdDeviation="6" in="SourceGraphic" />
      <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -9" result="blob" />
      <feBlend in="SourceGraphic" in2="blob" />
    </filter>
  </svg>
);

export default function HeaderSearch({ pages, searchRecords }: { pages: SearchPage[]; searchRecords: boolean }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [active, setActive] = useState(0);
  const [hoveredShortcut, setHoveredShortcut] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const entries = useSearchIndex(open, pages, searchRecords);
  const results = useMemo(() => (value.trim() ? search(entries, value) : []), [entries, value]);
  const shortcuts = pages.slice(0, 4);

  // Ctrl/Cmd+K opens it from anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A click elsewhere closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => setActive(0), [value]);

  function close() {
    setOpen(false);
    setValue("");
    setHoveredShortcut(null);
    inputRef.current?.blur();
  }

  function go(link: string) {
    close();
    navigate(link);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") return close();
    if (!results.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(results[active].link);
    }
  }

  const placeholder = hoveredShortcut !== null ? shortcuts[hoveredShortcut]?.label ?? "Search ERIS" : open ? "People, incidents, assessments, offices…" : "Search ERIS";

  return (
    <div ref={rootRef} className="relative flex w-full justify-center">
      <SVGFilter />
      <div className="flex items-center gap-2" style={open && !value ? { filter: "url(#eris-blob)" } : undefined}>
        <motion.div
          layout
          initial={false}
          animate={{ width: open ? 460 : 300 }}
          transition={{ type: "spring", stiffness: 380, damping: 32 }}
          onClick={() => {
            setOpen(true);
            inputRef.current?.focus();
          }}
          className={cn(
            "relative flex h-10 max-w-[56vw] cursor-text items-center gap-2 rounded-full border px-4 transition-[background-color,border-color,box-shadow]",
            open
              ? "border-[color:color-mix(in_oklab,var(--brand)_45%,var(--line))] bg-[var(--panel)] shadow-[0_6px_24px_rgba(15,23,42,0.12)]"
              : "border-[var(--line)] bg-[var(--panel-soft)] hover:border-[color:color-mix(in_oklab,var(--brand)_35%,var(--line))]"
          )}
        >
          <Search size={16} className="shrink-0 text-muted" aria-hidden />
          <div className="relative min-w-0 flex-1">
            {!value ? (
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={placeholder}
                  initial={{ opacity: 0, y: 6, filter: "blur(4px)" }}
                  animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  exit={{ opacity: 0, y: -6, filter: "blur(4px)" }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  className="pointer-events-none absolute inset-y-0 left-0 flex items-center truncate text-sm text-muted"
                >
                  {placeholder}
                </motion.span>
              </AnimatePresence>
            ) : null}
            <input
              ref={inputRef}
              value={value}
              onFocus={() => setOpen(true)}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={onKeyDown}
              aria-label="Search ERIS"
              aria-expanded={open && !!value}
              aria-controls="eris-search-results"
              role="combobox"
              className="h-10 w-full bg-transparent text-sm text-[var(--ink)] outline-none"
            />
          </div>
          {value ? (
            <button type="button" aria-label="Clear search" onClick={() => setValue("")} className="rounded-full p-1 text-muted hover:bg-[var(--panel-soft)] hover:text-[var(--ink)]">
              <X size={14} />
            </button>
          ) : !open ? (
            <kbd className="hidden rounded-md border border-[var(--line)] bg-[var(--panel)] px-1.5 py-0.5 text-[10px] font-medium text-muted lg:inline">Ctrl K</kbd>
          ) : null}
        </motion.div>

        {/* The pages split off the pill as small bubbles. */}
        <AnimatePresence>
          {open && !value
            ? shortcuts.map((shortcut, i) => (
                <motion.button
                  type="button"
                  key={shortcut.to}
                  onMouseEnter={() => setHoveredShortcut(i)}
                  onMouseLeave={() => setHoveredShortcut(null)}
                  onClick={() => go(shortcut.to)}
                  aria-label={shortcut.label}
                  initial={{ scale: 0.6, x: -1 * (48 * (i + 1)), opacity: 0 }}
                  animate={{ scale: 1, x: 0, opacity: 1 }}
                  exit={{ scale: 0.6, x: -1 * (48 * (i + 1)), opacity: 0 }}
                  transition={{ type: "spring", bounce: 0.25, duration: 0.7, delay: i * 0.05 }}
                  className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--panel)] text-muted shadow-sm hover:text-[var(--brand)] xl:flex"
                >
                  <shortcut.icon size={17} strokeWidth={1.8} aria-hidden />
                </motion.button>
              ))
            : null}
        </AnimatePresence>
      </div>

      {/* Results drop from the bubble. */}
      <AnimatePresence>
        {open && value ? (
          <div className="pointer-events-none absolute inset-x-0 top-[calc(100%+8px)] z-50 flex justify-center">
          <motion.div
            id="eris-search-results"
            role="listbox"
            initial={{ opacity: 0, y: -8, scaleY: 0.92, filter: "blur(6px)" }}
            animate={{ opacity: 1, y: 0, scaleY: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -8, scaleY: 0.92, filter: "blur(6px)" }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
            style={{ transformOrigin: "top center" }}
            className="pointer-events-auto w-[min(560px,92vw)] overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--panel)] shadow-[0_18px_48px_rgba(15,23,42,0.18)]"
          >
            {results.length ? (
              <ul className="max-h-[60vh] overflow-y-auto p-1.5">
                {results.map((result, i) => {
                  const kind = KIND[result.kind];
                  const Icon = kind.icon;
                  return (
                    <motion.li
                      key={result.key}
                      role="option"
                      aria-selected={i === active}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: Math.min(i, 8) * 0.03, duration: 0.18 }}
                    >
                      <button
                        type="button"
                        onMouseEnter={() => setActive(i)}
                        onClick={() => go(result.link)}
                        className={cn(
                          "group flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left",
                          i === active ? "bg-[color:color-mix(in_oklab,var(--brand)_9%,var(--panel))]" : "hover:bg-[var(--panel-soft)]"
                        )}
                      >
                        <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", i === active ? "bg-[var(--brand)] text-white" : "bg-[var(--panel-soft)] text-[var(--brand)]")}>
                          <Icon size={16} strokeWidth={1.8} aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-[var(--ink)]">{result.label}</span>
                          <span className="block truncate text-xs text-muted">{result.description}</span>
                        </span>
                        <span className="shrink-0 rounded-full border border-[var(--line)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">{kind.label}</span>
                      </button>
                    </motion.li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-4 py-4 text-sm text-muted">{entries.length ? `Nothing in ERIS matches “${value}”.` : "Loading ERIS…"}</p>
            )}
            <div className="flex items-center gap-3 border-t border-[var(--line)] bg-[var(--panel-soft)] px-4 py-2 text-[11px] text-muted">
              <span>↑↓ to move</span>
              <span>Enter to open</span>
              <span>Esc to close</span>
            </div>
          </motion.div>
          </div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
