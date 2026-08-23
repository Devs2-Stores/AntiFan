# DeepSeek Harness Compatibility Spike

Decision: keep DeepSeek Harness research-only for the MVP. The adapter is feature-gated by `ANTIFAN_DSH_SPIKE`, maps representative session/tool/turn events to AntiFan's normalized event vocabulary, and has no production package or on-disk format dependency.

The pinned research reports document the remaining incompatibilities: developer-preview breaking changes, process-local PTY state, incomplete SDK cancellation/result attribution, and partial Windows sandbox enforcement. A failed or disabled spike therefore cannot weaken AntiFan ownership, policy, receipt, or recovery behavior.
