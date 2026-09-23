import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../../../api/client";
import {
  adminAddCoverage,
  adminListCoverage,
  adminListOffices,
  adminRemoveCoverage,
  districtLabel,
  normalizeDistrictCode,
  type OrgCoverageDistrict,
  type OrgOfficeRecord,
} from "../../../api/org";
import type { AdminUser } from "../../../api/types";
import { ROLES, roleLabel } from "../../../utils/roleModel";
import {
  OrgAdminShell,
  OrgChip,
  orgButton,
  orgInput,
  orgLabel,
  orgPrimary,
  orgSmallButton,
} from "./OrgAdminShell";

/**
 * Organization › Coverage.
 *
 * Two different facts about a district, deliberately on one page because they
 * are read together:
 *
 *  - **District → office** is decided by the Offices tab and shown here
 *    read-only. Editing it in two places is how the district map ended up with
 *    three disagreeing copies.
 *  - **District → coordinators** is edited here. A district with no active
 *    coordinator silently drops every notification for the reports filed in it,
 *    and nobody finds out until somebody asks why they were never told — so an
 *    uncovered district is flagged at the top of the page, not buried in a row
 *    (design §3.6, UX plan open question 6).
 *
 * A coordinator may cover several districts; the rows are a set, not a field.
 */

const COORDINATOR_ROLES = new Set<string>([ROLES.MAINTENANCE_COORDINATOR]);

