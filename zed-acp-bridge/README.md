# zed-acp-bridge

Cầu nối để Zed (Agent Panel, giao thức ACP) nói chuyện với `opencode-server`
**remote** đang chạy trên vpn4 qua `https://opencode.hangocthanh.io.vn`
(xem `deployHeadscale/edge-vpn4`). Zed chỉ spawn agent cục bộ qua stdio —
`opencode-server` không nói ACP, chỉ có REST + SSE (`docs/opencode-api-do-duoc.md`)
— nên `bridge.mjs` dịch hai chiều giữa hai giao thức đó.

**v1, không đầy đủ đặc tả ACP** nhưng đã có: chat văn bản, dropdown đổi model/agent,
UI tool_call thật, `session/load`, xử lý `question.asked`, UI `plan` (qua tính
năng `todo` của OpenCode) — hình dạng do trực tiếp từ traffic thật của
`opencode acp` và đặc tả `opencode-openapi.json`, xem chú thích trong `bridge.mjs`.

## UI `plan` (đã hỗ trợ — 2026-08-28, sửa lại kết luận sai trước đó)

Lúc đầu kết luận nhầm "OpenCode không có tính năng plan" vì chỉ tìm từ khoá
`plan` trong đặc tả — **OpenCode có tính năng này thật, chỉ gọi tên khác:
`todo`/`todowrite`**. Tìm lại kỹ hơn ra:

- `GET /session/:id/todo` — snapshot todo/plan hiện tại của phiên.
- SSE `todo.updated` — `{sessionID, todos: [...]}`, bắn mỗi khi model cập nhật.
- Schema `Todo`: `{content, status, priority}` — khớp gần như y hệt `plan
  entries` của ACP, chuyển thẳng không cần đoán.

Bridge dịch `todo.updated` thành `session/update` dạng `sessionUpdate: "plan"`
ngay khi model cập nhật, và `session/load` phát lại trạng thái todo hiện tại
qua `GET /session/:id/todo` khi nạp lại phiên cũ.

## Yêu cầu

- Node.js >= 18 (dùng `fetch`/`AbortSignal.timeout` built-in) trên máy chạy Zed.
- Domain `opencode.hangocthanh.io.vn` đã trỏ DNS + PR route đã merge & deploy
  (xem `deployHeadscale/edge-vpn4/README.md`). Endpoint này chỉ nghe đúng
  **cổng 443** phía ngoài — nginx trên vpn4 định tuyến theo SNI, không có cổng
  phụ nào lộ ra Internet (khác với đường CLIProxyAPI cũ 28417).
- Mật khẩu `OPENCODE_SERVER_PASSWORD` của `opencode-server` trên vpn4.
- Nếu máy chạy Zed **chỉ ra Internet được qua proxy** (mạng công ty/ISP chặn
  outbound trực tiếp, chỉ cho `CONNECT :443` — giống itop/gost đã dùng cho các
  máy khác trong hạ tầng này): chạy `npm install` trong thư mục này một lần để
  lấy `undici`, rồi đặt `HTTPS_PROXY` (xem mục "Qua proxy" bên dưới). Node's
  `fetch` built-in **không tự đọc** biến `HTTPS_PROXY` — thiếu bước cài này thì
  bridge vẫn cố kết nối thẳng và sẽ timeout.

## Cấu hình Zed

Thêm vào `settings.json` của Zed (Cmd/Ctrl+Shift+P → "Open Settings"):

```json
{
  "agent_servers": {
    "OpenCode (vpn4)": {
      "command": "node",
      "args": ["D:/05. Peru/05.TelegramAgent/zed-acp-bridge/bridge.mjs"],
      "env": {
        "OPENCODE_URL": "https://opencode.hangocthanh.io.vn",
        "OPENCODE_SERVER_PASSWORD": "<mat_khau_that>",
        "OPENCODE_PROVIDER_ID": "cliproxy",
        "OPENCODE_MODEL_ID": "claude-opus-5",
        "OPENCODE_AGENT": "build",
        "ACP_AUTO_APPROVE_FALLBACK": "reject"
      }
    }
  }
}
```

**Không commit mật khẩu vào settings.json nếu file đó đồng bộ/chia sẻ.** Có thể
thay bằng biến môi trường hệ điều hành và tham chiếu `"env": {}` rỗng — Zed kế
thừa env của tiến trình cha nếu không override.

