import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ClipboardList, GripVertical, LayoutGrid, ListChecks, Maximize2, Minimize2, NotebookPen, Plus, RotateCcw, Ruler, ShieldCheck, Shrub, Siren, Sprout, Trash2, TreeDeciduous, X } from "lucide-react";
import { api } from "../api/client";
import type { GisaLookups, SubmissionDetail } from "../api/types";
import { getFormShares, type FormShares } from "../api/sharing";
import AppShell from "../ui/AppShell";
import { useAuth } from "../auth/AuthContext";
import SubmissionDetailHeader from "../features/submissions/SubmissionDetailHeader";
import SubmissionReviewerSupport from "../features/submissions/SubmissionReviewerSupport";
import SubmissionAccessSharing from "../features/submissions/SubmissionAccessSharing";
import SubmissionMeasurementContext from "../features/submissions/SubmissionMeasurementContext";
import SiteMeasurementsPanel, { MEASURE_KEYS, type MeasureValues } from "../features/submissions/SiteMeasurementsPanel";
import SubmissionLocationHero from "../features/submissions/SubmissionLocationHero";
import SubmissionLibrary from "../features/submissions/SubmissionLibrary";
import SubmissionSectionAttachmentsDialog, { SectionAttachmentsButton } from "../features/submissions/SubmissionSectionAttachmentsDialog";
import { useAttachmentUrlResolver } from "../features/submissions/SubmissionAttachmentTiles";
import { R, SubmissionDetailCard, SubmissionDetailCardGrid } from "../features/submissions/SubmissionDetailPrimitives";
import { getSubmissionPhotoEvidence, type PhotoMapResponse } from "../features/submissions/photoEvidenceApi";
import { buildLibraryItems, CARD_SECTION_KEYS, itemsForSectionKeys, NOTES_SECTION_KEYS } from "../features/submissions/submissionAttachmentModel";
import { useSubmissionDashboardLayout, type ResizeMode } from "../features/submissions/useSubmissionDashboardLayout";
import {
  boolToTri,
  DASHBOARD_CARD_TITLES,
  DISTRIBUTION_ICON_SRC,
  districtContactRaw,
  EMPTY_SUBMISSION_DRAFT as EMPTY,
  INCIDENT_TYPE_CODE_BY_FORM_KEY,
  INCIDENT_TYPE_FORM_CODES,
  INCIDENT_TYPE_OPTIONS,
  LANES_CLOSED_OPTIONS,
  nullableInteger as ni,
  nullableNumber as nf,
  nullablePercent as np,
  nullableText as nt,
  normalizeCounty,
  normalizeDistrictValue,
  parseDistrictContacts,
  parseStatePlaneFeetValue,
  pointFromLatLon,
  serializeDistrictContacts,
  textValue as t,
  triToBool,
  tryExtractRoute,
  type DashboardCardId,
  type DistrictContact,
  type IncidentTypeOption,
  type SubmissionDraft as Draft,
  type Tri,
} from "../features/submissions/submissionDetailModel";
import {
  convertCaliforniaStatePlaneFeetToLatLon,
  convertLatLonToCaliforniaStatePlaneFeet,
  formatCaliforniaStatePlaneFeet,
  getCaliforniaStatePlaneZone,
} from "../utils/californiaCoordinateSystem";
import { buildSubmissionDisplayTitle } from "../utils/submissionLabel";
import { CALIFORNIA_COUNTIES, CALTRANS_DISTRICTS, countiesForDistrict, countyCodeFromNameOrCode, countyNameFromNameOrCode, districtForCounty, routesForDistrictCounty } from "../utils/caltransLookups";
import { formatCoordinate, normalizeCoordinateValue, normalizePostMileInput, normalizePostMileValue, normalizeRouteInput, normalizeRouteValue } from "../utils/precision";
import { isAssessmentAuthor, isOperationalUser, isPublicOnly } from "../utils/roleModel";
import ActionChecklist from "../features/submissions/ActionChecklist";
import { CompositionBar, DateField, FieldGroup, InlineField, NumberField, OptionTile, PanelChoice, Segmented, SliderField, Stepper } from "../features/submissions/gisaFields";
import MemosPanel from "../features/submissions/MemosPanel";
import SubmissionRecordCard from "../features/submissions/SubmissionRecordCard";
import { chooseMemoContent, RICH_MEMO_KEYS, type RichMemoKey } from "../features/submissions/memoContentModel";
import SavedLayoutsMenu from "../features/submissions/SavedLayoutsMenu";
import { AccessDeniedNotice } from "../auth/AccessDenied";

const label = "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted";
const input = "w-full rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2.5 py-2 text-sm";
const toolbarButton = "inline-flex items-center gap-1 rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2.5 py-1.5 text-xs font-medium hover:brightness-95 disabled:opacity-60";

/** Text of a formatted memo, for the page's plain-text copy of it. */
const memoText = (html: string) =>
  html ? new DOMParser().parseFromString(html, "text/html").body.textContent ?? "" : "";

const EMPTY_MEMOS: Record<RichMemoKey, string> = {
  observations_notes: "",
  geotechnical_assessment_notes: "",
  recommendations_notes: "",
  sketchpad_notes: "",
};

const YES_NO = [{ value: "YES", label: "Yes" }, { value: "NO", label: "No" }] as const;
const IMPACT_OPTIONS = [{ value: "MAYBE", label: "Maybe" }, { value: "IMPACTED", label: "Impacted" }] as const;
const triValue = (value: string) => (value === "YES" || value === "NO" ? value : "");
const triFrom = (value: string) => (value === "YES" || value === "NO" ? value : "UNKNOWN");
const SOIL_FRACTIONS = [
  ["est_clay_pct", "Clay", "#a0522d"],
  ["est_silt_pct", "Silt", "#b58d5f"],
  ["est_sand_pct", "Sand", "#d4a933"],
  ["est_gravel_pct", "Gravel", "#78818c"],
] as const;
// Dry ground to flowing water, with the color the scale shows for each.
const WATER_STEPS = [
  ["water_dry", "Dry", "#a8793a"],
  ["water_moist", "Moist", "#5f9a84"],
  ["water_wet", "Wet", "#3a86c8"],
  ["water_flowing", "Flowing", "#1f5fae"],
] as const;
const DISTRICT_CONTACT_FIELDS = [
  ["first_name", "First name"],
  ["last_name", "Last name"],
  ["s_number", "S number"],
  ["phone", "Phone"],
  ["cell_phone", "Cell phone"],
] as const;

function SectionHeading({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle: string }) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[color:color-mix(in_oklab,var(--accent)_14%,var(--panel))] text-[var(--accent)]" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">
        <h2 className="text-base font-semibold leading-tight">{title}</h2>
        <p className="text-xs text-muted">{subtitle}</p>
      </div>
    </div>
  );
}

type CanvasCardProps = {
  id: DashboardCardId;
  style: CSSProperties;
  dragging: boolean;
  formDisabled: boolean;
  attachmentCount: number;
  onOpenAttachments: () => void;
  onDragStart: (id: DashboardCardId, event: ReactMouseEvent) => void;
  onResizeStart: (id: DashboardCardId, mode: ResizeMode, event: ReactMouseEvent) => void;
  /** Receives the card's natural height (header plus content), so auto layout can fit it. */
  onMeasure?: (id: DashboardCardId, height: number) => void;
  /** Rendered outside the disabled fieldset (read-only tools such as the 3D scene). */
  tools?: ReactNode;
  children: ReactNode;
};