export default function AdminCoveragePage() {
  const [coverage, setCoverage] = useState<OrgCoverageDistrict[]>([]);
  const [uncovered, setUncovered] = useState<string[]>([]);
  const [offices, setOffices] = useState<OrgOfficeRecord[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addDistrict, setAddDistrict] = useState("");
  const [addUserId, setAddUserId] = useState("");
  const [addPrimary, setAddPrimary] = useState(true);
  const [showAllAccounts, setShowAllAccounts] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [coverageResponse, officeResponse, userResponse] = await Promise.all([
        adminListCoverage(),
        adminListOffices({ includeInactive: false }),
        api<{ items: AdminUser[] }>("/admin/users?limit=500").catch(() => ({ items: [] as AdminUser[] })),
      ]);
      setCoverage(coverageResponse.items ?? []);
      setUncovered(coverageResponse.uncovered_districts ?? []);
      setOffices(officeResponse.items ?? []);
      setUsers(userResponse.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load district coverage.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** District → the office that serves it, from the Offices tab's own rows. */
  const officeByDistrict = useMemo(() => {
    const map = new Map<string, OrgOfficeRecord>();
    for (const office of offices) {
      if (office.org_type !== "GEOTECH") continue;
      for (const row of office.districts) {
        if (row.is_active) map.set(row.district, office);
      }
    }
    return map;
  }, [offices]);

  const districts = useMemo(() => {
    const all = new Set<string>([...officeByDistrict.keys(), ...coverage.map((row) => row.district), ...uncovered]);
    return [...all].sort();
  }, [coverage, officeByDistrict, uncovered]);

  const coordinatorChoices = useMemo(() => {
    const active = users.filter((user) => user.is_active);
    const coordinators = active.filter((user) => user.roles.some((role) => COORDINATOR_ROLES.has(role)));
    const list = showAllAccounts || coordinators.length === 0 ? active : coordinators;
    return [...list].sort((a, b) => a.full_name.localeCompare(b.full_name));
  }, [showAllAccounts, users]);

  const coverageByDistrict = useMemo(() => new Map(coverage.map((row) => [row.district, row])), [coverage]);

  async function addCoverage() {
    const district = normalizeDistrictCode(addDistrict);
    if (!district) { setError("Choose a district (1–12)."); return; }
    if (!addUserId) { setError("Choose the account that covers it."); return; }
    setRowBusy(district);
    setError(null);
    setNotice(null);
    try {
      await adminAddCoverage(district, Number(addUserId), addPrimary);
      const person = users.find((user) => user.id === Number(addUserId));
      setAddUserId("");
      setNotice(`${person?.full_name ?? "That account"} now covers ${districtLabel(district)}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to record coverage.");
    } finally {
      setRowBusy(null);
    }
  }

  async function removeCoverage(district: string, coverageId: number, name: string) {
    setRowBusy(district);
    setError(null);
    setNotice(null);
    try {
      await adminRemoveCoverage(coverageId);
      setNotice(`${name} no longer covers ${districtLabel(district)}. The record of who was notified is kept.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove coverage.");
    } finally {
      setRowBusy(null);
    }
  }

  return (
    <OrgAdminShell
      title="Organization · Coverage"
      intro="Which office serves each district, and who triages its reports. A district with no active coordinator receives no notifications — those are flagged below."
      error={error}
      notice={notice}
      toolbar={<button type="button" className={orgButton} onClick={() => void load()} disabled={busy}>{busy ? "Refreshing…" : "Refresh"}</button>}
    >
      {uncovered.length ? (
        <div role="alert" className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">
          <b>No active coordinator:</b> {uncovered.map((district) => districtLabel(district)).join(", ")}. Reports filed in these districts notify nobody.
        </div>
      ) : null}

      <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
        <h2 className="text-sm font-semibold">Assign coverage</h2>
        <p className="mt-1 text-sm text-muted">A coordinator may cover several districts. Adding coverage never removes anyone else&apos;s.</p>
        <div className="mt-3 grid gap-3 md:grid-cols-[10rem_1fr_auto_auto] md:items-end">
          <label className="grid gap-1.5">
            <span className={orgLabel}>District</span>
            <select className={orgInput} value={addDistrict} onChange={(event) => setAddDistrict(event.target.value)}>
              <option value="">Choose…</option>
              {districts.map((district) => <option key={district} value={district}>{districtLabel(district)}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5">
            <span className={orgLabel}>Coordinator</span>
            <select className={orgInput} value={addUserId} onChange={(event) => setAddUserId(event.target.value)}>
              <option value="">Choose…</option>
              {coordinatorChoices.map((user) => <option key={user.id} value={user.id}>{user.full_name} — {user.roles.map(roleLabel).join(", ")}</option>)}
            </select>
          </label>
          <label className="inline-flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" checked={addPrimary} onChange={(event) => setAddPrimary(event.target.checked)} />
            Primary
          </label>
          <button type="button" className={orgPrimary} disabled={rowBusy != null} onClick={() => void addCoverage()}>Assign</button>
        </div>
        <label className="mt-2 inline-flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={showAllAccounts} onChange={(event) => setShowAllAccounts(event.target.checked)} />
          Show every active account, not only accounts holding a coordinator role
        </label>
      </section>

      <div className="flex-1 overflow-auto rounded-xl border border-[var(--line)] bg-[var(--panel)]">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-[var(--line)] bg-[var(--panel-soft)] text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
              <th className="px-3 py-3">District</th>
              <th className="px-3 py-3">GeoTech office</th>
              <th className="px-3 py-3">Coordinators</th>
              <th className="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {districts.length === 0 ? (
              <tr><td colSpan={4} className="px-3 py-8 text-center text-sm text-muted">{busy ? "Loading coverage…" : "No districts are served by any office yet."}</td></tr>
            ) : districts.map((district) => {
              const office = officeByDistrict.get(district);
              const people = coverageByDistrict.get(district)?.users ?? [];
              return (
                <tr key={district} className="border-b border-[var(--line)]/60 align-top last:border-b-0">
                  <td className="px-3 py-3 text-sm font-semibold tabular-nums">{districtLabel(district)}</td>
                  <td className="px-3 py-3 text-sm">
                    {office ? (
                      <Link to="/admin/org/offices" className="font-medium text-[var(--brand)] hover:underline">{office.name || office.code}</Link>
                    ) : (
                      <span className="text-muted">Not served — set it on <Link to="/admin/org/offices" className="text-[var(--brand)] hover:underline">Offices</Link></span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-sm">
                    {people.length === 0 ? (
                      <OrgChip tone="warn">No active coordinator</OrgChip>
                    ) : (
                      <div className="grid gap-1.5">
                        {people.map((person) => (
                          <div key={person.coverage_id} className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{person.full_name}</span>
                            <span className="text-xs text-muted">{person.email}</span>
                            {person.is_primary ? <OrgChip tone="good">Primary</OrgChip> : null}
                            {person.user_is_active ? null : <OrgChip tone="warn">Account disabled</OrgChip>}
                            <button
                              type="button"
                              className={orgSmallButton}
                              disabled={rowBusy === district}
                              onClick={() => void removeCoverage(district, person.coverage_id, person.full_name)}
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <button type="button" className={orgSmallButton} onClick={() => { setAddDistrict(district); setNotice(null); setError(null); }}>Add coordinator</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </OrgAdminShell>
  );
}