## Qua proxy (mạng chỉ cho ra ngoài qua CONNECT :443)

```bash
cd zed-acp-bridge
npm install
```

Thêm `HTTPS_PROXY` vào khối `env` trong `settings.json` của Zed (cùng chỗ với
`OPENCODE_URL`):

```json
"env": {
  "OPENCODE_URL": "https://opencode.hangocthanh.io.vn",
  "OPENCODE_SERVER_PASSWORD": "<mat_khau_that>",
  "HTTPS_PROXY": "http://127.0.0.1:<port_proxy_cuc_bo>"
}
```

Bridge tự dò `HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY`/`http_proxy` (không phân
biệt hoa thường theo thói quen POSIX) lúc khởi động, gắn `ProxyAgent` của
`undici` làm dispatcher toàn cục cho mọi `fetch` (kể cả luồng SSE `/event`).
Không đặt biến này thì bridge kết nối thẳng như bình thường — không ảnh hưởng
máy không cần proxy.

Kiểm nhanh proxy có hoạt động không, xem dòng log ở stderr khi khởi động:
`bridge.mjs: di qua proxy http://...`. Nếu không thấy dòng này mà máy bạn cần
proxy, kiểm lại tên biến trong `env` của Zed (Zed không tự merge biến hệ điều
hành cho phần `env` đã khai — chỉ merge khi bỏ trống hẳn khối `env`).

## Chạy thử độc lập (không qua Zed) để debug

```bash
export OPENCODE_URL=https://opencode.hangocthanh.io.vn
export OPENCODE_SERVER_PASSWORD=xxx
node zed-acp-bridge/bridge.mjs
```