function CanvasCard({ id, style, dragging, formDisabled, attachmentCount, onOpenAttachments, onDragStart, onResizeStart, onMeasure, tools, children }: CanvasCardProps) {
  const headerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Re-measured before paint whenever the card's width changes (content reflows), and
  // by the observer whenever the content itself grows or shrinks.
  const width = style.width;
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || !onMeasure || typeof ResizeObserver === "undefined") return;
    // +2: the card's top and bottom border.
    const report = () => onMeasure(id, (headerRef.current?.offsetHeight ?? 0) + content.offsetHeight + 2);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(content);
    return () => observer.disconnect();
  }, [id, onMeasure, width]);
  return (
    <div
      data-card-id={id}
      style={style}
      className={`flex flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)] ${dragging ? "opacity-40 shadow-2xl" : ""}`}
    >
      <div
        ref={headerRef}
        onMouseDown={(event) => onDragStart(id, event)}
        className="flex shrink-0 cursor-grab select-none items-center justify-between gap-2 px-3 pb-2 pt-3 active:cursor-grabbing"
        title="Drag to move this card"
      >
        <div className="flex min-w-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">
          <GripVertical size={14} strokeWidth={1.9} aria-hidden className="shrink-0 text-muted" />
          <span className="truncate">{DASHBOARD_CARD_TITLES[id]}</span>
        </div>
        <SectionAttachmentsButton count={attachmentCount} onClick={onOpenAttachments} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div ref={contentRef} className="@container px-3 pb-3">
          {tools}
          <fieldset disabled={formDisabled} className="contents min-w-0">
            {children}
          </fieldset>
        </div>
      </div>
      <div data-no-drag className="absolute bottom-0 right-3 top-10 w-1.5 cursor-ew-resize" onMouseDown={(event) => onResizeStart(id, "right", event)} aria-hidden />
      <div data-no-drag className="absolute bottom-0 left-3 right-3 h-1.5 cursor-ns-resize" onMouseDown={(event) => onResizeStart(id, "bottom", event)} aria-hidden />
      <div
        data-no-drag
        className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize rounded-tl border-l border-t border-[var(--line)] bg-[var(--panel-soft)]"
        onMouseDown={(event) => onResizeStart(id, "bottomRight", event)}
        title="Resize"
        aria-hidden
      />
    </div>
  );
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
  const [reviewNote, setReviewNote] = useState("");
  const [submitNote, setSubmitNote] = useState("");
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [inc, setInc] = useState<string[]>([]);
  const [imm, setImm] = useState<string[]>([]);
  const [memos, setMemos] = useState<Record<RichMemoKey, string>>(EMPTY_MEMOS);
  const [fol, setFol] = useState<string[]>([]);
  const [districtContacts, setDistrictContacts] = useState<DistrictContact[]>([]);
  const [geom, setGeom] = useState<any | null>(null);
  const [shareQuery, setShareQuery] = useState("");
  const [shares, setShares] = useState<FormShares | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoSaveState, setGeoSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [geoSaveMessage, setGeoSaveMessage] = useState("");
  const [showNorthingEasting, setShowNorthingEasting] = useState(false);
  const [northingInput, setNorthingInput] = useState("");
  const [eastingInput, setEastingInput] = useState("");
  const [statePlaneInputError, setStatePlaneInputError] = useState<string | null>(null);
  const [photoMap, setPhotoMap] = useState<PhotoMapResponse | null>(null);
  const [photoLoading, setPhotoLoading] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [sectionDialog, setSectionDialog] = useState<{ title: string; keys: readonly string[] } | null>(null);

  const canvas = useSubmissionDashboardLayout();

  // A read-only viewer reads the APPROVED record and nothing else. The server
  // enforces that — it answers 404 for anything in flight, so ids cannot be
  // probed — and this flag decides what the page LOOKS like: a read view with a
  // banner saying so, rather than an editable form with every input disabled,
  // and the refusal surface rather than a red toast (org model design §8).
  const viewer = isPublicOnly(me?.roles);
  // Review authority follows the linked assessment's routing path, so it is
  // decided server-side and never re-derived from a role string here.
  const canReview = data?.submission.can_review === true || data?.context?.can_review === true;
  // Authoring is Staff's and the Senior Specialist's job, narrowed to
  // the people the server actually grants edit to (owner or editor grant).
  const canEdit = isAssessmentAuthor(me?.roles)
    && data?.submission.can_edit === true
    && (data?.submission.status === "DRAFT" || data?.submission.status === "REJECTED");
  // On an assessment-linked form the decision belongs to the assessment; the
  // server answers 409 here, so the control must not be offered.
  const assessmentLinked = data?.context?.assessment_id != null;
  const canAct = canReview && !assessmentLinked && data?.submission.status === "SUBMITTED";
  const canManageSharing = data?.submission.can_manage_permissions === true;
  const canDeleteSubmission =
    !!data?.submission &&
    (me?.roles?.includes("ADMIN") ||
      (data.submission.status === "DRAFT" && me?.id === data.submission.created_by_user_id));
  const tog = (arr: string[], code: string) => (arr.includes(code) ? arr.filter((x) => x !== code) : [...arr, code]);
  const statePlaneZone = useMemo(() => getCaliforniaStatePlaneZone(draft.county), [draft.county]);
  const statePlaneCoordinates = useMemo(() => {
    if (!statePlaneZone) return null;
    const latitude = normalizeCoordinateValue(draft.latitude);
    const longitude = normalizeCoordinateValue(draft.longitude);
    if (latitude == null || longitude == null) {
      return {
        countyCode: "",
        zone: statePlaneZone,
        northing: Number.NaN,
        easting: Number.NaN,
        units: "US survey ft" as const,
      };
    }
    return convertLatLonToCaliforniaStatePlaneFeet({ latitude, longitude, county: draft.county });
  }, [draft.county, draft.latitude, draft.longitude, statePlaneZone]);

  useEffect(() => {
    if (statePlaneCoordinates) {
      setNorthingInput(formatCaliforniaStatePlaneFeet(statePlaneCoordinates.northing));
      setEastingInput(formatCaliforniaStatePlaneFeet(statePlaneCoordinates.easting));
    } else {
      setNorthingInput("");
      setEastingInput("");
    }
    setStatePlaneInputError(null);
  }, [statePlaneCoordinates?.northing, statePlaneCoordinates?.easting, statePlaneCoordinates?.zone]);

  const applyStatePlaneInputs = useCallback(() => {
    const northing = parseStatePlaneFeetValue(northingInput);
    const easting = parseStatePlaneFeetValue(eastingInput);

    if (northing == null || easting == null) {
      setStatePlaneInputError("Northing and easting must be numeric.");
      return;
    }

    const converted = convertCaliforniaStatePlaneFeetToLatLon({
      northing,
      easting,
      county: draft.county,
    });

    if (!converted) {
      setStatePlaneInputError("Unable to convert northing/easting for the selected county.");
      return;
    }

    setDraft((prev) => ({
      ...prev,
      latitude: formatCoordinate(converted.latitude),
      longitude: formatCoordinate(converted.longitude),
    }));
    setNorthingInput(formatCaliforniaStatePlaneFeet(northing));
    setEastingInput(formatCaliforniaStatePlaneFeet(easting));
    setStatePlaneInputError(null);
  }, [draft.county, eastingInput, northingInput]);

  function soilPercentValidationMessage(): string | null {
    if (draft.material_soil !== "YES") return null;
    const fields: Array<[string, string]> = [
      ["est_clay_pct", "Clay"],
      ["est_silt_pct", "Silt"],
      ["est_sand_pct", "Sand"],
      ["est_gravel_pct", "Gravel"],
    ];
    let total = 0;
    for (const [key, name] of fields) {
      const raw = String(draft[key] ?? "").trim();
      const value = raw ? Number(raw) : 0;
      if (Number.isNaN(value)) return `${name} percentage must be numeric.`;
      total += value;
    }
    const delta = total - 100;
    if (total === 100) return null;
    const dir = delta > 0 ? "over" : "under";
    return `Material Soil percentages must total 100%. Current total is ${total.toFixed(2)}% (${dir} by ${Math.abs(delta).toFixed(2)}%).`;
  }

  const loadPhotoMap = useCallback(async () => {
    if (invalid) return;
    setPhotoLoading(true);
    setPhotoError(null);
    try {
      setPhotoMap(await getSubmissionPhotoEvidence(sid));
    } catch (e: any) {
      setPhotoError(e?.message ?? "Failed to load photo evidence.");
    } finally {
      setPhotoLoading(false);
    }
  }, [invalid, sid]);

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
      const districtContactText = districtContactRaw(gisa.district_contact);
      const loadedDistrictContacts = parseDistrictContacts(districtContactText);
      const loadedIncidentTypeCodes = new Set((d.incident_types ?? []).map((x) => String(x)));
      const incidentTri = (key: string, value: unknown): Tri =>
        value === true || value === 1 || value === "1" || loadedIncidentTypeCodes.has(INCIDENT_TYPE_CODE_BY_FORM_KEY[key])
          ? "YES"
          : "NO";
      setDraft({
        ...EMPTY,
        report_date: t(gisa.report_date),
        district: normalizeDistrictValue(gisa.district) || normalizeDistrictValue(districtForCounty(gisa.county)),
        county: countyNameFromNameOrCode(gisa.county) ?? t(gisa.county),
        route: normalizeRouteInput(gisa.route),
        post_mile: normalizePostMileInput(gisa.post_mile),
        ea: t(gisa.ea),
        project_id: t(gisa.project_id),
        date_incident_reported: t(gisa.date_incident_reported),
        district_contact: districtContactText,
        latitude: formatCoordinate(gisa.latitude), longitude: formatCoordinate(gisa.longitude), distribution_code: t(gisa.distribution_code), highway_status_cause: t(gisa.highway_status_cause), highway_status_code: t(gisa.highway_status_code), lanes_closed_count: t(gisa.lanes_closed_count), open_highway_traffic_lanes_count: t(gisa.open_highway_traffic_lanes_count),
        pavement_ground_cracks: boolToTri(gisa.pavement_ground_cracks), crack_length_ft: t(gisa.crack_length_ft), crack_horizontal_in: t(gisa.crack_horizontal_in), crack_vertical_in: t(gisa.crack_vertical_in), crack_depth_in: t(gisa.crack_depth_in), settlement_in: t(gisa.settlement_in), bulge_in: t(gisa.bulge_in), indented_by_rocks: boolToTri(gisa.indented_by_rocks),
        failure_rock_fall: incidentTri("failure_rock_fall", gisa.failure_rock_fall), failure_topple: incidentTri("failure_topple", gisa.failure_topple), failure_slide: incidentTri("failure_slide", gisa.failure_slide), failure_spread: incidentTri("failure_spread", gisa.failure_spread), failure_flow: incidentTri("failure_flow", gisa.failure_flow), failure_compound: incidentTri("failure_compound", gisa.failure_compound), failure_erosion: incidentTri("failure_erosion", gisa.failure_erosion), failure_surficial_failure: incidentTri("failure_surficial_failure", gisa.failure_surficial_failure), failure_scoured_toe: incidentTri("failure_scoured_toe", gisa.failure_scoured_toe), failure_washout: incidentTri("failure_washout", gisa.failure_washout),
        incident_type_description: t(gisa.incident_type_description),
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
      setDistrictContacts(loadedDistrictContacts);
      setInc(d.incident_types ?? []);
      setMemos(
        Object.fromEntries(
          RICH_MEMO_KEYS.map((key) => {
            const html = (gisa as Record<string, unknown>)[`${key}_html`] as string | null | undefined;
            const plain = (gisa as Record<string, unknown>)[key] as string | null | undefined;
            return [key, chooseMemoContent(html, plain, memoText(html ?? ""))];
          }),
        ) as Record<RichMemoKey, string>,
      );
      setImm(d.actions?.immediate ?? []);
      setFol(d.actions?.follow_up ?? []);
      const loadedCanManageSharing = d.submission.can_manage_permissions === true;
      if (loadedCanManageSharing) {
        setShares(await getFormShares(sid));
      } else {
        setShares(null);
      }
      void loadPhotoMap();
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
    const incidentItems = Array.from(new Set([
      ...Object.entries(INCIDENT_TYPE_CODE_BY_FORM_KEY)
        .filter(([key]) => draft[key] === "YES")
        .map(([, code]) => code),
      ...inc.filter((code) => !INCIDENT_TYPE_FORM_CODES.has(code)),
    ]));
    await api(`/submissions/${sid}/gisa`, { method: "PATCH", body: JSON.stringify({
      report_date: nt(draft.report_date), district: nt(draft.district), county: nt(draft.county), route: normalizeRouteValue(draft.route), post_mile: normalizePostMileValue(draft.post_mile), ea: nt(draft.ea), project_id: nt(draft.project_id), date_incident_reported: nt(draft.date_incident_reported), district_contact: nt(draft.district_contact),
      latitude: normalizeCoordinateValue(nf(draft.latitude, "Latitude")), longitude: normalizeCoordinateValue(nf(draft.longitude, "Longitude")), distribution_code: nt(draft.distribution_code), highway_status_cause: nt(draft.highway_status_cause), highway_status_code: nt(draft.highway_status_code), lanes_closed_count: ni(draft.lanes_closed_count, "Lanes closed count"), open_highway_traffic_lanes_count: ni(draft.open_highway_traffic_lanes_count, "Open highway lanes"),
      pavement_ground_cracks: triToBool(draft.pavement_ground_cracks), crack_length_ft: nf(draft.crack_length_ft, "Crack length"), crack_horizontal_in: nf(draft.crack_horizontal_in, "Crack horizontal"), crack_vertical_in: nf(draft.crack_vertical_in, "Crack vertical"), crack_depth_in: nf(draft.crack_depth_in, "Crack depth"), settlement_in: nf(draft.settlement_in, "Settlement"), bulge_in: nf(draft.bulge_in, "Bulge"), indented_by_rocks: triToBool(draft.indented_by_rocks),
      failure_rock_fall: triToBool(draft.failure_rock_fall), failure_topple: triToBool(draft.failure_topple), failure_slide: triToBool(draft.failure_slide), failure_spread: triToBool(draft.failure_spread), failure_flow: triToBool(draft.failure_flow), failure_compound: triToBool(draft.failure_compound), failure_erosion: triToBool(draft.failure_erosion), failure_surficial_failure: triToBool(draft.failure_surficial_failure), failure_scoured_toe: triToBool(draft.failure_scoured_toe), failure_washout: triToBool(draft.failure_washout), incident_type_description: nt(draft.incident_type_description),
      distribution_advancing: triToBool(draft.distribution_advancing), distribution_retrogressive: triToBool(draft.distribution_retrogressive), distribution_enlarging: triToBool(draft.distribution_enlarging), distribution_widening: triToBool(draft.distribution_widening), distribution_moving: triToBool(draft.distribution_moving), distribution_confined: triToBool(draft.distribution_confined),
      material_rock: triToBool(draft.material_rock), material_soil: triToBool(draft.material_soil), material_bedding: triToBool(draft.material_bedding), material_joints: triToBool(draft.material_joints), material_fractures: triToBool(draft.material_fractures),
      est_soil_pct: nf(draft.est_soil_pct, "Estimated soil %"), est_clay_pct: nf(draft.est_clay_pct, "Estimated clay %"), est_silt_pct: nf(draft.est_silt_pct, "Estimated silt %"), est_sand_pct: nf(draft.est_sand_pct, "Estimated sand %"), est_gravel_pct: nf(draft.est_gravel_pct, "Estimated gravel %"),
      water_dry: triToBool(draft.water_dry), water_moist: triToBool(draft.water_moist), water_wet: triToBool(draft.water_wet), water_flowing: triToBool(draft.water_flowing), water_seep: triToBool(draft.water_seep), water_spring: triToBool(draft.water_spring),
      vegetation_trees: np(draft.vegetation_trees, "Trees Coverage %"), vegetation_bushes_shrubs: np(draft.vegetation_bushes_shrubs, "Bushes/Shrubs Coverage %"), vegetation_groundcover: np(draft.vegetation_groundcover, "Groundcover Coverage %"),
      drainage_clogged_inlet: triToBool(draft.drainage_clogged_inlet), drainage_compromised_drains: triToBool(draft.drainage_compromised_drains), drainage_surface_runoff: triToBool(draft.drainage_surface_runoff), drainage_torrent_surge_flood: triToBool(draft.drainage_torrent_surge_flood),
      impact_impacted_adj_utilities: triToBool(draft.impact_impacted_adj_utilities), impact_maybe_adj_utilities: triToBool(draft.impact_maybe_adj_utilities), impact_adj_utilities: nt(draft.impact_adj_utilities), impact_impacted_adj_properties: triToBool(draft.impact_impacted_adj_properties), impact_maybe_adj_properties: triToBool(draft.impact_maybe_adj_properties), impact_adj_properties: nt(draft.impact_adj_properties), impact_impacted_adj_structure: triToBool(draft.impact_impacted_adj_structure), impact_maybe_adj_structure: triToBool(draft.impact_maybe_adj_structure), impact_adj_structure: nt(draft.impact_adj_structure),
      measure_slope_height_ft: nf(draft.measure_slope_height_ft, "Slope height"), measure_original_slope_deg: nf(draft.measure_original_slope_deg, "Original slope"), measure_landslide_width_ft: nf(draft.measure_landslide_width_ft, "Landslide width"), measure_landslide_length_ft: nf(draft.measure_landslide_length_ft, "Landslide length"), measure_main_scarp_height_ft: nf(draft.measure_main_scarp_height_ft, "Main scarp height"), measure_landslide_slope_deg: nf(draft.measure_landslide_slope_deg, "Landslide slope"), measure_roadway_length_ft: nf(draft.measure_roadway_length_ft, "Roadway length"), measure_roadway_width_ft: nf(draft.measure_roadway_width_ft, "Roadway width"),
      record_of_event_notes: nt(draft.record_of_event_notes), maintenance_history_notes: nt(draft.maintenance_history_notes), geotechnical_assessment_notes: nt(draft.geotechnical_assessment_notes), recommendations_notes: nt(draft.recommendations_notes), sketchpad_notes: nt(draft.sketchpad_notes),
      observations_notes: nt(draft.observations_notes), geometry_json: geometry,
      observations_notes_html: memos.observations_notes, geotechnical_assessment_notes_html: memos.geotechnical_assessment_notes,
      recommendations_notes_html: memos.recommendations_notes, sketchpad_notes_html: memos.sketchpad_notes,
    })});
    await api(`/submissions/${sid}/gisa/incident-types`, { method: "PUT", body: JSON.stringify({ items: incidentItems }) });
    await api(`/submissions/${sid}/gisa/actions`, { method: "PUT", body: JSON.stringify({ immediate: imm, follow_up: fol }) });
  }

  async function saveDraft() { setBusy(true); setErr(null); try { await persistDraft(); await load(); } catch (e: any) { setErr(e?.message ?? "Save failed"); setBusy(false); } }
  async function submitDraft() {
    // A linked form is sent for review on its assessment; the server 409s here.
    if (assessmentLinked) {
      setErr("Send this for review on the assessment — the technical form no longer has its own Submit.");
      return;
    }
    const soilMsg = soilPercentValidationMessage();
    if (soilMsg) {
      setErr(soilMsg);
      return;
    }
    setBusy(true); setErr(null); try { await persistDraft(); await api(`/submissions/${sid}/submit`, { method: "POST", body: JSON.stringify({ comment: submitNote.trim() || null }) }); setSubmitNote(""); await load(); } catch (e: any) { setErr(e?.message ?? "Submit failed"); setBusy(false); }
  }
  // One approval per piece of work: on a linked form the decision is the
  // assessment's, and the server refuses this endpoint with a 409.
  async function review(decision: "APPROVE" | "REJECT") { if (assessmentLinked) { setErr("Decide this on the assessment — the technical form no longer carries the decision."); return; } setBusy(true); setErr(null); try { await api(`/submissions/${sid}/review`, { method: "POST", body: JSON.stringify({ decision, comment: reviewNote.trim() || null }) }); await load(); } catch (e: any) { setErr(e?.message ?? "Review failed"); setBusy(false); } }
  async function addShare(userId: number) {
    if (!canManageSharing) return;
    setBusy(true); setErr(null);
    try {
      await api(`/submissions/${sid}/share`, { method: "POST", body: JSON.stringify({ user_id: userId }) });
      setShareQuery("");
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

  const onMapGeometryChange = useCallback(
    async (nextGeometry: any | null) => {
      setGeom(nextGeometry);
      setDraft((d) => ({
        ...d,
        geometry_json: nextGeometry ? JSON.stringify(nextGeometry, null, 2) : "",
      }));

      if (!canEdit || invalid) return;

      setGeoSaveState("saving");
      setGeoSaveMessage(nextGeometry ? "Saving map geometry..." : "Clearing map geometry...");
      try {
        await api(`/submissions/${sid}/gisa`, {
          method: "PATCH",
          body: JSON.stringify({ geometry_json: nextGeometry }),
        });
        setGeoSaveState("saved");
        setGeoSaveMessage(nextGeometry ? "Map geometry saved." : "Map geometry cleared.");
      } catch (e: any) {
        setGeoSaveState("error");
        setGeoSaveMessage(e?.message ?? "Map geometry save failed.");
      }
    },
    [canEdit, invalid, sid]
  );

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

      setDraft((prev) => ({ ...prev, latitude: formatCoordinate(lat), longitude: formatCoordinate(lon) }));

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

  useEffect(() => { if (!invalid) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [sid]);

  const drainageKeys = ["drainage_clogged_inlet", "drainage_compromised_drains", "drainage_surface_runoff", "drainage_torrent_surge_flood"] as const;
  const baseWaterKeys = ["water_dry", "water_moist", "water_wet", "water_flowing"] as const;
  const materialRockSelected = draft.material_rock === "YES";
  const materialSoilSelected = draft.material_soil === "YES";
  const waterFlowingSelected = draft.water_flowing === "YES";
  const highwayLanesClosedSelected = draft.highway_status_code === "LANES_CLOSED";
  const openHighwayTrafficSelected = imm.includes("OPEN_HIGHWAY_TRAFFIC") || fol.includes("OPEN_HIGHWAY_TRAFFIC");
  const countyOptions = draft.district ? countiesForDistrict(draft.district) : CALIFORNIA_COUNTIES;
  const routeOptions = routesForDistrictCounty(draft.district, draft.county);

  const contactDisplayName = (contact: DistrictContact, idx: number) => {
    const full = `${contact.first_name} ${contact.last_name}`.trim();
    return full || `Contact ${idx + 1}`;
  };
  const syncDistrictContacts = (nextContacts: DistrictContact[]) => {
    setDistrictContacts(nextContacts);
    setDraft((d) => ({ ...d, district_contact: serializeDistrictContacts(nextContacts) }));
  };
  const addDistrictContact = () => {
    if (!canEdit) return;
    const nextContact: DistrictContact = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      first_name: "",
      last_name: "",
      s_number: "",
      phone: "",
      cell_phone: "",
    };
    const nextContacts = [...districtContacts, nextContact];
    syncDistrictContacts(nextContacts);
  };
  const updateDistrictContact = (
    idToUpdate: string,
    field: "first_name" | "last_name" | "s_number" | "phone" | "cell_phone",
    value: string
  ) => {
    if (!canEdit) return;
    const next = districtContacts.map((contact) =>
      contact.id === idToUpdate ? { ...contact, [field]: value } : contact
    );
    syncDistrictContacts(next);
  };
  const removeDistrictContact = (idToRemove: string) => {
    if (!canEdit) return;
    const next = districtContacts.filter((contact) => contact.id !== idToRemove);
    syncDistrictContacts(next);
  };

  const toggleIncidentType = (option: IncidentTypeOption) => {
    if (!canEdit) return;
    const active = inc.includes(option.code) || (!!option.key && draft[option.key] === "YES");
    const selecting = !active;
    setInc((prev) => {
      const without = prev.filter((code) => code !== option.code);
      return selecting ? [...without, option.code] : without;
    });
    if (option.key) {
      setDraft((prev) => ({ ...prev, [option.key as string]: selecting ? "YES" : "NO" }));
    }
  };
  const selectMaterialPrimary = (key: "material_rock" | "material_soil") => {
    if (!canEdit) return;
    const selecting = draft[key] !== "YES";
    if (!selecting) {
      setDraft((prev) => ({
        ...prev,
        material_rock: "NO",
        material_soil: "NO",
        material_bedding: "NO",
        material_joints: "NO",
        material_fractures: "NO",
        est_clay_pct: "",
        est_silt_pct: "",
        est_sand_pct: "",
        est_gravel_pct: "",
      }));
      return;
    }
    if (key === "material_rock") {
      setDraft((prev) => ({
        ...prev,
        material_rock: "YES",
        material_soil: "NO",
        est_clay_pct: "",
        est_silt_pct: "",
        est_sand_pct: "",
        est_gravel_pct: "",
      }));
      return;
    }
    setDraft((prev) => ({
      ...prev,
      material_soil: "YES",
      material_rock: "NO",
      material_bedding: "NO",
      material_joints: "NO",
      material_fractures: "NO",
    }));
  };
  const selectRockSubtype = (key: "material_bedding" | "material_joints" | "material_fractures") => {
    if (!canEdit) return;
    const selecting = draft[key] !== "YES";
    // Rock and soil exclude each other: a rock detail makes the material rock.
    setDraft((prev) => ({
      ...prev,
      material_rock: "YES",
      material_soil: "NO",
      est_clay_pct: "",
      est_silt_pct: "",
      est_sand_pct: "",
      est_gravel_pct: "",
      material_bedding: key === "material_bedding" && selecting ? "YES" : "NO",
      material_joints: key === "material_joints" && selecting ? "YES" : "NO",
      material_fractures: key === "material_fractures" && selecting ? "YES" : "NO",
    }));
  };
  /** A soil fraction makes the material soil (rock and soil exclude each other). */
  const setSoilFraction = (key: "est_clay_pct" | "est_silt_pct" | "est_sand_pct" | "est_gravel_pct", value: string) => {
    if (!canEdit) return;
    setDraft((prev) =>
      value.trim() === "" || prev.material_soil === "YES"
        ? { ...prev, [key]: value }
        : { ...prev, [key]: value, material_soil: "YES", material_rock: "NO", material_bedding: "NO", material_joints: "NO", material_fractures: "NO" }
    );
  };
  /** A crack measurement means there are cracks. */
  const setCrackMeasure = (key: "crack_length_ft" | "crack_horizontal_in" | "crack_vertical_in" | "crack_depth_in", value: string) => {
    if (!canEdit) return;
    setDraft((prev) => ({ ...prev, [key]: value, ...(value.trim() !== "" ? { pavement_ground_cracks: "YES" as const } : {}) }));
  };
  const setWaterContent = (key: typeof baseWaterKeys[number] | "") => {
    if (!canEdit) return;
    setDraft((prev) => {
      const next = { ...prev };
      for (const k of baseWaterKeys) next[k] = k === key ? "YES" : "NO";
      if (key !== "water_flowing") {
        next.water_seep = "NO";
        next.water_spring = "NO";
      }
      return next;
    });
  };
  const selectSingleDrainage = (key: typeof drainageKeys[number]) => {
    if (!canEdit) return;
    const selecting = draft[key] !== "YES";
    setDraft((prev) => {
      const next = { ...prev };
      for (const k of drainageKeys) next[k] = k === key && selecting ? "YES" : "NO";
      return next;
    });
  };
  const selectFlowingSubtype = (key: "water_seep" | "water_spring") => {
    if (!canEdit) return;
    const selecting = draft[key] !== "YES";
    // A seep or a spring is flowing water.
    setDraft((prev) => ({
      ...prev,
      water_dry: "NO",
      water_moist: "NO",
      water_wet: "NO",
      water_flowing: "YES",
      water_seep: key === "water_seep" && selecting ? "YES" : "NO",
      water_spring: key === "water_spring" && selecting ? "YES" : "NO",
    }));
  };
  const setImpact = (
    impactedKey: "impact_impacted_adj_utilities" | "impact_impacted_adj_properties" | "impact_impacted_adj_structure",
    maybeKey: "impact_maybe_adj_utilities" | "impact_maybe_adj_properties" | "impact_maybe_adj_structure",
    target: string
  ) => {
    if (!canEdit) return;
    setDraft((prev) => ({
      ...prev,
      [impactedKey]: target === "IMPACTED" ? "YES" : "UNKNOWN",
      [maybeKey]: target === "MAYBE" ? "YES" : "UNKNOWN",
    }));
  };
  useEffect(() => {
    if (!highwayLanesClosedSelected && draft.lanes_closed_count) {
      setDraft((prev) => ({ ...prev, lanes_closed_count: "" }));
    }
  }, [highwayLanesClosedSelected, draft.lanes_closed_count]);
  useEffect(() => {
    if (!openHighwayTrafficSelected && draft.open_highway_traffic_lanes_count) {
      setDraft((prev) => ({ ...prev, open_highway_traffic_lanes_count: "" }));
    }
  }, [openHighwayTrafficSelected, draft.open_highway_traffic_lanes_count]);
  useEffect(() => {
    if (draft.pavement_ground_cracks === "NO") {
      setDraft((prev) => ({
        ...prev,
        crack_length_ft: "",
        crack_horizontal_in: "",
        crack_vertical_in: "",
        crack_depth_in: "",
      }));
    }
  }, [draft.pavement_ground_cracks]);
  useEffect(() => {
    const items = Object.entries(INCIDENT_TYPE_CODE_BY_FORM_KEY)
      .filter(([k]) => draft[k] === "YES")
      .map(([, code]) => code);
    setInc((prev) => Array.from(new Set([
      ...items,
      ...prev.filter((code) => !INCIDENT_TYPE_FORM_CODES.has(code)),
    ])));
  }, [
    draft.failure_rock_fall,
    draft.failure_topple,
    draft.failure_slide,
    draft.failure_spread,
    draft.failure_flow,
    draft.failure_compound,
    draft.failure_erosion,
    draft.failure_surficial_failure,
    draft.failure_scoured_toe,
    draft.failure_washout,
  ]);

  // Attachments: library items (with section tags) + short-lived access URLs.
  const libraryItems = useMemo(() => buildLibraryItems(data?.attachments ?? []), [data?.attachments]);
  const seedUrls = useMemo(() => {
    const urls = new Map<number, string>();
    for (const photo of photoMap?.photos ?? []) {
      if (photo.download_url) urls.set(photo.attachment_id, photo.download_url);
    }
    return urls;
  }, [photoMap]);
  const resolver = useAttachmentUrlResolver(seedUrls);
  const sectionCount = (keys: readonly string[] | undefined) => (keys ? itemsForSectionKeys(libraryItems, keys).length : 0);
  const sectionDialogItems = sectionDialog ? itemsForSectionKeys(libraryItems, sectionDialog.keys) : [];
  const openSectionAttachments = (title: string, keys: readonly string[] | undefined) => {
    if (keys) setSectionDialog({ title, keys });
  };

  const cardProps = (cardId: DashboardCardId) => ({
    id: cardId,
    style: canvas.cardStyle(cardId),
    dragging: canvas.draggingId === cardId,
    formDisabled: !canEdit,
    attachmentCount: sectionCount(CARD_SECTION_KEYS[cardId]),
    onOpenAttachments: () => openSectionAttachments(DASHBOARD_CARD_TITLES[cardId], CARD_SECTION_KEYS[cardId]),
    onDragStart: canvas.startDrag,
    onResizeStart: canvas.startResize,
    onMeasure: canvas.reportContentHeight,
  });

  const descriptor = data
    ? buildSubmissionDisplayTitle({
        id: data.submission.id,
        created_at: data.submission.created_at,
        district: data.gisa?.district,
        county: data.gisa?.county,
        route: data.gisa?.route,
        post_mile: data.gisa?.post_mile,
      })
    : `Submission ${sid}`;

  const statePlaneHero = statePlaneCoordinates
    ? {
        zone: String(statePlaneCoordinates.zone),
        units: statePlaneCoordinates.units,
        northing: northingInput,
        easting: eastingInput,
        error: statePlaneInputError,
        onNorthingChange: (value: string) => {
          setNorthingInput(value);
          if (statePlaneInputError) setStatePlaneInputError(null);
        },
        onEastingChange: (value: string) => {
          setEastingInput(value);
          if (statePlaneInputError) setStatePlaneInputError(null);
        },
        onApply: applyStatePlaneInputs,
      }
    : null;

  const canvasToolbar = (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">GISA Sheet</div>
        <span className="rounded-full border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-0.5 text-[11px] font-medium text-muted">
          {canvas.custom ? "Custom layout" : "Auto-fit layout"}
        </span>
        <span className="hidden text-[11px] text-muted md:inline">Drag a card by its header · resize from the edges</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!viewer ? (
          <SavedLayoutsMenu layout={canvas.layout} applyLayout={canvas.applyLayout} buttonClassName={toolbarButton} />
        ) : null}
        {canvas.custom ? (
          <button type="button" onClick={canvas.tidy} className={toolbarButton} title="Return to the auto-fit flow, keeping this reading order">
            <LayoutGrid size={13} strokeWidth={2} aria-hidden />
            Tidy layout
          </button>
        ) : null}
        <button type="button" onClick={canvas.reset} className={toolbarButton} title="Restore default sizes and auto-fit flow">
          <RotateCcw size={13} strokeWidth={2} aria-hidden />
          Reset layout
        </button>
        <button
          type="button"
          onClick={() => canvas.setFullscreen(!canvas.fullscreen)}
          className={toolbarButton}
          aria-pressed={canvas.fullscreen}
          title={canvas.fullscreen ? "Exit full screen (Esc)" : "Show the GISA sheet full screen"}
        >
          {canvas.fullscreen ? <Minimize2 size={13} strokeWidth={2} aria-hidden /> : <Maximize2 size={13} strokeWidth={2} aria-hidden />}
          {canvas.fullscreen ? "Exit full screen" : "Full screen"}
        </button>
      </div>
    </div>
  );

  const canvasCards = data ? (
    // The canvas is as tall as its cards, so outside full screen it never scrolls
    // vertically: a scrollbar coming and going would change its width, reflow the
    // cards, change their heights and bring the scrollbar back, without end. In
    // full screen it scrolls, with the scrollbar's room always kept.
    <div ref={canvas.containerRef} className={`min-w-0 overflow-x-auto ${canvas.fullscreen ? "min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]" : "overflow-y-hidden"}`}>
      <div style={canvas.canvasStyle} className="eris-canvas-grid rounded-md">
        <CanvasCard {...cardProps("report_header")}>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 @2xl:grid-cols-4">
            <div className="min-w-0">
              <label className={label}>District</label>
              <select
                className={input}
                value={draft.district}
                onChange={(e) =>
                  setDraft((d) => {
                    const district = e.target.value;
                    const nextCountyOptions = countiesForDistrict(district);
                    const county = nextCountyOptions.includes(d.county) ? d.county : "";
                    const nextRouteOptions = routesForDistrictCounty(district, county);
                    const route = nextRouteOptions.includes(d.route) ? d.route : "";
                    return { ...d, district, county, route };
                  })
                }
              >
                <option value="">Select district</option>
                {CALTRANS_DISTRICTS.map((d) => <option key={d} value={d}>{`District ${d}`}</option>)}
              </select>
            </div>
            <div className="min-w-0">
              <label className={label}>County</label>
              <select
                className={input}
                value={draft.county}
                onChange={(e) =>
                  setDraft((d) => {
                    const county = e.target.value;
                    const routeChoices = routesForDistrictCounty(d.district, county);
                    const route = routeChoices.includes(d.route) ? d.route : "";
                    return { ...d, county, route };
                  })
                }
                disabled={!draft.district}
              >
                <option value="">Select county</option>
                {countyOptions.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="min-w-0">
              <label className={label}>Highway (route)</label>
              <select className={input} value={draft.route} onChange={(e)=>setDraft((d)=>({...d,route:e.target.value}))} disabled={!draft.district || !draft.county}>
                <option value="">Select route</option>
                {routeOptions.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div className="min-w-0">
              <label className={label}>Post mile</label>
              <input className={input} value={draft.post_mile} onChange={(e)=>setDraft((d)=>({...d,post_mile:e.target.value}))} onBlur={()=>setDraft((d)=>({...d,post_mile: normalizePostMileInput(d.post_mile)}))} />
            </div>
            <DateField label="Report date" value={draft.report_date} onChange={(value)=>setDraft((d)=>({...d,report_date:value}))} />
            <DateField label="Incident reported" value={draft.date_incident_reported} onChange={(value)=>setDraft((d)=>({...d,date_incident_reported:value}))} />
            <div className="min-w-0">
              <label className={label}>EA</label>
              <input className={input} value={draft.ea} onChange={(e)=>setDraft((d)=>({...d,ea:e.target.value}))} />
            </div>
            <div className="min-w-0">
              <label className={label}>Project ID</label>
              <input className={input} value={draft.project_id} onChange={(e)=>setDraft((d)=>({...d,project_id:e.target.value}))} />
            </div>
          </div>
          <FieldGroup
            title="District contacts"
            className="mt-3 border-t border-[var(--line)] pt-2.5"
            aside={
              canEdit ? (
                <button type="button" onClick={addDistrictContact} className="inline-flex items-center gap-1 text-xs font-medium text-[var(--brand)] hover:underline">
                  <Plus size={13} /> Add contact
                </button>
              ) : null
            }
          >
            {districtContacts.length === 0 ? (
              <p className="text-xs text-muted">No district contacts yet.</p>
            ) : (
              <div className="space-y-1.5">
                <div className="hidden gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted @2xl:grid @2xl:grid-cols-[1fr_1fr_0.8fr_1fr_1fr_1.75rem]" aria-hidden>
                  {DISTRICT_CONTACT_FIELDS.map(([, name]) => <span key={name}>{name}</span>)}
                  <span />
                </div>
                {districtContacts.map((contact, idx) => (
                  <div
                    key={contact.id}
                    className="grid grid-cols-2 gap-2 rounded-lg border border-[var(--line)] p-2 @2xl:grid-cols-[1fr_1fr_0.8fr_1fr_1fr_1.75rem] @2xl:items-center @2xl:border-0 @2xl:p-0"
                  >
                    {DISTRICT_CONTACT_FIELDS.map(([field, name]) => (
                      <input
                        key={field}
                        aria-label={`${name}, ${contactDisplayName(contact, idx)}`}
                        title={name}
                        placeholder={name}
                        className={`${input} py-1.5`}
                        value={contact[field]}
                        onChange={(e) => updateDistrictContact(contact.id, field, e.target.value)}
                      />
                    ))}
                    {canEdit ? (
                      <button
                        type="button"
                        onClick={() => removeDistrictContact(contact.id)}
                        aria-label={`Remove ${contactDisplayName(contact, idx)}`}
                        title="Remove contact"
                        className="justify-self-end rounded p-1 text-muted hover:text-[var(--bad)]"
                      >
                        <Trash2 size={14} />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
            {draft.district_contact.trim() && districtContacts.length === 0 ? (
              <details className="mt-2 rounded-md border border-[var(--line)] bg-[var(--panel-soft)] p-2">
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted">Raw contact data</summary>
                <textarea
                  className="mt-2 w-full rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-2 font-mono text-xs"
                  rows={5}
                  value={draft.district_contact}
                  onChange={(e) => setDraft((d) => ({ ...d, district_contact: e.target.value }))}
                />
              </details>
            ) : null}
          </FieldGroup>
        </CanvasCard>

        <CanvasCard {...cardProps("distribution")}>
          <div role="radiogroup" aria-label="Distribution" className="grid grid-cols-[repeat(auto-fill,minmax(5.25rem,1fr))] gap-1.5">
            {(lookups?.distribution ?? []).map((x) => {
              const active = draft.distribution_code === x.code;
              return (
                <button
                  key={x.code}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setDraft((d) => ({ ...d, distribution_code: active ? "" : x.code }))}
                  className={`flex min-w-0 flex-col items-center gap-1 rounded-lg border px-1 py-1.5 text-center text-[11px] font-medium leading-tight transition-colors ${
                    active
                      ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_12%,var(--panel))]"
                      : "border-[var(--line)] hover:border-[color:color-mix(in_oklab,var(--brand)_60%,var(--line))]"
                  }`}
                >
                  <span className="rounded-md bg-white p-0.5">
                    <img src={DISTRIBUTION_ICON_SRC[x.code] ?? ""} alt="" aria-hidden className="h-8 w-8 object-contain" />
                  </span>
                  <span>{x.label}</span>
                </button>
              );
            })}
          </div>
        </CanvasCard>

        <CanvasCard {...cardProps("highway_status")}>
          <div className="space-y-2.5">
            <div>
              <label className={label}>Cause</label>
              <input
                type="text"
                className={input}
                value={draft.highway_status_cause}
                onChange={(e) => setDraft((d) => ({ ...d, highway_status_cause: e.target.value }))}
                placeholder="What is affecting the highway"
              />
            </div>
            <FieldGroup title="Status">
              <div role="radiogroup" aria-label="Highway status" className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-1.5">
                {(lookups?.highway_status ?? []).map((x) => {
                  const active = draft.highway_status_code === x.code;
                  return (
                    <OptionTile key={x.code} kind="radio" active={active} onClick={() => canEdit && setDraft((d) => ({ ...d, highway_status_code: active ? "" : x.code }))}>
                      {x.label}
                    </OptionTile>
                  );
                })}
              </div>
            </FieldGroup>
            {highwayLanesClosedSelected || openHighwayTrafficSelected ? (
              <div className="space-y-2 rounded-lg bg-[var(--panel-soft)] p-2.5">
                {highwayLanesClosedSelected ? (
                  <InlineField label="Lanes closed">
                    <Segmented
                      label="Lanes closed"
                      options={LANES_CLOSED_OPTIONS.map((v) => ({ value: v, label: v }))}
                      value={draft.lanes_closed_count}
                      onChange={(value) => setDraft((d) => ({ ...d, lanes_closed_count: value }))}
                    />
                  </InlineField>
                ) : null}
                {openHighwayTrafficSelected ? (
                  <InlineField label="Lanes open to traffic">
                    <Stepper label="Lanes open to traffic" value={draft.open_highway_traffic_lanes_count} onChange={(value) => setDraft((d) => ({ ...d, open_highway_traffic_lanes_count: value }))} />
                  </InlineField>
                ) : null}
              </div>
            ) : null}
          </div>
        </CanvasCard>

        <CanvasCard {...cardProps("incident_type")}>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-1.5">
            {INCIDENT_TYPE_OPTIONS.map((option) => (
              <OptionTile key={option.code} active={inc.includes(option.code) || (!!option.key && draft[option.key] === "YES")} onClick={() => toggleIncidentType(option)}>
                {option.label}
              </OptionTile>
            ))}
          </div>
          <div className="mt-2.5">
            <label className={label}>Description</label>
            <textarea
              className={`${input} min-h-20`}
              value={draft.incident_type_description}
              onChange={(e) => setDraft((d) => ({ ...d, incident_type_description: e.target.value }))}
            />
          </div>
        </CanvasCard>

        <CanvasCard {...cardProps("material")}>
          <div role="radiogroup" aria-label="Material" className="grid items-start gap-2 @xl:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
            <PanelChoice title="Rock" active={materialRockSelected} onSelect={() => selectMaterialPrimary("material_rock")}>
              <div role="radiogroup" aria-label="Rock structure" className="grid grid-cols-3 gap-1.5 @xl:grid-cols-1">
                {([["material_bedding", "Bedding"], ["material_joints", "Joints"], ["material_fractures", "Fractures"]] as const).map(([key, text]) => (
                  <OptionTile key={key} kind="radio" active={draft[key] === "YES"} onClick={() => selectRockSubtype(key)}>
                    {text}
                  </OptionTile>
                ))}
              </div>
            </PanelChoice>
            <PanelChoice title="Soil" active={materialSoilSelected} onSelect={() => selectMaterialPrimary("material_soil")}>
              <div className="space-y-1.5">
                {SOIL_FRACTIONS.map(([key, text, color]) => (
                  <SliderField key={key} label={text} color={color} value={draft[key]} onChange={(value) => setSoilFraction(key, value)} />
                ))}
              </div>
              <CompositionBar parts={SOIL_FRACTIONS.map(([key, text, color]) => ({ label: text, value: draft[key], color }))} />
            </PanelChoice>
          </div>
        </CanvasCard>

        <CanvasCard {...cardProps("pavement_ground_status")}>
          <div className="space-y-3">
            <div className="grid gap-2 @lg:grid-cols-2">
              <InlineField label="Cracks in pavement or ground">
                <Segmented label="Cracks in pavement or ground" options={YES_NO} value={triValue(draft.pavement_ground_cracks)} onChange={(value) => setDraft((d) => ({ ...d, pavement_ground_cracks: triFrom(value) }))} />
              </InlineField>
              <InlineField label="Indented by rocks">
                <Segmented label="Indented by rocks" options={YES_NO} value={triValue(draft.indented_by_rocks)} onChange={(value) => setDraft((d) => ({ ...d, indented_by_rocks: triFrom(value) }))} />
              </InlineField>
            </div>
            <FieldGroup title="Crack" className={draft.pavement_ground_cracks === "NO" ? "opacity-60" : ""}>
              <div className="grid gap-x-4 gap-y-2 @lg:grid-cols-2">
                <NumberField label="Length" unit="ft" value={draft.crack_length_ft} onChange={(value) => setCrackMeasure("crack_length_ft", value)} />
                <SliderField label="Depth" unit="in" max={48} step={0.5} value={draft.crack_depth_in} onChange={(value) => setCrackMeasure("crack_depth_in", value)} />
                <SliderField label="Horizontal displacement" unit="in" max={24} step={0.25} value={draft.crack_horizontal_in} onChange={(value) => setCrackMeasure("crack_horizontal_in", value)} />
                <SliderField label="Vertical displacement" unit="in" max={24} step={0.25} value={draft.crack_vertical_in} onChange={(value) => setCrackMeasure("crack_vertical_in", value)} />
              </div>
            </FieldGroup>
            <FieldGroup title="Deformation">
              <div className="grid gap-x-4 gap-y-2 @lg:grid-cols-2">
                <SliderField label="Settlement" unit="in" max={48} step={0.5} value={draft.settlement_in} onChange={(value) => setDraft((d) => ({ ...d, settlement_in: value }))} />
                <SliderField label="Bulge" unit="in" max={48} step={0.5} value={draft.bulge_in} onChange={(value) => setDraft((d) => ({ ...d, bulge_in: value }))} />
              </div>
            </FieldGroup>
          </div>
        </CanvasCard>

        <CanvasCard {...cardProps("vegetation_on_slope")}>
          <div className="space-y-2">
            <SliderField label="Trees" icon={<TreeDeciduous size={15} />} color="#2e7d32" value={draft.vegetation_trees} onChange={(value) => setDraft((d) => ({ ...d, vegetation_trees: value }))} />
            <SliderField label="Bushes and shrubs" icon={<Shrub size={15} />} color="#6a9a2c" value={draft.vegetation_bushes_shrubs} onChange={(value) => setDraft((d) => ({ ...d, vegetation_bushes_shrubs: value }))} />
            <SliderField label="Groundcover" icon={<Sprout size={15} />} color="#9a8a2e" value={draft.vegetation_groundcover} onChange={(value) => setDraft((d) => ({ ...d, vegetation_groundcover: value }))} />
          </div>
          <p className="mt-2 text-[11px] text-muted">Share of the slope each covers. Layers overlap, so they need not add up to 100%.</p>
        </CanvasCard>

        <CanvasCard {...cardProps("water_drainage")}>
          <FieldGroup title="Drainage">
            <div role="radiogroup" aria-label="Drainage" className="grid grid-cols-2 gap-1.5 @xl:grid-cols-4">
              {([["drainage_clogged_inlet", "Clogged inlet"], ["drainage_compromised_drains", "Compromised drains"], ["drainage_surface_runoff", "Surface runoff"], ["drainage_torrent_surge_flood", "Torrent, surge or flood"]] as const).map(([key, text]) => (
                <OptionTile key={key} kind="radio" active={draft[key] === "YES"} onClick={() => selectSingleDrainage(key)}>
                  {text}
                </OptionTile>
              ))}
            </div>
          </FieldGroup>
          <FieldGroup title="Adjacent impacts" className="mt-3">
            <div className="divide-y divide-[var(--line)]">
              {([
                ["impact_impacted_adj_utilities", "impact_maybe_adj_utilities", "impact_adj_utilities", "Utilities"],
                ["impact_impacted_adj_properties", "impact_maybe_adj_properties", "impact_adj_properties", "Properties"],
                ["impact_impacted_adj_structure", "impact_maybe_adj_structure", "impact_adj_structure", "Structures"],
              ] as const).map(([impacted, maybe, notes, text]) => (
                <div key={text} className="grid gap-1.5 py-2 first:pt-0 last:pb-0 @lg:grid-cols-[5.5rem_auto_minmax(0,1fr)] @lg:items-center">
                  <span className="text-xs font-medium">{text}</span>
                  <Segmented
                    label={`${text} impact`}
                    options={IMPACT_OPTIONS}
                    value={draft[impacted] === "YES" ? "IMPACTED" : draft[maybe] === "YES" ? "MAYBE" : ""}
                    onChange={(value) => setImpact(impacted, maybe, value)}
                  />
                  <input
                    aria-label={`${text} notes`}
                    placeholder="Notes"
                    className={`${input} py-1.5`}
                    value={draft[notes]}
                    onChange={(e) => setDraft((d) => ({ ...d, [notes]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
          </FieldGroup>
        </CanvasCard>

        <CanvasCard {...cardProps("water_content")}>
          {(() => {
            const index = WATER_STEPS.findIndex(([key]) => draft[key] === "YES");
            return (
              <>
                <div className="mb-0.5 flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">How wet is the ground</span>
                  <span className="inline-flex items-center gap-1 text-sm font-semibold" style={index >= 0 ? { color: WATER_STEPS[index][2] } : undefined}>
                    {index >= 0 ? WATER_STEPS[index][1] : <span className="text-xs font-normal text-muted">Not recorded</span>}
                    {index >= 0 && canEdit ? (
                      <button type="button" onClick={() => setWaterContent("")} aria-label="Clear water content" title="Clear" className="rounded p-0.5 text-muted hover:text-[var(--ink)]">
                        <X size={13} />
                      </button>
                    ) : null}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={WATER_STEPS.length - 1}
                  step={1}
                  aria-label="Water content"
                  aria-valuetext={index >= 0 ? WATER_STEPS[index][1] : "Not recorded"}
                  value={Math.max(0, index)}
                  onChange={(e) => setWaterContent(WATER_STEPS[Number(e.target.value)][0])}
                  className={`eris-range eris-range--water ${index < 0 ? "is-empty" : ""}`}
                  style={index >= 0 ? ({ "--range-color": WATER_STEPS[index][2] } as CSSProperties) : undefined}
                />
                <div className="mt-0.5 flex justify-between text-[11px]">
                  {WATER_STEPS.map(([key, text], i) => (
                    <button key={key} type="button" onClick={() => setWaterContent(key)} className={i === index ? "font-semibold" : "text-muted hover:text-[var(--ink)]"}>
                      {text}
                    </button>
                  ))}
                </div>
                <FieldGroup title="Flowing from" className="mt-2.5">
                  <div role="radiogroup" aria-label="Flowing water source" className="grid grid-cols-2 gap-1.5">
                    <OptionTile kind="radio" active={draft.water_seep === "YES"} onClick={() => selectFlowingSubtype("water_seep")}>Seep</OptionTile>
                    <OptionTile kind="radio" active={draft.water_spring === "YES"} onClick={() => selectFlowingSubtype("water_spring")}>Spring</OptionTile>
                  </div>
                </FieldGroup>
              </>
            );
          })()}
        </CanvasCard>
      </div>
      {canvas.draggingId && canvas.dragPointer ? (
        <div
          className="pointer-events-none fixed z-50 rounded-md border border-[var(--line)] bg-[var(--panel)]/95 px-2 py-1 text-xs shadow-lg"
          style={{ left: canvas.dragPointer.x + 14, top: canvas.dragPointer.y + 14 }}
        >
          Moving: {DASHBOARD_CARD_TITLES[canvas.draggingId]}
        </div>
      ) : null}
    </div>
  ) : null;

  return (
    <AppShell title={invalid ? "Submission" : descriptor}>
      <div className="space-y-4 p-4">
        <SubmissionDetailHeader
          status={data?.submission?.status}
          descriptor={data ? descriptor : undefined}
          ownerLabel={data ? (me?.id === data.submission.created_by_user_id ? "you" : `user #${data.submission.created_by_user_id}`) : undefined}
          context={data?.context ?? null}
          invalid={invalid}
          busy={busy}
          canAct={canAct}
          canEdit={canEdit}
          canDelete={canDeleteSubmission}
          assessmentLinked={assessmentLinked}
          hideOperationalLinks={viewer}
          submitLabel={data?.submission.status === "REJECTED" ? "Resubmit for review" : "Submit for review"}
          onRefresh={load}
          onSaveDraft={saveDraft}
          onSubmitDraft={submitDraft}
          onApprove={() => review("APPROVE")}
          onReject={() => review("REJECT")}
          onDelete={onDeleteSubmission}
        />

        {data?.submission.status === "REJECTED" && data.submission.review_comment ? (
          <div className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]"><b>Returned for correction:</b> {data.submission.review_comment}</div>
        ) : null}
        {data && canEdit ? (
          <div className="rounded-md border border-[color:color-mix(in_oklab,var(--brand)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] px-3 py-2 text-sm">
            <b>You are completing this technical submission.</b>{" "}
            {data.context?.assessment_id != null ? (
              <>It belongs to <Link to={`/assessments/${data.context.assessment_id}`} className="font-medium text-[var(--brand)] hover:underline">assessment #{data.context.assessment_id}</Link> for <Link to={`/incidents/${data.context.incident_id}`} className="font-medium text-[var(--brand)] hover:underline">incident #{data.context.incident_id}</Link>. </>
            ) : data.context?.incident_id != null ? (
              <>It belongs to <Link to={`/incidents/${data.context.incident_id}`} className="font-medium text-[var(--brand)] hover:underline">incident #{data.context.incident_id}</Link>. </>
            ) : null}
            {assessmentLinked
              ? "Fill out the GISA form below — every field stays editable until the assessment is sent for review."
              : "Fill out the GISA form below — every field stays editable until you submit it for review."}
          </div>
        ) : null}

        {viewer && data ? (
          <div className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm text-muted">
            <b>Read-only record.</b> This technical form belongs to an approved assessment
            {data.context?.assessment_id != null ? <> — <Link to={`/assessments/${data.context.assessment_id}`} className="font-medium text-[var(--brand)] hover:underline">assessment #{data.context.assessment_id}</Link></> : null}
            . Nothing on this page can be changed.
          </div>
        ) : null}

        {/* A viewer's failure is a refusal, not a fault: the server answers 404
            for a record that is not part of the public record, and a red banner
            reading "Not found" over an empty page explains nothing. */}
        {err && viewer && !data ? (
          <AccessDeniedNotice
            title="This record is not available"
            detail="Only approved records are published. This one is either still in progress or does not exist."
          />
        ) : err ? (
          <div className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{err}</div>
        ) : null}
        {invalid && <div className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] p-4 text-sm text-muted">Invalid submission id.</div>}
        {!invalid && !data && !err && <div className="text-sm text-muted">{busy ? "Loading..." : "No data."}</div>}

        {!invalid && data && (
          <>
            <SubmissionLocationHero
              submissionId={data.submission.id}
              gisa={data.gisa}
              canEdit={canEdit}
              busy={busy}
              latitude={draft.latitude}
              longitude={draft.longitude}
              onLatitudeChange={(value) => setDraft((d) => ({ ...d, latitude: value }))}
              onLongitudeChange={(value) => setDraft((d) => ({ ...d, longitude: value }))}
              onCoordinateBlur={(field) => setDraft((d) => ({ ...d, [field]: formatCoordinate(d[field]) }))}
              geoBusy={geoBusy}
              onAutofillFromGps={autofillFromGps}
              statePlane={statePlaneHero}
              showStatePlane={showNorthingEasting}
              onToggleStatePlane={() => setShowNorthingEasting((prev) => !prev)}
              geojson={geom}
              onGeometryChange={onMapGeometryChange}
              geoSaveState={geoSaveState}
              geoSaveMessage={geoSaveMessage}
              photoMap={photoMap}
              photoLoading={photoLoading}
              photoError={photoError}
            />

            {canvas.fullscreen ? (
              <div className="fixed inset-0 z-40 flex flex-col bg-[var(--bg)] p-3" role="dialog" aria-modal="true" aria-label="GISA sheet full screen">
                {canvasToolbar}
                {canvasCards}
              </div>
            ) : (
              <section className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-3">
                {canvasToolbar}
                {canvasCards}
              </section>
            )}

            {data ? (
              <section id="measurements-section" className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4">
                <div className="flex items-start justify-between gap-3">
                  <SectionHeading
                    icon={<Ruler size={16} />}
                    title="Measurements"
                    subtitle="The slide's dimensions, taken in the field or measured from the terrain under the area drawn on the map."
                  />
                  <SectionAttachmentsButton
                    count={sectionCount(CARD_SECTION_KEYS.measurements)}
                    onClick={() => openSectionAttachments(DASHBOARD_CARD_TITLES.measurements, CARD_SECTION_KEYS.measurements)}
                  />
                </div>
                <div className="grid gap-5 lg:grid-cols-2">
                  <div className="min-w-0 lg:sticky lg:top-4 lg:self-start">
                    <SubmissionMeasurementContext submissionId={data.submission.id} gisa={data.gisa} onReload={load} geometryJson={geom} height={560} />
                  </div>
                  <SiteMeasurementsPanel
                    values={Object.fromEntries(MEASURE_KEYS.map((key) => [key, draft[key]])) as MeasureValues}
                    onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
                    geojson={geom}
                    canEdit={canEdit}
                    road={{ county: countyCodeFromNameOrCode(draft.county), route: draft.route, postMile: draft.post_mile, district: draft.district }}
                  />
                </div>
              </section>
            ) : null}

            <section className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4">
              <SectionHeading icon={<ListChecks size={16} />} title="Actions" subtitle="What was done to make the site safe, and the work that should follow." />
              <div className="grid gap-4 xl:grid-cols-2">
                <ActionChecklist
                  title="Immediate actions"
                  description="Taken, or needed now, to make the site safe."
                  icon={<Siren size={16} />}
                  accent="#d97706"
                  options={lookups?.actions?.immediate ?? []}
                  selected={imm}
                  onToggle={(code) => setImm((p) => tog(p, code))}
                  onClear={() => setImm([])}
                  editable={canEdit}
                />
                <ActionChecklist
                  title="Follow-up actions"
                  description="Investigation, design and repair to plan next."
                  icon={<ClipboardList size={16} />}
                  accent="var(--accent)"
                  options={lookups?.actions?.follow_up ?? []}
                  selected={fol}
                  onToggle={(code) => setFol((p) => tog(p, code))}
                  onClear={() => setFol([])}
                  editable={canEdit}
                />
              </div>
            </section>

            <section className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4">
              <SectionHeading icon={<NotebookPen size={16} />} title="Memos" subtitle="The written record of this assessment, and what is known about the site." />
              <MemosPanel
                submissionId={data.submission.id}
                memos={memos}
                onMemoChange={(key, html) => {
                  setMemos((current) => ({ ...current, [key]: html }));
                  setDraft((d) => ({ ...d, [key]: memoText(html) }));
                }}
                notes={{ record_of_event_notes: draft.record_of_event_notes, maintenance_history_notes: draft.maintenance_history_notes }}
                onNotesChange={(key, value) => setDraft((d) => ({ ...d, [key]: value }))}
                editable={canEdit}
                showSiteHistory={isOperationalUser(me?.roles)}
                attachmentCount={(key) => sectionCount(NOTES_SECTION_KEYS[key])}
                onOpenAttachments={(key, title) => openSectionAttachments(title, NOTES_SECTION_KEYS[key])}
                attachmentsButton={(count, onClick) => <SectionAttachmentsButton count={count} onClick={onClick} />}
              />
              <details className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2">
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted">Advanced: geometry JSON</summary>
                <textarea
                  id="notes-geometry-json"
                  aria-label="Geometry JSON"
                  className={`${input} mt-2 font-mono text-xs`}
                  rows={4}
                  disabled={!canEdit}
                  placeholder='{"type":"Point","coordinates":[...]}'
                  value={draft.geometry_json}
                  onChange={(e) => setDraft((d) => ({ ...d, geometry_json: e.target.value }))}
                />
              </details>
              {/* A linked form is sent for review on its assessment, which carries its own note. */}
              {canEdit && !assessmentLinked ? (
                <div className="mt-4 border-t border-[var(--line)] pt-3">
                  <label className={label} htmlFor="submit-comment">Submit comment (optional)</label>
                  <textarea id="submit-comment" className={input} rows={2} placeholder="Included with the submission when you submit for review from the header" value={submitNote} onChange={(e)=>setSubmitNote(e.target.value)} />
                </div>
              ) : null}
            </section>

            <SubmissionLibrary attachments={data.attachments} resolver={resolver} />

            <section className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4">
              <SectionHeading icon={<ShieldCheck size={16} />} title="Review and record" subtitle="Where this form stands, the reviewer's note, its history and who can see it." />
            <SubmissionDetailCardGrid>
              <SubmissionRecordCard
                descriptor={descriptor}
                submissionId={data.submission.id}
                status={data.submission.status}
                createdAt={data.submission.created_at ?? null}
                updatedAt={data.submission.updated_at ?? null}
                submittedAt={data.submission.submitted_at ?? null}
                reviewedAt={data.submission.reviewed_at ?? null}
              />

              {/* On a linked form the reviewer note is recorded with the assessment's decision. */}
              <SubmissionReviewerSupport
                reviewNote={reviewNote}
                canReview={canReview && !assessmentLinked}
                busy={busy}
                workflowEvents={data.workflow_events}
                onReviewNoteChange={setReviewNote}
              />

              {canManageSharing ? (
                <SubmissionAccessSharing
                  query={shareQuery}
                  data={shares}
                  busy={busy}
                  onQueryChange={setShareQuery}
                  onShare={addShare}
                  onWithdraw={removeShare}
                />
              ) : null}
            </SubmissionDetailCardGrid>
            </section>
          </>
        )}
      </div>

      {sectionDialog ? (
        <SubmissionSectionAttachmentsDialog
          sectionTitle={sectionDialog.title}
          items={sectionDialogItems}
          resolver={resolver}
          onClose={() => setSectionDialog(null)}
        />
      ) : null}
    </AppShell>
  );
}
