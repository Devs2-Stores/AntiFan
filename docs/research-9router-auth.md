# Research Report: Antigravity `ag/*` — cách 9Router làm & tích hợp direct (không qua 9Router)

- **Ngày research**: 2026-08-16 14:00–15:30 (giờ +07)
- **Mục tiêu**: dùng model nội bộ Antigravity (`ag/gemini-3.6-flash-high`) trong app **ghi trực tiếp upstream**, theo cách 9Router xác thực — không dùng API 9Router.
- **Kết quả**: **ĐÃ CHẠY** — app gọi thẳng `daily-cloudcode-pa.googleapis.com` bằng token OAuth (cùng client + scopes 9Router), stream "PONG" ~1s; đồng thời phát hiện + sửa bug token bị mã hoá vỡ khiến app từ lâu gửi ciphertext làm Bearer.

## Executive Summary

9Router không phát Minh OAuth riêng lẻ: nó **MITM CLI/IDE Antigravity** (đọc token `Authorization: Bearer` từ luồng CLI → `cloudcode-pa.googleapis.com`), đồng thời có provider `antigravity` self-OAuth bằng **chính OAuth client `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`** — y hệt client app đang dùng, với y hệt 5 scopes (`cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`, `experimentsandconfigs`). Upstream là **Gemini Code Assist (cloudcode-pa)**, wire format `v1internal:streamGenerateContent`, model `gemini-3.6-flash-tiered` + `thinkingConfig.thinkingLevel`. Vì token app và token 9Router cùng loại, app chỉ cần token OAuth hợp lệ là gọi thẳng được — không cần proxy.

## Key Findings

### 1. Chuỗi xác thực thật của 9Router (chứng cứ source)
- `app/src/mitm/server.js`: danh sách host bị MITM gồm `cloudcode-pa.googleapis.com` / `daily-cloudcode-pa.googleapis.com`; đánh dấu endpoint `:generateContent`/`:streamGenerateContent` cho antigravity; alias `gemini-3.6-flash-tiered` ↔ high/medium/low theo thinkingLevel.
- `chunks/2573.js`: config provider `antigravity` — transport baseUrls `["https://daily-cloudcode-pa.googleapis.com"]`, User-Agent `antigravity/ide/2.1.1 darwin/arm64`, models: `gemini-3.6-flash-high → upstreamModelId gemini-3.6-flash-tiered(high)` (tương tự medium/low), OAuth client `1071006060591-…` + clientSecret, scopes như trên, deprecation flag.
- `chunks/8499.js` (adapter): `buildUrl → {base}/v1internal:{streamGenerateContent?alt=sse|generateContent}`; `buildHeaders → {Content-Type, Authorization: Bearer <accessToken>, User-Agent}`; `transformRequest → {…, project, model, requestType:'agent', userAgent:'antigravity', requestId, request:{contents, generationConfig, sessionId, …}}`; refresh dùng `oauth2.googleapis.com/token` + clientSecret.
- `chunks/6832.js`: `postExchange` gọi `v1internal:loadCodeAssist` (headers: UA `google-api-nodejs-client/9.15.1`, `X-Goog-Api-Client: google-cloud-sdk vscode_cloudshelleditor/0.1`, `Client-Metadata {ideType:9, pluginType:2}`, `x-request-source: local`).

### 2. Probe thực trên máy (token 9Router = ya29.a0AdM…)
| Gọi | Kết quả |
|---|---|
| `userinfo` | 200 |
| `v1internal:loadCodeAssist` | 200 → `allowedTiers: [{id:"standard-tier", name:"Gemini Code Assist"}]` (account CÓ entitlement) |
| `v1internal:streamGenerateContent` body phẳng `{contents,…}` | 400 Unknown field `contents` — **phải bọc `request`** |
| **Body chuẩn (nested `request`)** | **200, "PONG" trong ~1.2s** |

Wire OK cuối cùng:
```
POST https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
{ "model":"gemini-3.6-flash-tiered", "requestType":"agent", "userAgent":"antigravity",
  "request": { "contents":[{"role":"user","parts":[{"text":"..."}]}],
    "generationConfig": {"maxOutputTokens":8192,"thinkingConfig":{"thinkingLevel":"high"}} } }
→ SSE: data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"..."}]}}]}}
```

### 3. Bug gốc khiến app fail mọi nơi
- File `~/.gemini/antigravity_direct_auth.json`: `accessToken` = `djEwMaS2…` (base64 của `v101` + ciphertext) — được mã hoá bởi key safeStorage **cũ hơn**; `safeStorage.decryptString` hiện tại **THROW** ("Error while decrypting the ciphertext").
- Code cũ `decryptSecret` catch → **return chính ciphertext**; `getValidCredentials` trả `{token: ciphertext}` → 401 "Missing/Invalid auth credentials" ở mọi endpoint Google (userinfo, cloudcode-pa, 9Router).
- Ảnh hưởng chồng: token vỡ → các luồng cũ fallback Google public → 404/405 "Model không tồn tại".

### 4. Best practices
- Không bao giờ dùng ciphertext làm credential: decrypt fail = coi như chưa đăng nhập.
- Validate token theo định dạng (`ya29.`/`1//`) trước khi dùng.
- Ghi trực tiếp upstream (1 hop) thay vì proxy local (2 hop): độ trễ ~1s vs ~12.7s, không phụ thuộc tiến trình ngoài.

## Implementation (đã áp dụng)
- `antigravity-auth-service.ts`: `decryptSecret` fail → `undefined`; guard `isPlausibleAccessToken` (`/^(ya29\.|1\/\/)/`) trong `getValidCredentials`.
- `antigravity-direct-driver.ts`: model `ag/*` → `agUpstreamModel()` (tiered + thinkingLevel), `agentUrl/agentHeaders/agentBody`, SSE parse `parseAgentStreamChunks` (`response.candidates.parts[].text`); testModel + streamChat direct; giữ proxy 9Router cho gemini-3/sonnet/opus; bỏ `proxyRejectedGuidance` (không dùng cho ag nữa).
- Test: +7 case (agUpstreamModel ×2, parseAgentStreamChunks ×2, còn lại giữ) → suite 260/260. Probe electron: auth blob → null; testModel(ag/high) ok=true; streamChat(ag/medium) done "PONG" 978ms.

## User action (duy nhất)
**Đăng nhập lại Google OAuth trong app** (⚙️ → Antigravity Direct → Đăng Nhập Google OAuth). Token mới được mã hoá bằng key hiện tại → giải mã được từ giờ về sau → `ag/*` chạy thẳng (không cần 9Router, không cần API key dashboard). Nếu sau đăng nhập vẫn 401 ở `/v1internal`, gửi status — khả năng account hết entitlement (antigravity.google RISK_NOTICE deprecated trong 9Router).

## Unresolved
- `sessionId`/`projectId` bắt buộc ở mọi request hay chỉ một số mô hình? (probe OK khi thiếu cả hai — xem như optional, theo dõi khi dùng tool-calling dài hạn)
- Model list `fetchAvailableModels` chưa wire vào UI (chỉ dùng `ag/*` preset hiện có).
- Entitlement theo account: token mới của user phải cùng Google account có quyền Code Assist (hiện máy có: f1genz2022 — đúng account 9Router đang dùng).