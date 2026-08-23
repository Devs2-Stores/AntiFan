# Codex Backend Spike

The adapter uses the installed `codex` executable through `codex exec --json` and treats each stdout line as an independently validated JSON event. The implementation emits only normalized AntiFan events, preserves the exact run/attempt IDs, keeps the requested cwd, bounds stderr, and records timeout/cancellation as `unknown` rather than retrying.

The target installation was not assumed to have a usable Codex binary during repository validation. When unavailable, spawn failure is represented as a failed backend event; no provider-specific DTO becomes a durable AntiFan contract.
