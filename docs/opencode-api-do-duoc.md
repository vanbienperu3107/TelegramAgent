# Bề mặt API của OpenCode — **đo được**, không phải suy đoán

Nguồn: `opencode-server` **1.18.18** đang chạy trên vpn4, đo ngày **2026-08-18** bằng
`.github/workflows/probe-opencode-api.yml` (chạy trên runner, không phải máy cá nhân,
để kết quả tái lập được và gắn với một phiên bản image cụ thể).

Bằng chứng kèm theo:

| File | Nội dung |
|---|---|
| `opencode-openapi.json` | Đặc tả `/doc` đầy đủ — 162 đường dẫn, 478 KB |
| `opencode-events-sample.jsonl` | 111 sự kiện SSE của **một lượt hỏi-đáp thật** có dùng tool và có duyệt quyền |

Tài liệu này thay thế phần "8 endpoint là dấu hỏi" của §17.2. Mọi khẳng định dưới đây
đều đọc được lại từ hai file trên.

---

## 1. Xác thực: HTTP **Basic**, không phải Bearer

Mọi đường dẫn đều trả **401** khi không có xác thực — kể cả `/doc` và `/global/health`.

```
Authorization: Basic base64("opencode:$OPENCODE_SERVER_PASSWORD")
```

Đã thử ba cách; chỉ Basic ra 200:

| Cách | Kết quả |
|---|---|
| `Authorization: Bearer <mật khẩu>` | 401 |
| `Authorization: Basic base64("opencode:<mật khẩu>")` | **200** |
| `x-opencode-password: <mật khẩu>` | 401 |

> Healthcheck của compose dùng `curl -sS` **không kèm `-f`** nên 401 vẫn tính là khỏe.
> Đó là chủ ý: nó hỏi "server có đang lắng nghe không", không hỏi "xác thực có đúng không".

## 2. Hai cây route song song

Đặc tả liệt cả `/session` lẫn `/api/session`, `/event` lẫn `/api/event`… Nhánh không có
tiền tố `/api` là nhánh đã đo và dùng được. **Không trộn hai nhánh.**

## 3. Vòng đời một lượt chạy

```
POST /session                          -> 200, {id:"ses_…", projectID:"global", directory:"/workspace", …}
POST /session/{id}/prompt_async        -> 204 KHÔNG CÓ THÂN
GET  /event                            -> SSE, mỗi dòng "data: {…}"
GET  /session/{id}/message             -> 200, mảng {info, parts}
GET  /session/{id}/diff                -> 200, mảng (rỗng nếu không sửa file)
POST /session/{id}/abort               -> huỷ lượt đang chạy
```

**`prompt_async` trả 204 và không có thân.** Không lấy được `messageID` từ phản hồi —
phải hoặc tự sinh `messageID` (đặc tả cho phép, mẫu `^msg`) và gửi kèm, hoặc bám theo
sự kiện `message.updated` đầu tiên có `role:"assistant"`.

Thân yêu cầu của `prompt_async` — **`parts` là trường bắt buộc duy nhất**:

```json
{
  "model": {"providerID": "cliproxy", "modelID": "claude-opus-5"},
  "agent": "build",
  "parts": [{"type": "text", "text": "…"}]
}
```

## 4. Luồng sự kiện

`GET /event`, định dạng SSE (`data: ` + JSON, dòng trống ngăn cách).
Mỗi sự kiện: `{id, type, properties}`.

### 4.1 KHÔNG có replay

Nối lại lần hai chỉ nhận `server.connected`, **không phát lại** sự kiện đã bỏ lỡ.
Hệ quả bắt buộc cho Event Processor:

- mất kết nối = **mất sự kiện vĩnh viễn**, không có cách nào lấy lại từ luồng;
- sau mỗi lần nối lại phải **đối chiếu bằng thăm dò**: `GET /session/{id}/message`
  cho nội dung và `GET /permission` cho yêu cầu quyền còn treo;
- `server.heartbeat` (~10 s một lần) là cách phát hiện luồng chết mà không cần chờ TCP timeout.

### 4.2 Các loại thực sự phát ra

Đặc tả khai **135 lớp sự kiện**. Một lượt hỏi-đáp thật chỉ phát ra **16 loại**:

| Loại | Số lần | Dùng để làm gì |
|---|---:|---|
| `plugin.added` | 45 | **nhiễu** — lọc bỏ |
| `message.part.updated` | 14 | part đầy đủ (text/tool/step-*) |
| `server.heartbeat` | 14 | phát hiện luồng chết |
| `message.updated` | 10 | siêu dữ liệu message (role, agent, model) |
| `session.updated` | 6 | siêu dữ liệu phiên |
| `session.status` | 6 | `{type:"busy"}` / `{type:"idle"}` |
| `message.part.delta` | 4 | **luồng chữ theo token** |
| `session.diff` | 3 | thay đổi file |
| `catalog.updated` | 2 | nhiễu |
| `server.connected` | 1 | mở luồng |
| `session.created` | 1 | |
| `reference.updated` | 1 | nhiễu |
| `integration.updated` | 1 | nhiễu |
| `permission.asked` | 1 | **cửa duyệt** |
| `permission.replied` | 1 | xác nhận đã duyệt |
| `session.idle` | 1 | **kết thúc** |

