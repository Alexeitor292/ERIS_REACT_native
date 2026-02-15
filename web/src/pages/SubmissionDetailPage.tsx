import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import type { GisaLookups, SubmissionDetail } from "../api/types";
import AppShell from "../ui/AppShell";
import { useAuth } from "../auth/AuthContext";
import { getToken } from "../auth/token";
import { appConfig } from "../config";

type Tri = "UNKNOWN" | "YES" | "NO";
type Draft = Record<string, string> & { pavement_ground_cracks: Tri; indented_by_rocks: Tri };

const EMPTY: Draft = {
  report_date: "", district: "", county: "", route: "", post_mile: "", ea: "", project_id: "", date_incident_reported: "", district_contact: "",
  latitude: "", longitude: "", distribution_code: "", highway_status_code: "", lanes_closed_count: "",
  crack_length_ft: "", crack_horizontal_in: "", crack_vertical_in: "", crack_depth_in: "", settlement_in: "", bulge_in: "",
  observations_notes: "", geometry_json: "", pavement_ground_cracks: "UNKNOWN", indented_by_rocks: "UNKNOWN",
};

const t = (v: unknown) => (v == null ? "" : String(v));
const nt = (v: string) => (v.trim() ? v.trim() : null);
const triToBool = (v: Tri) => (v === "YES" ? true : v === "NO" ? false : null);
const boolToTri = (v: unknown): Tri => (v === true ? "YES" : v === false ? "NO" : "UNKNOWN");
const nf = (v: string, n: string) => { if (!v.trim()) return null; const x = Number(v); if (Number.isNaN(x)) throw new Error(`${n} must be numeric`); return x; };
const ni = (v: string, n: string) => { if (!v.trim()) return null; const x = Number(v); if (Number.isNaN(x) || !Number.isInteger(x)) throw new Error(`${n} must be whole number`); return x; };

function S({ s }: { s: string }) {
  const c = s === "APPROVED" ? "bg-[color:color-mix(in_oklab,var(--good)_16%,transparent)] text-[var(--good)] border-[color:color-mix(in_oklab,var(--good)_48%,transparent)]" : s === "REJECTED" ? "bg-[color:color-mix(in_oklab,var(--bad)_16%,transparent)] text-[var(--bad)] border-[color:color-mix(in_oklab,var(--bad)_48%,transparent)]" : s === "SUBMITTED" ? "bg-[color:color-mix(in_oklab,var(--brand)_16%,transparent)] text-[var(--brand)] border-[color:color-mix(in_oklab,var(--brand)_48%,transparent)]" : "bg-[var(--panel-soft)] text-[var(--ink)] border-[var(--line)]";
  return <span className={`inline-flex rounded border px-2 py-0.5 text-xs font-medium ${c}`}>{s}</span>;
}
function R({ l, v }: { l: string; v: unknown }) {
  return <div className="grid grid-cols-3 gap-3 border-b border-[var(--line)]/70 py-1.5 text-sm last:border-b-0"><div className="text-muted">{l}</div><div className="col-span-2 font-medium">{v == null || v === "" ? "-" : String(v)}</div></div>;
}
function resolve(items: { code: string; label: string }[] | undefined, code: string) {
  return items?.find((x) => x.code === code)?.label ?? code;
}

