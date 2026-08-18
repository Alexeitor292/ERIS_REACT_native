import TerrainCrossSectionWorkspace from "../features/terrainCrossSections/TerrainCrossSectionWorkspace";
import AppShell from "../ui/AppShell";

export default function TerrainCrossSectionsPage() {
  return (
    <AppShell title="Terrain Cross Sections">
      <TerrainCrossSectionWorkspace />
    </AppShell>
  );
}