`plugin.added` chiếm 41% số sự kiện và không mang thông tin gì cho bot — bộ lọc phải
theo **danh sách trắng** các loại quan tâm, không phải danh sách đen.

### 4.3 Tín hiệu kết thúc

**`session.idle`** — `{"type":"session.idle","properties":{"sessionID":"ses_…"}}`

Ngay trước nó là `session.status` với `{"type":"idle"}`. Dùng `session.idle` làm mốc dừng:
nó xuất hiện đúng một lần cho cả lượt chạy, trong khi `session.status` phát 6 lần
(busy↔idle xen kẽ giữa các bước).

> Không có bước tự duyệt quyền thì **không bao giờ thấy tín hiệu này** — lượt chạy kẹt ở
> cửa duyệt vô thời hạn. Đây là lý do vòng đo đầu tiên vô dụng.

### 4.4 Hình dạng các sự kiện then chốt

```jsonc
// luồng chữ theo token — dựng màn hình tiến độ
{"type":"message.part.delta","properties":{
  "sessionID":"ses_…","messageID":"msg_…","partID":"prt_…",
  "field":"text","delta":"I"}}

// cửa duyệt — đủ dữ liệu cho nút bấm Telegram, không cần gọi thêm
{"type":"permission.asked","properties":{
  "id":"per_…","sessionID":"ses_…",
  "permission":"bash","patterns":["ls -la"],
  "metadata":{"command":"ls -la"},
  "always":["ls *"],
  "tool":{"messageID":"msg_…","callID":"toolu_…"}}}

// xác nhận
{"type":"permission.replied","properties":{
  "sessionID":"ses_…","requestID":"per_…","reply":"once"}}
```

## 5. Duyệt quyền

```
GET  /permission                                  -> danh sách yêu cầu còn treo
POST /session/{sessionID}/permissions/{permissionID}
     {"response": "once" | "always" | "reject"}   -> 200
```

`always` **ghi vào cấu hình quyền của server** (bền qua các phiên) — không phải "luôn
cho phép trong phiên này". Ánh xạ nút bấm phải nói rõ điều đó cho người dùng.

`permission.asked` đã mang sẵn `metadata.command` và `patterns`, nên bot dựng được nút
bấm ngay từ sự kiện, không cần gọi `GET /permission` trước.

## 6. Cấu trúc message

`GET /session/{id}/message` trả mảng `{info, parts}`. Các loại part đã thấy:

| role | các loại part |
|---|---|
| `user` | `text` |
| `assistant` | `step-start`, `text`, `tool`, `step-finish` |

Một lượt có dùng tool sinh ra **hai** message assistant (một cho bước gọi tool, một cho
bước trả lời cuối). Bộ gộp câu trả lời cuối phải lấy phần `text` của message assistant
**cuối cùng**, không phải của message assistant đầu tiên.

## 7. Provider, model, agent

```
GET /config             -> cấu hình đang hiệu lực, gồm provider.cliproxy.options.baseURL
GET /config/providers   -> danh sách provider + model kèm khả năng và giới hạn
GET /agent              -> danh sách agent kèm ma trận quyền
```

`GET /config` là cách duy nhất kiểm được `baseURL` có thật sự tới tiến trình server
không — chính nó đã phát hiện lỗi `baseURL` rỗng ngày 2026-08-18.

`GET /agent` trả agent `build` (`mode:"primary"`, `native:true`) kèm mảng `permission`
đã giải nghĩa từ `opencode.json`.

---

## 8. Điều này ràng buộc gì cho Milestone 2–6

1. **Event Processor** lọc theo danh sách trắng 9 loại: `session.created`,
   `session.status`, `session.idle`, `session.diff`, `message.updated`,
   `message.part.updated`, `message.part.delta`, `permission.asked`,
   `permission.replied`. Cộng `server.connected`/`server.heartbeat` cho phần vòng đời
   kết nối.
2. **Không có replay** ⇒ mỗi lần nối lại phải đối chiếu bằng thăm dò. Đây là ràng buộc
   kiến trúc, không phải tối ưu hoá.
3. **`prompt_async` trả 204** ⇒ phải tự sinh `messageID` để tương quan chắc chắn.
4. **`session.idle`** là mốc dừng của bộ gộp tiến độ.
5. **`message.part.delta`** cho phép cập nhật tiến độ theo token; `message.part.updated`
   cho ảnh chụp đầy đủ. Dùng delta cho tốc độ, dùng updated để tự sửa sai lệch.
6. Câu trả lời cuối lấy từ message assistant **cuối cùng**.