export default function SubmissionDetailPage() {
  const { id } = useParams();
  const sid = Number(id);
  const invalid = !id || Number.isNaN(sid) || sid <= 0;
  const { me } = useAuth();

  const [data, setData] = useState<SubmissionDetail | null>(null);
  const [lookups, setLookups] = useState<GisaLookups | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<number | null>(null);

  const [reviewNote, setReviewNote] = useState("");
  const [submitNote, setSubmitNote] = useState("");
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [inc, setInc] = useState<string[]>([]);
  const [imm, setImm] = useState<string[]>([]);
  const [fol, setFol] = useState<string[]>([]);

  const canReview = !!me?.roles?.some((r) => r === "REVIEWER" || r === "ADMIN");
  const canEdit = !!me?.roles?.some((r) => r === "FIELD_WORKER" || r === "ADMIN") && data?.submission.status === "DRAFT";
  const canAct = canReview && data?.submission.status === "SUBMITTED";
  const tog = (arr: string[], code: string) => (arr.includes(code) ? arr.filter((x) => x !== code) : [...arr, code]);

  async function load() {
    setBusy(true); setErr(null);
    try {
      const [d, l] = await Promise.all([api<SubmissionDetail>(`/submissions/${sid}`), api<GisaLookups>("/gisa/lookups")]);
      setData(d); setLookups(l); setReviewNote(d.submission.review_comment ?? "");
      const g: any = d.gisa || {};
      setDraft({
        ...EMPTY,
        report_date: t(g.report_date), district: t(g.district), county: t(g.county), route: t(g.route), post_mile: t(g.post_mile), ea: t(g.ea), project_id: t(g.project_id), date_incident_reported: t(g.date_incident_reported), district_contact: t(g.district_contact),
        latitude: t(g.latitude), longitude: t(g.longitude), distribution_code: t(g.distribution_code), highway_status_code: t(g.highway_status_code), lanes_closed_count: t(g.lanes_closed_count),
        pavement_ground_cracks: boolToTri(g.pavement_ground_cracks), crack_length_ft: t(g.crack_length_ft), crack_horizontal_in: t(g.crack_horizontal_in), crack_vertical_in: t(g.crack_vertical_in), crack_depth_in: t(g.crack_depth_in), settlement_in: t(g.settlement_in), bulge_in: t(g.bulge_in), indented_by_rocks: boolToTri(g.indented_by_rocks),
        observations_notes: t(g.observations_notes), geometry_json: g.geometry_json ? JSON.stringify(g.geometry_json, null, 2) : "",
      });
      setInc(d.incident_types ?? []); setImm(d.actions?.immediate ?? []); setFol(d.actions?.follow_up ?? []);
    } catch (e: any) { setErr(e?.message ?? "Failed to load"); } finally { setBusy(false); }
  }

  async function persistDraft() {
    if (!canEdit) return;
    let geometry: Record<string, unknown> | null = null;
    if (draft.geometry_json.trim()) {
      const parsed = JSON.parse(draft.geometry_json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Geometry JSON must be object");
      geometry = parsed as Record<string, unknown>;
    }
    await api(`/submissions/${sid}/gisa`, { method: "PATCH", body: JSON.stringify({
      report_date: nt(draft.report_date), district: nt(draft.district), county: nt(draft.county), route: nt(draft.route), post_mile: nt(draft.post_mile), ea: nt(draft.ea), project_id: nt(draft.project_id), date_incident_reported: nt(draft.date_incident_reported), district_contact: nt(draft.district_contact),
      latitude: nf(draft.latitude, "Latitude"), longitude: nf(draft.longitude, "Longitude"), distribution_code: nt(draft.distribution_code), highway_status_code: nt(draft.highway_status_code), lanes_closed_count: ni(draft.lanes_closed_count, "Lanes closed count"),
      pavement_ground_cracks: triToBool(draft.pavement_ground_cracks), crack_length_ft: nf(draft.crack_length_ft, "Crack length"), crack_horizontal_in: nf(draft.crack_horizontal_in, "Crack horizontal"), crack_vertical_in: nf(draft.crack_vertical_in, "Crack vertical"), crack_depth_in: nf(draft.crack_depth_in, "Crack depth"), settlement_in: nf(draft.settlement_in, "Settlement"), bulge_in: nf(draft.bulge_in, "Bulge"), indented_by_rocks: triToBool(draft.indented_by_rocks), observations_notes: nt(draft.observations_notes), geometry_json: geometry,
    })});
    await api(`/submissions/${sid}/gisa/incident-types`, { method: "PUT", body: JSON.stringify({ items: inc }) });
    await api(`/submissions/${sid}/gisa/actions`, { method: "PUT", body: JSON.stringify({ immediate: imm, follow_up: fol }) });
  }

  async function saveDraft() { setBusy(true); setErr(null); try { await persistDraft(); await load(); } catch (e: any) { setErr(e?.message ?? "Save failed"); setBusy(false); } }
  async function submitDraft() { setBusy(true); setErr(null); try { await persistDraft(); await api(`/submissions/${sid}/submit`, { method: "POST", body: JSON.stringify({ comment: submitNote.trim() || null }) }); setSubmitNote(""); await load(); } catch (e: any) { setErr(e?.message ?? "Submit failed"); setBusy(false); } }
  async function review(decision: "APPROVE" | "REJECT") { setBusy(true); setErr(null); try { await api(`/submissions/${sid}/review`, { method: "POST", body: JSON.stringify({ decision, comment: reviewNote.trim() || null }) }); await load(); } catch (e: any) { setErr(e?.message ?? "Review failed"); setBusy(false); } }
  async function openDownloadUrl(id: number) {
    setDownloading(id);
    try {
      const token = getToken();
      if (!token) throw new Error("Missing auth token");
      const base = appConfig.apiBaseUrl.replace(/\/+$/, "");
      const url = `${base}/attachments/${id}/content?access_token=${encodeURIComponent(token)}&ts=${Date.now()}`;
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      setErr(e?.message ?? "Download failed");
    } finally {
      setDownloading(null);
    }
  }

  useEffect(() => { if (!invalid) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [sid]);

  return (
    <AppShell title={invalid ? "Submission" : `Submission #${sid}`}>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <Link className="text-sm underline text-muted" to="/submissions">{"<-"} Back to submissions</Link>
            <div className="mt-2 flex items-center gap-2"><h2 className="text-lg font-semibold">{invalid ? "Invalid submission id" : `Case ${sid}`}</h2>{data?.submission && <S s={data.submission.status} />}</div>
          </div>
          <div className="flex gap-2">
            <button onClick={load} disabled={busy || invalid} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm hover:brightness-95 disabled:opacity-60">Refresh</button>
            <button onClick={() => review("APPROVE")} disabled={busy || invalid || !canAct} className="rounded-md bg-[var(--brand)] px-3 py-2 text-sm text-white hover:brightness-95 disabled:opacity-60">Approve</button>
            <button onClick={() => review("REJECT")} disabled={busy || invalid || !canAct} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm hover:brightness-95 disabled:opacity-60">Reject</button>
          </div>
        </div>

        {err && <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>}
        {invalid && <div className="mt-4 rounded-md border border-[var(--line)] bg-[var(--panel-soft)] p-4 text-sm text-muted">Invalid submission id.</div>}
        {!invalid && !data && <div className="mt-4 text-sm text-muted">{busy ? "Loading..." : "No data."}</div>}

        {!invalid && data && (
          <div className="mt-4 space-y-4">
            {canEdit && (
              <section className="rounded-xl surface-soft p-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">Draft Editor</h3>
                <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-2">
                  {[
                    ["report_date","Report Date (YYYY-MM-DD)"],["district","District"],["county","County"],["route","Route"],["post_mile","Post Mile"],["ea","EA"],["project_id","Project ID"],["date_incident_reported","Date Incident Reported"],["district_contact","District Contact"],["latitude","Latitude"],["longitude","Longitude"],["lanes_closed_count","Lanes Closed Count"],["crack_length_ft","Crack Length (ft)"],["crack_horizontal_in","Crack Horizontal (in)"],["crack_vertical_in","Crack Vertical (in)"],["crack_depth_in","Crack Depth (in)"],["settlement_in","Settlement (in)"],["bulge_in","Bulge (in)"],
                  ].map(([k,p]) => <input key={k} className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder={p} value={draft[k]} onChange={(e)=>setDraft((d)=>({...d,[k]:e.target.value}))} />)}
                  <select className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" value={draft.distribution_code} onChange={(e)=>setDraft((d)=>({...d,distribution_code:e.target.value}))}><option value="">Distribution</option>{(lookups?.distribution??[]).map((x)=><option key={x.code} value={x.code}>{x.label}</option>)}</select>
                  <select className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" value={draft.highway_status_code} onChange={(e)=>setDraft((d)=>({...d,highway_status_code:e.target.value}))}><option value="">Highway Status</option>{(lookups?.highway_status??[]).map((x)=><option key={x.code} value={x.code}>{x.label}</option>)}</select>
                  <select className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" value={draft.pavement_ground_cracks} onChange={(e)=>setDraft((d)=>({...d,pavement_ground_cracks:e.target.value as Tri}))}><option value="UNKNOWN">Pavement Cracks: Unknown</option><option value="YES">Pavement Cracks: Yes</option><option value="NO">Pavement Cracks: No</option></select>
                  <select className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" value={draft.indented_by_rocks} onChange={(e)=>setDraft((d)=>({...d,indented_by_rocks:e.target.value as Tri}))}><option value="UNKNOWN">Indented by Rocks: Unknown</option><option value="YES">Indented by Rocks: Yes</option><option value="NO">Indented by Rocks: No</option></select>
                </div>
                <textarea className="mt-2 w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" rows={3} placeholder="Observations" value={draft.observations_notes} onChange={(e)=>setDraft((d)=>({...d,observations_notes:e.target.value}))} />
                <textarea className="mt-2 w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-mono" rows={4} placeholder='Geometry JSON {"type":"Point","coordinates":[...]} ' value={draft.geometry_json} onChange={(e)=>setDraft((d)=>({...d,geometry_json:e.target.value}))} />
                <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-3">
                  <div><div className="text-xs font-semibold uppercase text-muted">Incident Types</div><div className="mt-1 flex flex-wrap gap-1">{(lookups?.incident_types??[]).map((x)=><button key={x.code} type="button" onClick={()=>setInc((p)=>tog(p,x.code))} className={`rounded-full border px-2 py-1 text-xs ${inc.includes(x.code)?"border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_16%,transparent)] text-[var(--brand)]":"border-[var(--line)] bg-[var(--panel)] text-[var(--ink)]"}`}>{x.label}</button>)}</div></div>
                  <div><div className="text-xs font-semibold uppercase text-muted">Immediate</div><div className="mt-1 flex flex-wrap gap-1">{(lookups?.actions?.immediate??[]).map((x)=><button key={x.code} type="button" onClick={()=>setImm((p)=>tog(p,x.code))} className={`rounded-full border px-2 py-1 text-xs ${imm.includes(x.code)?"border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_16%,transparent)] text-[var(--brand)]":"border-[var(--line)] bg-[var(--panel)] text-[var(--ink)]"}`}>{x.label}</button>)}</div></div>
                  <div><div className="text-xs font-semibold uppercase text-muted">Follow-Up</div><div className="mt-1 flex flex-wrap gap-1">{(lookups?.actions?.follow_up??[]).map((x)=><button key={x.code} type="button" onClick={()=>setFol((p)=>tog(p,x.code))} className={`rounded-full border px-2 py-1 text-xs ${fol.includes(x.code)?"border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_16%,transparent)] text-[var(--brand)]":"border-[var(--line)] bg-[var(--panel)] text-[var(--ink)]"}`}>{x.label}</button>)}</div></div>
                </div>
                <textarea className="mt-2 w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" rows={2} placeholder="Submit comment (optional)" value={submitNote} onChange={(e)=>setSubmitNote(e.target.value)} />
                <div className="mt-2 flex gap-2"><button onClick={saveDraft} disabled={busy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm disabled:opacity-60">Save Draft</button><button onClick={submitDraft} disabled={busy} className="rounded-md bg-[var(--good)] px-3 py-2 text-sm text-white disabled:opacity-60">Submit for Review</button></div>
              </section>
            )}

            <section className="rounded-md border border-[var(--line)] p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Summary</h3>
              <div className="mt-2"><R l="Created" v={data.submission.created_at} /><R l="Updated" v={data.submission.updated_at} /><R l="Submitted" v={data.submission.submitted_at} /><R l="District" v={data.gisa?.district} /><R l="County" v={data.gisa?.county} /><R l="Latitude" v={data.gisa?.latitude} /><R l="Longitude" v={data.gisa?.longitude} /></div>
            </section>

            <section className="rounded-md border border-[var(--line)] p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Reviewer Note</h3>
              <textarea value={reviewNote} onChange={(e)=>setReviewNote(e.target.value)} rows={3} disabled={busy||!canReview} className="mt-2 w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" />
            </section>

            <section className="rounded-md border border-[var(--line)] p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Incident/Actions Snapshot</h3>
              <div className="mt-2 text-sm"><div><span className="text-muted">Incident Types: </span>{(data.incident_types??[]).map((x)=>resolve(lookups?.incident_types,x)).join(", ") || "-"}</div><div><span className="text-muted">Immediate: </span>{(data.actions?.immediate??[]).map((x)=>resolve(lookups?.actions?.immediate,x)).join(", ") || "-"}</div><div><span className="text-muted">Follow-Up: </span>{(data.actions?.follow_up??[]).map((x)=>resolve(lookups?.actions?.follow_up,x)).join(", ") || "-"}</div></div>
            </section>

            <section className="rounded-md border border-[var(--line)] p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Attachments</h3>
              <div className="mt-2 overflow-x-auto">{data.attachments.length===0?<div className="text-sm text-muted">No attachments.</div>:<table className="w-full border-collapse"><thead><tr className="border-b border-[var(--line)] text-left text-xs font-semibold uppercase tracking-wide text-muted"><th className="py-2 px-2">ID</th><th className="py-2 px-2">File</th><th className="py-2 px-2">Type</th><th className="py-2 px-2">Size</th><th className="py-2 px-2"></th></tr></thead><tbody>{data.attachments.map((a)=><tr key={a.id} className="border-b border-[var(--line)]/50"><td className="py-2 px-2 text-sm">{a.id}</td><td className="py-2 px-2 text-sm">{a.file_name}</td><td className="py-2 px-2 text-sm">{a.mime_type}</td><td className="py-2 px-2 text-sm">{a.file_size_bytes.toLocaleString()}</td><td className="py-2 px-2 text-sm"><button onClick={()=>openDownloadUrl(a.id)} disabled={downloading===a.id} className="rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-xs">{downloading===a.id?"Opening...":"Open Photo"}</button></td></tr>)}</tbody></table>}</div>
            </section>

            <section className="rounded-md border border-[var(--line)] p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Workflow Events</h3>
              <div className="mt-2">{data.workflow_events.length===0?<div className="text-sm text-muted">No workflow events.</div>:<ol className="space-y-2">{data.workflow_events.map((e)=><li key={e.id} className="rounded border border-[var(--line)] p-2 text-sm"><div className="text-xs text-muted">{e.created_at}</div><div className="font-medium">{e.event_type} ({e.from_status ?? "-"} {"->"} {e.to_status ?? "-"})</div><div className="text-xs text-muted">Actor {e.actor_user_id}{e.comment ? ` - ${e.comment}` : ""}</div></li>)}</ol>}</div>
            </section>
          </div>
        )}
      </div>
    </AppShell>
  );
}
