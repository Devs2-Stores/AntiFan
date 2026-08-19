# Phase 1: Scout And Tool Map

## Requirements

- Inventory existing callable capabilities; do not invent parallel implementations.
- Trace provider structured output into RunService and durable events.
- Identify read-only versus mutating operations and their binding/lease requirements.

## Files

- `src/main/projects/run-executor.ts`
- `src/main/projects/project-run-service.ts`
- `src/main/providers/antigravity-direct-driver.ts`
- `src/main/capability-broker.ts`
- `src/main/projects/workspace-capability-adapter.ts`
- `src/main/browser/`
- `src/main/terminal/`
- `src/main/mcp/agent-mcp-server.ts`
- `src/shared/harness-contract.ts`

## Steps

- [x] Map current provider event shapes and missing continuation contract.
- [x] Map broker capability names, schemas, results, receipts, and safety classes.
- [x] Select the smallest useful coding tool catalogue.
- [x] Record integration boundaries and regression risks.

## Validation

- Every selected tool maps to an existing executable owner.
- No selected mutation bypasses Project ownership, binding validation, lease, or receipt handling.
