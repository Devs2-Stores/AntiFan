# Haravan Customize Theme Fidelity — Phase 5

Date: 2026-09-11. Plan: `plans/260911-0133-haravan-customize-theme-fidelity/`.
Run directory: `.canary/theme-fidelity-run4/` (runs 1–3 kept as the refusal trail).
Store `https://phukienmaymoc.com/`, org `200001207485`, theme copy `1001512581`
("Bản sao chép của clothing", **unpublished**), local source `E:/Work/customizes/Phukienmaymoc`.

## References were pinned read-only before anything wrote

`preflight` proved the workspace declares the authorised copy (`themeId 1001512581`,
`orgId 200001207485`) and derived a 7-surface × 3-tier manifest from
`.canary/theme-fidelity/inventory-surfaces.json`. That inventory is the plan's 7 page surfaces; the 32
fragment views are `{% layout none %}` partials and are declared out of scope for capture, carried in the
inventory's `unresolved` list as not-measured.

`references` then captured R1 (the copy, `?themeid=1001512581`) and R2 (live production, `?themeid=-1`),
21 documents each, `status COMPLETE`, `notMeasurable 0`, in 743 s. Neither is a write.

## Two harness defects surfaced on the live path, both fixed in the tool

1. **Session tab quota.** `home__390x844` was the third target refused
   `POLICY_DENIED (session tab quota reached)` on a freshly restarted instance with nothing still
   running. `adoptChildTab` keeps a `Set` per session that is never pruned and refuses at 10, so a
   capture run exhausts a session's budget long before it leaves a tab open — the `POLICY_DENIED` is a
   binding count, not a leak. `renewSession` now rotates the session per target (and per compared pair),
   closing the old mint tab first while its own session still owns it. That also removes the orphan-tab
   trade: at most one mint tab is alive at a time and the last one is closed at the end.
2. **Viewport confirmation.** `browser.set-viewport` with `reload: true` returns false when the host's own
   reload wait window elapses, which on a heavy mobile page says nothing about the resize; the reload is
   still running and re-issuing would race it. `setViewportAndConfirm` polls the tab the host already
   asked for (`readyState` plus `innerWidth`) and decides on the measurement rather than the call's own
   report. R1/R2 went from 7 failures to 21/21 on this change alone.

`hrv theme dev` was run supervised (`serve.json`, pid recorded, `hrv-theme-dev.log` 1058 bytes) and its
own first readiness signal is **not** proof of a write: it prints "Watching … — pushing when content
changes", skips a pending difference when no terminal is attached, and the copy preview answers 200 with
`hstatic` assets whether or not a dev session ever synced. Readiness was therefore recorded as what it
is (a log signal plus an HTTP probe), and the write was made explicit.

## The write

