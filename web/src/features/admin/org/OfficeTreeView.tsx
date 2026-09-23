import { useEffect, useRef, useState, type ReactNode } from "react";
import { Crown, Leaf, MoreHorizontal, Pencil, Plus, TriangleAlert, Users } from "lucide-react";

import { POSITION_LABEL, type OfficeTree, type TreeBranch, type TreePerson, type TreePosition } from "../../../api/orgTree";

export type AddKind = "chief" | "specialist" | "branchChief" | "staff";
export type AddRequest = { kind: AddKind; officeId: number; branchId?: number; title: string; target: string; branchChiefOnly: boolean };

const TONE: Record<TreePosition, string> = {
  OFFICE_CHIEF: "var(--brand)",
  BRANCH_CHIEF: "var(--accent)",
  SENIOR_SPECIALIST: "#c96f12",
  STAFF: "#64748b",
};

const AVAILABILITY_LABEL: Record<string, string> = {
  ROTATION_OUT: "Rotation out",
  ACTING_ELSEWHERE: "Acting elsewhere",
  UNAVAILABLE: "Unavailable",
};

export function branchTitle(branch: Pick<TreeBranch, "letter" | "name">): string {
  if (branch.letter && branch.name && !branch.name.toLowerCase().includes(`branch ${branch.letter.toLowerCase()}`)) {
    return `Branch ${branch.letter} · ${branch.name}`;
  }
  return branch.name || (branch.letter ? `Branch ${branch.letter}` : "Branch");
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}

function availabilityNote(person: TreePerson): string | null {
  const label = AVAILABILITY_LABEL[person.availability];
  if (!label) return null;
  if (!person.available_until) return label;
  const date = new Date(`${person.available_until.slice(0, 10)}T00:00:00`);
  return `${label} · back ${date.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" })}`;
}

/**
 * One GeoTech office as a tree: its chief(s) at the top, and hanging from them
 * the senior specialists (single fruits) and the branches, each with its chief
 * and the staff on its rail. The + buttons appear only where the viewer may add.
 */
