import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import type { GisaLookups, SubmissionDetail } from "../api/types";
import AppShell from "../ui/AppShell";
import { useAuth } from "../auth/AuthContext";
import { getToken } from "../auth/token";
import { appConfig } from "../config";
import SubmissionArcGisMap from "../components/SubmissionArcGisMap";
import { buildSubmissionDisplayTitle } from "../utils/submissionLabel";
import { CALIFORNIA_COUNTIES, CALTRANS_DISTRICTS, districtForCounty } from "../utils/caltransLookups";

type Tri = "UNKNOWN" | "YES" | "NO";
type Draft = Record<string, string> & {
  pavement_ground_cracks: Tri;
  indented_by_rocks: Tri;
  failure_rock_fall: Tri;
  failure_topple: Tri;
  failure_slide: Tri;
  failure_spread: Tri;
  failure_flow: Tri;
  failure_compound: Tri;
  failure_erosion: Tri;
  failure_surficial_failure: Tri;
  failure_scoured_toe: Tri;
  failure_washout: Tri;
  distribution_advancing: Tri;
  distribution_retrogressive: Tri;
  distribution_enlarging: Tri;
  distribution_widening: Tri;
  distribution_moving: Tri;
  distribution_confined: Tri;
  material_rock: Tri;
  material_soil: Tri;
  material_bedding: Tri;
  material_joints: Tri;
  material_fractures: Tri;
  water_dry: Tri;
  water_moist: Tri;
  water_wet: Tri;
  water_flowing: Tri;
  water_seep: Tri;
  water_spring: Tri;
  drainage_clogged_inlet: Tri;
  drainage_compromised_drains: Tri;
  drainage_surface_runoff: Tri;
  drainage_torrent_surge_flood: Tri;
  impact_impacted_adj_utilities: Tri;
  impact_maybe_adj_utilities: Tri;
  impact_impacted_adj_properties: Tri;
  impact_maybe_adj_properties: Tri;
  impact_impacted_adj_structure: Tri;
  impact_maybe_adj_structure: Tri;
};
type SharedUser = { user_id: number; email: string; full_name: string; granted_by_user_id: number; created_at: string };
type AdminUser = { id: number; email: string; full_name: string; is_active: boolean; roles: string[] };

