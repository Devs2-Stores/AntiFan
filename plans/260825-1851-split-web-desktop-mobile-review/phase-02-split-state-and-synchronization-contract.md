---
title: "Phase 2: Split state and synchronization contract"
status: completed
---

# Phase 2: Split state and synchronization contract

## Overview

Define the durable logical-tab state and the event protocol that keeps two live renderers on one URL without navigation loops or accidental transient-state cloning.

## Requirements

- [x] Add a typed internal split state associated with one `AntiFanTab`: enabled flag, desktop/mobile preset IDs, pane view references, focused pane (runtime-only), logical URL, and navigation transaction metadata. Keep pane identity internal; do not duplicate `AntiFanTab` entries or persist focus.
- [x] Define legacy compatibility: a persisted single `devicePresetId` remains readable; split records are optional; disabling split returns the original single-view path and active preset behavior.
- [x] Define synchronization as main-process initiated transactions. An explicit navigate/back/forward/reload chooses an authority pane, starts one transaction, and mirrors the resulting committed URL to the sibling. `did-navigate` and `did-navigate-in-page` events from a mirror are observed but must not start a second transaction.
- [x] Define failure semantics: if the authority fails, report the logical operation as failed and do not claim both panes committed; if the mirror fails, retain the authority URL and expose a non-fatal pane error in state rather than retrying indefinitely.
- [x] Define whether browser-history back/forward applies to the logical tab by invoking the same operation on both panes, with a loop guard and one result envelope. Do not independently advance histories and then attempt to reconcile arbitrary URLs.
- [x] Define shared-session behavior explicitly: cookies, localStorage, IndexedDB, service workers, and network cache remain shared by the existing session; DOM, focus, form values, scroll, and in-memory SPA state remain renderer-local. Do not promise isolation that Electron sessions cannot provide.

## Implementation Steps

1. Add shared/internal types in the owning contract location selected by existing project conventions; keep `AntiFanTab` backward compatible unless toolbar state must expose a new optional split field.
2. Implement pure helpers for pane selection, URL equality/canonicalization, transaction IDs, duplicate-event suppression, and split bounds inputs. Pure helpers must be unit-testable without Electron.
3. Route every logical navigation entry point (`navigate`, `goBack`, `goForward`, `reload`, and renderer-originated navigation) through the transaction coordinator.
4. Update persisted tab records to include only split enabled and preset IDs. Exclude focused pane, WebContentsView handles, document generation, form values, scroll, DOM, cookies, storage, and SPA state; restore paired views non-activating and perform one explicit final active-tab switch.
5. Keep one `documentGeneration` per logical tab/document. A mirror renderer load or in-page event must not increment the generation independently or invalidate the existing `BrowserTarget` contract.
6. Keep capsule IDs and preview watcher subscriptions on the logical tab; a split mirror must never create a second capsule subscription.

## Todo

- [x] Define and test transaction state transitions: idle → authority-started → authority-committed → mirror-started → settled/failed.
- [x] Define duplicate, stale, in-page, destroyed-view, and navigation-failure event handling.
- [x] Define persistence migration and restore behavior for legacy and malformed split records.

## Success Criteria

Unit-level state tests prove one logical URL, no mirror loop, deterministic failure handling, legacy restore compatibility, and exclusion of transient page state from persistence. The contract states exactly which pane is authoritative for toolbar, user, and tool actions.
