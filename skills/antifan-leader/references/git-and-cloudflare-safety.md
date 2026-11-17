# Git, worktree and Cloudflare safety

Loaded before a repo is deleted or moved, before a worker deploys, and when a deploy is rolled back. Every destructive step below needs the owner approval first.

## Git worktree deletion safety
- NEVER delete a repo containing `.git/worktrees/` admin dirs before detaching/copying production worktree sources to permanent locations. Worktree `.git` files point INTO the parent repo's `.git/worktrees/<name>`.
- Order: (1) verify production source on disk + wrangler works, (2) copy the working tree to a permanent dir, (3) `git init` + commit as a standalone repo, (4) `wrangler deployments status` to verify, (5) `git bundle create --all` to 2 locations + `git bundle verify`, (6) junction scan `dir /AL /S` before `rm -rf`, (7) only then delete.
- `git bundle` only preserves committed refs; `git bundle verify` can pass on a truncated bundle, also `git clone` test if critical. Bundles are stored in 2 places (scratch + project-local `.archive-*`).
- Junction guard: `rm -rf` on a junction deletes the shared `node_modules` (04/11 lesson); remove junctions with `cmd /c rmdir` (no `/s`) or use `robocopy /MIR`.
- Restoring a deleted repo: `git clone <bundle> <dir>`; worktree metadata is NOT in the bundle.

## Wrangler / Cloudflare constraints
- `wrangler deploy` bundles the working tree, not a commit: check `git status` clean first. Config is `wrangler.jsonc`. Account selection and token env names: `E:/Work/docs/naming-cloudflare.md` (the default OAuth login is the wrong account, error 10000).
- `wrangler deployments status --name <worker>` and `secret list` are read-only and safe.
- Workers never run `git push`, `wrangler deploy` or `secret put`; a deploy happens only with the owner approval. The theme CLI runs only through the bash tool; hook refusals are final.

## Deploy reality
- `wrangler versions upload --keep-vars --var BUILD_SHA:<sha>` then `versions deploy <id>@100% -y`; record the previous version id as the rollback target BEFORE uploading.
- `versions deploy <old>@100%` swaps code only. A Durable Object SQLite migration is NOT rolled back: gate the deploy on a migration dry-run plus a rollback-simulation test and pre-write compensating SQL. After a migration applied on a shop it is forward-fix-only.
- Create declared queues (`wrangler queues create <name>`) before deploying, otherwise the deploy fails.

## Post-deploy watch
`wrangler tail <worker> --format json` often emits `logs: []`, so counting substrings proves nothing. Count `outcome != ok`, non-empty `exceptions`, `response.status >= 500` and the 401/403/429 distribution per route (`E:/Work/apps/AntiFan/scripts/leader/cf-tail-count.mjs` does this). Roll back on a burst of 403s on admin routes or any 5xx.