const EMPTY: Draft = {
  report_date: "", district: "", county: "", route: "", post_mile: "", ea: "", project_id: "", date_incident_reported: "", district_contact: "",
  latitude: "", longitude: "", distribution_code: "", highway_status_code: "", lanes_closed_count: "", open_highway_traffic_lanes_count: "",
  crack_length_ft: "", crack_horizontal_in: "", crack_vertical_in: "", crack_depth_in: "", settlement_in: "", bulge_in: "",
  est_soil_pct: "", est_clay_pct: "", est_silt_pct: "", est_sand_pct: "", est_gravel_pct: "",
  vegetation_trees: "", vegetation_bushes_shrubs: "", vegetation_groundcover: "",
  impact_adj_utilities: "", impact_adj_properties: "", impact_adj_structure: "",
  measure_slope_height_ft: "", measure_original_slope_deg: "", measure_landslide_width_ft: "", measure_landslide_length_ft: "", measure_main_scarp_height_ft: "", measure_landslide_slope_deg: "", measure_roadway_length_ft: "", measure_roadway_width_ft: "",
  record_of_event_notes: "", maintenance_history_notes: "", geotechnical_assessment_notes: "", recommendations_notes: "", sketchpad_notes: "",
  observations_notes: "", geometry_json: "", pavement_ground_cracks: "UNKNOWN", indented_by_rocks: "UNKNOWN",
  failure_rock_fall: "UNKNOWN", failure_topple: "UNKNOWN", failure_slide: "UNKNOWN", failure_spread: "UNKNOWN", failure_flow: "UNKNOWN", failure_compound: "UNKNOWN", failure_erosion: "UNKNOWN", failure_surficial_failure: "UNKNOWN", failure_scoured_toe: "UNKNOWN", failure_washout: "UNKNOWN",
  distribution_advancing: "UNKNOWN", distribution_retrogressive: "UNKNOWN", distribution_enlarging: "UNKNOWN", distribution_widening: "UNKNOWN", distribution_moving: "UNKNOWN", distribution_confined: "UNKNOWN",
  material_rock: "UNKNOWN", material_soil: "UNKNOWN", material_bedding: "UNKNOWN", material_joints: "UNKNOWN", material_fractures: "UNKNOWN",
  water_dry: "UNKNOWN", water_moist: "UNKNOWN", water_wet: "UNKNOWN", water_flowing: "UNKNOWN", water_seep: "UNKNOWN", water_spring: "UNKNOWN",
  drainage_clogged_inlet: "UNKNOWN", drainage_compromised_drains: "UNKNOWN", drainage_surface_runoff: "UNKNOWN", drainage_torrent_surge_flood: "UNKNOWN",
  impact_impacted_adj_utilities: "UNKNOWN", impact_maybe_adj_utilities: "UNKNOWN", impact_impacted_adj_properties: "UNKNOWN", impact_maybe_adj_properties: "UNKNOWN", impact_impacted_adj_structure: "UNKNOWN", impact_maybe_adj_structure: "UNKNOWN",
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
function Section({ title, children, open = false }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="rounded-md border border-[var(--line)] p-4" open={open}>
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted select-none">{title}</summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

function pointFromLatLon(gisa: any): any | null {
  const lat = Number(gisa?.latitude);
  const lon = Number(gisa?.longitude);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  return { type: "Point", coordinates: [lon, lat] };
}

function normalizeCounty(value: string): string {
  return value.replace(/\s+County$/i, "").trim();
}

function tryExtractRoute(addressText: string): string | null {
  const m = addressText.match(/\b(?:I|US|CA|SR)[-\s]?(\d{1,3})\b/i) || addressText.match(/\b(\d{1,3})\b/);
  return m?.[1] ?? null;
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
  const [geom, setGeom] = useState<any | null>(null);
  const [shareQuery, setShareQuery] = useState("");
  const [shareCandidates, setShareCandidates] = useState<AdminUser[]>([]);
  const [sharedWith, setSharedWith] = useState<SharedUser[]>([]);
  const [geoBusy, setGeoBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const canReview = !!me?.roles?.some((r) => r === "REVIEWER" || r === "ADMIN");
  const canEdit = !!me?.roles?.some((r) => r === "FIELD_WORKER" || r === "ADMIN") && (data?.submission.status === "DRAFT" || data?.submission.status === "REJECTED");
  const canAct = canReview && data?.submission.status === "SUBMITTED";
  const canManageSharing = !!me?.roles?.includes("ADMIN");
  const canDeleteSubmission =
    !!data?.submission &&
    (me?.roles?.includes("ADMIN") ||
      (data.submission.status === "DRAFT" && me?.id === data.submission.created_by_user_id));
  const tog = (arr: string[], code: string) => (arr.includes(code) ? arr.filter((x) => x !== code) : [...arr, code]);

  async function load() {
    setBusy(true); setErr(null);
    try {
      const [d, l, geomRes] = await Promise.all([
        api<SubmissionDetail>(`/submissions/${sid}`),
        api<GisaLookups>("/gisa/lookups"),
        api<{ submission_id: number; geometry: any | null }>(`/submissions/${sid}/geometry`).catch(() => null),
      ]);
      setData(d);
      setLookups(l);
      setReviewNote(d.submission.review_comment ?? "");
      setGeom(geomRes?.geometry ?? d.gisa?.geometry_json ?? pointFromLatLon(d.gisa) ?? null);
      const gisa: any = d.gisa || {};
      setDraft({
        ...EMPTY,
        report_date: t(gisa.report_date), district: t(gisa.district), county: t(gisa.county), route: t(gisa.route), post_mile: t(gisa.post_mile), ea: t(gisa.ea), project_id: t(gisa.project_id), date_incident_reported: t(gisa.date_incident_reported), district_contact: t(gisa.district_contact),
        latitude: t(gisa.latitude), longitude: t(gisa.longitude), distribution_code: t(gisa.distribution_code), highway_status_code: t(gisa.highway_status_code), lanes_closed_count: t(gisa.lanes_closed_count), open_highway_traffic_lanes_count: t(gisa.open_highway_traffic_lanes_count),
        pavement_ground_cracks: boolToTri(gisa.pavement_ground_cracks), crack_length_ft: t(gisa.crack_length_ft), crack_horizontal_in: t(gisa.crack_horizontal_in), crack_vertical_in: t(gisa.crack_vertical_in), crack_depth_in: t(gisa.crack_depth_in), settlement_in: t(gisa.settlement_in), bulge_in: t(gisa.bulge_in), indented_by_rocks: boolToTri(gisa.indented_by_rocks),
        failure_rock_fall: boolToTri(gisa.failure_rock_fall), failure_topple: boolToTri(gisa.failure_topple), failure_slide: boolToTri(gisa.failure_slide), failure_spread: boolToTri(gisa.failure_spread), failure_flow: boolToTri(gisa.failure_flow), failure_compound: boolToTri(gisa.failure_compound), failure_erosion: boolToTri(gisa.failure_erosion), failure_surficial_failure: boolToTri(gisa.failure_surficial_failure), failure_scoured_toe: boolToTri(gisa.failure_scoured_toe), failure_washout: boolToTri(gisa.failure_washout),
        distribution_advancing: boolToTri(gisa.distribution_advancing), distribution_retrogressive: boolToTri(gisa.distribution_retrogressive), distribution_enlarging: boolToTri(gisa.distribution_enlarging), distribution_widening: boolToTri(gisa.distribution_widening), distribution_moving: boolToTri(gisa.distribution_moving), distribution_confined: boolToTri(gisa.distribution_confined),
        material_rock: boolToTri(gisa.material_rock), material_soil: boolToTri(gisa.material_soil), material_bedding: boolToTri(gisa.material_bedding), material_joints: boolToTri(gisa.material_joints), material_fractures: boolToTri(gisa.material_fractures),
        est_soil_pct: t(gisa.est_soil_pct), est_clay_pct: t(gisa.est_clay_pct), est_silt_pct: t(gisa.est_silt_pct), est_sand_pct: t(gisa.est_sand_pct), est_gravel_pct: t(gisa.est_gravel_pct),
        water_dry: boolToTri(gisa.water_dry), water_moist: boolToTri(gisa.water_moist), water_wet: boolToTri(gisa.water_wet), water_flowing: boolToTri(gisa.water_flowing), water_seep: boolToTri(gisa.water_seep), water_spring: boolToTri(gisa.water_spring),
        vegetation_trees: t(gisa.vegetation_trees), vegetation_bushes_shrubs: t(gisa.vegetation_bushes_shrubs), vegetation_groundcover: t(gisa.vegetation_groundcover),
        drainage_clogged_inlet: boolToTri(gisa.drainage_clogged_inlet), drainage_compromised_drains: boolToTri(gisa.drainage_compromised_drains), drainage_surface_runoff: boolToTri(gisa.drainage_surface_runoff), drainage_torrent_surge_flood: boolToTri(gisa.drainage_torrent_surge_flood),
        impact_impacted_adj_utilities: boolToTri(gisa.impact_impacted_adj_utilities), impact_maybe_adj_utilities: boolToTri(gisa.impact_maybe_adj_utilities), impact_adj_utilities: t(gisa.impact_adj_utilities), impact_impacted_adj_properties: boolToTri(gisa.impact_impacted_adj_properties), impact_maybe_adj_properties: boolToTri(gisa.impact_maybe_adj_properties), impact_adj_properties: t(gisa.impact_adj_properties), impact_impacted_adj_structure: boolToTri(gisa.impact_impacted_adj_structure), impact_maybe_adj_structure: boolToTri(gisa.impact_maybe_adj_structure), impact_adj_structure: t(gisa.impact_adj_structure),
        measure_slope_height_ft: t(gisa.measure_slope_height_ft), measure_original_slope_deg: t(gisa.measure_original_slope_deg), measure_landslide_width_ft: t(gisa.measure_landslide_width_ft), measure_landslide_length_ft: t(gisa.measure_landslide_length_ft), measure_main_scarp_height_ft: t(gisa.measure_main_scarp_height_ft), measure_landslide_slope_deg: t(gisa.measure_landslide_slope_deg), measure_roadway_length_ft: t(gisa.measure_roadway_length_ft), measure_roadway_width_ft: t(gisa.measure_roadway_width_ft),
        record_of_event_notes: t(gisa.record_of_event_notes), maintenance_history_notes: t(gisa.maintenance_history_notes), geotechnical_assessment_notes: t(gisa.geotechnical_assessment_notes), recommendations_notes: t(gisa.recommendations_notes), sketchpad_notes: t(gisa.sketchpad_notes),
        observations_notes: t(gisa.observations_notes), geometry_json: gisa.geometry_json ? JSON.stringify(gisa.geometry_json, null, 2) : "",
      });
      setInc(d.incident_types ?? []);
      setImm(d.actions?.immediate ?? []);
      setFol(d.actions?.follow_up ?? []);
      if (canManageSharing) {
        const sharedRes = await api<{ items: SharedUser[] }>(`/submissions/${sid}/shared-with`);
        setSharedWith(sharedRes.items ?? []);
      } else {
        setSharedWith([]);
      }
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load");
    } finally {
      setBusy(false);
    }
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
      latitude: nf(draft.latitude, "Latitude"), longitude: nf(draft.longitude, "Longitude"), distribution_code: nt(draft.distribution_code), highway_status_code: nt(draft.highway_status_code), lanes_closed_count: ni(draft.lanes_closed_count, "Lanes closed count"), open_highway_traffic_lanes_count: ni(draft.open_highway_traffic_lanes_count, "Open highway lanes"),
      pavement_ground_cracks: triToBool(draft.pavement_ground_cracks), crack_length_ft: nf(draft.crack_length_ft, "Crack length"), crack_horizontal_in: nf(draft.crack_horizontal_in, "Crack horizontal"), crack_vertical_in: nf(draft.crack_vertical_in, "Crack vertical"), crack_depth_in: nf(draft.crack_depth_in, "Crack depth"), settlement_in: nf(draft.settlement_in, "Settlement"), bulge_in: nf(draft.bulge_in, "Bulge"), indented_by_rocks: triToBool(draft.indented_by_rocks),
      failure_rock_fall: triToBool(draft.failure_rock_fall), failure_topple: triToBool(draft.failure_topple), failure_slide: triToBool(draft.failure_slide), failure_spread: triToBool(draft.failure_spread), failure_flow: triToBool(draft.failure_flow), failure_compound: triToBool(draft.failure_compound), failure_erosion: triToBool(draft.failure_erosion), failure_surficial_failure: triToBool(draft.failure_surficial_failure), failure_scoured_toe: triToBool(draft.failure_scoured_toe), failure_washout: triToBool(draft.failure_washout),
      distribution_advancing: triToBool(draft.distribution_advancing), distribution_retrogressive: triToBool(draft.distribution_retrogressive), distribution_enlarging: triToBool(draft.distribution_enlarging), distribution_widening: triToBool(draft.distribution_widening), distribution_moving: triToBool(draft.distribution_moving), distribution_confined: triToBool(draft.distribution_confined),
      material_rock: triToBool(draft.material_rock), material_soil: triToBool(draft.material_soil), material_bedding: triToBool(draft.material_bedding), material_joints: triToBool(draft.material_joints), material_fractures: triToBool(draft.material_fractures),
      est_soil_pct: nf(draft.est_soil_pct, "Estimated soil %"), est_clay_pct: nf(draft.est_clay_pct, "Estimated clay %"), est_silt_pct: nf(draft.est_silt_pct, "Estimated silt %"), est_sand_pct: nf(draft.est_sand_pct, "Estimated sand %"), est_gravel_pct: nf(draft.est_gravel_pct, "Estimated gravel %"),
      water_dry: triToBool(draft.water_dry), water_moist: triToBool(draft.water_moist), water_wet: triToBool(draft.water_wet), water_flowing: triToBool(draft.water_flowing), water_seep: triToBool(draft.water_seep), water_spring: triToBool(draft.water_spring),
      vegetation_trees: nt(draft.vegetation_trees), vegetation_bushes_shrubs: nt(draft.vegetation_bushes_shrubs), vegetation_groundcover: nt(draft.vegetation_groundcover),
      drainage_clogged_inlet: triToBool(draft.drainage_clogged_inlet), drainage_compromised_drains: triToBool(draft.drainage_compromised_drains), drainage_surface_runoff: triToBool(draft.drainage_surface_runoff), drainage_torrent_surge_flood: triToBool(draft.drainage_torrent_surge_flood),
      impact_impacted_adj_utilities: triToBool(draft.impact_impacted_adj_utilities), impact_maybe_adj_utilities: triToBool(draft.impact_maybe_adj_utilities), impact_adj_utilities: nt(draft.impact_adj_utilities), impact_impacted_adj_properties: triToBool(draft.impact_impacted_adj_properties), impact_maybe_adj_properties: triToBool(draft.impact_maybe_adj_properties), impact_adj_properties: nt(draft.impact_adj_properties), impact_impacted_adj_structure: triToBool(draft.impact_impacted_adj_structure), impact_maybe_adj_structure: triToBool(draft.impact_maybe_adj_structure), impact_adj_structure: nt(draft.impact_adj_structure),
      measure_slope_height_ft: nf(draft.measure_slope_height_ft, "Slope height"), measure_original_slope_deg: nf(draft.measure_original_slope_deg, "Original slope"), measure_landslide_width_ft: nf(draft.measure_landslide_width_ft, "Landslide width"), measure_landslide_length_ft: nf(draft.measure_landslide_length_ft, "Landslide length"), measure_main_scarp_height_ft: nf(draft.measure_main_scarp_height_ft, "Main scarp height"), measure_landslide_slope_deg: nf(draft.measure_landslide_slope_deg, "Landslide slope"), measure_roadway_length_ft: nf(draft.measure_roadway_length_ft, "Roadway length"), measure_roadway_width_ft: nf(draft.measure_roadway_width_ft, "Roadway width"),
      record_of_event_notes: nt(draft.record_of_event_notes), maintenance_history_notes: nt(draft.maintenance_history_notes), geotechnical_assessment_notes: nt(draft.geotechnical_assessment_notes), recommendations_notes: nt(draft.recommendations_notes), sketchpad_notes: nt(draft.sketchpad_notes),
      observations_notes: nt(draft.observations_notes), geometry_json: geometry,
    })});
    await api(`/submissions/${sid}/gisa/incident-types`, { method: "PUT", body: JSON.stringify({ items: inc }) });
    await api(`/submissions/${sid}/gisa/actions`, { method: "PUT", body: JSON.stringify({ immediate: imm, follow_up: fol }) });
  }

  async function saveDraft() { setBusy(true); setErr(null); try { await persistDraft(); await load(); } catch (e: any) { setErr(e?.message ?? "Save failed"); setBusy(false); } }
  async function submitDraft() { setBusy(true); setErr(null); try { await persistDraft(); await api(`/submissions/${sid}/submit`, { method: "POST", body: JSON.stringify({ comment: submitNote.trim() || null }) }); setSubmitNote(""); await load(); } catch (e: any) { setErr(e?.message ?? "Submit failed"); setBusy(false); } }
  async function review(decision: "APPROVE" | "REJECT") { setBusy(true); setErr(null); try { await api(`/submissions/${sid}/review`, { method: "POST", body: JSON.stringify({ decision, comment: reviewNote.trim() || null }) }); await load(); } catch (e: any) { setErr(e?.message ?? "Review failed"); setBusy(false); } }
  async function searchShareCandidates() {
    if (!canManageSharing) return;
    const q = shareQuery.trim();
    if (!q) {
      setShareCandidates([]);
      return;
    }
    try {
      const res = await api<{ items: AdminUser[] }>(`/admin/users?q=${encodeURIComponent(q)}`);
      setShareCandidates((res.items ?? []).filter((u) => u.id !== data?.submission.created_by_user_id));
    } catch (e: any) {
      setErr(e?.message ?? "User search failed");
    }
  }
  async function addShare(userId: number) {
    if (!canManageSharing) return;
    setBusy(true); setErr(null);
    try {
      await api(`/submissions/${sid}/share`, { method: "POST", body: JSON.stringify({ user_id: userId }) });
      await load();
    } catch (e: any) {
      setErr(e?.message ?? "Share failed");
      setBusy(false);
    }
  }
  async function removeShare(userId: number) {
    if (!canManageSharing) return;
    setBusy(true); setErr(null);
    try {
      await api(`/submissions/${sid}/share/${userId}`, { method: "DELETE" });
      await load();
    } catch (e: any) {
      setErr(e?.message ?? "Unshare failed");
      setBusy(false);
    }
  }
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

  async function onDeleteSubmission() {
    if (!data || !canDeleteSubmission) return;
    const ok = window.confirm(
      data.submission.status === "DRAFT"
        ? "Delete this draft?"
        : "Delete this submitted/reviewed record? This cannot be undone."
    );
    if (!ok) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/submissions/${sid}`, { method: "DELETE" });
      window.location.href = "/submissions";
    } catch (e: any) {
      setErr(e?.message ?? "Delete failed");
      setBusy(false);
    }
  }

  async function autofillFromGps() {
    if (!canEdit || !navigator.geolocation) return;
    setGeoBusy(true);
    setErr(null);
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 30000,
        });
      });

      const lat = position.coords.latitude;
      const lon = position.coords.longitude;

      setDraft((prev) => ({ ...prev, latitude: String(lat), longitude: String(lon) }));

      const reverseUrl =
        `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?` +
        `location=${encodeURIComponent(`${lon},${lat}`)}&f=pjson&langCode=en`;
      const geocodeRes = await fetch(reverseUrl);
      if (!geocodeRes.ok) return;
      const geocode = await geocodeRes.json();
      const addr = geocode?.address ?? {};
      const countyRaw = String(addr.Subregion ?? addr.County ?? "").trim();
      const county = countyRaw ? normalizeCounty(countyRaw) : "";
      const districtGuess = districtForCounty(county);
      const routeGuess = tryExtractRoute(
        [addr.StreetName, addr.Match_addr, addr.LongLabel, addr.ShortLabel].filter(Boolean).join(" ")
      );

      setDraft((prev) => ({
        ...prev,
        county: county || prev.county,
        district: districtGuess || prev.district,
        route: routeGuess || prev.route,
      }));
    } catch {
      // keep lat/lon if available; silent fallthrough with generic error
      setErr("Could not fully autofill from GPS. Latitude/Longitude may still be available.");
    } finally {
      setGeoBusy(false);
    }
  }

  useEffect(() => { if (!invalid) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [sid, canManageSharing]);

  const box = "rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3";
  const label = "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted";
  const input = "w-full rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2.5 py-2 text-sm";
  const triFields: Array<[string, string]> = [
    ["failure_rock_fall","Rock Fall"],["failure_topple","Topple"],["failure_slide","Slide"],["failure_spread","Spread"],["failure_flow","Flow"],["failure_compound","Compound"],["failure_erosion","Erosion"],["failure_surficial_failure","Surficial Failure"],["failure_scoured_toe","Scoured Toe"],["failure_washout","Washout"],
    ["distribution_advancing","Dist: Advancing"],["distribution_retrogressive","Dist: Retrogressive"],["distribution_enlarging","Dist: Enlarging"],["distribution_widening","Dist: Widening"],["distribution_moving","Dist: Moving"],["distribution_confined","Dist: Confined"],
    ["material_rock","Material Rock"],["material_soil","Material Soil"],["material_bedding","Rock Bedding"],["material_joints","Rock Joints"],["material_fractures","Rock Fractures"],
    ["water_dry","Water Dry"],["water_moist","Water Moist"],["water_wet","Water Wet"],["water_flowing","Water Flowing"],["water_seep","Water Seep"],["water_spring","Water Spring"],
    ["drainage_clogged_inlet","Drainage Clogged Inlet"],["drainage_compromised_drains","Drainage Compromised Drains"],["drainage_surface_runoff","Drainage Surface Runoff"],["drainage_torrent_surge_flood","Drainage Torrent/Surge/Flood"],
    ["impact_impacted_adj_utilities","Impacted Utilities"],["impact_maybe_adj_utilities","Maybe Utilities"],["impact_impacted_adj_properties","Impacted Properties"],["impact_maybe_adj_properties","Maybe Properties"],["impact_impacted_adj_structure","Impacted Structures"],["impact_maybe_adj_structure","Maybe Structures"],
  ];

  return (
    <AppShell title={invalid ? "Submission" : (data ? buildSubmissionDisplayTitle({
      id: data.submission.id,
      created_at: data.submission.created_at,
      district: data.gisa?.district,
      county: data.gisa?.county,
      route: data.gisa?.route,
      post_mile: data.gisa?.post_mile,
    }) : `Submission ${sid}`)}>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <Link className="text-sm underline text-muted" to="/submissions">{"<-"} Back to submissions</Link>
            <div className="mt-2 flex items-center gap-2"><h2 className="text-lg font-semibold">{invalid ? "Invalid submission id" : (data ? buildSubmissionDisplayTitle({
              id: data.submission.id,
              created_at: data.submission.created_at,
              district: data.gisa?.district,
              county: data.gisa?.county,
              route: data.gisa?.route,
              post_mile: data.gisa?.post_mile,
            }) : `Case ${sid}`)}</h2>{data?.submission && <S s={data.submission.status} />}</div>
          </div>
          <div className="flex gap-2">
            <div className="relative">
              <button
                onClick={() => setMenuOpen((prev) => !prev)}
                disabled={invalid}
                className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm hover:brightness-95 disabled:opacity-60"
                title="Submission options"
              >
                ⋮
              </button>
              {menuOpen ? (
                <div className="absolute right-0 top-10 z-10 min-w-36 rounded-md border border-[var(--line)] bg-[var(--panel)] p-1 shadow-lg">
                  <button
                    onClick={load}
                    className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--panel-soft)]"
                  >
                    Refresh
                  </button>
                  {canDeleteSubmission ? (
                    <button
                      onClick={onDeleteSubmission}
                      className="block w-full rounded px-2 py-1.5 text-left text-xs text-red-600 hover:bg-[color:color-mix(in_oklab,var(--bad)_12%,transparent)]"
                    >
                      Delete
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
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
            <section className="rounded-xl surface-soft p-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">GISA Form</h3>
                <div className="mt-1 text-xs text-muted">{canEdit ? "Unified view/edit form." : "Unified read-only form."}</div>
                <fieldset disabled={!canEdit} className="contents">
                <div className="mt-3 rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">Location And ERIS Map</div>
                    <button onClick={autofillFromGps} disabled={busy || geoBusy} className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-1.5 text-xs disabled:opacity-60">{geoBusy ? "Detecting..." : "Use GPS Autofill"}</button>
                  </div>
                  <SubmissionArcGisMap
                    geojson={geom}
                    location={{ latitude: draft.latitude ? Number(draft.latitude) : null, longitude: draft.longitude ? Number(draft.longitude) : null }}
                    height={300}
                  />
                </div>
                <div className="mt-3 rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-3">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">GISA Sheet Fields</div>
                <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                  <input className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Report Date (YYYY-MM-DD)" value={draft.report_date} onChange={(e)=>setDraft((d)=>({...d,report_date:e.target.value}))} />
                  <select className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" value={draft.district} onChange={(e)=>setDraft((d)=>({...d,district:e.target.value}))}>
                    <option value="">District</option>
                    {CALTRANS_DISTRICTS.map((d) => <option key={d} value={d}>{`District ${d}`}</option>)}
                  </select>
                  <select className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" value={draft.county} onChange={(e)=>{
                    const county = e.target.value;
                    const district = districtForCounty(county);
                    setDraft((d)=>({...d,county,district:district ?? d.district}));
                  }}>
                    <option value="">County</option>
                    {CALIFORNIA_COUNTIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <input className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Route" inputMode="numeric" pattern="[0-9]*" value={draft.route} onChange={(e)=>setDraft((d)=>({...d,route:e.target.value}))} />
                  <input className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Post Mile" value={draft.post_mile} onChange={(e)=>setDraft((d)=>({...d,post_mile:e.target.value}))} />
                  <input className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="EA" value={draft.ea} onChange={(e)=>setDraft((d)=>({...d,ea:e.target.value}))} />
                  <input className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Project ID" value={draft.project_id} onChange={(e)=>setDraft((d)=>({...d,project_id:e.target.value}))} />
                  <input className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Date Incident Reported" value={draft.date_incident_reported} onChange={(e)=>setDraft((d)=>({...d,date_incident_reported:e.target.value}))} />
                  <input className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="District Contact" value={draft.district_contact} onChange={(e)=>setDraft((d)=>({...d,district_contact:e.target.value}))} />
                  <input type="number" step="any" inputMode="decimal" className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Latitude" value={draft.latitude} onChange={(e)=>setDraft((d)=>({...d,latitude:e.target.value}))} />
                  <input type="number" step="any" inputMode="decimal" className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Longitude" value={draft.longitude} onChange={(e)=>setDraft((d)=>({...d,longitude:e.target.value}))} />
                  <input type="number" step="1" inputMode="numeric" className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Lanes Closed Count" value={draft.lanes_closed_count} onChange={(e)=>setDraft((d)=>({...d,lanes_closed_count:e.target.value}))} />
                  <input type="number" step="any" inputMode="decimal" className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Crack Length (ft)" value={draft.crack_length_ft} onChange={(e)=>setDraft((d)=>({...d,crack_length_ft:e.target.value}))} />
                  <input type="number" step="any" inputMode="decimal" className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Crack Horizontal (in)" value={draft.crack_horizontal_in} onChange={(e)=>setDraft((d)=>({...d,crack_horizontal_in:e.target.value}))} />
                  <input type="number" step="any" inputMode="decimal" className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Crack Vertical (in)" value={draft.crack_vertical_in} onChange={(e)=>setDraft((d)=>({...d,crack_vertical_in:e.target.value}))} />
                  <input type="number" step="any" inputMode="decimal" className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Crack Depth (in)" value={draft.crack_depth_in} onChange={(e)=>setDraft((d)=>({...d,crack_depth_in:e.target.value}))} />
                  <input type="number" step="any" inputMode="decimal" className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Settlement (in)" value={draft.settlement_in} onChange={(e)=>setDraft((d)=>({...d,settlement_in:e.target.value}))} />
                  <input type="number" step="any" inputMode="decimal" className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Bulge (in)" value={draft.bulge_in} onChange={(e)=>setDraft((d)=>({...d,bulge_in:e.target.value}))} />
                  <select className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" value={draft.distribution_code} onChange={(e)=>setDraft((d)=>({...d,distribution_code:e.target.value}))}><option value="">Distribution</option>{(lookups?.distribution??[]).map((x)=><option key={x.code} value={x.code}>{x.label}</option>)}</select>
                  <select className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" value={draft.highway_status_code} onChange={(e)=>setDraft((d)=>({...d,highway_status_code:e.target.value}))}><option value="">Highway Status</option>{(lookups?.highway_status??[]).map((x)=><option key={x.code} value={x.code}>{x.label}</option>)}</select>
                  <select className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" value={draft.pavement_ground_cracks} onChange={(e)=>setDraft((d)=>({...d,pavement_ground_cracks:e.target.value as Tri}))}><option value="UNKNOWN">Pavement Cracks: Unknown</option><option value="YES">Pavement Cracks: Yes</option><option value="NO">Pavement Cracks: No</option></select>
                  <select className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" value={draft.indented_by_rocks} onChange={(e)=>setDraft((d)=>({...d,indented_by_rocks:e.target.value as Tri}))}><option value="UNKNOWN">Indented by Rocks: Unknown</option><option value="YES">Indented by Rocks: Yes</option><option value="NO">Indented by Rocks: No</option></select>
                  <input type="number" step="1" inputMode="numeric" className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Open Highway Traffic Lanes Count" value={draft.open_highway_traffic_lanes_count} onChange={(e)=>setDraft((d)=>({...d,open_highway_traffic_lanes_count:e.target.value}))} />
                  {[
                    ["failure_rock_fall","Rock Fall"],["failure_topple","Topple"],["failure_slide","Slide"],["failure_spread","Spread"],["failure_flow","Flow"],["failure_compound","Compound"],["failure_erosion","Erosion"],["failure_surficial_failure","Surficial Failure"],["failure_scoured_toe","Scoured Toe"],["failure_washout","Washout"],
                    ["distribution_advancing","Distribution Advancing"],["distribution_retrogressive","Distribution Retrogressive"],["distribution_enlarging","Distribution Enlarging"],["distribution_widening","Distribution Widening"],["distribution_moving","Distribution Moving"],["distribution_confined","Distribution Confined"],
                    ["material_rock","Material Rock"],["material_soil","Material Soil"],["material_bedding","Material Bedding"],["material_joints","Material Joints"],["material_fractures","Material Fractures"],
                    ["water_dry","Water Dry"],["water_moist","Water Moist"],["water_wet","Water Wet"],["water_flowing","Water Flowing"],["water_seep","Water Seep"],["water_spring","Water Spring"],
                    ["drainage_clogged_inlet","Drainage Clogged Inlet"],["drainage_compromised_drains","Drainage Compromised Drains"],["drainage_surface_runoff","Drainage Surface Runoff"],["drainage_torrent_surge_flood","Drainage Torrent/Surge/Flood"],
                    ["impact_impacted_adj_utilities","Impacted Adjacent Utilities"],["impact_maybe_adj_utilities","Maybe Adjacent Utilities"],
                    ["impact_impacted_adj_properties","Impacted Adjacent Properties"],["impact_maybe_adj_properties","Maybe Adjacent Properties"],
                    ["impact_impacted_adj_structure","Impacted Adjacent Structures"],["impact_maybe_adj_structure","Maybe Adjacent Structures"],
                  ].map(([key, label]) => (
                    <select key={key} className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" value={draft[key]} onChange={(e)=>setDraft((d)=>({...d,[key]:e.target.value as Tri}))}>
                      <option value="UNKNOWN">{label}: Unknown</option>
                      <option value="YES">{label}: Yes</option>
                      <option value="NO">{label}: No</option>
                    </select>
                  ))}
                  <input className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Adjacent Utilities Notes" value={draft.impact_adj_utilities} onChange={(e)=>setDraft((d)=>({...d,impact_adj_utilities:e.target.value}))} />
                  <input className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Adjacent Properties Notes" value={draft.impact_adj_properties} onChange={(e)=>setDraft((d)=>({...d,impact_adj_properties:e.target.value}))} />
                  <input className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Adjacent Structures Notes" value={draft.impact_adj_structure} onChange={(e)=>setDraft((d)=>({...d,impact_adj_structure:e.target.value}))} />
                  <input type="number" step="any" inputMode="decimal" className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Estimated Soil %" value={draft.est_soil_pct} onChange={(e)=>setDraft((d)=>({...d,est_soil_pct:e.target.value}))} />
                  <input type="number" step="any" inputMode="decimal" className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Estimated Clay %" value={draft.est_clay_pct} onChange={(e)=>setDraft((d)=>({...d,est_clay_pct:e.target.value}))} />
                  <input type="number" step="any" inputMode="decimal" className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Estimated Silt %" value={draft.est_silt_pct} onChange={(e)=>setDraft((d)=>({...d,est_silt_pct:e.target.value}))} />
                  <input type="number" step="any" inputMode="decimal" className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Estimated Sand %" value={draft.est_sand_pct} onChange={(e)=>setDraft((d)=>({...d,est_sand_pct:e.target.value}))} />
                  <input type="number" step="any" inputMode="decimal" className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Estimated Gravel %" value={draft.est_gravel_pct} onChange={(e)=>setDraft((d)=>({...d,est_gravel_pct:e.target.value}))} />
                  <input className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Vegetation Trees %" value={draft.vegetation_trees} onChange={(e)=>setDraft((d)=>({...d,vegetation_trees:e.target.value}))} />
                  <input className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Vegetation Bushes/Shrubs %" value={draft.vegetation_bushes_shrubs} onChange={(e)=>setDraft((d)=>({...d,vegetation_bushes_shrubs:e.target.value}))} />
                  <input className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Vegetation Groundcover %" value={draft.vegetation_groundcover} onChange={(e)=>setDraft((d)=>({...d,vegetation_groundcover:e.target.value}))} />
                  <input type="number" step="any" inputMode="decimal" className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Slope Height (ft)" value={draft.measure_slope_height_ft} onChange={(e)=>setDraft((d)=>({...d,measure_slope_height_ft:e.target.value}))} />
                  <input type="number" step="any" inputMode="decimal" className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Original Slope (deg)" value={draft.measure_original_slope_deg} onChange={(e)=>setDraft((d)=>({...d,measure_original_slope_deg:e.target.value}))} />
                  <input type="number" step="any" inputMode="decimal" className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Landslide Width (ft)" value={draft.measure_landslide_width_ft} onChange={(e)=>setDraft((d)=>({...d,measure_landslide_width_ft:e.target.value}))} />
                  <input type="number" step="any" inputMode="decimal" className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Landslide Length (ft)" value={draft.measure_landslide_length_ft} onChange={(e)=>setDraft((d)=>({...d,measure_landslide_length_ft:e.target.value}))} />
                  <input type="number" step="any" inputMode="decimal" className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Main Scarp Height (ft)" value={draft.measure_main_scarp_height_ft} onChange={(e)=>setDraft((d)=>({...d,measure_main_scarp_height_ft:e.target.value}))} />
                  <input type="number" step="any" inputMode="decimal" className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Landslide Slope (deg)" value={draft.measure_landslide_slope_deg} onChange={(e)=>setDraft((d)=>({...d,measure_landslide_slope_deg:e.target.value}))} />
                  <input type="number" step="any" inputMode="decimal" className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Roadway Length (ft)" value={draft.measure_roadway_length_ft} onChange={(e)=>setDraft((d)=>({...d,measure_roadway_length_ft:e.target.value}))} />
                  <input type="number" step="any" inputMode="decimal" className="rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" placeholder="Roadway Width (ft)" value={draft.measure_roadway_width_ft} onChange={(e)=>setDraft((d)=>({...d,measure_roadway_width_ft:e.target.value}))} />
                </div>
                </div>
                <textarea className="mt-2 w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" rows={3} placeholder="Observations" value={draft.observations_notes} onChange={(e)=>setDraft((d)=>({...d,observations_notes:e.target.value}))} />
                <textarea className="mt-2 w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" rows={2} placeholder="Record of Event Notes" value={draft.record_of_event_notes} onChange={(e)=>setDraft((d)=>({...d,record_of_event_notes:e.target.value}))} />
                <textarea className="mt-2 w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" rows={2} placeholder="Maintenance History Notes" value={draft.maintenance_history_notes} onChange={(e)=>setDraft((d)=>({...d,maintenance_history_notes:e.target.value}))} />
                <textarea className="mt-2 w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" rows={2} placeholder="Geotechnical Assessment Notes" value={draft.geotechnical_assessment_notes} onChange={(e)=>setDraft((d)=>({...d,geotechnical_assessment_notes:e.target.value}))} />
                <textarea className="mt-2 w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" rows={2} placeholder="Recommendations Notes" value={draft.recommendations_notes} onChange={(e)=>setDraft((d)=>({...d,recommendations_notes:e.target.value}))} />
                <textarea className="mt-2 w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" rows={2} placeholder="Sketchpad Notes" value={draft.sketchpad_notes} onChange={(e)=>setDraft((d)=>({...d,sketchpad_notes:e.target.value}))} />
                <textarea className="mt-2 w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-mono" rows={4} placeholder='Geometry JSON {"type":"Point","coordinates":[...]} ' value={draft.geometry_json} onChange={(e)=>setDraft((d)=>({...d,geometry_json:e.target.value}))} />
                <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-3">
                  <div><div className="text-xs font-semibold uppercase text-muted">Incident Types</div><div className="mt-1 flex flex-wrap gap-1">{(lookups?.incident_types??[]).map((x)=><button key={x.code} type="button" onClick={()=>setInc((p)=>tog(p,x.code))} className={`rounded-full border px-2 py-1 text-xs ${inc.includes(x.code)?"border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_16%,transparent)] text-[var(--brand)]":"border-[var(--line)] bg-[var(--panel)] text-[var(--ink)]"}`}>{x.label}</button>)}</div></div>
                  <div><div className="text-xs font-semibold uppercase text-muted">Immediate</div><div className="mt-1 flex flex-wrap gap-1">{(lookups?.actions?.immediate??[]).map((x)=><button key={x.code} type="button" onClick={()=>setImm((p)=>tog(p,x.code))} className={`rounded-full border px-2 py-1 text-xs ${imm.includes(x.code)?"border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_16%,transparent)] text-[var(--brand)]":"border-[var(--line)] bg-[var(--panel)] text-[var(--ink)]"}`}>{x.label}</button>)}</div></div>
                  <div><div className="text-xs font-semibold uppercase text-muted">Follow-Up</div><div className="mt-1 flex flex-wrap gap-1">{(lookups?.actions?.follow_up??[]).map((x)=><button key={x.code} type="button" onClick={()=>setFol((p)=>tog(p,x.code))} className={`rounded-full border px-2 py-1 text-xs ${fol.includes(x.code)?"border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_16%,transparent)] text-[var(--brand)]":"border-[var(--line)] bg-[var(--panel)] text-[var(--ink)]"}`}>{x.label}</button>)}</div></div>
                </div>
                </fieldset>
                {canEdit ? (
                  <>
                    <textarea className="mt-2 w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" rows={2} placeholder="Submit comment (optional)" value={submitNote} onChange={(e)=>setSubmitNote(e.target.value)} />
                    <div className="mt-2 flex gap-2"><button onClick={saveDraft} disabled={busy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm disabled:opacity-60">Save Draft</button><button onClick={submitDraft} disabled={busy} className="rounded-md bg-[var(--good)] px-3 py-2 text-sm text-white disabled:opacity-60">{data.submission.status === "REJECTED" ? "Resubmit for Review" : "Submit for Review"}</button></div>
                  </>
                ) : null}
              </section>

            <Section title="Summary" open>
              <R l="Descriptor" v={buildSubmissionDisplayTitle({
                id: data.submission.id,
                created_at: data.submission.created_at,
                district: data.gisa?.district,
                county: data.gisa?.county,
                route: data.gisa?.route,
                post_mile: data.gisa?.post_mile,
              })} />
              <R l="Created" v={data.submission.created_at} />
              <R l="Updated" v={data.submission.updated_at} />
              <R l="Submitted" v={data.submission.submitted_at} />
              <R l="Reviewed" v={data.submission.reviewed_at} />
              <R l="Status" v={data.submission.status} />
            </Section>


            <Section title="Reviewer Note" open>
              <textarea value={reviewNote} onChange={(e)=>setReviewNote(e.target.value)} rows={3} disabled={busy||!canReview} className="w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" />
            </Section>

            <Section title="Attachments">
              <div className="overflow-x-auto">{data.attachments.length===0?<div className="text-sm text-muted">No attachments.</div>:<table className="w-full border-collapse"><thead><tr className="border-b border-[var(--line)] text-left text-xs font-semibold uppercase tracking-wide text-muted"><th className="py-2 px-2">ID</th><th className="py-2 px-2">File</th><th className="py-2 px-2">Type</th><th className="py-2 px-2">Size</th><th className="py-2 px-2"></th></tr></thead><tbody>{data.attachments.map((a)=><tr key={a.id} className="border-b border-[var(--line)]/50"><td className="py-2 px-2 text-sm">{a.id}</td><td className="py-2 px-2 text-sm">{a.file_name}</td><td className="py-2 px-2 text-sm">{a.mime_type}</td><td className="py-2 px-2 text-sm">{a.file_size_bytes.toLocaleString()}</td><td className="py-2 px-2 text-sm"><button onClick={()=>openDownloadUrl(a.id)} disabled={downloading===a.id} className="rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-xs">{downloading===a.id?"Opening...":"Open Photo"}</button></td></tr>)}</tbody></table>}</div>
            </Section>

            <Section title="Workflow Events">
              <div>{data.workflow_events.length===0?<div className="text-sm text-muted">No workflow events.</div>:<ol className="space-y-2">{data.workflow_events.map((e)=><li key={e.id} className="rounded border border-[var(--line)] p-2 text-sm"><div className="text-xs text-muted">{e.created_at}</div><div className="font-medium">{e.event_type} ({e.from_status ?? "-"} {"->"} {e.to_status ?? "-"})</div><div className="text-xs text-muted">Actor {e.actor_user_id}{e.comment ? ` - ${e.comment}` : ""}</div></li>)}</ol>}</div>
            </Section>

            {canManageSharing && (
              <Section title="Access Sharing">
                <div className="flex gap-2">
                  <input
                    className="w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"
                    placeholder="Search users by email or name"
                    value={shareQuery}
                    onChange={(e) => setShareQuery(e.target.value)}
                  />
                  <button onClick={searchShareCandidates} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm">Search</button>
                </div>
                {shareCandidates.length > 0 ? (
                  <div className="mt-2 space-y-1">
                    {shareCandidates.map((u) => (
                      <div key={u.id} className="flex items-center justify-between rounded border border-[var(--line)] p-2 text-sm">
                        <div>{u.full_name} ({u.email})</div>
                        <button onClick={() => addShare(u.id)} className="rounded border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1 text-xs">Grant Access</button>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted">Users with explicit access</div>
                {sharedWith.length === 0 ? (
                  <div className="mt-1 text-sm text-muted">No explicit grants yet.</div>
                ) : (
                  <div className="mt-2 space-y-1">
                    {sharedWith.map((u) => (
                      <div key={u.user_id} className="flex items-center justify-between rounded border border-[var(--line)] p-2 text-sm">
                        <div>{u.full_name} ({u.email})</div>
                        <button onClick={() => removeShare(u.user_id)} className="rounded border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1 text-xs">Revoke</button>
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