Gửi tay một dòng JSON-RPC để kiểm `initialize`:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n' | node zed-acp-bridge/bridge.mjs
```

Kỳ vọng nhận lại một dòng `{"jsonrpc":"2.0","id":1,"result":{...}}`.

## Xem log khi Zed "im lặng"/treo (2026-08-28)

Có **hai** nơi đọc log, dùng cả hai khi chẩn đoán:

1. `bridge.log` — bridge tự ghi, mặc định **cùng thư mục** với `bridge.mjs`
   (đổi qua `ACP_BRIDGE_LOG_PATH`). Đây là nguồn chính.
2. `%LOCALAPPDATA%\Zed\logs\Zed.log` — Zed **có** ghi lại `stderr` của bridge,
   dạng `WARN [agent_servers::acp] agent stderr: ...`.
   **Đính chính (2026-08-29):** phần này trước đây ghi nhầm là "Zed KHÔNG ghi
   stderr của bridge" — sai, do lần kiểm tra đầu chỉ nhìn phần cuối file lúc
   chưa có dòng nào của bridge. Zed.log còn có thêm lỗi cấp Zed
   (`acp_thread Error in run turn`) mà `bridge.log` không thấy được, nên vẫn
   phải đọc cả hai.

**Cập nhật 2026-08-28:** ban đầu chỉ ghi log khi có lỗi — một lượt đang chạy
bình thường (dù chậm) thì file vẫn trống suốt, không phân biệt được "đang chạy"
với "treo thật". Giờ ghi cả lúc **bắt đầu** (`>>>`) và **kết thúc** (`<<<`, kèm
số mili-giây) của mọi request, ví dụ:

```text
[...] bridge.mjs: >>> session/prompt (id=5) sessionId=zed-1-ses_...
[...] bridge.mjs: <<< session/prompt (id=5) OK, 3421ms
```

Nếu thấy dòng `>>>` mà mãi không có `<<<` tương ứng, nghĩa là bridge THẬT SỰ
đang kẹt ở request đó — khác với trước đây không phân biệt được.

## Quyền (permission.asked)

`opencode-server` được phép chạy `bash`/sửa file. Khi model cần chạy lệnh, sự
kiện `permission.asked` sinh ra; bridge gọi ngược `session/request_permission`
lên Zed để bạn duyệt trong UI. Nếu Zed không trả lời trong
`ACP_PERMISSION_TIMEOUT_MS` (mặc định 60s) — vì phiên bản Zed đang dùng chưa hỗ
trợ method này, hoặc lỗi mạng — bridge dùng `ACP_AUTO_APPROVE_FALLBACK`
(mặc định `"reject"`, **cố ý** an toàn hơn là tự ý cho phép lệnh chạy trên máy
đang giữ DERP relay của cả tailnet). Đổi sang `"once"` chỉ khi bạn hiểu rõ rủi
ro.

## Câu hỏi làm rõ (`question.asked`, đã hỗ trợ — 2026-08-28)

**Sự cố thật đã gặp:** model gọi tool nội bộ "question" để hỏi lại người dùng
trước khi làm tiếp (ví dụ khi lập kế hoạch) → kẹt vĩnh viễn ở trạng thái
`running`, `session.idle` không bao giờ tới, bridge timeout sau 10 phút, và
**mở lại thread cũ (kể cả gõ "thử lại") không giải quyết được** vì câu hỏi treo
vẫn còn nguyên trong lịch sử phiên.

Nguyên nhân: đây là **kênh hoàn toàn khác** `permission.asked` — dò được qua
`docs/opencode-openapi.json`: `GET /question`, `POST /question/:id/reply`
(`{answers:[["nhãn đã chọn"],...]}`), `POST /question/:id/reject`. Không nằm
trong danh sách sự kiện trắng gốc lấy từ mẫu 111 sự kiện của bot Telegram (mẫu
đó không có lượt nào dùng tool "question").

Đã thêm `question.asked`/`question.replied`/`question.rejected` vào danh sách
trắng + `xuLyQuestionAsked()`: hỏi tuần tự từng câu qua chính cơ chế
`session/request_permission` (ghép tạm — ACP không có form hỏi nhiều câu tự
do), timeout hoặc lỗi bất kỳ bước nào → **từ chối cả yêu cầu** qua
`POST /question/:id/reject` thay vì đoán bừa câu trả lời.

**Giới hạn:** chưa hỗ trợ `multiple: true` (chọn nhiều lựa chọn cho 1 câu, chỉ
lấy 1); chưa hỗ trợ trả lời tự do khi `custom: true`.

## Model/agent dropdown (đã hỗ trợ)

`session/new` trả kèm `configOptions` (model + agent), và `session/set_config_option`
cho phép đổi ngay trong dropdown UI của Zed — đúng cơ chế mà `opencode acp` bản
chính hãng dùng (đo trực tiếp bằng cách gọi tay vào binary thật ngày 2026-08-27,
đây là phần mở rộng riêng của OpenCode, không nằm trong đặc tả ACP công khai).
Danh sách model lấy từ `GET /config/providers`, agent từ `GET /agent` — cùng 2 API
bot Telegram đang dùng.

Ảnh dạng Markdown `![alt](url)` trong câu trả lời của model **không cần bridge xử
lý riêng** — Zed tự render Markdown (kể cả cú phap ảnh) trong content block text.
Nếu ảnh không hiện, kiểm lại câu trả lời của model có đúng cú pháp `![]()` (có dấu
`!`) hay chỉ là link thường `[]()`.

## Tool call (đã hỗ trợ)

`message.part.updated` với `part.type === 'tool'` (bash, read, write...) được dịch
thành `tool_call`/`tool_call_update` đúng schema thật của `opencode acp`
(pending → in_progress → completed/failed, kèm output trong `content`/`rawOutput`).
`kind` ACP chỉ chắc chắn đo được cho `bash` (→ `execute`); các tool khác dùng ánh
xạ suy đoán hợp lý (`read`→read, `write`/`edit`/`patch`→edit...) hoặc `other` nếu
chưa rõ — chỉ ảnh hưởng icon hiển thị, không ảnh hưởng chức năng.

**Tự động tải file về máy (2026-08-28):** workspace của opencode-server nằm
**trên vpn4**, không phải máy chạy Zed — file model tạo ra (`.html`, `.md`,
code...) không tự xuất hiện trong file explorer của Zed (giống lý do bot
Telegram cần riêng `tep-ket-qua.ts`). Đã đo được chính xác tên trường qua
`diag-session.yml`: `state.input.filePath` (vd
`/workspace/opencode-sandbox/test.md`). Khi tool `write`/`edit`/`patch` hoàn
tất, bridge:

1. Gọi `GET /file/content?path=...` đọc lại nội dung.
2. **Ghi thật ra ổ đĩa cục bộ** (mặc định `zed-acp-bridge/downloads/`, đổi qua
   `ACP_BRIDGE_DOWNLOAD_DIR`) — đây là bước quan trọng nhất, vì đích "tải file"
   thật sự cần file tồn tại trên máy bạn, không chỉ xem nội dung trong chat.
3. Gửi cả nội dung lẫn đường dẫn cục bộ qua `agent_message_chunk` (bong bóng
   chat thường) — **không chỉ** nhét vào `content` của `tool_call_update`, vì
   `kind:"edit"` có thể có UI riêng trong Zed (ưu tiên khối diff) bỏ qua nội
   dung dạng text và tự hiện dòng cố định "Wrote file successfully" — đúng bug
   đã gặp thật khi chỉ dựa vào tool_call.

**Xem HTML render NGAY TRONG Zed qua ảnh chụp (2026-08-28, mặc định bật):**
Zed không có webview cho HTML, nhưng **Agent Panel render được ảnh inline**
(theo release notes chính thức của Zed). Cách lách khả thi duy nhất: sau khi
tải file `.html` về, bridge chụp trang đã render thành PNG bằng trình duyệt
headless (Edge — có sẵn mọi Windows, đã kiểm chứng chạy đúng trên chính máy
này; fallback Chrome/Chromium) rồi nhúng vào chat bằng cú pháp ảnh Markdown —
bạn thấy **giao diện đã render** ngay trong khung chat, không chỉ mã nguồn.
Tắt bằng `ACP_HTML_SCREENSHOT=0`; đổi kích thước qua
`ACP_HTML_SCREENSHOT_SIZE` (mặc định `1024,768`). Không tìm thấy trình duyệt
thì bỏ qua có ghi log, không hỏng lượt chat. **Chưa kiểm chứng** việc Agent
Panel có load được ảnh từ `file:///` URL cục bộ hay không — nếu ảnh không
hiện, báo lại để đổi sang cách nhúng khác (data URI/đường dẫn tương đối).

