# zed-acp-bridge

Cầu nối để Zed (Agent Panel, giao thức ACP) nói chuyện với `opencode-server`
**remote** đang chạy trên vpn4 qua `https://opencode.hangocthanh.io.vn`
(xem `deployHeadscale/edge-vpn4`). Zed chỉ spawn agent cục bộ qua stdio —
`opencode-server` không nói ACP, chỉ có REST + SSE (`docs/opencode-api-do-duoc.md`)
— nên `bridge.mjs` dịch hai chiều giữa hai giao thức đó.

**v1, không đầy đủ đặc tả ACP.** Đủ để chat văn bản qua Agent Panel; tool-call
hiển thị dạng chunk văn bản đơn giản, chưa dựng UI tool_call/plan riêng.

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

## Quyền (permission.asked)

`opencode-server` được phép chạy `bash`/sửa file. Khi model cần chạy lệnh, sự
kiện `permission.asked` sinh ra; bridge gọi ngược `session/request_permission`
lên Zed để bạn duyệt trong UI. Nếu Zed không trả lời trong
`ACP_PERMISSION_TIMEOUT_MS` (mặc định 60s) — vì phiên bản Zed đang dùng chưa hỗ
trợ method này, hoặc lỗi mạng — bridge dùng `ACP_AUTO_APPROVE_FALLBACK`
(mặc định `"reject"`, **cố ý** an toàn hơn là tự ý cho phép lệnh chạy trên máy
đang giữ DERP relay của cả tailnet). Đổi sang `"once"` chỉ khi bạn hiểu rõ rủi
ro.

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

## Giới hạn đã biết

- Không hỗ trợ `session/load` (nạp lại phiên cũ) — mỗi lần mở Agent Panel là
  một `POST /session` mới trên opencode-server.
- Không có replay sự kiện (xem `docs/opencode-api-do-duoc.md` §4.1): nếu mất
  kết nối SSE giữa chừng một lượt, bridge coi lượt đó kết thúc thay vì treo —
  nhưng có thể mất phần đuôi câu trả lời. Chưa làm bước đối chiếu
  `GET /session/:id/message` sau khi mất kết nối như bot Telegram đã làm.
- `mcpServers` Zed gửi trong `session/new` bị bỏ qua — MCP của opencode-server
  cấu hình riêng qua `opencode.json` trên vpn4, không nhận cấu hình từ client.
- Chưa có test tự động cho file này (khác với phần còn lại của repo, vốn có
  ~145 test). Kiểm bằng tay theo mục "Chạy thử độc lập" ở trên trước khi tin
  cậy dùng hàng ngày.
