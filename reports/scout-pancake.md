# ULTRA SCOUT REPORT — E:\Work\apps\Pancake

## 1. Project & Directory
E:\Work\apps\Pancake is NOT a live app — it is a one-off, zero-dependency Python 3.12 data-migration toolkit converting merchant-exported Pancake POS ("POSCake") Excel files (Customer.xlsx 11.9KB, Order.xlsx 369.9KB) into Haravan via REST API https://apis.haravan.com/com/*. Client: Levents (VN fashion brand; SKUs like LTSBOCOA220VSS26; token env HARAVAN_TOKEN_THUYSINH → fallback HARAVAN_ACCESS_TOKEN, Bearer auth).

Integration reality: NO Pancake API client, NO webhook handler exists. The "Pancake integration" is purely file-based batch migration (XLSX → transform → REST push). The only webhook concern is defensive: never write carrier tracking codes into `fulfillments` because that triggers Haravan→ĐVVC booking webhooks.

## 2. Architecture & Role
Pipeline: Customer.xlsx/Order.xlsx (masked PII) → hand-rolled OOXML parser (zipfile+ElementTree, sharedStrings+sheet1.xml only, stdlib-only) → dry-run audit (migrate_poscake_to_haravan.py: groups multi-line orders by 'Mã đơn hàng' positional continuation; masked/cancelled/no-address quarantine) → reconciliation_queue.json (30 cust→23 ok/7 review; 30 orders→5 ok/25 review; 38 line items) → live push (post_to_test_store.py: GET /com/locations.json → POST /com/customers.json → POST /com/orders.json) → haravan_poscake_order_reconciliation.json (pancake_code→haravan id/number 1-1 map) → verification probes (POST→GET persisted readback→typed assertions→fail-closed error artifact) → 3 overlapping XLSX report generators → Bao_Cao_*.xlsx + docs/field-mapping-report.md.

## 3. Load-Bearing Files & Contracts
- migrate_poscake_to_haravan.py: parse_xlsx_with_headers (L24-72); order grouping by 'Mã đơn hàng' with positional continuation rows (L118-148); masked/cancelled/no-address review queues (L150-180).
- order_utils.py: build_order_note → "Mã đơn gốc Pancake: {code} | Thời điểm tạo đơn: {t} | Ngày tạo đơn: {d} | Ghi chú giao hàng: {n}".
- post_to_test_store.py: order payload name=tags="POSCake_{code}", financial_status:"paid", fulfillment_status:"fulfilled", gateway:"cod", note_attributes Pancake_Code/Created_Time/Created_Date (L240-275); location fallback locations[0] (L120) — BUG, picks transit hub.
- test_single_order_fields.py: 3-step GET locations→POST order→GET readback; fail-closed single_order_live_error.json on error, exit 1, no mock fallback; dry-run fixture when token absent (asserts order_number int — contradicts live string).
- inspect_locations_and_test.py: dumps store_locations_metadata.json; prefers "Địa điểm mặc định"/ID 3526911 else locations[-1] (L73-82); ISO-8601 regex assertion on created_at.
- test_haravan_api_fields.py: offline assertion suite; catalog codes == expected unique codes.
- build_final_excel.py / build_customer_final_excel.py / build_clean_customer_excel.py: three near-identical hand-built OOXML emitters; build_customer_final_excel.py is most complete (4 sheets incl. live-verification sheet).
- docs/field-mapping-report.md (345 lines): 30 customer + 287 order fields → Haravan targets; 5 acceptance gates (L339-345).
- store_locations_metadata.json: 3526912 "Kho trung gian" location_type:"ontheroad" is_primary:false; 3526911 "Địa điểm mặc định" location_type:"default" is_primary:true province_code:"1079".
- single_order_live_error.json: POST orders location_id:3526912 → HTTP 422 {"errors":"Chi nhánh không hợp lệ"}.
- single_order_reconciliation_test.json: order_number persisted as STRING "POSCake_314641" (synced from order.name); created_at server-stamped 2026-08-24T06:55:11.608Z; note_attributes round-tripped verbatim.