`hrv backup --name phase5-pre-dev` → `backups/phase5-pre-dev.zip` (13.42 MB, 518 files), then
`hrv theme push --nodelete --log`: 136 pushed, 46 refused as `conflict` (remote-changed) including
`layout/theme.liquid`, `snippets/header.liquid`, `snippets/footer.liquid`. A partial state would have been
neither the local source nor R1, so `hrv theme push --force --nodelete --log` completed it:
**182 pushed, 0 errors, 0 skipped**. Exactly one writer touched the copy — the watched dev child pushed
nothing (no local edit happened), and it was stopped afterwards (pid 5768, the `hrv.cmd` shim's node
child; the driver's `taskkill` had missed it because it addressed the shim).

No `assets/` file appears in either push: the CLI's tracked set is 182 config/snippets/templates files.
`hrv theme push --only assets/ll-style-all.scss.liquid assets/style-product.scss.liquid` answered
"No files matched --only pattern(s)" although both files exist locally (32,240 B and 57,665 B), and the
CLI had itself reported both as remote-divergent. The two references were pinned before any of this, so
the measurement is unaffected by the write.

## The subject does not reproduce the storefront

Subject capture: 14 of 21 documents captured; 7 refused `FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY` —
desktop legs whose documents are 16,229 to 27,360 CSS px tall, outside the 1..16384 raster range. The
refusal is the correct outcome: full-page evidence never falls back to a viewport-only capture.

Document height, pinned copy (R1) vs the pushed copy, same viewport, same surface:

| surface | 1440 (R1 → subject) | 1024 | 390 |
|---|---|---|---|
| home | 7532 → refused (27360) | 7547 → refused (25100) | 9059 → 10746 (1.19×) |
| product | 4749 → refused (17229) | 5371 → 15207 (2.83×) | 4235 → 3514 (0.83×) |
| collection | 4117 → 15961 (3.88×) | 3798 → 13701 (3.61×) | 2604 → 1943 (0.75×) |
| article | 4954 → refused (18853) | 5942 → refused (16759) | 6226 → 6373 (1.02×) |
| cart | 2301 → refused (16477) | 3226 → 14329 (4.44×) | 2046 → 2141 (1.05×) |
| search | 7721 → refused (16465) | 4480 → 14205 (3.17×) | 4906 → 4976 (1.01×) |
| 404 | 1570 → 15811 (10.07×) | 2304 → 13551 (5.88×) | 1629 → 1797 (1.10×) |

Desktop tiers diverge 3–10×, the phone tier stays within 0.75–1.19×. The shape of that — a desktop-only
blow-up while the phone layout survives — is what markup and config arriving without their stylesheet
sources would produce, which is consistent with the 182-file push set containing no `assets/` file. The
subject is therefore the local markup and config against the copy's server-compiled stylesheets, and
that is the confound this run cannot remove. [INFERENCE on the mechanism; the heights are measured.]

The comparison stage refused the verdict set: `PROVENANCE_UNRESOLVED` on the first unmeasurable subject
leg, because a verdict set is complete or it is refused — a missing artifact is never a PASS. With 7 of
21 legs structurally uncapturable, no set can be complete, so no pair verdict exists to publish. The
report assembled anyway and named all 49 gaps; it did not publish `current.json`.

Structural checks (``checks``, exit 0 with findings): `config/settings_schema.json` parses; the theme
declares 0 sections; 95 settings reads are undeclared by that schema (`add_to_cart_show`,
`cart_deliverytime_start/end`, `code_messenger_mb`, …); 78 local assets present, 6 referenced but missing
from the source. Reproduced on the real theme directory twice, and the false-positive probe holds: sampled
ids occur zero times in the theme's 1463-id `settings_schema.json`.

Safety audit (`report.json.safetyAudit`): 6 driver commands, `themeIds` exactly `["-1","1001512581"]`,
`foreignThemeIds.count 0`, `publishDeployPush.absent true` — scoped to the driver's `commands.jsonl`. The
write itself was the explicit `hrv theme backup` + `hrv theme push` pair recorded in
`.canary/theme-fidelity-run4/push.log` and `push-force.log`; no `hrv theme publish` or `deploy` was issued,
the copy is unpublished, and production was read-only throughout.

## Restore procedure, if the copy should go back

`backups/phase5-pre-dev.zip` (theme + `settings_data.json`) is the pre-write state. Restoring is a
separate, destructive action against `1001512581` and was not taken in this run.

## Follow-ups this run did not close

- Push excluded `assets/ll-style-all.scss.liquid` and `assets/style-product.scss.liquid`
  (`No files matched --only pattern(s)`): push cannot reconcile them, so the copy's compiled stylesheets
  cannot be proven to be the local revision.
- Desktop page heights over 16384 px cannot be captured at all; those surfaces are unmeasurable until the
  rendering above is explained.
- `hrv theme dev`'s readiness signal ("Preview: …?themeid=…") fires before any sync and is not proof of a
  write. A future runner must treat it as a hint and make the write explicit, as this run did.
