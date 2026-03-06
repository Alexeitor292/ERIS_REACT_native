# Diagram Pack

This folder contains detailed Mermaid diagrams for architecture, use cases, workflows, ERD, and sync behavior.

## Files

- `01-system-context.mmd`
- `02-use-cases.mmd`
- `03-incident-workflow.mmd`
- `04-submission-workflow.mmd`
- `05-mobile-offline-sync-sequence.mmd`
- `06-database-erd.mmd`
- `07-data-flow-api-db-storage.mmd`
- `08-role-visibility-flow.mmd`

## Render options

1. GitHub/GitLab markdown viewers that support Mermaid.
2. Mermaid Live Editor: paste file contents.
3. Local `mmdc` export to SVG/PNG.

Example local export command:

```bash
mmdc -i docs/diagrams/06-database-erd.mmd -o docs/diagrams/06-database-erd.svg
```
