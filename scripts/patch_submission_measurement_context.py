from pathlib import Path

path = Path("web/src/pages/SubmissionDetailPage.tsx")
text = path.read_text(encoding="utf-8")

replacements = [
    (
        'import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";\n',
        'import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";\n',
        "React import",
    ),
    (
        'import { useParams, useSearchParams } from "react-router-dom";\n',
        'import { useParams } from "react-router-dom";\n',
        "router import",
    ),
    (
        'import type { GisaElevationProfile, GisaLookups, GisaTerrainGrid, SubmissionDetail, SubmissionPermissionGrant, SubmissionPermissions, SubmissionPermissionUser } from "../api/types";\n',
        'import type { GisaLookups, SubmissionDetail, SubmissionPermissionGrant, SubmissionPermissions, SubmissionPermissionUser } from "../api/types";\n',
        "API type import",
    ),
    (
        'import { TerrainRelief } from "../components/TerrainRelief";\n// Lazy-loaded so ArcGIS SceneView\'s heavy 3D modules are fetched only when the\n// user actually opens the 3D Terrain tab — the normal page never eagerly loads it.\nconst InteractiveTerrainScene = lazy(() => import("../components/InteractiveTerrainScene"));\nimport { friendlyFieldLabel, friendlyFieldValue, fieldDescription, terrainLabel } from "../utils/roadInventoryGlossary";\n',
        '',
        "legacy measurement-context imports",
    ),
    (
        'import SubmissionAccessSharing from "../features/submissions/SubmissionAccessSharing";\n',
        'import SubmissionAccessSharing from "../features/submissions/SubmissionAccessSharing";\nimport SubmissionMeasurementContext from "../features/submissions/SubmissionMeasurementContext";\n',
        "measurement-context feature import",
    ),
    (
        '  const [elevFetching, setElevFetching] = useState(false);\n  const [elevError, setElevError] = useState<string | null>(null);\n  const [bearingInput, setBearingInput] = useState<string>("");\n  const [terrainView, setTerrainView] = useState<"profile" | "terrain">("profile");\n  const [terrainFetching, setTerrainFetching] = useState(false);\n  const [terrainError, setTerrainError] = useState<string | null>(null);\n  const [riDetailsOpen, setRiDetailsOpen] = useState(false);\n  const [searchParams] = useSearchParams();\n  const deepLinkTerrain = searchParams.get("section") === "terrain";\n\n',
        '',
        "measurement-context state",
    ),
]

for old, new, label in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected exactly one {label}; found {count}")
    text = text.replace(old, new, 1)

deep_link_block = '''  // Deep link (e.g. the mobile "Open full 3D map" handoff: /submissions/:id?section=terrain):
  // open the 3D Terrain view and scroll it into view once the page is mounted.
  useEffect(() => {
    if (!deepLinkTerrain) return;
    setTerrainView("terrain");
    const t = window.setTimeout(() => {
      document.getElementById("terrain-3d-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 400);
    return () => window.clearTimeout(t);
  }, [deepLinkTerrain]);

'''
if text.count(deep_link_block) != 1:
    raise SystemExit(f"Expected exactly one terrain deep-link effect; found {text.count(deep_link_block)}")
text = text.replace(deep_link_block, '', 1)

fetch_start = '  async function fetchElevation(force: boolean) {\n'
fetch_end = '  async function openDownloadUrl(id: number) {\n'
if text.count(fetch_start) != 1 or text.count(fetch_end) != 1:
    raise SystemExit("Could not uniquely locate measurement fetch-function boundaries")
start = text.index(fetch_start)
end = text.index(fetch_end, start)
legacy_fetch = text[start:end]
for required in [
    '/gisa/elevation-profile',
    '/gisa/terrain-grid',
    'setElevFetching',
    'setTerrainFetching',
]:
    if required not in legacy_fetch:
        raise SystemExit(f"Legacy measurement fetch block missing expected marker: {required}")
text = text[:start] + text[end:]

bearing_effect = '''  // Prefill bearing from road inventory snapshot when available
  useEffect(() => {
    const snapBearing = data?.gisa?.road_inventory_context?.snapshot?.road_bearing_deg;
    if (snapBearing != null && bearingInput === "") {
      setBearingInput(String(snapBearing));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.gisa?.road_inventory_context?.snapshot?.road_bearing_deg]);

'''
if text.count(bearing_effect) != 1:
    raise SystemExit(f"Expected exactly one bearing-prefill effect; found {text.count(bearing_effect)}")
text = text.replace(bearing_effect, '', 1)

ui_start = '                        {data.gisa?.road_inventory_context ? (() => {\n'
ui_end = '                        <div className="rounded border border-[var(--line)] bg-[var(--panel-soft)] p-2">\n                          <img src="/measurement/landslide.png"'
if text.count(ui_start) != 1:
    raise SystemExit(f"Expected exactly one measurement-context UI start; found {text.count(ui_start)}")
if text.count(ui_end) != 1:
    raise SystemExit(f"Expected exactly one landslide reference boundary; found {text.count(ui_end)}")
start = text.index(ui_start)
end = text.index(ui_end, start)
legacy_ui = text[start:end]
for required in [
    'Road inventory context',
    'Elevation Profile',
    '3D Terrain',
    'InteractiveTerrainScene',
    'TerrainRelief',
    'Fetch Elevation Profile',
]:
    if required not in legacy_ui:
        raise SystemExit(f"Legacy measurement-context UI missing expected marker: {required}")
replacement_ui = '''                        <SubmissionMeasurementContext
                          submissionId={data.submission.id}
                          gisa={data.gisa}
                          onReload={load}
                        />
'''
text = text[:start] + replacement_ui + text[end:]

checks = {
    "feature import": 'SubmissionMeasurementContext from "../features/submissions/SubmissionMeasurementContext"',
    "feature render": '<SubmissionMeasurementContext',
}
for label, marker in checks.items():
    if text.count(marker) != 1:
        raise SystemExit(f"Expected exactly one {label}; found {text.count(marker)}")

for forbidden in [
    'useSearchParams',
    'InteractiveTerrainScene',
    'TerrainRelief',
    'friendlyFieldLabel',
    'friendlyFieldValue',
    'fieldDescription',
    'terrainLabel',
    'fetchElevation(',
    'fetchTerrain(',
    'setBearingInput',
    'setRiDetailsOpen',
    'setTerrainView',
    'setElevFetching',
    'setTerrainFetching',
]:
    if forbidden in text:
        raise SystemExit(f"Legacy measurement-context marker is still present: {forbidden}")

path.write_text(text, encoding="utf-8")
