---
type: researcher
date: 2026-08-19
timestamp: "2026-08-19T23:13:00+07:00"
status: complete
subject: "Antigravity independent conversation routing"
---

# Research Report: Push chat doc lap trong Antigravity

## Muc luc

- [Ket luan](#ket-luan)
- [Pham vi va phuong phap](#pham-vi-va-phuong-phap)
- [Bang chung API hien tai](#bang-chung-api-hien-tai)
- [Route Sidecar chinh thuc](#route-sidecar-chinh-thuc)
- [Bang chung RPC noi bo](#bang-chung-rpc-noi-bo)
- [So sanh phuong an](#so-sanh-phuong-an)
- [Kien nghi cho AntiFan](#kien-nghi-cho-antifan)
- [Tac dong len ban da cook](#tac-dong-len-ban-da-cook)
- [Nguon](#nguon)
- [Cau hoi con mo](#cau-hoi-con-mo)

## Ket luan

**Co the push vao mot Antigravity conversation cu the ma khong phu thuoc tab
chat dang active.** Route duoc Antigravity ho tro chinh thuc la Sidecar CLI:

```text
agentapi send-message <conversation_id> <prompt>
```

Tuy nhien, **khong the lam viec do bang
`antigravityExtensibility.sendToAgentPanel()` trong ban Antigravity hien tai**.
API nay chuyen payload den active panel. Cac field `sessionId`,
`conversationId`, `queue`, `queueIfRunning`, va `sendToQueue` ma extension AntiFan
dang truyen vao khong duoc Antigravity doc.

Vi vay hien tuong "da phan chi vo tab active" khong phai loi timing cua AntiFan.
No la contract thuc cua route dang dung:

```text
Dung Antigravity window/workspace != dung Antigravity conversation
```

Kien nghi cho cong cu ca nhan: giu filesystem bridge da harden cho workspace,
receipt, Draft, va fallback; them mot Sidecar mong cho Auto Send can route chinh
xac theo `conversation_id`. Khong goi truc tiep private language-server RPC.

## Pham vi va phuong phap

- Antigravity da kiem tra: `1.107.0`, commit
  `ecfbad74d93962fc8ca485d93ab9b4f3d4cb6cf8`, build
  `2026-08-13T08:37:22.547Z`.
- Doi chieu bundle cai dat tren may, source extension AntiFan, source Desktop,
  plan da cook, va tai lieu Sidecars chinh thuc.
- Tieu chi: target conversation chinh xac, khong doi UI focus, do on dinh qua
  update Antigravity, kha nang tich hop vao cong cu mot nguoi dung.
- Khong sua production code trong nghien cuu nay.

## Bang chung API hien tai

### 1. `sendToAgentPanel` chi doc ba nhom input

Trong bundle Antigravity, `$sendToAgentPanel(options)` tao items tu:

- `message`
- `files`
- `autoSend`

Sau do no chon action va gui den active panel:

```js
const action = options.autoSend === false ? "populateInput" : "sendMessage";
this._sidePanelFocusService.sendActionToActivePanel(action, items);
```

Khong co nhanh nao doc `sessionId` hay `conversationId`.

### 2. Active-panel service khong mang target ID

Implementation tiep theo chi phat:

```js
sendActionToActivePanel(actionType, payload) {
  this._workbenchServiceProvider.sendChatAction?.({ actionType, payload });
}
```

Event khong co conversation target. Route phu thuoc panel ma UI Antigravity
dang coi la active tai thoi diem xu ly.

### 3. AntiFan dang gui field khong duoc ho tro

Extension tai `E:/Work/apps/antigravity-browser/src/runtime.ts` khai bao va gui:

```ts
{
  message,
  files,
  autoSend,
  queue: true,
  queueIfRunning: true,
  sendToQueue: autoSend,
  sessionId,
  conversationId,
}
```

Desktop da cook cung dat `sessionId` va `conversationId` bang session transcript
duoc chon trong `src/main/browser/native-tab-host.ts`.

Day la metadata chi co y nghia trong protocol AntiFan. Khi payload vao
Antigravity, cac field nay bi bo qua. Receipt `ide-api-accepted` moi da dung khi
khong tuyen bo message da vao dung composer, nhung cung khong chung minh message
vao dung conversation.

### 4. Contract thuc cua route hien tai

Filesystem bridge da cook co the dam bao:

1. Lenh den dung workspace.
2. Dung Extension Host claim lenh.
3. Goi API toi da mot lan.
4. Promise resolve/reject/timeout duoc phan anh trung thuc.

No khong the dam bao:

1. Conversation ID duoc Antigravity ton trong.
2. Tab chat nao dang active khi action duoc xu ly.
3. Message khong bi day vao conversation khac trong cung window.

## Route Sidecar chinh thuc

Tai lieu Antigravity Sidecars cong bo `agentapi` cho tuong tac lap trinh voi
Antigravity. CLI duoc tu dong them vao `PATH` cua process Sidecar.

Hai command lien quan:

```text
agentapi new-conversation <prompt>
agentapi send-message <conversation_id> <prompt>
```

`send-message` nhan ID dich ro rang, nen khong can chat tab active va khong can
chuyen focus UI. `new-conversation` yeu cau Sidecar co `projectId` khi tao
conversation moi.

### Gioi han trien khai quan trong

Khong tim thay `agentapi.exe` standalone trong thu muc cai dat Antigravity. Tai
lieu cung noi executable duoc inject vao `PATH` cua Sidecar. Do do Electron
khong nen gia dinh co the spawn `agentapi` truc tiep tu process Desktop.

Mo hinh hop ly:

```text
AntiFan Desktop
  -> local queue hoac loopback endpoint
  -> AntiFan Sidecar do Antigravity quan ly
  -> agentapi send-message <conversation_id> <prompt>
  -> dung conversation
```

Sidecar chi can la adapter mong, persistent, va chi bind local machine. Khong
can build Harness hay agent engine rieng.

## Bang chung RPC noi bo

Bundle Antigravity con co private language-server method:

```js
sendUserCascadeMessage({
  cascadeId,
  items,
  cascadeConfig,
  activeProfile,
})
```

UI chat noi bo goi method nay voi `cascadeId` la dich. Dieu nay xac nhan
Antigravity co primitive route theo conversation/cascade thuc su; gioi han nam
o public extension facade `sendToAgentPanel`, khong nam o agent backend.

Khong nen tich hop truc tiep RPC nay vi:

- khong phai API public;
- auth, endpoint, protobuf, va config co the doi theo moi build;
- can tai tao state UI/cascade ma Sidecar da duoc Antigravity quan ly;
- rui ro mat kha nang gui sau mot update cao hon nhieu so voi `agentapi`.

## So sanh phuong an

| Phuong an | Dung conversation | Anh huong focus | On dinh | Chi phi |
|---|---:|---:|---:|---:|
| `sendToAgentPanel` hien tai | Khong | Co the | Kha | Da co |
| UI automation chuyen tab roi gui | Best effort | Co | Thap | Thap-trung binh |
| Private `sendUserCascadeMessage` RPC | Co | Khong | Rat thap | Cao |
| Sidecar `agentapi send-message` | Co | Khong | Cao nhat trong cac route da biet | Trung binh |

UI automation chi che race thay vi loai bo race: nguoi dung hoac Antigravity co
the doi active tab giua luc focus va send. Private RPC dung dich nhung bien
AntiFan thanh reverse-engineered client. Sidecar la phuong an duy nhat vua co
conversation ID trong contract vua duoc tai lieu hoa chinh thuc.

## Kien nghi cho AntiFan

### Kien truc hai route

```text
Draft / fallback
  -> filesystem bridge
  -> sendToAgentPanel(autoSend=false)
  -> active composer

Auto exact
  -> filesystem bridge hoac local loopback
  -> AntiFan Sidecar
  -> agentapi send-message(conversationId, prompt)
  -> exact conversation
```

### Thu tu trien khai nho nhat

1. Tao Sidecar toi gian co kha nang nhan mot request local va goi
   `agentapi send-message`.
2. Probe xem transcript session ID hien tai co trung `conversation_id`/
   `cascadeId` hay can bang mapping rieng.
3. Them capability discovery: `active-panel` va `exact-conversation`.
4. Auto Send chi dung exact route khi mapping da xac minh; neu chua co thi bao
   ro fallback active-panel, khong im lang gia vo da target.
5. Giu Draft tren active-panel route vi hanh vi mong muon la nap composer de
   nguoi dung xem lai.
6. Ghi route da dung vao delivery record de debug: `active-panel` hoac
   `sidecar-agentapi`.

### Bien an toan vua du cho cong cu ca nhan

- Chi nhan local request; bind `127.0.0.1` hoac dung workspace file queue.
- Neu dung loopback, them secret ngau nhien theo process va gioi han payload.
- Khong auto retry ket qua khong ro de tranh gui trung.
- Serialize message theo tung conversation neu `agentapi` khong cong bo
  ordering/concurrency guarantee.
- Giu staged artifacts trong target workspace; khong dua Base64 lon qua local
  control channel.

## Tac dong len ban da cook

Plan `plans/260819-2244-harden-antifan-antigravity-sync/plan.md` van dung va co
gia tri. No da xu ly workspace ownership, atomic claim, idempotency, receipts,
cleanup, va tach delivery khoi transcript observation.

Nhung can hieu gioi han sau khi cook:

- "explicitly bound Antigravity workspace" da dat;
- "explicitly bound Antigravity conversation" chua dat;
- `sessionId`/`conversationId` trong command v2 hien la correlation metadata,
  khong phai routing authority;
- `ide-api-accepted` la ten dung cho active-panel route;
- transcript correlation van chi la observation, khong the sua sai routing.

Khong nen chen Sidecar vao plan reliability vua cook. Nen tao mot plan nho rieng
cho exact-conversation routing, de regression surface cua bridge hien tai giu
on dinh va co fallback ro rang.

## Nguon

### Tai lieu chinh thuc

- Antigravity Sidecars: <https://antigravity.google/docs/sidecars/>

### Ban cai dat da kiem tra

- `C:/Users/Admin/AppData/Local/Programs/Antigravity IDE/resources/app/package.json`
- `C:/Users/Admin/AppData/Local/Programs/Antigravity IDE/resources/app/product.json`
- `C:/Users/Admin/AppData/Local/Programs/Antigravity IDE/resources/app/out/vs/workbench/workbench.desktop.main.js`

### Source du an

- `E:/Work/apps/antigravity-browser/src/runtime.ts`
- `E:/Work/apps/antifan-browser-desktop/src/main/browser/native-tab-host.ts`
- `E:/Work/apps/antifan-browser-desktop/src/main/bridge/antigravity-command-client.ts`
- `E:/Work/apps/antifan-browser-desktop/plans/260819-2244-harden-antifan-antigravity-sync/plan.md`

## Cau hoi con mo

- Transcript session ID hien tai co trung voi `conversation_id` ma `agentapi`
  nhan hay can lay mapping tu Sidecar runtime events?
- `agentapi send-message` exit luc Antigravity nhan request, queue request, hay
  sau khi agent bat dau xu ly?
- Khi mot conversation dang chay, `send-message` queue, reject, hay interrupt?
- `send-message` chi cong bo prompt string; staged screenshot/file nen duoc tham
  chieu bang workspace path hay Sidecar co artifact API khac?
- Cach nho nhat de Desktop giao tiep voi Sidecar tren Windows ma van theo doi
  lifecycle va khong de lai process mo coi la file queue hay loopback server?
- Conversation/project ID nao duoc cung cap trong Sidecar runtime data va event
  files, va co on dinh qua restart Antigravity khong?
