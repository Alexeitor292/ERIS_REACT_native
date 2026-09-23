import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Building2, HardHat, Plus, TriangleAlert } from "lucide-react";

import AppShell from "../../../ui/AppShell";
import {
  addBranch,
  addMaintenance,
  addOfficeChief,
  addSpecialist,
  addStaff,
  editBranch,
  getMaintenance,
  getTree,
  makePrimaryCoordinator,
  removeFromTree,
  removeMaintenance,
  retireBranch,
  setBranchChief,
  type MaintenancePayload,
  type OfficeTree,
  type PersonHit,
  type TreeBranch,
  type TreePayload,
  type TreePerson,
} from "../../../api/orgTree";
import OfficeTreeView, { branchTitle, type AddRequest } from "./OfficeTreeView";
import MaintenanceDistricts from "./MaintenanceDistricts";
import PersonPickerDialog, { type PickRule } from "./PersonPickerDialog";
import { BranchDialog, DetailsDialog, OfficeDialog } from "./OrgTreeDialogs";

type Picker = { title: string; target: string; rule: PickRule; onPick: (person: PersonHit) => Promise<void> };

const OFFICE_KEY = "eris_org_office";

/**
 * Organization: one tree per GeoTech office, and the maintenance lists per
 * district. Where a person sits decides their role; nobody is given a work role
 * any other way. Office chiefs manage their office's tree, branch chiefs their
 * branch's staff, administrators everything.
 */
