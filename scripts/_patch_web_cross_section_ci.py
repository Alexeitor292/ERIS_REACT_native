from pathlib import Path

workspace = Path("web/src/features/terrainCrossSections/TerrainCrossSectionWorkspace.tsx")
text = workspace.read_text(encoding="utf-8")
old = '      view.goTo(profileLine.extent.expand(1.25), { animate: true }).catch(() => {});\n'
new = '''      const profileExtent = profileLine.extent;\n      if (profileExtent) {\n        view.goTo(profileExtent.expand(1.25), { animate: true }).catch(() => {});\n      }\n'''
if text.count(old) != 1:
    raise SystemExit(f"Expected exactly one profile extent marker, found {text.count(old)}")
workspace.write_text(text.replace(old, new), encoding="utf-8")

workflow = Path(".github/workflows/ci.yml")
text = workflow.read_text(encoding="utf-8")
old = '      - name: Unit tests (node --test)\n        run: node --experimental-strip-types --test src/components/terrainScene.test.ts src/components/caltransHighwaysLayer.test.ts\n'
new = '      - name: Unit tests (node --test)\n        run: npm test\n'
if text.count(old) != 1:
    raise SystemExit(f"Expected exactly one Web unit-test marker, found {text.count(old)}")
workflow.write_text(text.replace(old, new), encoding="utf-8")
