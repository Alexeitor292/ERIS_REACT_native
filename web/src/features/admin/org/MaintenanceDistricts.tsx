import { useMemo, useState } from "react";
import { ChevronRight, HardHat, Plus, Radio, Star, TriangleAlert, X } from "lucide-react";

import { DISTRICT_HQ, type MaintenanceDistrict, type UnplacedPerson } from "../../../api/orgTree";

type Kind = "coordinators" | "crew";

/**
 * Each Caltrans district opens into its Maintenance Coordinators and its
 * Maintenance Crew. Being on a district's list is what makes somebody a
 * coordinator or crew; being on none (and in no office tree) makes them a guest.
 */
export default function MaintenanceDistricts({
  districts,
  unplaced,
  onAdd,
  onRemove,
  onMakePrimary,
}: {
  districts: MaintenanceDistrict[];
  unplaced: UnplacedPerson[];
  onAdd: (district: string, kind: Kind) => void;
  onRemove: (district: string, kind: Kind, person: { id: number; full_name: string }) => void;
  onMakePrimary: (district: string, userId: number) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const uncovered = districts.filter((d) => !d.coordinators.length).map((d) => Number(d.district));

  return (
    <div className="space-y-3">
      {uncovered.length ? (
        <div className="flex items-start gap-2 rounded-lg border border-[color:color-mix(in_oklab,var(--bad)_40%,var(--line))] bg-[color:color-mix(in_oklab,var(--bad)_7%,var(--panel))] px-3 py-2 text-sm">
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-[var(--bad)]" aria-hidden />
          <span>
            <strong>No coordinator in District {uncovered.join(", ")}.</strong>{" "}
            <span className="text-muted">Field reports filed there notify nobody until a coordinator is added.</span>
          </span>
        </div>
      ) : null}
      {unplaced.length ? (
        <div className="rounded-lg border border-[color:color-mix(in_oklab,var(--warn)_45%,var(--line))] bg-[color:color-mix(in_oklab,var(--warn)_7%,var(--panel))] px-3 py-2 text-sm">
          <strong>Not on any district list yet:</strong>{" "}
          {unplaced.map((p) => `${p.full_name} (${p.role === "MAINTENANCE_COORDINATOR" ? "coordinator" : "crew"})`).join(", ")}.{" "}
          <span className="text-muted">They keep their role until they are added to a district or changed.</span>
        </div>
      ) : null}

      <ul className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
        {districts.map((d) => {
          const isOpen = !!open[d.district];
          return (
            <li key={d.district} className="border-b border-[var(--line)] last:border-b-0">
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen((cur) => ({ ...cur, [d.district]: !cur[d.district] }))}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--panel-soft)]"
              >
                <ChevronRight size={16} className={`shrink-0 text-muted transition-transform ${isOpen ? "rotate-90" : ""}`} aria-hidden />
                <span className="flex h-8 w-10 shrink-0 items-center justify-center rounded-md bg-[var(--brand)] text-sm font-bold tabular-nums text-white">D{Number(d.district)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">District {Number(d.district)}</span>
                  <span className="block text-xs text-muted">{DISTRICT_HQ[d.district] ?? ""}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs">
                  <Count icon={<Radio size={12} />} n={d.coordinators.length} label="coordinator" warn={!d.coordinators.length} />
                  <Count icon={<HardHat size={12} />} n={d.crew.length} label="crew" />
                </span>
              </button>
              {isOpen ? (
                <div className="grid gap-3 border-t border-[var(--line)] bg-[var(--panel-soft)] px-4 py-3 lg:grid-cols-2">
                  <Section
                    title="Maintenance Coordinators"
                    icon={<Radio size={14} />}
                    people={d.coordinators}
                    addLabel="Add coordinator"
                    empty="No coordinator: reports filed here notify nobody."
                    onAdd={() => onAdd(d.district, "coordinators")}
                    onRemove={(p) => onRemove(d.district, "coordinators", p)}
                    renderExtra={(p) =>
                      "is_primary" in p && p.is_primary ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-[color:color-mix(in_oklab,var(--brand)_12%,var(--panel))] px-2 py-0.5 text-[10px] font-semibold text-[var(--brand)]" title="Notified first">
                          <Star size={10} /> Primary
                        </span>
                      ) : d.coordinators.length > 1 ? (
                        <button type="button" onClick={() => onMakePrimary(d.district, p.id)} className="text-[11px] font-medium text-[var(--brand)] hover:underline">
                          Make primary
                        </button>
                      ) : null
                    }
                  />
                  <Section
                    title="Maintenance Crew"
                    icon={<HardHat size={14} />}
                    people={d.crew}
                    addLabel="Add crew member"
                    empty="No crew listed."
                    filterable
                    onAdd={() => onAdd(d.district, "crew")}
                    onRemove={(p) => onRemove(d.district, "crew", p)}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Count({ icon, n, label, warn = false }: { icon: React.ReactNode; n: number; label: string; warn?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium tabular-nums ${
      warn ? "border-[color:color-mix(in_oklab,var(--bad)_45%,var(--line))] text-[var(--bad)]" : "border-[var(--line)] text-muted"
    }`}>
      {icon} {n} {label}{label === "coordinator" && n !== 1 ? "s" : ""}
    </span>
  );
}

type Person = { id: number; full_name: string; email: string; is_primary?: boolean };

function Section({
  title,
  icon,
  people,
  addLabel,
  empty,
  filterable = false,
  onAdd,
  onRemove,
  renderExtra,
}: {
  title: string;
  icon: React.ReactNode;
  people: Person[];
  addLabel: string;
  empty: string;
  filterable?: boolean;
  onAdd: () => void;
  onRemove: (person: Person) => void;
  renderExtra?: (person: Person) => React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? people.filter((p) => p.full_name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)) : people;
  }, [people, filter]);
  return (
    <section className="rounded-lg border border-[var(--line)] bg-[var(--panel)]">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <ChevronRight size={14} className={`text-muted transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
        <span className="text-[var(--brand)]" aria-hidden>{icon}</span>
        <span className="flex-1 text-sm font-semibold">{title}</span>
        <span className="rounded-full bg-[var(--panel-soft)] px-2 py-0.5 text-xs font-semibold tabular-nums">{people.length}</span>
      </button>
      {open ? (
        <div className="space-y-1.5 border-t border-[var(--line)] p-2">
          {filterable && people.length > 8 ? (
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter crew" aria-label={`Filter ${title}`}
              className="w-full rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2.5 py-1.5 text-sm" />
          ) : null}
          {!people.length ? <p className="px-1 py-1 text-xs text-muted">{empty}</p> : null}
          <ul className={`space-y-1 ${people.length > 12 ? "max-h-72 overflow-auto pr-1" : ""}`}>
            {shown.map((p) => (
              <li key={p.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--panel-soft)]">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{p.full_name}</span>
                  <span className="block truncate text-[11px] text-muted">{p.email}</span>
                </span>
                {renderExtra?.(p)}
                <button type="button" onClick={() => onRemove(p)} aria-label={`Remove ${p.full_name}`} title="Remove from this list"
                  className="rounded p-1 text-muted hover:bg-[color:color-mix(in_oklab,var(--bad)_10%,var(--panel))] hover:text-[var(--bad)]">
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
          <button type="button" onClick={onAdd}
            className="flex w-full items-center gap-2 rounded-md border-2 border-dashed border-[color:color-mix(in_oklab,var(--brand)_45%,var(--line))] px-2 py-1.5 text-sm font-medium text-[var(--brand)] hover:border-[var(--brand)]">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--brand)] text-white" aria-hidden><Plus size={13} /></span>
            {addLabel}
          </button>
        </div>
      ) : null}
    </section>
  );
}