export default function OrganizationPage() {
  const [params, setParams] = useSearchParams();
  const [tree, setTree] = useState<TreePayload | null>(null);
  const [maintenance, setMaintenance] = useState<MaintenancePayload | null>(null);
  const [officeId, setOfficeId] = useState<number | null>(() => {
    try {
      const stored = Number(window.localStorage.getItem(OFFICE_KEY));
      return Number.isFinite(stored) && stored > 0 ? stored : null;
    } catch {
      return null;
    }
  });
  const [picker, setPicker] = useState<Picker | null>(null);
  const [branchDialog, setBranchDialog] = useState<{ office: OfficeTree; branch: TreeBranch | null } | null>(null);
  const [officeDialog, setOfficeDialog] = useState<{ office: OfficeTree["office"] | null } | null>(null);
  const [details, setDetails] = useState<TreePerson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isAdmin = !!tree?.me.is_admin;
  const tab = params.get("tab") === "maintenance" && isAdmin ? "maintenance" : "offices";

  const loadTree = useCallback(async () => {
    try {
      setTree(await getTree());
    } catch (e: any) {
      setError(e?.message ?? "Could not load the organization.");
    }
  }, []);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  useEffect(() => {
    if (tab !== "maintenance" || maintenance) return;
    getMaintenance().then(setMaintenance).catch((e) => setError(e?.message ?? "Could not load the maintenance lists."));
  }, [tab, maintenance]);

  const offices = tree?.offices ?? [];
  const current = offices.find((o) => o.office.id === officeId) ?? offices[0] ?? null;

  function chooseOffice(id: number) {
    setOfficeId(id);
    try {
      window.localStorage.setItem(OFFICE_KEY, String(id));
    } catch {
      // Remembering the office is a convenience only.
    }
  }

  function done(message: string) {
    setError(null);
    setNotice(message);
  }

  function openAdd(req: AddRequest) {
    setNotice(null);
    setPicker({
      title: req.title,
      target: req.target,
      rule: { officeId: req.officeId, isAdmin, branchChiefOnly: req.branchChiefOnly },
      onPick: async (person) => {
        const next =
          req.kind === "chief"
            ? await addOfficeChief(req.officeId, person.id)
            : req.kind === "specialist"
              ? await addSpecialist(req.officeId, person.id)
              : req.kind === "branchChief"
                ? await setBranchChief(req.branchId!, person.id)
                : await addStaff(req.branchId!, person.id);
        setTree(next);
        done(`${person.full_name} is now ${req.target}.`);
      },
    });
  }

  async function remove(person: TreePerson) {
    if (!window.confirm(`Remove ${person.full_name} from the tree? They become a Guest unless they are on a maintenance list or an administrator.`)) return;
    try {
      setTree(await removeFromTree(person.id));
      done(`${person.full_name} left the tree.`);
    } catch (e: any) {
      setError(e?.message ?? "Could not remove them.");
    }
  }

  async function retire(branch: TreeBranch) {
    if (!window.confirm(`Retire ${branchTitle(branch)}? Assessments already routed to it keep it.`)) return;
    try {
      setTree(await retireBranch(branch.id));
      done(`${branchTitle(branch)} is retired.`);
    } catch (e: any) {
      setError(e?.message ?? "Could not retire the branch.");
    }
  }

  function openMaintenanceAdd(district: string, kind: "coordinators" | "crew") {
    const role = kind === "coordinators" ? "Maintenance Coordinator" : "Maintenance Crew";
    setNotice(null);
    setPicker({
      title: `Add ${kind === "coordinators" ? "a coordinator" : "crew"} to District ${Number(district)}`,
      target: `${role} in District ${Number(district)}`,
      rule: { officeId: null, isAdmin: true, branchChiefOnly: false },
      onPick: async (person) => {
        setMaintenance(await addMaintenance(district, kind, person.id));
        done(`${person.full_name} is now ${role} in District ${Number(district)}.`);
      },
    });
  }

  async function maintenanceRemove(district: string, kind: "coordinators" | "crew", person: { id: number; full_name: string }) {
    if (!window.confirm(`Take ${person.full_name} off District ${Number(district)}'s ${kind === "coordinators" ? "coordinators" : "crew"}?`)) return;
    try {
      setMaintenance(await removeMaintenance(district, kind, person.id));
      done(`${person.full_name} is off District ${Number(district)}'s list.`);
    } catch (e: any) {
      setError(e?.message ?? "Could not remove them.");
    }
  }

  return (
    <AppShell title="Organization">
      <div className="flex h-full flex-col gap-4 p-4 md:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-sm text-muted">
            Where people sit decides their role. Anyone in no office tree and on no district list is a Guest.
          </p>
          {isAdmin ? (
            <nav className="inline-flex overflow-hidden rounded-lg border border-[var(--line)]" aria-label="Organization views">
              {([["offices", "GeoTech offices", Building2], ["maintenance", "Maintenance", HardHat]] as const).map(([key, label, Icon], i) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={tab === key}
                  onClick={() => setParams(key === "offices" ? {} : { tab: key })}
                  className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold ${i ? "border-l border-[var(--line)]" : ""} ${
                    tab === key ? "bg-[var(--brand)] text-white" : "bg-[var(--panel)] hover:bg-[var(--panel-soft)]"
                  }`}
                >
                  <Icon size={15} /> {label}
                </button>
              ))}
            </nav>
          ) : null}
        </div>

        {error ? <div role="alert" className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}
        {notice ? <div role="status" className="rounded-md border border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] px-3 py-2 text-sm text-[var(--good)]">{notice}</div> : null}

        {tab === "offices" ? (
          <>
            {isAdmin && tree?.unplaced.length ? (
              <div className="flex items-start gap-2 rounded-lg border border-[color:color-mix(in_oklab,var(--warn)_45%,var(--line))] bg-[color:color-mix(in_oklab,var(--warn)_7%,var(--panel))] px-3 py-2 text-sm">
                <TriangleAlert size={16} className="mt-0.5 shrink-0 text-[var(--warn-text)]" aria-hidden />
                <span>
                  <strong>{tree.unplaced.length} {tree.unplaced.length === 1 ? "person holds" : "people hold"} a GeoTech role but sit in no tree:</strong>{" "}
                  {tree.unplaced.map((p) => `${p.full_name} (${p.role.replace("_", " ").toLowerCase()})`).join(", ")}.{" "}
                  <span className="text-muted">Add them with a + in the right tree. Until then they keep their current role.</span>
                </span>
              </div>
            ) : null}

            {offices.length > 1 || isAdmin ? (
              <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Offices">
                {offices.map((o) => {
                  const people = o.chiefs.length + o.specialists.length + o.branches.reduce((n, b) => n + b.staff.length + (b.chief ? 1 : 0), 0);
                  const active = current?.office.id === o.office.id;
                  return (
                    <button
                      key={o.office.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => chooseOffice(o.office.id)}
                      className={`rounded-full border px-3 py-1.5 text-sm font-medium ${
                        active ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_12%,var(--panel))] text-[var(--brand)]" : "border-[var(--line)] bg-[var(--panel)] hover:border-[var(--brand)]"
                      }`}
                    >
                      {o.office.short_name || o.office.code}
                      <span className="ml-1.5 text-xs text-muted tabular-nums">{people}</span>
                    </button>
                  );
                })}
                {isAdmin ? (
                  <button type="button" onClick={() => setOfficeDialog({ office: null })} className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--brand)] px-3 py-1.5 text-sm font-medium text-[var(--brand)]">
                    <Plus size={14} /> New office
                  </button>
                ) : null}
              </div>
            ) : null}

            {!tree ? (
              <p className="text-sm text-muted">Loading the organization…</p>
            ) : !current ? (
              <p className="text-sm text-muted">No office tree to show.</p>
            ) : (
              <OfficeTreeView
                key={current.office.id}
                tree={current}
                meId={tree.me.id}
                isAdmin={isAdmin}
                onAdd={openAdd}
                onRemove={remove}
                onDetails={setDetails}
                onAddBranch={() => setBranchDialog({ office: current, branch: null })}
                onEditBranch={(branch) => setBranchDialog({ office: current, branch })}
                onRetireBranch={retire}
                onEditOffice={() => setOfficeDialog({ office: current.office })}
              />
            )}
          </>
        ) : maintenance ? (
          <MaintenanceDistricts
            districts={maintenance.districts}
            unplaced={maintenance.unplaced}
            onAdd={openMaintenanceAdd}
            onRemove={maintenanceRemove}
            onMakePrimary={async (district, userId) => {
              try {
                setMaintenance(await makePrimaryCoordinator(district, userId));
                done("Primary coordinator changed.");
              } catch (e: any) {
                setError(e?.message ?? "Could not change the primary coordinator.");
              }
            }}
          />
        ) : (
          <p className="text-sm text-muted">Loading the maintenance lists…</p>
        )}
      </div>

      {picker ? <PersonPickerDialog {...picker} onClose={() => setPicker(null)} /> : null}
      {branchDialog ? (
        <BranchDialog
          officeName={branchDialog.office.office.short_name || branchDialog.office.office.name}
          branch={branchDialog.branch}
          onClose={() => setBranchDialog(null)}
          onSave={async (body) => {
            const next = branchDialog.branch ? await editBranch(branchDialog.branch.id, body) : await addBranch(branchDialog.office.office.id, body);
            setTree(next);
            done(branchDialog.branch ? "Branch saved." : "Branch added. Name its chief with the + under it.");
          }}
        />
      ) : null}
      {officeDialog ? (
        <OfficeDialog
          office={officeDialog.office}
          onClose={() => setOfficeDialog(null)}
          onDone={async () => {
            await loadTree();
            done(officeDialog.office ? "Office saved. Reports already routed keep the office they were sent to." : "Office created. Name its chief with the + at the top of its tree.");
          }}
        />
      ) : null}
      {details ? <DetailsDialog person={details} canClassify={isAdmin} onClose={() => setDetails(null)} onSaved={loadTree} /> : null}
    </AppShell>
  );
}