**Tự mở file `.html` bằng trình duyệt (tuỳ chọn, 2026-08-28):** Zed **không có**
preview HTML — xác nhận qua issue thật của chính team Zed
([#21208](https://github.com/zed-industries/zed/issues/21208) "Webview via
Extensions" còn mở, [#59598](https://github.com/zed-industries/zed/discussions/59598)
mới là đề xuất API, chưa tồn tại). Đây là giới hạn nền tảng, không phải thiếu
sót của bridge. Cách duy nhất hiện có để xem HTML render thật: mở bằng trình
duyệt ngoài Zed. Bật `ACP_AUTO_OPEN_HTML=1` trong `env` của Zed để bridge tự
mở file `.html`/`.htm` bằng trình duyệt mặc định ngay sau khi tải về
(`cmd /c start` trên Windows, `open` trên macOS, `xdg-open` trên Linux). Mặc
định **tắt** — bật tuỳ ý vì đây là hành vi phụ (mở cửa sổ ứng dụng khác), không
phải lõi chức năng chat.

## session/load và đối chiếu sau mất kết nối (đã hỗ trợ)

`session/load` nạp lại lịch sử phiên cũ bằng cách tách `ocSessionId` ngay từ
`sessionId` ACP (dạng `zed-<n>-<ocSessionId>`) rồi phát lại toàn bộ qua
`GET /session/:id/message` — không cần bridge tự nhớ gì giữa các lần khởi động
(Zed spawn tiến trình bridge mới mỗi lần mở Agent Panel). Vai trò `user` dùng
`sessionUpdate: "user_message_chunk"` theo quy ước ACP công khai — **chưa kiểm
chứng trực tiếp bằng traffic thật** (khác với các phần khác trong file đều đo
tay), vì phiên đo hôm 2026-08-27 chỉ tạo được ví dụ cho vai trò assistant.

Khi mất kết nối SSE giữa lượt (không có replay — `docs/opencode-api-do-duoc.md`
§4.1), bridge giờ đối chiếu bằng `GET /session/:id/message` và gửi nốt phần còn
thiếu thay vì để mất hẳn. Đánh đổi: có thể trùng lặp với phần delta đã gửi
trước đó (chưa khử trùng) — chấp nhận được vì còn hơn câu trả lời biến mất.

## Một kết nối `/event` cho cả phiên (2026-08-27, sửa sự cố "phản hồi chậm dần")

**Trước đây** mỗi `session/prompt` tự mở một kết nối SSE `/event` riêng rồi huỷ
ngay khi xong lượt. Log thật trên vpn4 cho thấy hai hệ quả: `caddy-edge` báo lỗi
`aborting with incomplete response ... broken pipe` mỗi lần huỷ giữa chừng, và
`opencode-server` tự cảnh báo rò rỉ listener nội bộ (kiểu `MaxListenersExceeded`,
đếm tới 11) — hậu quả tích luỹ dần theo số lượt chat, khiến server (giới hạn chỉ
`576m` RAM) càng dùng càng nặng, đúng cảm giác "phản hồi chậm dần" người dùng
báo cáo.

**Giờ** mỗi phiên (`VongDoiPhien`) chỉ mở **một** kết nối `/event`, sống suốt
vòng đời phiên, dùng chung cho mọi lượt `session/prompt` — theo đúng mẫu
`LuongSuKien` (`src/services/event-stream.ts`) bot Telegram đã dùng ổn định.
Giảm số lần mở/huỷ SSE từ "mỗi lượt chat" xuống "mỗi lần mở Agent Panel".

## File đính kèm / @mention (đã hỗ trợ, 2026-08-28)

Trước đây `session/prompt` chỉ lấy content block `type: "text"`, mọi thứ khác
(file đính kèm qua `@mention` trong Zed) bị vứt bỏ hoàn toàn — model luôn báo
"không thấy file đính kèm nào". Giờ dịch cả 3 loại content block chuẩn ACP
(`agentclientprotocol.com/protocol/content`) sang `FilePartInput` của
opencode-server (giống hệt `dinh-kem.ts` của bot Telegram):

- `resource` (nội dung đã nhúng sẵn, `text` hoặc `blob` base64)
- `resource_link` (chỉ có đường dẫn `file://`) — bridge tự đọc file, vì nó chạy
  **cùng máy** với Zed (tiến trình con do Zed spawn)
- `image` (base64 `data`)

Nếu một loại content block không dịch được, bridge bỏ qua và ghi log ra stderr
(`bo qua content block khong dich duoc`) thay vì làm hỏng cả lượt chat.

**Giới hạn kích thước (2026-08-28):** `resource_link` có trần cứng **20 MB**
(đồng bộ với `TRAN_TAI_VE_MB` của bot Telegram). Trước đó không có trần — đọc +
mã hoá base64 + gửi một tệp vài chục MB có thể treo rất lâu qua đường proxy chậm
mà **không log gì cả** (lỗi chỉ được ghi ở bước gọi mạng, không phải ở bước đọc
file), đúng dạng lỗi "Zed im lặng hoàn toàn" báo cáo thật cùng ngày. Vượt trần,
bridge chèn thẳng một dòng cảnh báo vào text của lượt chat thay vì đọc/gửi tệp.

**MIME type không được `application/octet-stream` (2026-08-28) — nguyên nhân
thật của "gửi file xong Zed im lặng hoàn toàn":** đối chiếu trực tiếp qua
`GET /session/:id/message` (workflow `diag-session.yml`) thấy message assistant
lỗi **ngay lập tức** (~400ms, không sinh chữ nào):

```text
"error":{"name":"UnknownError","data":{"message":"'file part media type
application/octet-stream' functionality not supported."}}
```

Zed không luôn gửi kèm `mimeType` cho `resource_link`, bridge trước đó fallback
về `application/octet-stream` — server từ chối thẳng kiểu MIME chung chung này.
Sửa: hàm `doanMime()` đoán theo đuôi tệp (giống `dinh-kem.ts` của bot Telegram,
mở rộng thêm `.ps1/.sh/.js/.py/.yaml`...), mặc định `text/plain` nếu không đoán
được — hợp lý hơn `octet-stream` vì đính kèm trong ngữ cảnh coding phần lớn là
văn bản. **Bài học quan trọng nhất:** `session/prompt` trả `OK` không có nghĩa
là model trả lời thành công — phải đối chiếu `GET /session/:id/message` mới
biết chắc, vì lỗi phía model không tự động thành lỗi ACP.

## Giới hạn đã biết

- `mcpServers` Zed gửi trong `session/new` bị bỏ qua — MCP của opencode-server
  cấu hình riêng qua `opencode.json` trên vpn4, không nhận cấu hình từ client.
- Chưa có test tự động cho file này (khác với phần còn lại của repo, vốn có
  ~145 test). Kiểm bằng tay theo mục "Chạy thử độc lập" ở trên trước khi tin
  cậy dùng hàng ngày.
