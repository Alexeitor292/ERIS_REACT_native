# Caltrans Project cross-section persistence

## Domain boundary

Caltrans **Projects** in this feature are engineering/business Project references. They are not Incident **Event Groups**.

- Incident -> optional `event_group_id` grouping attribute.
- Terrain Cross Section -> required `caltrans_project_id` save destination.
- No Project navigation/workspace is introduced by this feature.

Projects exist only where they are needed in the Terrain Cross Sections workflow.

## User workflow

1. Open **Terrain Cross Sections**.
2. Draw two or more control points and optionally build the DEM profile.
3. Select **Save** in the cross-section toolbar.
4. Choose a Project in the save dialog.
5. During the current development phase, the dialog may create an ERIS-managed Project reference if the Project does not exist yet.
6. Save the cross section.

The persisted record contains ordered control points and, when available, the historical DEM profile snapshot produced during that analysis.

## Current Project source

`caltrans_projects.source_system = ERIS_MANUAL`

ERIS temporarily allows Project reference creation from the cross-section save dialog. This is not intended to become a second authoritative Caltrans Project system.

## Future Project source

When Caltrans provides access to its Project database, a synchronization/read adapter will populate the same `caltrans_projects` reference table with:

`source_system = CALTRANS_PROJECT_DB`

and an immutable `external_project_id` from the authoritative source.

The Terrain Cross Sections UI will continue calling the same Project-list API. The user workflow and saved cross-section foreign keys therefore do not need to change when the source switches from temporary ERIS-managed entries to Caltrans-managed Projects.

## Persistence

### `caltrans_projects`

Local reference/cache for Projects available as cross-section save destinations. It carries a source-system identifier specifically so the authoritative source can change later.

### `terrain_cross_sections`

Stable cross-section identity, selected Project, name/notes, DEM source, requested/actual sampling spacing, creator, timestamps, and optional historical profile snapshot.

### `terrain_cross_section_points`

Ordered user-authored control points. Each point stores sequence number, latitude, longitude, distance along the control path, and the nearest sampled elevation when a DEM profile exists.

## Historical profile behavior

The profile snapshot is saved with the cross section instead of being silently recalculated on every open. That keeps the stored analysis reproducible even if an upstream elevation surface changes. A future explicit re-sample action can create a newer snapshot without changing the cross-section identity.