## 4. Critical Edge Cases / Traps / Workarounds
1. Transit-hub 422 (verified live): location_type:"ontheroad" rejects order creation; post_to_test_store.py:120 falls back to locations[0] = the transit hub itself, reproducing the recorded 422. Correct heuristic: is_primary/default (inspect_locations_and_test.py:73-82).
2. order_number is NOT numeric: live readback returned "POSCake_314641" string synced from order.name; dry-run fixture asserts int — fixture drift.
3. created_at cannot be backdated: server-stamped; source timestamps preserved only via note+note_attributes (verified live).
4. Cancelled orders leak into live push: post_to_test_store.py never filters Trạng thái=="Đã hủy" — pushes them as paid/fulfilled; ignores reconciliation_queue.json review queue entirely.
5. Carrier isolation: tracking codes → note_attributes (Carrier_TrackingCode/Carrier_Name), NEVER fulfillments (fires ĐVVC booking webhooks).
6. Masked PII: phone/name masked with "*" ("+84982****07", "K** D***n"): 7/30 customers, 18/30 orders; empty phone treated as masked.
7. Positional continuation grouping: blank 'Mã đơn hàng' rows append to LAST seen order — silently corrupts if export is sorted/filtered.
8. XLSX parser traps: sheet1.xml only; t="s" shared strings + raw numeric only; inlineStr/b/str/e cells and styles.xml ignored → real date cells surface as serial floats.
9. No idempotency, no rate limiting: rerun duplicates everything; created_customers phone→id map built but never used to link orders; spec demands 4 req/s leaky-bucket + 429 Retry-After — unimplemented.
10. Gateway hardcoded "cod"; source 'Phương thức thanh toán' read then discarded (L213 vs L254).
11. Gender contract conflict: code sends "male"/"female" strings; spec says Nam→1, Nữ→2, else→0 — unresolved.
12. Geography lookup unimplemented: spec gate 3 requires dynamic /com/countries→provinces→districts code resolution (sample province_code:"1079"); code sends raw names.
13. Address fallbacks persist literal "Chưa cập nhật"/"Chưa cập nhật địa chỉ" into records.
14. Latent Excel-writer bug: chr(64+c_idx) column math breaks past column Z (untriggered, all sheets 5 cols).
15. Order-code heterogeneity: short numerics (314641) + long FB-sourced IDs (585700291402826821); POSCake_ prefix handles both.
16. Pancake 287-column schema carries social-commerce metadata (PSID, Page ID, Chat page, Ad ID, UTM_*, FB click ID, Link hội thoại Pancake), marketplace fees (Phí sàn, Sàn TMĐT), carrier fields (GHTK, Viettel Post, Flash), e-invoice, staff attribution — all spec'd to tags/note_attributes overflow, none implemented.

## 5. Improvements for Super Core
Platform semantics (verified claims): haravan.locations ontheroad→422, select is_primary/default; haravan.orders.name accepts arbitrary strings, order_number may persist same string (never assert numeric); created_at immutable server-stamp → preserve in note/note_attributes; financial_status/fulfillment_status are labels only (no transaction/carrier); pancake.exports mask PII with "*", use blank-code continuation rows, 287-col schema.
Anti-patterns: location_id by array position → 422; tracking codes into fulfillments → carrier webhooks; backfill without filtering cancelled → revenue corruption; order_number-as-int fixtures → live drift.
Fix patterns: POST→GET persisted readback + typed assertions before declaring verified; fail-closed error artifact {error_step,http_code,error_body,payload} + exit 1, no silent mock fallback; quarantine queue with reason codes instead of silent drops.
Workarounds/hidden requirements: masked-PII → manual review queue, never auto-post; migration idempotency needs Pancake_Code lookup (search by tag/note_attribute) before POST — absent, record as hidden requirement; 4 req/s + 429 Retry-After required for batch Haravan writes.

## 6. Improvements for Haravan Theme Core Output
- order.name/order_number are opaque strings (POSCake_314641): ThemeCompiler/SchemaGenerator must never emit Liquid/JS parsing #\d+ or assuming numeric order numbers in order-status/account templates.
- Namespaced tag convention POSCake_<code>, Staff:<n>, Src:<ch>, Tier:<lvl>, PSID:<id>, Telco:<c>: schema generator should treat Prefix:Value tags as namespaced facets for filter/search/account settings; DOM sanitizer must not strip them.
- note_attributes audit surface: migrated orders carry Pancake_Code/Created_Time/Created_Date — templates rendering note_attributes need a whitelist (safe keys vs carrier/PII-adjacent).
- Unresolved contract: customer.gender ("male"/"female" vs 1/2/0) — theme output must not depend on it; add to settings-contract unknowns.
- Fallback strings "Chưa cập nhật"/"Chưa cập nhật địa chỉ" appear in address renders — treat as empty for display.

## 7. Improvements for AntiFan Core & Site Clone
AntiFan Core: adopt POST→GET persisted-state verification as a verification_claim archetype (claim="field X persisted as Y", proof=authenticated GET readback+typed assertions); adopt fail-closed error artifact shape for telemetry.record_fallback/verification receipts; entity-resolution gate before writes (enumerate→classify ontheroad vs default→select is_primary→probe→verify) reusable for any resolve-before-mutate capability; reconciliation artifact (source_id→target_id 1-1) = evidence lease shape claims should reference. Note: zero browser/CDP surface here — bridge is pure REST.
Site Clone: dry-run→quarantine→emit mirrors IR→validate→emit; reconciliation_queue.json is an IR artifact with per-record reason codes — DoD validator should adopt "review queue with machine-readable reasons" over binary pass/fail; the spec's 5 acceptance gates are a ready-made DoD validator pattern (encode as machine-checkable validators with evidence paths); hand-built OOXML writers prove byte-deterministic stdlib-only emission — same philosophy as offline standalone HTML; note_attributes/tags are the overflow escape hatch when target schema lacks native fields — component-contract IR should reserve an equivalent extension field so unmapped source data is never silently dropped (287-field spec → ~20 native fields).