export default function OfficeTreeView({
  tree,
  meId,
  isAdmin,
  onAdd,
  onRemove,
  onDetails,
  onAddBranch,
  onEditBranch,
  onRetireBranch,
  onEditOffice,
}: {
  tree: OfficeTree;
  meId: number;
  isAdmin: boolean;
  onAdd: (request: AddRequest) => void;
  onRemove: (person: TreePerson) => void;
  onDetails: (person: TreePerson) => void;
  onAddBranch: () => void;
  onEditBranch: (branch: TreeBranch) => void;
  onRetireBranch: (branch: TreeBranch) => void;
  onEditOffice: () => void;
}) {
  const { office } = tree;
  const officeName = office.short_name || office.name;
  // A wide office opens scrolled to its middle, so its chief is in view.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, [office.id]);
  const manage = tree.can_manage;
  const showSpecialists = tree.specialists.length > 0 || manage;

  const personActions = (person: TreePerson, removable: boolean) => ({
    onDetails: isAdmin || manage || person.id === meId ? () => onDetails(person) : undefined,
    onRemove: removable ? () => onRemove(person) : undefined,
  });

  return (
    <section className="rounded-2xl border border-[var(--line)] bg-[var(--panel)]" aria-label={office.name}>
      <header className="flex flex-wrap items-start gap-3 border-b border-[var(--line)] px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold leading-tight">{office.name}</h2>
          <p className="mt-0.5 text-xs text-muted">
            {[office.code, office.unit_number, office.home_city ? `${office.home_city}${office.home_district ? ` · D${office.home_district}` : ""}` : null]
              .filter(Boolean)
              .join(" · ")}
            {office.is_routing_target ? "" : " · not a routing target"}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Serves</span>
            {office.districts.length ? (
              office.districts.map((d) => (
                <span key={d} className="rounded-full border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-0.5 text-[11px] font-semibold tabular-nums">D{d}</span>
              ))
            ) : (
              <span className="text-[11px] text-muted">no districts</span>
            )}
          </div>
        </div>
        {isAdmin ? (
          <button type="button" onClick={onEditOffice} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 py-1.5 text-xs font-medium hover:bg-[var(--panel-soft)]">
            <Pencil size={13} /> Edit office
          </button>
        ) : null}
      </header>

      <div ref={scrollRef} className="org-tree overflow-x-auto">
        <div className="mx-auto flex w-max min-w-full flex-col items-center px-6 pb-8 pt-6">
          {/* The top of the tree */}
          <div className="flex flex-wrap items-start justify-center gap-3">
            {tree.chiefs.map((chief) => (
              <PersonCard key={chief.id} person={chief} tone={TONE.OFFICE_CHIEF} icon={<Crown size={12} />} {...personActions(chief, isAdmin)} wide />
            ))}
            {!tree.chiefs.length ? (
              tree.can_name_chiefs ? (
                <AddButton label="Office Chief" wide onClick={() => onAdd({ kind: "chief", officeId: office.id, title: `Office chief of ${officeName}`, target: `Office Chief of ${officeName}`, branchChiefOnly: false })} />
              ) : (
                <EmptySlot label="No office chief" />
              )
            ) : tree.can_name_chiefs ? (
              <AddButton label="" round title="Add another office chief" onClick={() => onAdd({ kind: "chief", officeId: office.id, title: `Another office chief for ${officeName}`, target: `Office Chief of ${officeName}`, branchChiefOnly: false })} />
            ) : null}
          </div>

          <div className="org-stem" />
          <div className="org-children">
            {showSpecialists ? (
              <div className="org-node">
                <Column title="Senior Specialists" icon={<Leaf size={13} />}>
                  {tree.specialists.map((person) => (
                    <PersonCard key={person.id} person={person} tone={TONE.SENIOR_SPECIALIST} fruit {...personActions(person, manage)} />
                  ))}
                  {!tree.specialists.length && !manage ? <EmptySlot label="None" /> : null}
                  {manage ? (
                    <AddButton
                      label="Senior Specialist"
                      onClick={() => onAdd({ kind: "specialist", officeId: office.id, title: `Add a senior specialist to ${officeName}`, target: `Senior Specialist in ${officeName}`, branchChiefOnly: false })}
                    />
                  ) : null}
                </Column>
              </div>
            ) : null}

            {tree.branches.map((branch) => (
              <div key={branch.id} className="org-node">
                <BranchColumn
                  branch={branch}
                  officeName={officeName}
                  officeId={office.id}
                  manageOffice={manage}
                  onAdd={onAdd}
                  personActions={personActions}
                  onEdit={() => onEditBranch(branch)}
                  onRetire={() => onRetireBranch(branch)}
                />
              </div>
            ))}

            {tree.unbranched.length ? (
              <div className="org-node">
                <Column title="Not in a branch" icon={<TriangleAlert size={13} />} warn>
                  <p className="max-w-[13rem] text-[11px] text-[var(--warn-text)]">Their branch is missing or retired. Add them to a branch with its + button.</p>
                  {tree.unbranched.map((person) => (
                    <PersonCard key={person.id} person={person} tone={TONE[person.position ?? "STAFF"]} {...personActions(person, manage)} />
                  ))}
                </Column>
              </div>
            ) : null}

            {manage ? (
              <div className="org-node">
                <div className="flex w-[13.5rem] justify-center">
                  <AddButton label="Branch" wide onClick={onAddBranch} />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function BranchColumn({
  branch,
  officeName,
  officeId,
  manageOffice,
  onAdd,
  personActions,
  onEdit,
  onRetire,
}: {
  branch: TreeBranch;
  officeName: string;
  officeId: number;
  manageOffice: boolean;
  onAdd: (request: AddRequest) => void;
  personActions: (person: TreePerson, removable: boolean) => { onDetails?: () => void; onRemove?: () => void };
  onEdit: () => void;
  onRetire: () => void;
}) {
  const title = branchTitle(branch);
  return (
    <div className="w-[13.5rem]">
      <div className="mb-2 flex items-start gap-2 rounded-lg border border-[color:color-mix(in_oklab,var(--accent)_45%,var(--line))] bg-[color:color-mix(in_oklab,var(--accent)_8%,var(--panel))] px-2.5 py-2">
        <span className="flex h-6 min-w-6 items-center justify-center rounded-md bg-[var(--accent)] px-1 text-xs font-bold text-white" aria-hidden>
          {branch.letter ?? <Users size={12} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" title={title}>{title}</div>
          <div className="truncate text-[11px] text-muted">
            {[branch.home_city, branch.home_district ? `D${branch.home_district}` : null].filter(Boolean).join(" · ") || "No home recorded"}
            {` · ${branch.staff.length} staff`}
          </div>
        </div>
        {manageOffice ? (
          <Menu label={`${title} options`}>
            {(close) => (
              <>
                <MenuItem onClick={() => { close(); onEdit(); }}>Rename or move home</MenuItem>
                <MenuItem danger onClick={() => { close(); onRetire(); }}>Retire branch</MenuItem>
              </>
            )}
          </Menu>
        ) : null}
      </div>

      {branch.chief ? (
        <PersonCard person={branch.chief} tone={TONE.BRANCH_CHIEF} icon={<Crown size={12} />} {...personActions(branch.chief, manageOffice)}
          extra={manageOffice ? { label: "Replace chief", onClick: () => onAdd({ kind: "branchChief", officeId, branchId: branch.id, title: `New chief for ${title}`, target: `Branch Chief of ${title}`, branchChiefOnly: false }) } : undefined}
        />
      ) : manageOffice ? (
        <AddButton label="Branch Chief" onClick={() => onAdd({ kind: "branchChief", officeId, branchId: branch.id, title: `Chief of ${title}`, target: `Branch Chief of ${title}`, branchChiefOnly: false })} />
      ) : (
        <EmptySlot label="No branch chief" />
      )}

      <div className="org-rail mt-2 space-y-1.5">
        {branch.staff.map((person) => (
          <PersonCard key={person.id} person={person} tone={TONE.STAFF} compact {...personActions(person, branch.can_manage)} />
        ))}
        {branch.can_manage ? (
          <AddButton
            label="Staff"
            compact
            onClick={() => onAdd({ kind: "staff", officeId, branchId: branch.id, title: `Add staff to ${title}`, target: `Staff in ${title} · ${officeName}`, branchChiefOnly: !manageOffice })}
          />
        ) : !branch.staff.length ? (
          <EmptySlot label="No staff yet" compact />
        ) : null}
      </div>
    </div>
  );
}

function Column({ title, icon, warn = false, children }: { title: string; icon: ReactNode; warn?: boolean; children: ReactNode }) {
  return (
    <div className="w-[13.5rem] space-y-1.5">
      <div className={`mb-2 flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-sm font-semibold ${
        warn
          ? "border-[color:color-mix(in_oklab,var(--warn)_50%,var(--line))] bg-[color:color-mix(in_oklab,var(--warn)_8%,var(--panel))] text-[var(--warn-text)]"
          : "border-[color:color-mix(in_oklab,#c96f12_45%,var(--line))] bg-[color:color-mix(in_oklab,#c96f12_8%,var(--panel))]"
      }`}>
        <span aria-hidden className={warn ? "" : "text-[#c96f12]"}>{icon}</span>
        {title}
      </div>
      {children}
    </div>
  );
}

function PersonCard({
  person,
  tone,
  icon,
  fruit = false,
  compact = false,
  wide = false,
  onDetails,
  onRemove,
  extra,
}: {
  person: TreePerson;
  tone: string;
  icon?: ReactNode;
  fruit?: boolean;
  compact?: boolean;
  wide?: boolean;
  onDetails?: () => void;
  onRemove?: () => void;
  extra?: { label: string; onClick: () => void };
}) {
  const note = availabilityNote(person);
  const role = person.position ? POSITION_LABEL[person.position] : "";
  const hasMenu = onDetails || onRemove || extra;
  return (
    <div
      className={`group flex items-center gap-2.5 border bg-[var(--panel)] shadow-sm ${fruit ? "rounded-full pr-2" : "rounded-lg pr-1.5"} ${
        compact ? "py-1 pl-1.5" : "py-1.5 pl-2"
      } ${wide ? "w-[15rem]" : "w-full"}`}
      style={{ borderColor: `color-mix(in oklab, ${tone} 40%, var(--line))` }}
    >
      <span
        className={`relative flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${compact ? "h-7 w-7 text-[11px]" : "h-8 w-8 text-xs"}`}
        style={{ background: tone }}
        aria-hidden
      >
        {initials(person.full_name)}
        {icon ? <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--panel)]" style={{ color: tone }}>{icon}</span> : null}
      </span>
      <button type="button" disabled={!onDetails} onClick={onDetails} className="min-w-0 flex-1 text-left disabled:cursor-default" title={onDetails ? "Details" : person.email}>
        <span className={`block truncate font-semibold ${compact ? "text-xs" : "text-sm"}`}>{person.full_name}</span>
        <span className="block truncate text-[11px] text-muted">{note ?? role}</span>
      </button>
      {hasMenu ? (
        <Menu label={`${person.full_name} options`}>
          {(close) => (
            <>
              {onDetails ? <MenuItem onClick={() => { close(); onDetails(); }}>Details and availability</MenuItem> : null}
              {extra ? <MenuItem onClick={() => { close(); extra.onClick(); }}>{extra.label}</MenuItem> : null}
              {onRemove ? <MenuItem danger onClick={() => { close(); onRemove(); }}>Remove from tree</MenuItem> : null}
            </>
          )}
        </Menu>
      ) : null}
    </div>
  );
}

function AddButton({ label, onClick, compact = false, wide = false, round = false, title }: { label: string; onClick: () => void; compact?: boolean; wide?: boolean; round?: boolean; title?: string }) {
  if (round) {
    return (
      <button type="button" onClick={onClick} title={title} aria-label={title}
        className="flex h-9 w-9 items-center justify-center self-center rounded-full border-2 border-dashed border-[color:color-mix(in_oklab,var(--brand)_55%,var(--line))] text-[var(--brand)] hover:bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--panel))]">
        <Plus size={16} />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 rounded-lg border-2 border-dashed border-[color:color-mix(in_oklab,var(--brand)_45%,var(--line))] text-left font-medium text-[var(--brand)] hover:border-[var(--brand)] hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,var(--panel))] ${
        compact ? "px-1.5 py-1 text-xs" : "px-2 py-1.5 text-sm"
      } ${wide ? "w-[15rem]" : "w-full"}`}
    >
      <span className={`flex shrink-0 items-center justify-center rounded-full bg-[var(--brand)] text-white ${compact ? "h-6 w-6" : "h-7 w-7"}`} aria-hidden>
        <Plus size={compact ? 13 : 15} />
      </span>
      {label}
    </button>
  );
}

function EmptySlot({ label, compact = false }: { label: string; compact?: boolean }) {
  return <div className={`rounded-lg border border-dashed border-[var(--line)] text-center text-xs text-muted ${compact ? "px-2 py-1" : "px-3 py-2"}`}>{label}</div>;
}

function Menu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative shrink-0">
      <button type="button" aria-label={label} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((v) => !v)}
        className="flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-[var(--panel-soft)] hover:text-[var(--ink)]">
        <MoreHorizontal size={15} />
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 top-7 z-20 min-w-[12rem] overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--panel)] py-1 shadow-xl">
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({ children, onClick, danger = false }: { children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" onClick={onClick}
      className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-[var(--panel-soft)] ${danger ? "text-[var(--bad)]" : ""}`}>
      {children}
    </button>
  );
}
