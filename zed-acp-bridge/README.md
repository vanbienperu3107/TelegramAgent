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
  (xem `deployHeadscale/edge-vpn4/README.md`).
- Mật khẩu `OPENCODE_SERVER_PASSWORD` của `opencode-server` trên vpn4.

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
