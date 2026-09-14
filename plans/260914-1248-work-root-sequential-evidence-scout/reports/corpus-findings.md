# Corpus Findings (mechanical pass)

Generated 2026-09-14T15:38:31.893Z from 246 analyzed units.

## Scale
- Units analyzed: 246 / 774 routed
- Claims extracted: 1884
- Lineage candidates: 2286 (same-bytes clusters: 2855)
- Conflicts: 5 (all UNRESOLVED — no majority vote)

## Domains observed
- unknown: 47 units (no platform markers; settings_schema.json + .liquid but no platform marker in path)
- generic-js: 92 units (package.json present)
- shopify: 3 units (settings_schema.json + .liquid under shopify path)
- liquid-theme: 157 units (liquid schema/form claims; theme-project markers)
- sapo: 7 units (.bwt templates present)
- skill-package: 53 units (SKILL.md present; kind=skill; SKILL.md claim)
- haravan: 80 units (settings.html present (legacy Haravan settings); settings_schema.json + .liquid under haravan/f1genz/customizes path)

## Lineage highlights
- Theme families: customizes/* (37 theme projects), themes/f1genz/Haravan/* (11), themes/devs2/* (9)
- Skill mirrors: 528 AK-excluded, 19 eligible
- Backup copies: 84 name-variant clusters

## Limitations
- Mechanical extraction only; semantic depth per unit is bounded.
- Binary/media files are metadata-only; no content interpretation.
- Conflicts are recorded, not resolved; no claim promoted to active rule.
- Hash equality proves same bytes, not authorship or success.
