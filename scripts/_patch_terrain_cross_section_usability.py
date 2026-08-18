from pathlib import Path

# App shell: allow long pages to expand instead of clipping against the footer.
shell_path = Path("web/src/ui/AppShell.tsx")
shell = shell_path.read_text(encoding="utf-8")
old = '<div className="product-card h-full overflow-hidden">{children}</div>'
new = '<div className="product-card min-h-full overflow-hidden">{children}</div>'
if shell.count(old) != 1:
    raise SystemExit(f"Expected one AppShell height marker, found {shell.count(old)}")
shell_path.write_text(shell.replace(old, new), encoding="utf-8")

workspace_path = Path("web/src/features/terrainCrossSections/TerrainCrossSectionWorkspace.tsx")
text = workspace_path.read_text(encoding="utf-8")

replacements = [
    (
        'import CrossSectionProfileChart from "./CrossSectionProfileChart";\n',
        'import CrossSectionProfileChart from "./CrossSectionProfileChart";\nimport SceneDualScaleBar from "./SceneDualScaleBar";\n',
    ),
    (
        '  const [basemapMode, setBasemapMode] = useState<BasemapMode>("satellite");\n',
        '  const [basemapMode, setBasemapMode] = useState<BasemapMode>("satellite");\n  const [sceneScale, setSceneScale] = useState<number | null>(null);\n',
    ),
    (
        '    let compass: Compass | null = null;\n',
        '    let compass: Compass | null = null;\n    let scaleHandle: { remove: () => void } | null = null;\n',
    ),
    (
        '      view.ui.add(compass, "top-left");\n\n      clickHandle = view.on("click", (event) => {\n',
        '''      view.ui.add(compass, "top-left");\n      const updateScale = (value: number) => setSceneScale(Number.isFinite(value) && value > 0 ? value : null);\n      updateScale(Number(view.scale));\n      scaleHandle = view.watch("scale", (value) => updateScale(Number(value)));\n\n      clickHandle = view.on("click", (event) => {\n''',
    ),
    (
        '      clickHandle?.remove();\n',
        '      clickHandle?.remove();\n      scaleHandle?.remove();\n      setSceneScale(null);\n',
    ),
    (
        '<div className="flex h-full min-h-[760px] flex-col gap-4 p-4 md:p-5">',
        '<div className="flex min-h-[760px] flex-col gap-4 p-4 md:p-5">',
    ),
    (
        '<div className="grid min-h-[560px] flex-1 gap-4 xl:grid-cols-[minmax(0,1.75fr)_380px]">',
        '<div className="grid flex-1 items-start gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(520px,0.85fr)]">',
    ),
    (
        '<div className="relative min-h-[560px] overflow-hidden rounded-xl border border-[var(--line)] bg-[#0f172a]">',
        '<div className="relative min-h-[560px] overflow-hidden rounded-xl border border-[var(--line)] bg-[#0f172a] xl:sticky xl:top-[82px] xl:h-[calc(100vh-110px)] xl:max-h-[780px]">',
    ),
    (
        '''          <div className="absolute bottom-3 left-3 z-10 flex overflow-hidden rounded-lg border border-white/20 bg-black/55 text-[11px] text-white backdrop-blur-sm">\n            {(["satellite", "topo-vector"] as BasemapMode[]).map((mode) => (\n              <button key={mode} type="button" onClick={() => setBasemapMode(mode)} className={`px-3 py-2 ${basemapMode === mode ? "bg-white/20 font-semibold" : "hover:bg-white/10"}`}>{mode === "satellite" ? "Imagery" : "Topographic"}</button>\n            ))}\n          </div>\n''',
        '''          <div className="absolute bottom-3 left-3 z-10 flex overflow-hidden rounded-lg border border-white/20 bg-black/55 text-[11px] text-white backdrop-blur-sm">\n            {(["satellite", "topo-vector"] as BasemapMode[]).map((mode) => (\n              <button key={mode} type="button" onClick={() => setBasemapMode(mode)} className={`px-3 py-2 ${basemapMode === mode ? "bg-white/20 font-semibold" : "hover:bg-white/10"}`}>{mode === "satellite" ? "Imagery" : "Topographic"}</button>\n            ))}\n          </div>\n\n          <SceneDualScaleBar scale={sceneScale} />\n''',
    ),
    (
        '<div className="min-h-0 flex-1 overflow-auto rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">',
        '<div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">',
    ),
]

for old_text, new_text in replacements:
    if text.count(old_text) != 1:
        raise SystemExit(f"Expected exactly one workspace marker, found {text.count(old_text)}: {old_text[:90]!r}")
    text = text.replace(old_text, new_text)

# Move the engineering metrics + interactive profile into the right analysis
# column ahead of the selected-point list. The left SceneView can then stay
# sticky for the entire profile-hover workflow.
tail_start_marker = '      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">'
selected_marker = '          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">\n            <div className="flex items-center justify-between gap-3">\n              <div className="text-sm font-semibold">Selected control points</div>'
outer_end_marker = '    </div>\n  );\n}\n\nfunction MetricCard'

if text.count(tail_start_marker) != 1:
    raise SystemExit(f"Expected one metrics tail marker, found {text.count(tail_start_marker)}")
if text.count(selected_marker) != 1:
    raise SystemExit(f"Expected one selected-points marker, found {text.count(selected_marker)}")
if text.count(outer_end_marker) != 1:
    raise SystemExit(f"Expected one workspace end marker, found {text.count(outer_end_marker)}")

tail_start = text.index(tail_start_marker)
outer_end = text.index(outer_end_marker)
tail = text[tail_start:outer_end]
text = text[:tail_start] + text[outer_end:]

tail = tail.replace(
    'className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6"',
    'className="grid grid-cols-2 gap-3 2xl:grid-cols-3"',
)
tail = tail.replace(
    'className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"',
    'className="grid grid-cols-2 gap-3"',
)
# Indent from outer-workspace level to aside-child level.
tail = "\n".join(("    " + line if line else line) for line in tail.splitlines()) + "\n\n"
insert_at = text.index(selected_marker)
text = text[:insert_at] + tail + text[insert_at:]
workspace_path.write_text(text, encoding="utf-8")

chart_path = Path("web/src/features/terrainCrossSections/CrossSectionProfileChart.tsx")
chart = chart_path.read_text(encoding="utf-8")
old = 'className="min-w-[720px] w-full select-none"'
new = 'className="min-w-[520px] w-full select-none"'
if chart.count(old) != 1:
    raise SystemExit(f"Expected one chart width marker, found {chart.count(old)}")
chart_path.write_text(chart.replace(old, new), encoding="utf-8")
