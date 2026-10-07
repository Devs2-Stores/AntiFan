# Bak Files Inventory (audit 2026-10-08)

User-owned `.bak` files found in the repo/data trees. **No file was deleted or
moved.** Relocation to a dedicated `.antifan-archive/` directory is proposed but
requires explicit user approval.

| File | Size | Modified | Nature |
|---|---|---|---|
| `.super-core/core.db.bak` | 105.7 MB | 2026-09-15 | Super Core SQLite snapshot |
| `.super-core/core.db.pre-healthfix.bak` | 175.2 MB | 2026-09-27 | Pre-healthfix DB snapshot |
| `.antifan/phukienmaymoc-backup/header.liquid.20260914-144118.bak` | 83 KB | 2026-09-14 | Theme file backup |
| `.antifan/phukienmaymoc-backup/page-document.css.20260914-143953.bak` | 5 KB | 2026-09-13 | Theme file backup |
| `.antifan/phukienmaymoc-backup/page.documents.liquid.20260914-143953.bak` | 154 KB | 2026-09-14 | Theme file backup |
| `E:\Work\.antifan-data\issues\issue-register.jsonl.pre-reconcile.bak` | 109 KB | 2026-10-07 | Pre-reconciliation register snapshot (created by this fix run) |

## Recommendation

The two `core.db` backups (~280 MB combined) are pre-fix snapshots superseded by
the current database. Safe to archive under `.antifan-archive/` or delete, but
only after explicit user approval — they are the last local record of those
states.
