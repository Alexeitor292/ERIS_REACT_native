# ERIS UX research and design round

Evidence base for [UX_REDESIGN_PLAN.md](../UX_REDESIGN_PLAN.md). Everything here was produced against `main @ 727024e`
by a multi-agent research run on 2026-09-05 and 2026-09-09; nothing in this folder is hand-edited product documentation.
Treat it as the working record behind the plan, not as a spec in its own right.

## How the plan was produced

1. **Live measurements** (`measurements-live.json`): the deployed web client was opened in a Chromium browser pane at
   375x812, 768x1024 and 1440x900 against a seeded local backend, and page geometry was read from the real DOM
   (content start offset, page height in screens, overflowing elements, controls under 40 px, text under 12 px).
2. **Discovery** (`discovery/`, 31 agents): one inventory per screen area (every visible element classified essential /
   secondary / noise), a persona and journey model built from the docs and the backend routes, five outside-research
   tracks with cited sources, one heuristic + responsive + data-density audit per area, and one first-day cognitive
   walkthrough per role (15 tasks). The three `brief-*.md` files are the condensed form the design agents read.
3. **Design round** (`design-round/`, 14 agents): four independent redesign directions (`proposal-task-first`,
   `proposal-map-first`, `proposal-case-file`, `proposal-progressive`) and three direction-neutral specialist specs
   (`spec-responsive`, `spec-data`, `spec-language`); four judges scored every proposal on the same weighted criteria
   (`judge-*.json`); one synthesis wrote the plan (`synthesis.json`); an adversarial critique checked it against the
   evidence and the code (`critique.json`, 24 required fixes); a revision applied the fixes (`revision.json`).
   `plan.json` is the structured form of the final plan used to render the published page.
4. Discovery, the proposals and the specialist specs ran on Claude Fable 5.1; the judges, synthesis, critique and
   revision ran on Claude Opus 5 at maximum reasoning effort.

## File map

| Path | What it is |
|---|---|
| `brief-core.md` | Measurements, personas, journey, vocabulary, first-day walkthroughs, audit summaries |
| `brief-screens.md` | Every current screen with its data classified essential / secondary / noise |
| `brief-research.md` | Outside research: work queues, responsive density, map and field UX, learnability, long forms |
| `measurements-live.json` | The raw DOM measurements the plan's baselines come from |
| `discovery/domain.json` | Personas, the journey of one incident, and the vocabulary confusion table |
| `discovery/inventory-*.json` | Screen inventories per area |
| `discovery/audit-*.json` | Heuristic, responsive and data-density audits per area |
| `discovery/walkthrough-*.json` | First-day cognitive walkthroughs per role |
| `discovery/research-*.json` | Outside research per topic, with sources |
| `design-round/proposal-*.json` | The four competing redesign directions |
| `design-round/spec-*.json` | Responsive-system, data-minimalism and language specialist specs |
| `design-round/judge-*.json` | Four judge reviews with per-criterion scores |
| `design-round/synthesis.json`, `critique.json`, `revision.json` | The synthesis summary, the critique, and the list of fixes applied |
| `design-round/plan.json` | Structured final plan |
