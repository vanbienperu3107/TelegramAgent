# OpenCode Telegram Remote Gateway — Implementation Specification

> **Bản cập nhật 2026-08-13 — neo vào hạ tầng thật.**
> Spec gốc giả định OpenCode + PostgreSQL + CLIProxy nằm chung một máy (`127.0.0.1:4096`).
> Khảo sát trực tiếp vpn4 và vpn6 cho thấy điều đó không đúng: CLIProxy ở vpn4 (Peru),
> PostgreSQL ở vpn6 (Việt Nam), cách nhau **307 ms**, và **OpenCode chưa được cài ở đâu cả**.
> Các mục 0, 2, 4, 6, 7, 7.10, 7.11, 12, 17, 18, 26, 28, 34–37, 37.1–37.4, 45, 50 đã được
> viết lại theo số liệu đo được. Phần đặc tả trải nghiệm Telegram (mục 9–33, 38–44, 48–49)
> giữ nguyên vì không phụ thuộc hạ tầng.

---

# 0. Hạ tầng thực tế (khảo sát 2026-08-13)

Mọi số liệu dưới đây là **đo trực tiếp trên máy**, không phải giả định. Khi triển khai
mà thấy lệch thì đo lại rồi sửa mục này trước, sửa code sau.

## 0.1 vpn4 — `149.104.66.174` / `vpn4.hangocthanh.io.vn` (Peru)

```text
OS      Ubuntu 24.04.2 LTS
RAM     1968 MB tổng — 692 MB đã dùng, ~1275 MB còn trống
Swap    3915 MB (mới dùng 32 MB) ← đây là thứ cứu ta khi RAM mỏng
Disk    50 GB, dùng 30%
Tailnet ts-vpn4 = 100.64.0.4 · ts-vpngw = 100.64.0.9 (TS_USERSPACE=false)
```

| Container | Cổng host | Vai trò | Giới hạn RAM |
|---|---|---|---|
| `derper` | 80, 443(nội bộ), 3478/udp | DERP relay của fleet — **ưu tiên cao nhất, không được chết** | không đặt |
| `edge-nginx` | **443** | Định tuyến theo SNI: mặc định → `derper:443`, `cliproxy.hangocthanh.io.vn` → `caddy-edge:8444` | 128 MB |
| `caddy-edge` | (sau nginx) | Terminate TLS cho `cliproxy.hangocthanh.io.vn`, `flush_interval -1` cho SSE | 256 MB |
| `cliproxy` | **28417 → 8317** | CLIProxyAPI v7.2.112 — API OpenAI/Anthropic-compatible | 1 GB (đang dùng 24 MB) |
| `vpn-gw` + `ts-vpngw` | — | Cổng vào mạng Bitel, **chỉ advertise `10.121.124.155/32`** | không đặt |
| `ping-reporter-vpn4` | — | Telemetry DERP | không đặt |

Mạng docker: `edge` (cliproxy 172.23.0.3, caddy-edge 172.23.0.5), `cliproxy_default`,
`derp-vpn4_default`, `derp-vpn4-v2_default`, `relay-vpn4_relay_net`, `vpn-gw_default`.

**Thiếu gì:** không có `node`, không có `opencode`, **không có watchtower** (khác vpn6 — deploy
phải gọi workflow tường minh), và **không có `/etc/docker/daemon.json`** → log driver mặc định
không giới hạn dung lượng.

## 0.2 vpn6 — `45.119.87.220` (Việt Nam, `Asia/Ho_Chi_Minh`)

```text
RAM     3868 MB tổng — 1378 MB đã dùng, ~2489 MB còn trống
Disk    48 GB, dùng 46%
Tailnet ts-vpn6 = 100.64.0.7
Stack   /opt/dashboard-vn (headscale + dashboard + telemetry + Postgres)
```

| Container | Vai trò | Giới hạn RAM |
|---|---|---|
| `headscale` 0.27.1-pernode | **Control plane của toàn bộ fleet VPN** | không đặt |
| `derp-postgres` `postgres:18-alpine` | DB dùng chung — **không publish cổng ra host**, ở mạng `dashboard-vn_dashnet` (172.21.0.2) | 1 GB |
| `derp-backend` | API dashboard | 384 MB |
| `pgweb-derp`, `pgweb-headscale`, `pgweb-oauth2` | Quản trị DB qua `sql.hangocthanh.io.vn` | 128–256 MB |
| `memory-*` (caddy, qdrant, 3 API) | Stack `claude.hangocthanh.io.vn` | không đặt |
| `dashboard-watchtower` | Tự cập nhật image trên vpn6 | 128 MB |

PostgreSQL đo được:

```text
server_version   18.4
database         derp (10 MB) · headscale (8670 kB) · postgres
role login được  derp (superuser) · headscale
cổng             KHÔNG publish — chỉ container trong dashnet gọi được
backup           /opt/dashboard-vn/backup-db.sh — hiện CHỈ pg_dump DB "derp"
```

## 0.3 Độ trễ giữa hai máy (đo bằng ping, 2026-08-13)

```text
vpn6 → vpn4 công cộng      307.2 / 307.3 / 307.4 ms   (min/avg/max — cực ổn định)
vpn6 → vpn4 qua tailnet    312.1 / 417.2 / 626.9 ms   (jitter lớn vì đi qua DERP)
```

Kết luận rút ra: **đường công cộng nhanh và ổn định hơn tailnet**. Mọi thiết kế bên dưới
dùng đường công cộng có mã hoá (SSH tunnel), không dùng tailnet.

## 0.4 CLIProxyAPI — nguồn model duy nhất

```text
Image           eceasy/cli-proxy-api:v7.2.112
Nội bộ vpn4     http://cliproxy:8317/v1        (mạng docker "edge" — KHÔNG qua Internet)
Từ Internet     http://149.104.66.174:28417/v1 (HTTP trần, bắt buộc api-key)
                https://cliproxy.hangocthanh.io.vn (nginx SNI → caddy-edge → cliproxy)
Credential      1 × Claude + 1 × Codex (OAuth, nằm ở /opt/deployHeadscale/cliproxy/auths)
Model đã kiểm chứng  claude-opus-5  (smoke test trong deploy-cliproxy.yml gọi thật, có tiếng Việt)
Secret          CLIPROXY_API_KEY (GitHub secret của repo deployHeadscale)
```

**Sự cố phải nhớ (2026-08-02):** bật `logging-to-file: true` khiến **mỗi request của OpenCode**
sinh một file log 32 MB → cliproxy vượt giới hạn bộ nhớ → kernel OOM-kill giữa chừng → client
treo ở "Thinking". Cấu hình hiện tại đã tắt (`commercial-mode: true`, `logging-to-file: false`).
**Dự án này tuyệt đối không được bật lại.**

## 0.5 Quyết định kiến trúc đã chốt

| # | Quyết định | Lý do dựa trên số liệu |
|---|---|---|
| QĐ-1 | OpenCode server **và** Gateway chạy trên **vpn4** | Gọi LLM qua `cliproxy:8317` trong mạng docker nội bộ: không ra Internet, không lộ API key qua HTTP trần, không tốn 307 ms mỗi lượt |
| QĐ-2 | Không đặt lên vpn6 | vpn6 giữ **headscale control plane**; một agent được phép chạy `bash`/build mà OOM ở đó sẽ kéo sập VPN của cả fleet |
| QĐ-3 | PostgreSQL **dùng lại `derp-postgres` trên vpn6**, tạo DB `opencode_remote` riêng | Người dùng chốt. Đổi lại phải thiết kế giảm số round-trip (§7.10) |
| QĐ-4 | Kết nối DB bằng **SSH tunnel qua đường công cộng**, không qua tailnet | 307 ms ổn định so với 312–627 ms jitter (§0.3) |
| QĐ-5 | Telegram dùng **long polling**, không webhook | Cổng 443 của vpn4 đã thuộc `edge-nginx`/derper; thêm webhook phải sửa SNI router của hạ tầng đang chạy |
| QĐ-6 | V1 chỉ đăng ký **1 project thử nghiệm** | Người dùng chốt — chạy thông end-to-end trước, mở rộng sau |

## 0.6 Ràng buộc bắt buộc (rút từ sự cố đã xảy ra trên chính hạ tầng này)

1. **Mọi service mới phải có `mem_limit`.** Tổng ngân sách cho stack này ≤ 900 MB (§37.1).
2. **Mọi service mới phải có `logging: json-file, max-size 10m, max-file 3`.** Trên vpn6
   `derp-backend` từng phình 2.5 GB log, đọc log lớn làm nghẽn Postgres và dashboard trả 500.
   vpn4 không có `daemon.json` nên phải khai báo ở từng service.
3. **Không bật `logging-to-file` của cliproxy** (§0.4).
4. **Script deploy qua `appleboy/ssh-action` không được dùng heredoc và không được dùng khối
   `if/else` nhiều dòng** — action chèn dòng kiểm tra exit code sau mỗi dòng, làm script chết im
   lặng. Viết dạng phẳng: `[ -z "$X" ] || lệnh`.
5. **Repo `TelegramAgent` là repo PUBLIC** → không commit `.env`, không hardcode token/API key;
   CI phải có bước quét secret.
6. **Trước khi restart container đã chạy lâu ngày**, so `docker inspect` env với file `.env`
   trên đĩa — vpn6 từng chạy 12 ngày với env cũ, lần recreate đầu tiên nạp secret thật làm 401
   toàn bộ client.

---

## 1. Mục tiêu

Xây dựng một Telegram Bot hoạt động như **mobile remote UI cho OpenCode**.

Người dùng phải có thể điều khiển OpenCode từ Telegram theo workflow:

- Chọn project
- Tạo/chọn/continue OpenCode session
- Chọn provider/model AI
- Chọn OpenCode agent
- Gửi text
- Gửi image/screenshot
- Gửi file
- Nhận text response
- Nhận image/file artifact
- Theo dõi trạng thái agent realtime
- Xem diff
- Xem artifacts
- Approve / Reject permission
- Abort task
- Tiếp tục cùng session mà không mất context

Telegram Gateway **không phải một chatbot AI riêng**.
OpenCode vẫn là execution engine và quản lý conversation/session/context.

---

# 2. Kiến trúc tổng thể

## 2.1 Kiến trúc logic

```text
                         TELEGRAM
                            │
          ┌─────────────────┼──────────────────┐
          │                 │                  │
        Text              Image              File
          │                 │                  │
          └─────────────────┼──────────────────┘
                            ▼
                ┌───────────────────────┐
                │ OpenCode Telegram     │
                │ Gateway               │
                │                       │
                │ TypeScript / Node.js  │
                └───────────┬───────────┘
                            │
          ┌─────────────────┼──────────────────┐
          │                 │                  │
          ▼                 ▼                  ▼
   Session Manager     Content Adapter    Event Processor
          │                 │                  ▲
          │                 │                  │ SSE /global/event
          ▼                 ▼                  │
      PostgreSQL ────── OpenCode Adapter ──────┘
                              │
                              │ SDK / HTTP
                              ▼
                     ┌─────────────────┐
                     │ OpenCode Server │
                     │ 127.0.0.1:4096  │
                     └────────┬────────┘
                              │
                        selected project
                              │
                              ▼
                    CLIProxy / AI Provider
                         │          │
                         ▼          ▼
                       GPT       Claude
```

## 2.2 Kiến trúc vật lý thật (vpn4 + vpn6)

Đây mới là thứ phải code và deploy theo. Chú ý **đường đứt nét là đường duy nhất
băng qua Thái Bình Dương** — mọi thiết kế hiệu năng xoay quanh nó.

```text
   Điện thoại của bạn
          │  HTTPS long polling (Gateway chủ động gọi ra, KHÔNG webhook — QĐ-5)
          ▼
   api.telegram.org
          ▲
          │
══════════╪════════════════ vpn4 · 149.104.66.174 · Peru ════════════════════════
          │                                                                     ║
   ┌──────┴────────────────┐   HTTP nội bộ    ┌──────────────────────────────┐  ║
   │ telegram-gateway      │─────────────────▶│ opencode-server              │  ║
   │ Node 22 · mem 256 MB  │   127.0.0.1:4096 │ opencode serve · mem 512 MB  │  ║
   │ KHÔNG publish cổng    │◀─ ─ ─ ─ ─ ─ ─ ─ ─│ /global/event (SSE)          │  ║
   └──────┬────────────────┘                  └──────────────┬───────────────┘  ║
          │                                                  │                  ║
          │ mạng docker "opencode_net" (nội bộ)              │ mount ro/rw      ║
          │                                                  ▼                  ║
          │                                   /opt/opencode/workspace/<project> ║
          │                                                  │                  ║
          │                                                  │ mạng docker      ║
          │                                                  │ "edge"           ║
          │                                                  ▼                  ║
          │                                       ┌──────────────────────┐      ║
          │                                       │ cliproxy:8317        │      ║
          │                                       │ (đã chạy sẵn)        │      ║
          │                                       └──────────┬───────────┘      ║
          │                                                  ▼                  ║
          │                                        Claude / Codex upstream      ║
          │                                                                     ║
   ┌──────▼────────────────┐                                                    ║
   │ pg-tunnel (autossh)   │  127.0.0.1:5433 → SSH → vpn6:127.0.0.1:5432        ║
   │ mem 64 MB             │                                                    ║
   └──────┬────────────────┘                                                    ║
══════════╪══════════════════════════════════════════════════════════════════════
          ┆ SSH, đường công cộng, đo được 307 ms ổn định (QĐ-4)
══════════╪════════════ vpn6 · 45.119.87.220 · Việt Nam ═════════════════════════
          ▼                                                                     ║
   127.0.0.1:5432 (publish mới, CHỈ loopback)                                   ║
          │                                                                     ║
   ┌──────▼──────────────────────────────────────────┐                          ║
   │ derp-postgres (postgres:18-alpine, đã chạy sẵn) │                          ║
   │   DB derp        ← dashboard DERP (không đụng)  │                          ║
   │   DB headscale   ← control plane (không đụng)   │                          ║
   │   DB opencode_remote  ← TẠO MỚI cho dự án này   │                          ║
   └─────────────────────────────────────────────────┘                          ║
                                                                                ║
   headscale control plane cũng ở máy này → không đặt thêm tải nặng lên (QĐ-2)  ║
═════════════════════════════════════════════════════════════════════════════════
```

Ba điều rút ra từ sơ đồ này, phải phản ánh trong code:

1. **OpenCode không bao giờ được publish cổng ra host.** Nó chỉ tồn tại trong
   `opencode_net`; Gateway là thứ duy nhất gọi tới nó.
2. **Chỉ truy vấn PostgreSQL mới tốn 307 ms.** Gọi LLM, đọc file, chạy tool đều là
   nội bộ vpn4 (< 1 ms). Vì vậy tối ưu hiệu năng = giảm số câu truy vấn, không phải
   tối ưu prompt.
3. **`pg-tunnel` là điểm chết đơn (SPOF).** Nó phải có `restart: unless-stopped`,
   healthcheck, và Gateway phải xử lý được trạng thái mất DB (§41).

---

# 3. Nguyên tắc thiết kế

1. Telegram chỉ là UI/control plane.
2. OpenCode quản lý session/context/message chính.
3. PostgreSQL chỉ lưu state, mapping, audit, approval, favorites và artifact metadata.
4. Không tạo session OpenCode mới cho mỗi message.
5. Mỗi Telegram user có:
   - current project
   - current OpenCode session
   - current provider
   - current model
   - current agent
6. Danh sách model phải lấy động từ OpenCode/provider.
7. Danh sách agent phải lấy động từ OpenCode.
8. Không hard-code model list.
9. OpenCode server không expose public Internet.
10. Telegram user phải whitelist.
11. Bot không hoạt động trong group ở V1.
12. Agent activity không được spam Telegram.
13. Một task chỉ có một status message được edit realtime.
14. Output quan trọng mới tạo Telegram message mới.
15. Private chain-of-thought/reasoning không hiển thị.
16. Tool activity/status có thể hiển thị.
17. Text/Image/File phải hỗ trợ hai chiều.

---

# 4. Technology Stack

Chốt theo đúng bộ đã chạy được ở repo anh em `Whatappagent` (Node/TS + grammY + Drizzle +
Postgres + Vitest) để tái dùng kinh nghiệm và cấu hình CI, không phát minh lại:

```text
Language       TypeScript 5.7
Runtime        Node.js 22 (engines: ">=22")
Telegram       grammY ^1.32          — long polling (QĐ-5)
OpenCode       HTTP client tự viết trên fetch + kiểu sinh từ /doc (OpenAPI 3.1)
ORM            drizzle-orm ^0.45
DB driver      postgres ^3.4 (postgres.js)
Validation     zod ^3.24
Logging        pino ^9.6
Health         fastify ^5.2 (chỉ /healthz, bind 127.0.0.1)
Deployment     Docker + GitHub Actions (appleboy/ssh-action) → vpn4
Testing        vitest ^3
```

**Về SDK OpenCode:** tài liệu chính thức công bố gói `@anomalyco/opencode-sdk`, trong khi
spec gốc ghi `@opencode-ai/sdk`. Việc đầu tiên của Milestone 2 là **kiểm chứng tên gói và
phiên bản thật** rồi ghi lại vào đây. Nếu gói không ổn định, dùng `fetch` trực tiếp theo
OpenAPI tại `http://opencode:4096/doc` — API bề mặt nhỏ (§17, §18, §26, §28) nên không phụ
thuộc SDK cũng không tốn kém.

## 4.1 PostgreSQL — dùng lại, không dựng mới

Không deploy PostgreSQL mới. Dùng lại `derp-postgres` (`postgres:18-alpine`) đang chạy trên
vpn6, nhưng **tạo database và role riêng** để không đụng dữ liệu DERP/headscale:

```sql
-- Chạy một lần trên vpn6, bằng superuser "derp"
CREATE ROLE opencode LOGIN PASSWORD '<OPENCODE_PG_PASSWORD>';
CREATE DATABASE opencode_remote OWNER opencode;
REVOKE ALL ON DATABASE opencode_remote FROM PUBLIC;
-- Least-privilege: role opencode KHÔNG được đụng vào derp/headscale
REVOKE CONNECT ON DATABASE derp      FROM opencode;
REVOKE CONNECT ON DATABASE headscale FROM opencode;
```

Chuỗi kết nối đi qua tunnel (§7.11), nên host luôn là loopback của chính vpn4:

```env
DATABASE_URL=postgresql://opencode:<password>@127.0.0.1:5433/opencode_remote
```

Ràng buộc kèm theo: `/opt/dashboard-vn/backup-db.sh` trên vpn6 hiện **chỉ `pg_dump` DB
`derp`**. Phải bổ sung `opencode_remote` vào script đó, nếu không DB này không có bản sao lưu
nào (§37.4).

---

# 5. Source Code Structure

```text
opencode-telegram-remote/
│
├── src/
│   ├── index.ts
│   ├── config.ts
│   │
│   ├── bot/
│   │   ├── bot.ts
│   │   ├── middleware/
│   │   │   ├── auth.middleware.ts
│   │   │   ├── private-chat.middleware.ts
│   │   │   └── error.middleware.ts
│   │   │
│   │   ├── commands/
│   │   │   ├── start.ts
│   │   │   ├── project.ts
│   │   │   ├── session.ts
│   │   │   ├── new.ts
│   │   │   ├── model.ts
│   │   │   ├── agent.ts
│   │   │   ├── status.ts
│   │   │   ├── diff.ts
│   │   │   ├── files.ts
│   │   │   └── abort.ts
│   │   │
│   │   ├── callbacks/
│   │   │   ├── project.callback.ts
│   │   │   ├── session.callback.ts
│   │   │   ├── model.callback.ts
│   │   │   ├── agent.callback.ts
│   │   │   ├── approval.callback.ts
│   │   │   └── pagination.callback.ts
│   │   │
│   │   ├── handlers/
│   │   │   ├── text.handler.ts
│   │   │   ├── photo.handler.ts
│   │   │   ├── document.handler.ts
│   │   │   └── callback.handler.ts
│   │   │
│   │   └── ui/
│   │       ├── dashboard.ts
│   │       ├── keyboards.ts
│   │       ├── formatter.ts
│   │       └── telegram-renderer.ts
│   │
│   ├── opencode/
│   │   ├── client.ts
│   │   ├── project-client.ts
│   │   ├── provider.service.ts
│   │   ├── agent.service.ts
│   │   ├── session.service.ts
│   │   ├── prompt.service.ts
│   │   ├── permission.service.ts
│   │   ├── diff.service.ts
│   │   ├── artifact.service.ts
│   │   └── event-stream.service.ts
│   │
│   ├── services/
│   │   ├── user.service.ts
│   │   ├── user-state.service.ts
│   │   ├── project.service.ts
│   │   ├── session-mapping.service.ts
│   │   ├── task.service.ts
│   │   ├── approval.service.ts
│   │   ├── artifact.service.ts
│   │   ├── favorite-model.service.ts
│   │   └── audit.service.ts
│   │
│   ├── content/
│   │   ├── input-adapter.ts
│   │   ├── output-adapter.ts
│   │   ├── image-adapter.ts
│   │   ├── document-adapter.ts
│   │   └── mime.ts
│   │
│   ├── events/
│   │   ├── processor.ts
│   │   ├── task-status.ts
│   │   ├── event-types.ts
│   │   └── throttled-status-updater.ts
│   │
│   ├── security/
│   │   ├── authorization.ts
│   │   ├── project-sandbox.ts
│   │   └── permission-policy.ts
│   │
│   └── db/
│       ├── index.ts
│       ├── schema.ts
│       ├── repositories/
│       └── migrations/
│
├── tests/
│
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── drizzle.config.ts
├── package.json
├── tsconfig.json
└── README.md
```

---

# 6. Environment Variables

Giá trị dưới đây là **giá trị thật sẽ chạy trên vpn4**, không phải ví dụ. Chỗ nào là bí mật
thì để trống trong `.env.example` và nạp từ GitHub Secrets lúc deploy.

```env
# ─── Telegram ────────────────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=                      # secret: TELEGRAM_BOT_TOKEN
TELEGRAM_ALLOWED_USER_IDS=               # secret: TELEGRAM_ALLOWED_USER_IDS (danh sách, phân tách bằng dấu phẩy)
TELEGRAM_MODE=polling                    # QĐ-5: 443 của vpn4 đã thuộc edge-nginx/derper

# ─── PostgreSQL (derp-postgres trên vpn6, qua tunnel — §7.11) ────────────────
DATABASE_URL=postgresql://opencode:__PG_PASSWORD__@127.0.0.1:5433/opencode_remote
PG_POOL_MAX=4                            # RTT 307 ms → ít kết nối nhưng giữ ấm, đừng mở/đóng liên tục
PG_CONNECT_TIMEOUT_S=15                  # phải > 2×RTT + bắt tay TLS/SSH
PG_IDLE_TIMEOUT_S=0                      # 0 = không đóng kết nối rỗi, tránh trả giá bắt tay 307 ms
PG_STATEMENT_TIMEOUT_MS=8000

# ─── OpenCode server (cùng máy vpn4, mạng docker opencode_net) ───────────────
OPENCODE_URL=http://opencode:4096        # KHÔNG publish ra host (§34)
OPENCODE_SERVER_PASSWORD=                # secret: OPENCODE_SERVER_PASSWORD — basic auth của opencode serve
OPENCODE_EVENT_PATH=/global/event        # SSE — đúng theo tài liệu, không phải /event
OPENCODE_HEALTH_PATH=/global/health

# ─── Model mặc định ──────────────────────────────────────────────────────────
DEFAULT_PROVIDER=cliproxy
DEFAULT_MODEL=claude-opus-5              # model DUY NHẤT đã kiểm chứng gọi thật được qua cliproxy
DEFAULT_AGENT=build

# ─── Workspace (V1 chỉ 1 project — QĐ-6) ─────────────────────────────────────
WORKSPACE_ROOT=/workspace
DEFAULT_PROJECT_NAME=TelegramAgent
DEFAULT_PROJECT_PATH=/workspace/TelegramAgent

# ─── Giới hạn ────────────────────────────────────────────────────────────────
MAX_INPUT_ATTACHMENT_MB=10
MAX_PROMPT_BODY_MB=8                     # chặn từ phía ta, vì body khổng lồ từng làm OOM cliproxy (§0.4)

# ─── Telegram UI ─────────────────────────────────────────────────────────────
MODEL_PAGE_SIZE=8
SESSION_PAGE_SIZE=8
PROJECT_PAGE_SIZE=8

# ─── Runtime ─────────────────────────────────────────────────────────────────
LOG_LEVEL=info
NODE_ENV=production
HEALTH_PORT=8790                         # bind 127.0.0.1; 8788 đã dành cho WhatsApp agent
```

## 6.1 Bảng secret cần tạo trong repo

| GitHub Secret | Dùng ở đâu | Ghi chú |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Gateway | Lấy từ @BotFather. Lộ = đổi token ngay |
| `TELEGRAM_ALLOWED_USER_IDS` | Gateway | Không hardcode vào repo public |
| `OPENCODE_PG_PASSWORD` | Gateway + lệnh tạo role trên vpn6 | Role `opencode`, không dùng lại mật khẩu của `derp` |
| `OPENCODE_SERVER_PASSWORD` | opencode-server + Gateway | Basic auth nội bộ giữa 2 container |
| `CLIPROXY_API_KEY` | opencode-server | **Đã tồn tại** ở repo `deployHeadscale` — copy sang repo này |
| `SSH_HOST_VPN4`, `SSH_USER`, `SSH_KEY`, `SSH_PORT` | Workflow deploy | Cùng bộ với các stack vpn4 khác |
| `SSH_HOST_VPN6`, `SSH_KEY_VPN6` | Workflow tạo DB + khoá tunnel | Dùng cho bước một lần trên vpn6 |
| `PG_TUNNEL_KEY` | Container `pg-tunnel` | Khoá SSH **riêng**, chỉ dùng cho tunnel, gắn `command=`/`permitopen=` (§7.11) |

Mọi bí mật nạp từ biến môi trường. Không commit `.env`. Repo này là **public** — CI phải có
bước quét secret trước khi merge (§37.3).

---

# 7. PostgreSQL Data Model

Toàn bộ schema dưới đây nằm trong DB **`opencode_remote`** trên `derp-postgres` (vpn6,
PostgreSQL **18.4**), thuộc sở hữu role `opencode` (§4.1). Không tạo bảng nào trong DB `derp`
hay `headscale`.

Vì mỗi truy vấn tốn **307 ms** (§0.3), schema này phải đọc bằng **ít câu truy vấn**, không phải
bằng nhiều câu nhỏ. Quy tắc truy cập bắt buộc nằm ở §7.10 — đọc trước khi viết repository.

## 7.1 telegram_users

```sql
CREATE TABLE telegram_users (
    id BIGSERIAL PRIMARY KEY,
    telegram_user_id BIGINT NOT NULL UNIQUE,
    telegram_username VARCHAR(255),
    display_name VARCHAR(255),
    role VARCHAR(30) NOT NULL DEFAULT 'user',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 7.2 projects

```sql
CREATE TABLE projects (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    project_path TEXT NOT NULL UNIQUE,
    description TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Project paths must be registered by admin.

Never allow arbitrary Telegram path input.

---

## 7.3 user_state

```sql
CREATE TABLE user_state (
    telegram_user_id BIGINT PRIMARY KEY,
    current_project_id BIGINT REFERENCES projects(id),
    current_session_id VARCHAR(255),
    current_provider_id VARCHAR(255),
    current_model_id VARCHAR(255),
    current_agent VARCHAR(255),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 7.4 opencode_sessions

```sql
CREATE TABLE opencode_sessions (
    id BIGSERIAL PRIMARY KEY,
    telegram_user_id BIGINT NOT NULL,
    project_id BIGINT REFERENCES projects(id),
    opencode_session_id VARCHAR(255) NOT NULL UNIQUE,
    title TEXT,
    provider_id VARCHAR(255),
    model_id VARCHAR(255),
    agent VARCHAR(255),
    status VARCHAR(30) NOT NULL DEFAULT 'idle',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_opencode_sessions_user
ON opencode_sessions(telegram_user_id);

CREATE INDEX idx_opencode_sessions_project
ON opencode_sessions(project_id);
```

---

## 7.5 tasks

```sql
CREATE TABLE tasks (
    id BIGSERIAL PRIMARY KEY,
    telegram_user_id BIGINT NOT NULL,
    session_id VARCHAR(255) NOT NULL,
    telegram_input_message_id BIGINT,
    telegram_status_message_id BIGINT,
    opencode_message_id VARCHAR(255),
    status VARCHAR(30) NOT NULL DEFAULT 'queued',
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tasks_session
ON tasks(session_id);

CREATE INDEX idx_tasks_status
ON tasks(status);
```

Task statuses:

```text
queued
running
waiting_permission
completed
failed
aborted
```

---

## 7.6 approvals

```sql
CREATE TABLE approvals (
    id BIGSERIAL PRIMARY KEY,
    telegram_user_id BIGINT NOT NULL,
    session_id VARCHAR(255) NOT NULL,
    permission_id VARCHAR(255) NOT NULL,
    tool_name VARCHAR(255),
    action_type VARCHAR(100),
    payload JSONB,
    status VARCHAR(30) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_approvals_status
ON approvals(status);

CREATE INDEX idx_approvals_permission
ON approvals(permission_id);
```

Approval statuses:

```text
pending
approved
rejected
expired
```

---

## 7.7 artifacts

```sql
CREATE TABLE artifacts (
    id BIGSERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    opencode_message_id VARCHAR(255),
    filename TEXT,
    mime_type VARCHAR(255),
    source_type VARCHAR(50),
    path_or_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_artifacts_session
ON artifacts(session_id);
```

---

## 7.8 user_model_favorites

```sql
CREATE TABLE user_model_favorites (
    id BIGSERIAL PRIMARY KEY,
    telegram_user_id BIGINT NOT NULL,
    provider_id VARCHAR(255) NOT NULL,
    model_id VARCHAR(255) NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (telegram_user_id, provider_id, model_id)
);
```

---

## 7.9 audit_logs

```sql
CREATE TABLE audit_logs (
    id BIGSERIAL PRIMARY KEY,
    telegram_user_id BIGINT,
    session_id VARCHAR(255),
    action VARCHAR(100) NOT NULL,
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_session
ON audit_logs(session_id);

CREATE INDEX idx_audit_user
ON audit_logs(telegram_user_id);
```

Do NOT store entire AI conversation in PostgreSQL.

---

## 7.10 Quy tắc truy cập DB dưới độ trễ 307 ms

Đây là phần thay đổi lớn nhất so với spec gốc. Spec gốc ngầm định DB ở localhost nên truy vấn
là "miễn phí". Thực tế mỗi round-trip tốn **307 ms**, nên một luồng viết ngây thơ (đọc user →
đọc state → đọc project → đọc session → ghi task → ghi audit = 6 round-trip) sẽ mất **~1.8 giây**
trước khi Telegram kịp hiện chữ "Working...".

**Ngân sách bắt buộc: ≤ 2 round-trip DB cho mỗi thao tác Telegram (≤ 0.7 giây).**

Bốn kỹ thuật, áp dụng theo đúng thứ tự này:

**1. Cache ghi xuyên (write-through) trong bộ nhớ cho dữ liệu nóng**

`telegram_users`, `projects`, `user_state` cộng lại chỉ vài chục dòng (V1 có 1 project, vài
người dùng). Nạp toàn bộ vào bộ nhớ lúc khởi động, phục vụ đọc từ RAM, ghi thì cập nhật RAM
**và** đẩy xuống DB. Dữ liệu này chỉ đổi khi chính bot đổi nó — không có tiến trình nào khác
ghi vào — nên cache không bao giờ lệch.

```typescript
// Đọc: 0 round-trip. Ghi: 1 round-trip, không chặn phản hồi Telegram.
class UserStateCache {
  private cache = new Map<bigint, UserState>();
  get(userId: bigint): UserState | undefined { return this.cache.get(userId); }
  async set(userId: bigint, patch: Partial<UserState>): Promise<void> {
    const next = { ...this.cache.get(userId)!, ...patch };
    this.cache.set(userId, next);          // UI phản hồi ngay từ đây
    await this.repo.upsert(userId, patch); // bền hoá sau
  }
}
```

**2. Gộp một round-trip thay vì nhiều câu lẻ**

Khi buộc phải chạm DB, gộp bằng CTE/`json_build_object` trong **một** câu:

```sql
-- 1 round-trip lấy đủ mọi thứ cần cho một prompt, thay cho 4 câu SELECT
WITH st AS (SELECT * FROM user_state WHERE telegram_user_id = $1)
SELECT json_build_object(
  'state',   (SELECT row_to_json(st) FROM st),
  'project', (SELECT row_to_json(p) FROM projects p
              WHERE p.id = (SELECT current_project_id FROM st)),
  'session', (SELECT row_to_json(s) FROM opencode_sessions s
              WHERE s.opencode_session_id = (SELECT current_session_id FROM st)),
  'running', (SELECT count(*) FROM tasks t
              WHERE t.session_id = (SELECT current_session_id FROM st)
                AND t.status IN ('queued','running','waiting_permission'))
) AS bundle;
```

**3. Ghi bất đồng bộ theo lô cho dữ liệu không chặn người dùng**

`audit_logs` và `artifacts` không ai chờ. Đẩy vào hàng đợi trong bộ nhớ, flush theo lô
(≥ 50 dòng hoặc mỗi 2 giây) bằng một câu `INSERT ... VALUES (...),(...)`. Khi tắt tiến trình
phải flush nốt hàng đợi (`SIGTERM` handler). Mất vài dòng audit khi máy sập là chấp nhận được;
làm chậm phản hồi Telegram thì không.

**4. Không ghi DB theo từng sự kiện SSE**

Một task OpenCode sinh hàng trăm sự kiện. Bộ đếm tiến độ (`TaskProgress` ở §20) sống **hoàn
toàn trong bộ nhớ**. DB chỉ được ghi tại các mốc chuyển trạng thái: `queued → running →
waiting_permission → completed/failed/aborted`. Tối đa 4 lần ghi cho một task, thay vì hàng trăm.

**Hệ quả bắt buộc với `tasks`:** vì tiến độ nằm trong RAM, Gateway khởi động lại giữa chừng sẽ
để lại task treo ở trạng thái `running`. Lúc khởi động phải chạy bước **hoà giải**: mọi task
`running`/`queued`/`waiting_permission` cũ hơn 10 phút → hỏi lại OpenCode trạng thái thật, không
biết thì đánh dấu `failed` kèm `error_message = 'gateway restart, trạng thái không xác định'`
(liên quan AC-17).

---

## 7.11 Đường kết nối tới PostgreSQL: SSH tunnel

Gateway ở vpn4 (Peru), DB ở vpn6 (Việt Nam), và `derp-postgres` **không publish cổng nào**.
Ba cách nối, chọn cách 1:

| Cách | Độ trễ đo được | Việc phải làm trên vpn6 | Rủi ro |
|---|---|---|---|
| **1. SSH tunnel (CHỌN)** | 307 ms, ổn định ±0.1 ms | Publish `127.0.0.1:5432` + thêm 1 user SSH hạn chế | Thấp — không đụng headscale, huỷ bỏ dễ |
| 2. Qua tailnet | 312–627 ms, jitter lớn | Gắn `ts-vpn6` vào `dashnet` + `tailscale serve --tcp` | Chạm vào node tailnet của control plane |
| 3. Mở Postgres ra Internet + TLS | 307 ms | Publish `0.0.0.0:5432`, cấu hình cert, iptables allowlist | Cao — DB lộ ra Internet |

Cách 2 vừa chậm hơn vừa nguy hiểm hơn, nên bị loại bằng số đo chứ không phải bằng cảm tính.

**Bước một lần trên vpn6:**

```bash
# 1. Cho phép loopback của vpn6 nói chuyện với Postgres (KHÔNG mở ra 0.0.0.0)
#    Thêm vào service postgres trong /opt/dashboard-vn/docker-compose.yml:
#      ports: ['127.0.0.1:5432:5432']
docker compose -f /opt/dashboard-vn/docker-compose.yml up -d postgres

# 2. Tài khoản SSH chuyên dụng, không shell, chỉ được forward đúng cổng Postgres
adduser --system --shell /usr/sbin/nologin --home /home/pgtunnel pgtunnel
install -d -m 700 -o pgtunnel /home/pgtunnel/.ssh
# authorized_keys — khoá riêng của tunnel, KHÔNG dùng lại khoá deploy:
# restrict,permitopen="127.0.0.1:5432",command="/bin/false" ssh-ed25519 AAAA... pg-tunnel
```

`restrict` + `permitopen` + `command="/bin/false"` nghĩa là khoá này **chỉ** mở được đúng một
cổng chuyển tiếp, không mở được shell, không chạy được lệnh. Khoá rò rỉ cũng không thành RCE.

**Container `pg-tunnel` trên vpn4** (dịch vụ trong compose của dự án này):

```yaml
pg-tunnel:
  image: ghcr.io/vanbienperu3107/pg-tunnel:stable   # alpine + autossh
  container_name: opencode-pg-tunnel
  restart: unless-stopped
  mem_limit: 64m
  command: >
    autossh -M 0 -N
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3
    -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=yes
    -o UserKnownHostsFile=/keys/known_hosts
    -i /keys/pg_tunnel_key
    -L 0.0.0.0:5433:127.0.0.1:5432
    pgtunnel@45.119.87.220
  networks: [opencode_net]
  healthcheck:
    test: ["CMD", "nc", "-z", "127.0.0.1", "5433"]
    interval: 30s
    timeout: 5s
    retries: 3
  logging:
    driver: json-file
    options: { max-size: "10m", max-file: "3" }
```

Ghi chú kỹ thuật:

- `ServerAliveInterval=15` + `ServerAliveCountMax=3` → phát hiện đứt kết nối trong ~45 giây.
  Không có nó, TCP treo có thể giữ tunnel "sống giả" hàng chục phút.
- `ExitOnForwardFailure=yes` → tunnel không mở được cổng thì thoát để `autossh` dựng lại, thay
  vì chạy tiếp mà không forward gì.
- `StrictHostKeyChecking=yes` + `known_hosts` cố định → chống MITM trên đường công cộng.
- Gateway trỏ `DATABASE_URL` tới `pg-tunnel:5433` (tên service trong `opencode_net`), không
  phải `127.0.0.1` của container Gateway.

**Khi tunnel chết:** Gateway không được sập theo. Nó phải trả lời Telegram bằng
`❌ Mất kết nối cơ sở dữ liệu, đang thử lại...`, thử lại có backoff, và **vẫn cho phép** người
dùng bấm Abort (đường này chỉ cần OpenCode, không cần DB).

---

# 8. Telegram Authorization

V1 must only support private Telegram chats.

Validation order:

```text
incoming update
    ↓
is private chat?
    ↓ no → ignore/reject
telegram user id whitelisted?
    ↓ no → Unauthorized
telegram_users.enabled?
    ↓ no → Unauthorized
process request
```

Whitelist source:

```env
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
```

Database may be used as an additional enabled/disabled layer.

---

# 9. Telegram Dashboard

Command:

```text
/start
```

Expected UI:

```text
🤖 OpenCode Remote

📁 Project
MPS

💬 Session
Fix Oracle connection leak

🧠 Model
cliproxy/gpt-5.6-sol

🤖 Agent
build

🟢 Ready
```

Buttons:

```text
[ 📁 Project ] [ 💬 Session ]
[ 🧠 Model   ] [ 🤖 Agent   ]
[ 📑 Diff    ] [ 📎 Files   ]
[ 📊 Status  ] [ 🛑 Abort   ]
[ ➕ New     ] [ ⚙️ More    ]
```

Dashboard must always show current state.

---

# 10. Project Selection

Command:

```text
/project
```

Load enabled projects from PostgreSQL.

Example (minh hoạ giao diện khi có nhiều project):

```text
📁 Select Project

[ MPS          ]
[ Provisioning ]
[ DCB          ]
[ Monitoring   ]
```

**V1 thực tế chỉ có đúng một dòng** — `TelegramAgent` (QĐ-6, §33.1). Vẫn phải viết luồng chọn
project cho tổng quát: thêm project thứ hai là `git clone` + một dòng `INSERT`, không sửa code.

On selection:

1. Validate project exists.
2. Validate enabled.
3. Validate project path is within configured workspace root if such root is used.
4. Save `user_state.current_project_id`.
5. Do not automatically destroy existing sessions.
6. Show sessions for selected project or offer New Session.

---

# 11. Session Management

Commands:

```text
/session
/sessions
/new
```

Functions required:

- create OpenCode session
- list sessions mapped to current Telegram user/project
- select session
- continue existing session
- display title/model/agent/status
- abort running session

Session selection UI:

```text
💬 Sessions — MPS

[ Fix Oracle leak        ]
[ Refactor SMS sender    ]
[ Analyze timeout        ]

[ ➕ New Session ]
[ ◀ Back ]
```

When selecting an existing session:

```text
current_session_id = selected OpenCode session id
```

Context must remain in OpenCode.

---

# 12. Dynamic Model Selection

Command:

```text
/model
```

Requirements:

- Retrieve providers dynamically from OpenCode.
- Retrieve models dynamically.
- Never hard-code model list.
- Support pagination.
- Support favorites.
- Store selected provider/model in `user_state`.
- Also persist selected model metadata in session mapping.

## 12.1 Model đến từ đâu trong thực tế

Đây là chỗ spec gốc lệch với thực tế và **phải hiểu đúng, nếu không sẽ code sai**.

CLIProxyAPI là provider kiểu "OpenAI-compatible". Với loại provider này, OpenCode **không tự dò**
danh sách model — nó đọc từ khối `provider` trong `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "cliproxy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "CLIProxy (vpn4)",
      "options": {
        "baseURL": "http://cliproxy:8317/v1",       // mạng docker nội bộ, không ra Internet
        "apiKey": "{env:CLIPROXY_API_KEY}"
      },
      "models": {
        "claude-opus-5": { "name": "Claude Opus 5" }
        // ... phần còn lại do bước đồng bộ lúc deploy sinh ra
      }
    }
  }
}
```

Vậy chuỗi thật là:

```text
cliproxy GET /v1/models  ──(bước đồng bộ lúc deploy)──▶  opencode.json
                                                              │
                                              OpenCode đọc cấu hình
                                                              │
                                         Gateway hỏi OpenCode ─┴─▶ Telegram /model
```

Quy tắc "không hard-code model" **vẫn giữ nguyên** với Gateway: Gateway tuyệt đối không được
chứa danh sách model trong mã nguồn, nó luôn hỏi OpenCode. Nhưng phải bổ sung một mắt xích:

- **Bước đồng bộ model lúc deploy (bắt buộc):** workflow gọi
  `GET /v1/models` trên cliproxy → sinh khối `models` trong `opencode.json` → khởi động lại
  container `opencode-server`. Thêm model mới vào CLIProxy thì chạy lại workflow, **không sửa
  code Gateway** (đúng tinh thần AC-05).
- **Kiểm chứng đã có:** hiện chỉ có 2 credential (Claude + Codex). Model duy nhất đã được gọi
  thật thành công là `claude-opus-5`. Danh sách đầy đủ chỉ biết chính xác khi chạy bước đồng bộ.
- **Khi CLIProxy hết quota một credential**, nó tự xoay sang credential khác
  (`quota-exceeded.switch-project: true`). Gateway không cần xử lý gì, nhưng lỗi 429/403 kéo dài
  phải hiện ra Telegram bằng thông điệp rõ ràng chứ không nuốt lặng.

Initial UI:

```text
🧠 Select Model

⭐ Favorites

[ GPT-5.6 Sol       ✓ ]
[ Claude Opus 4.8     ]
[ Claude Sonnet 5     ]
[ GPT-5.4 Mini        ]

[ 🔍 All Models ]
[ 🏢 Providers  ]
[ ◀ Back ]
```

Pagination example:

```text
🧠 CLIProxy Models
Page 2 / 4

[ Model A ]
[ Model B ]
[ Model C ]
...

[ ◀ Previous ] [ 2/4 ] [ Next ▶ ]
```

Callback data must use compact IDs because Telegram callback payload size is limited.

Do not put large model metadata directly in callback data.

Use a lookup key if necessary.

---

# 13. Agent Selection

Command:

```text
/agent
```

Load available agents dynamically from OpenCode.

Example:

```text
🤖 Select Agent

[ build  ✓ ]
[ plan     ]
[ review   ]
[ test     ]

[ ◀ Back ]
```

Save:

```text
user_state.current_agent
```

The next prompt uses selected agent.

---

# 14. Text Prompt Flow

Input:

```text
kiểm tra lỗi connection Oracle và sửa giúp tôi
```

Flow:

```text
Telegram text
    ↓
authorize
    ↓
load user state
    ↓
validate current project
    ↓
validate current session
    ↓
validate provider/model/agent
    ↓
create task row
    ↓
send immediate Telegram status message
    ↓
send prompt to OpenCode asynchronously
    ↓
listen via SSE
    ↓
update status message
    ↓
send final result
```

Do not block Telegram request until OpenCode completes.

---

# 15. Image Input Flow

Telegram photo + optional caption:

```text
[screenshot.png]

"xem lỗi này giúp tôi"
```

Flow:

```text
Telegram photo
    ↓
Telegram getFile
    ↓
download image
    ↓
validate size
    ↓
detect MIME
    ↓
convert to OpenCode-compatible FilePart
    ↓
combine TextPart + FilePart
    ↓
send async prompt
```

Conceptual OpenCode parts:

```json
[
  {
    "type": "text",
    "text": "xem lỗi này giúp tôi"
  },
  {
    "type": "file",
    "mime": "image/png",
    "filename": "screenshot.png",
    "url": "data:image/png;base64,..."
  }
]
```

V1 attachment max:

```text
10 MB
```

If over limit:

```text
❌ File too large.
Maximum supported input attachment: 10 MB.
```

---

# 16. Generic File Input Flow

Support at minimum:

```text
.txt
.log
.md
.json
.xml
.yaml
.yml
.csv
.png
.jpg
.jpeg
.webp
.pdf
```

For unsupported types:

- optionally save to controlled project temp directory
- attach/reference only if OpenCode/model/tool supports it
- otherwise return a clear error

Never write Telegram attachments outside the selected project/temp sandbox.

---

# 17. OpenCode Async Prompt

## 17.1 Bề mặt API thật (đối chiếu tài liệu OpenCode 2026-08-13)

| Việc | Method | Đường dẫn |
|---|---|---|
| Kiểm tra sống | `GET` | `/global/health` |
| Tạo session | `POST` | `/session` |
| Gửi prompt đồng bộ | `POST` | `/session/:id/message` |
| **Gửi prompt bất đồng bộ** | `POST` | `/session/:id/prompt_async` |
| **Luồng sự kiện SSE** | `GET` | `/global/event` |
| Huỷ task | `POST` | `/session/:id/abort` |
| Trả lời xin quyền | `POST` | `/session/:id/permissions/:permissionID` |
| Đặc tả OpenAPI 3.1 | `GET` | `/doc` |

Hai chỗ spec gốc ghi sai, **phải dùng bản trên**: SSE là `/global/event` (không phải `/event`),
và health là `/global/health`.

Máy chủ chạy bằng `opencode serve --port 4096 --hostname 0.0.0.0` **bên trong container**
(0.0.0.0 ở đây là trong không gian mạng riêng của container, không publish ra host — §34), bảo
vệ bằng basic auth qua biến `OPENCODE_SERVER_PASSWORD`.

**Việc đầu tiên của Milestone 2:** gọi `GET /doc`, lưu bản OpenAPI vào `docs/opencode-openapi.json`
và sinh kiểu TypeScript từ đó. Đó là nguồn chân lý, không phải mục này — nếu lệch thì sửa mục này.

## 17.2 Nội dung prompt

Prompt must include:

```text
providerID   → "cliproxy"
modelID      → ví dụ "claude-opus-5"
agent        → ví dụ "build"
parts[]      → TextPart + FilePart (§15)
```

Do not create a new OpenCode session for each prompt.

**Chặn kích thước trước khi gửi:** body vượt `MAX_PROMPT_BODY_MB` (8 MB) thì Gateway từ chối tại
chỗ. Sự cố 2026-08-02 cho thấy OpenCode Desktop từng đẩy body 57 MB vào CLIProxy và làm nó bị
OOM-kill (§0.4). CLIProxy vẫn giới hạn 1 GB RAM, Gateway phải là lớp chặn đầu tiên.

---

# 18. SSE Event Processing

Maintain a persistent OpenCode SSE event connection tới **`GET /global/event`**.

Đây là luồng sự kiện **toàn cục** (một kết nối cho cả server, không phải một kết nối cho mỗi
session). Hệ quả với code: Event Processor phải tự lọc theo `sessionID` và tra ngược ra task
đang chạy bằng bảng tra trong bộ nhớ — không được mở một kết nối SSE cho mỗi phiên.

Kết nối này nằm hoàn toàn trong vpn4 (Gateway → OpenCode, cùng mạng docker), nên độ trễ ~0 ms và
**không được dùng nó làm cớ để ghi DB theo từng sự kiện** — xem §7.10 quy tắc 4.

Event Processor responsibilities:

- map OpenCode event → session
- map session → Telegram task
- update task status
- update one Telegram status message
- detect permission request
- detect output text
- detect file/image artifact
- detect diff/file edit
- detect completion
- detect error
- detect abort

Do not send a Telegram message for every event.

---

# 19. Status Message Strategy

When task starts:

```text
🤖 Working...

📁 MPS
💬 Fix Oracle connection leak
🧠 GPT-5.6 Sol
🤖 build

🔍 Starting...

Files read: 0
Files changed: 0
Tools: 0

[ 🛑 Abort ]
```

Update the SAME Telegram message.

Possible later update:

```text
🤖 Working...

🔧 Modifying source

Files read: 14
Files changed: 2
Commands: 5

Last:
🧪 Running unit tests

[ 📑 Diff ] [ 🛑 Abort ]
```

Throttle edits.

Recommended:

```text
maximum one Telegram status edit every 1–2 seconds
```

Avoid Telegram flood/rate-limit issues.

---

# 20. Event Aggregation

Track per task:

```typescript
interface TaskProgress {
  filesRead: number;
  filesChanged: number;
  toolCalls: number;
  commands: number;
  currentAction?: string;
  lastTool?: string;
  startedAt: Date;
}
```

Never expose hidden reasoning/private chain-of-thought.

Allowed display examples:

```text
Reading source files
Searching references
Running tests
Editing configuration
Waiting for permission
Generating artifact
```

---

# 21. Final Response Rendering

When task completes:

```text
✅ Completed

Đã xác định và sửa connection leak.

Root cause:
Connection không được close khi executeQuery()
throw SQLException.

Changed:
• OracleConnectionManager.java
• DatabaseService.java

Tests:
✅ 18 passed
❌ 0 failed

2 files changed
+31 / -14
```

Buttons:

```text
[ 📑 Diff ]
[ 📎 Files ]
[ ▶ Continue ]
[ 🧪 Test Again ]
```

If result text is too long:

1. split safely by Telegram message limit
2. or send detailed response as `.md`/`.txt`
3. keep a short summary in Telegram

---

# 22. Output Content Renderer

Create a central renderer.

Rules:

```text
text/plain
    → Telegram message

text/markdown
    → formatted Telegram text when safe
    → fallback document if too large

image/png
image/jpeg
image/webp
    → Telegram sendPhoto

application/pdf
    → Telegram sendDocument

application/zip
    → Telegram sendDocument

source code
    → code block if short
    → document if long

diff
    → summary if short
    → .diff document if long
```

Do not rely on Telegram rendering arbitrary HTML.

Escape Telegram Markdown/HTML properly.

---

# 23. OpenCode Image/File Output

When OpenCode output contains FilePart or tool attachment:

```text
mime
filename
url/path
```

Process:

```text
FilePart
   ↓
resolve content
   ↓
validate allowed source/path
   ↓
detect MIME
   ↓
Telegram output renderer
```

Image example:

```text
🖼 Architecture generated

[actual image]

architecture.png
```

For multiple images, use Telegram media group if appropriate.

---

# 24. Artifacts

Command:

```text
/files
```

Output:

```text
📎 Session Artifacts

Images

[ 🖼 architecture.png ]
[ 🖼 result.png ]

Documents

[ 📄 report.md ]
[ 📄 analysis.txt ]
[ 📦 patch.zip ]

[ ◀ Back ]
```

Artifact metadata comes from PostgreSQL but file content remains in OpenCode/project storage when possible.

Do not duplicate large binary content into PostgreSQL.

---

# 25. Diff

Command:

```text
/diff
```

Retrieve session diff from OpenCode.

Example:

```text
📑 Session Diff

3 files changed
+73 / -28

src/service/OracleService.java
+32 / -9

src/db/ConnectionManager.java
+28 / -17

config/database.yml
+13 / -2

[ 📄 Full Diff ]
```

If diff too large:

```text
send full-session.diff
```

---

# 26. Permission / Approval Flow

OpenCode permissions must not be globally auto-approved for remote Telegram usage.

Flow:

```text
OpenCode permission event
    ↓
create approvals row
    ↓
task status = waiting_permission
    ↓
Telegram approval message
    ↓
Approve / Reject callback
    ↓
verify user owns session
    ↓
POST /session/:id/permissions/:permissionID   ← đường dẫn thật, đã đối chiếu tài liệu
    ↓
update approvals row
    ↓
task continues
```

Telegram UI:

```text
⚠️ Permission Required

📁 MPS
🤖 build

Tool:
bash

Command:
docker compose restart mps

[ ✅ Approve ]
[ ❌ Reject  ]
```

---

# 27. Default Permission Policy

Recommended baseline:

```text
read          allow
grep          allow
glob          allow
search        allow

edit          allow
write         allow
apply_patch   allow

bash          ask
external      ask
```

Sensitive/destructive patterns should require explicit approval or deny:

```text
git push
git reset --hard
rm
rm -rf
sudo
systemctl
docker compose down
docker restart
kubectl delete
DROP TABLE
TRUNCATE
DELETE without safe constraints
```

Do not attempt to implement perfect shell parsing in V1.

OpenCode permission requests remain the source of truth.

Gateway is an extra safety layer.

---

# 28. Abort

Command/button:

```text
/abort
```

Flow:

```text
validate current task/session
    ↓
POST /session/:id/abort          ← đường dẫn thật, đã đối chiếu tài liệu
    ↓
task.status = aborted
    ↓
edit status message
```

Abort là đường **không phụ thuộc DB**: nó chỉ cần `session_id` (đã có trong bộ nhớ) và OpenCode
(cùng máy). Vì vậy Abort vẫn phải chạy được khi tunnel PostgreSQL đứt (§7.11) — việc ghi
`task.status = aborted` khi đó xếp vào hàng đợi, ghi sau.

Telegram:

```text
🛑 Task aborted
```

---

# 29. User State Rules

If no project selected:

```text
❌ No project selected.

[ 📁 Select Project ]
```

If no session selected:

```text
❌ No active session.

[ ➕ New Session ]
[ 💬 Select Session ]
```

If model disappeared from provider:

```text
⚠️ Selected model is no longer available.

[ 🧠 Select Model ]
```

Do not silently switch model unless explicit fallback behavior is configured.

---

# 30. Model Favorites

Favorites are UI convenience only.

Do not treat them as source of truth for available models.

Flow:

```text
OpenCode provider/model list
        +
PostgreSQL favorites
        ↓
Telegram model selector
```

If favorite model no longer exists, mark unavailable or remove lazily.

---

# 31. Logging

Use structured JSON logs with Pino.

Fields:

```text
telegram_user_id
telegram_chat_id
session_id
task_id
project_id
provider_id
model_id
agent
event_type
duration_ms
error
```

Do not log:

```text
TELEGRAM_BOT_TOKEN
OPENCODE_PASSWORD
DATABASE_URL password
authorization headers
raw secret files
```

---

# 32. Audit

Audit at least:

```text
LOGIN/START
PROJECT_SELECT
SESSION_CREATE
SESSION_SELECT
MODEL_SELECT
AGENT_SELECT
PROMPT_SEND
FILE_UPLOAD
TASK_ABORT
PERMISSION_APPROVE
PERMISSION_REJECT
DIFF_VIEW
ARTIFACT_DOWNLOAD
```

Example payload:

```json
{
  "project": "MPS",
  "model": "gpt-5.6-sol"
}
```

Do not store full prompt text by default unless explicitly required.

---

# 33. Project Sandbox

Only registered project paths may be used.

Optional root:

```env
WORKSPACE_ROOT=/workspace
```

Validation:

```text
resolved project path must start with resolved WORKSPACE_ROOT
```

Reject symlink/path traversal escape where feasible.

Uploaded temporary files:

```text
<project>/.opencode-telegram/uploads/<task-id>/
```

or another controlled temp path.

Clean temporary Telegram files after they are no longer required.

## 33.1 Workspace thật trên vpn4 (V1 — đúng 1 project, QĐ-6)

```text
Trên host vpn4          /opt/opencode/workspace/TelegramAgent
Trong container         /workspace/TelegramAgent      (mount rw)
Đăng ký trong DB        projects(name='TelegramAgent', project_path='/workspace/TelegramAgent')
Nguồn                   git clone https://github.com/vanbienperu3107/TelegramAgent.git
Dung lượng còn lại      35 GB trên vpn4 — dư sức cho một repo, nhưng phải theo dõi (§37.4)
```

Chỉ mount đúng thư mục này. **Không** mount `/`, không mount `/opt/deployHeadscale` (chứa
`cliproxy/auths` — token OAuth Claude/Codex, mất là phải đăng nhập lại toàn bộ), không mount
`/var/run/docker.sock` (cho agent quyền docker trên máy đang chạy DERP relay là mở đường tự
huỷ hạ tầng).

Về `git` trong workspace: agent được phép commit và push **lên nhánh feature**, không được push
vào `main` — đúng quy ước đang áp dụng cho mọi repo khác. Khoá deploy gắn vào workspace phải là
khoá riêng, chỉ có quyền với repo được đăng ký.

Mở rộng sang project thứ hai chỉ cần: `git clone` vào `/opt/opencode/workspace/<tên>` rồi thêm
một dòng vào bảng `projects`. Không phải sửa code, không phải deploy lại (đúng tinh thần §10).

---

# 34. OpenCode Connectivity

OpenCode chỉ tồn tại trong mạng docker riêng `opencode_net`. **Không có dòng `ports:` nào cho
service `opencode-server`** — đây là điều kiện kiểm tra được, và CI phải chặn nếu ai đó thêm vào.

```text
Trong opencode_net      http://opencode:4096       ← Gateway gọi bằng đường này
Trên host vpn4          không có gì cả             ← ss -tlnp không được thấy 4096
Từ Internet             không có gì cả
Xác thực                basic auth qua OPENCODE_SERVER_PASSWORD (kể cả trong mạng nội bộ)
```

Vì sao siết chặt đến vậy: vpn4 đang mở 3 cổng ra Internet (80, 443, 28417) và chạy DERP relay
phục vụ toàn bộ fleet. OpenCode là tiến trình **được phép chạy `bash` và sửa file** — lộ nó ra
ngoài đồng nghĩa trao shell trên máy hạ tầng cho bất kỳ ai.

Cách kiểm chứng sau khi deploy (đưa vào bước verify của workflow):

```bash
ss -tlnp | grep -c ':4096'        # phải bằng 0
docker exec opencode-gateway nc -z opencode 4096 && echo "nội bộ OK"
```

Telegram Gateway là control plane duy nhất hướng ra ngoài — và bản thân nó cũng **chủ động gọi
ra** (long polling) chứ không mở cổng nhận vào.

---

# 34.1 Nối OpenCode với CLIProxy

OpenCode gọi LLM qua mạng docker `edge` — chính mạng mà `cliproxy` đang nằm (172.23.0.3):

```yaml
# trong docker-compose.yml của dự án này
opencode-server:
  networks:
    - opencode_net   # nói chuyện với Gateway
    - edge           # nói chuyện với cliproxy (mạng đã tồn tại, external: true)
```

```text
baseURL   http://cliproxy:8317/v1
apiKey    {env:CLIPROXY_API_KEY}
```

So với việc gọi `http://149.104.66.174:28417/v1`, đường nội bộ này: không đi ra Internet, không
gửi API key qua HTTP trần, không phụ thuộc nginx/caddy-edge còn sống, và tiết kiệm một chặng
mạng cho mọi token stream về.

Bắt buộc khai `networks: edge: external: true` trong compose — mạng này do stack khác tạo, dự án
này chỉ tham gia, **không được sở hữu hay xoá** nó.

---

# 35. Deployment Model

## 35.1 Cái gì đã có, cái gì phải dựng

| Thành phần | Trạng thái thật | Việc phải làm |
|---|---|---|
| CLIProxyAPI | ✅ đang chạy trên vpn4 (v7.2.112) | Không đụng. Chỉ tham gia mạng `edge` để gọi vào |
| PostgreSQL | ✅ đang chạy trên vpn6 (`derp-postgres` 18.4) | Publish `127.0.0.1:5432`, tạo DB + role (§4.1) |
| Workspace project | ❌ chưa có | `git clone` vào `/opt/opencode/workspace/TelegramAgent` |
| **OpenCode server** | ❌ **chưa cài ở đâu cả** | Dựng image + service mới trên vpn4 |
| **Telegram Gateway** | ❌ chưa có | Toàn bộ dự án này |
| **pg-tunnel** | ❌ chưa có | Container autossh + user `pgtunnel` trên vpn6 |
| Node.js runtime | ❌ không có trên cả 2 máy | Nằm trong image Docker, không cài lên host |
| Watchtower trên vpn4 | ❌ không có (vpn6 mới có) | Deploy bằng workflow tường minh, không tự động |

Điểm dễ hiểu nhầm nhất: **OpenCode chưa từng được cài trên bất kỳ máy nào**. Sự cố OOM ngày
2026-08-02 là do OpenCode Desktop **chạy trên máy cá nhân** gọi vào CLIProxy. Dựng OpenCode
server trên vpn4 là việc mới hoàn toàn, phải tính vào kế hoạch (Milestone 0).

## 35.2 Vị trí trên đĩa (vpn4)

```text
/opt/opencode/
├── docker-compose.yml          ← từ repo TelegramAgent
├── .env                        ← workflow sinh ra từ GitHub Secrets, chmod 600
├── opencode.json               ← workflow sinh ra (khối models đồng bộ từ cliproxy, §12.1)
├── keys/
│   ├── pg_tunnel_key           ← chmod 600, khoá riêng chỉ dùng cho tunnel
│   └── known_hosts             ← ghim host key của vpn6
└── workspace/
    └── TelegramAgent/          ← project duy nhất của V1
```

Đặt ở `/opt/opencode` chứ **không** đặt trong `/opt/deployHeadscale` — hai stack tách bạch, để
`git reset --hard` của workflow deploy bên kia không bao giờ chạm được vào dữ liệu bên này.

## 35.3 Sơ đồ triển khai

```text
Internet ──▶ api.telegram.org ◀── long polling ──┐
                                                 │
┌──────────────────── vpn4 (Peru) ───────────────┼──────────────────────────┐
│                                                │                          │
│  ┌─────────────────┐   opencode_net   ┌────────┴────────┐                 │
│  │ opencode-       │◀────────────────▶│ telegram-       │                 │
│  │ server          │   4096 (nội bộ)  │ gateway         │                 │
│  │ mem 512m        │                  │ mem 256m        │                 │
│  └────────┬────────┘                  └────────┬────────┘                 │
│           │ edge (external)                    │ opencode_net             │
│           ▼                                    ▼                          │
│  ┌─────────────────┐                  ┌─────────────────┐                 │
│  │ cliproxy:8317   │                  │ pg-tunnel:5433  │                 │
│  │ (ĐÃ CHẠY SẴN)   │                  │ mem 64m         │                 │
│  └─────────────────┘                  └────────┬────────┘                 │
│                                                │                          │
│  KHÔNG ĐỤNG: derper · edge-nginx · caddy-edge · vpn-gw                    │
└────────────────────────────────────────────────┼──────────────────────────┘
                                                 │ SSH 307 ms
┌────────────────────── vpn6 (VN) ───────────────┼──────────────────────────┐
│  127.0.0.1:5432 ──▶ derp-postgres ──▶ DB opencode_remote                  │
│  KHÔNG ĐỤNG: headscale · derp-backend · pgweb · memory-stack              │
└───────────────────────────────────────────────────────────────────────────┘
```

---

# 36. Dockerfile Requirements

Dự án này cần **ba** image, không phải một:

| Image | Nội dung | Đẩy lên |
|---|---|---|
| `ghcr.io/vanbienperu3107/opencode-telegram-gateway` | Node 22 alpine + mã Gateway | GHCR, tag theo `run_number` |
| `ghcr.io/vanbienperu3107/opencode-server` | Node 22 alpine + `opencode` CLI + git + ripgrep | GHCR, tag theo phiên bản OpenCode |
| `ghcr.io/vanbienperu3107/pg-tunnel` | alpine + `autossh` + `netcat` (§7.11) | GHCR, đổi rất hiếm |

## 36.1 Gateway

Multi-stage build, `node:22-alpine`.

Runtime:

- chạy bằng user không phải root
- chỉ dependency production
- có healthcheck (`GET 127.0.0.1:${HEALTH_PORT}/healthz`)
- không copy secret nào vào image
- lệnh chạy: `node dist/index.js`

## 36.2 opencode-server

Phải cài thêm công cụ mà agent thực sự cần, nếu không mọi tool của nó đều lỗi:

```dockerfile
FROM node:22-alpine
RUN apk add --no-cache git openssh-client ripgrep bash tini
RUN npm i -g opencode-ai        # kiểm chứng tên gói + ghim version ở Milestone 0
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["opencode", "serve", "--port", "4096", "--hostname", "0.0.0.0"]
```

Ghi chú:

- **Ghim version**, không dùng `latest`. CI của repo `deployHeadscale` đã chặn `:latest` — giữ
  cùng chuẩn ở đây.
- `tini` để tiến trình con (bash tool, git) không thành zombie khi agent huỷ task giữa chừng.
- `--hostname 0.0.0.0` chỉ có nghĩa trong không gian mạng container; không có `ports:` nên vẫn
  không lộ ra host (§34).
- Cấu hình provider nằm ở `opencode.json` **mount vào** (read-only), không nướng vào image —
  vì khối `models` được sinh lại mỗi lần deploy (§12.1).

---

# 37. docker-compose.yml

**Không tạo container PostgreSQL.** Stack gồm đúng ba service, tất cả đặt tại `/opt/opencode`
trên vpn4:

```yaml
services:
  telegram-gateway:
    image: ghcr.io/vanbienperu3107/opencode-telegram-gateway:${GATEWAY_TAG:-stable}
    container_name: opencode-gateway
    restart: unless-stopped
    mem_limit: 256m
    env_file: .env
    depends_on:
      pg-tunnel: { condition: service_healthy }
      opencode-server: { condition: service_healthy }
    networks: [opencode_net]
    # KHÔNG publish cổng: bot chủ động gọi ra Telegram (long polling).
    # Healthcheck gọi nội bộ trong container nên không cần mở cổng nào.
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:'+process.env.HEALTH_PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  opencode-server:
    image: ghcr.io/vanbienperu3107/opencode-server:${OPENCODE_TAG:-pinned}
    container_name: opencode-server
    restart: unless-stopped
    mem_limit: 512m
    environment:
      OPENCODE_SERVER_PASSWORD: ${OPENCODE_SERVER_PASSWORD:?bat buoc}
      CLIPROXY_API_KEY: ${CLIPROXY_API_KEY:?bat buoc}
    volumes:
      - ./opencode.json:/home/node/.config/opencode/opencode.json:ro
      - ./workspace:/workspace                # CHỈ thư mục này (§33.1)
    working_dir: /workspace
    networks: [opencode_net, edge]            # edge = nói chuyện với cliproxy
    # KHÔNG có "ports:" — bất biến bắt buộc, CI kiểm tra (§34)
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:4096/global/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  pg-tunnel:
    # định nghĩa đầy đủ ở §7.11
    image: ghcr.io/vanbienperu3107/pg-tunnel:stable
    container_name: opencode-pg-tunnel
    restart: unless-stopped
    mem_limit: 64m
    volumes:
      - ./keys:/keys:ro
    networks: [opencode_net]
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

networks:
  opencode_net:
    driver: bridge
  edge:
    external: true        # do stack edge-vpn4 sở hữu — chỉ tham gia, KHÔNG tạo/xoá
```

Cấm tuyệt đối trong file này: mount `/`, mount `/var/run/docker.sock`, mount
`/opt/deployHeadscale`, thêm `ports:` cho `opencode-server`, bỏ `mem_limit`, bỏ `logging`.

---

# 37.1 Ngân sách RAM trên vpn4

vpn4 chỉ có **1968 MB** RAM. Đây là ràng buộc cứng nhất của cả dự án.

| Khoản | RAM |
|---|---|
| Hệ điều hành + các container đang chạy (đo được) | ~692 MB |
| `opencode-server` (giới hạn) | 512 MB |
| `telegram-gateway` (giới hạn) | 256 MB |
| `pg-tunnel` (giới hạn) | 64 MB |
| **Tổng sau khi thêm stack này** | **~1524 MB / 1968 MB** |
| Còn lại cho đỉnh tải + page cache | ~444 MB |

Cộng thêm **3915 MB swap** (hiện mới dùng 32 MB) làm lớp đệm. Swap chậm nhưng ở đây nó cứu
mạng: thà agent chạy chậm còn hơn kernel OOM-killer chọn nhầm `derper` và làm cả fleet mất
DERP relay.

Quy tắc:

1. **Không service nào của stack này được thiếu `mem_limit`.** Không đặt = mặc định lấy hết RAM
   máy = kernel có quyền giết `derper`.
2. **`derper` và `cliproxy` được ưu tiên hơn stack này.** Nếu phải hy sinh, hy sinh OpenCode.
3. **Cảnh báo khi RAM khả dụng < 300 MB** — đưa vào healthcheck/telemetry của Gateway.
4. **Đo lại sau tuần đầu.** Nếu `opencode-server` thường xuyên chạm trần 512 MB thì nâng lên
   640 MB và hạ Gateway xuống 192 MB, chứ không phải nâng tổng.

---

# 37.2 CI/CD — theo đúng khuôn đã chạy được của repo `deployHeadscale`

Không phát minh quy trình mới. Sao chép khuôn `deploy-cliproxy.yml` vì nó đã chạy ổn định trên
chính máy này.

**`.github/workflows/deploy.yml`** (`workflow_dispatch`):

```yaml
concurrency:
  # BẮT BUỘC trùng group với deploy-cliproxy / deploy-derp-vpn4 / deploy-vpn-gw:
  # cùng một host vpn4, chạy song song sẽ tranh lock dpkg/docker.
  group: deploy-vpn4-host
  cancel-in-progress: false
```

Các bước:

1. **Kiểm tra secret bắt buộc** — thiếu thì fail sớm, đừng để chết giữa chừng trên server.
2. **Build + push image** lên GHCR, tag theo `github.run_number` (khoá so sánh phiên bản đang
   dùng cho các dự án khác), đồng thời gắn `stable`.
3. **SSH vào vpn4** bằng `appleboy/ssh-action@v1.2.0` với `script_stop: true`:
   - cập nhật repo về `/opt/opencode`
   - sinh `.env` từ secrets (`chmod 600`), kiểm tra không còn placeholder
   - **đồng bộ model**: gọi `GET http://127.0.0.1:28417/v1/models` → sinh khối `models` trong
     `opencode.json` (§12.1)
   - `docker compose pull && docker compose up -d --remove-orphans`
4. **Verify** — bước này quan trọng ngang bước deploy:

```bash
ss -tlnp | grep -c ':4096' || true          # phải là 0 — OpenCode không lộ ra host
docker exec opencode-pg-tunnel nc -z 127.0.0.1 5433   # tunnel sống
docker exec opencode-gateway node -e "..." # /healthz trả 200
docker compose ps                          # cả 3 service healthy
free -m                                    # RAM khả dụng còn > 300 MB
```

**Hai cái bẫy của `appleboy/ssh-action` đã trả giá ở dự án khác — không được lặp lại:**

- **Không dùng heredoc** trong `script:`. Action chèn dòng
  `DRONE_SSH_PREV_COMMAND_EXIT_CODE=$? ; ...` sau **mỗi** dòng, dòng đó rơi thẳng vào thân
  heredoc và làm hỏng nội dung. (Dấu vết còn thấy được trong `/opt/dashboard-vn/.env` trên
  vpn6: file đó lẫn cả chuỗi `DRONE_SSH_PREV_COMMAND_EXIT_CODE`.)
- **Không dùng khối `if/else` nhiều dòng**. Sau dòng `else`, `$?` vẫn là kết quả của điều kiện
  `if` (= 1 khi sai) → script thoát 1 vô cớ và **chết im lặng, không log lỗi**. Từng làm deploy
  hỏng 5 lần liên tiếp. Viết phẳng: `[ -z "$X" ] || lệnh` và thêm `set -x`.

vpn4 **không có watchtower**, nên không có cơ chế tự cập nhật: mỗi lần đổi image đều phải chạy
workflow. Đây là chủ đích — không để một agent có quyền `bash` được tự nâng cấp chính nó.

---

# 37.3 CI kiểm tra trước khi merge

Repo `TelegramAgent` là **public**, và stack này chạy trên máy hạ tầng. CI phải chặn được các
lỗi sau, mỗi lỗi là một bài kiểm thử:

| Kiểm tra | Chặn điều gì |
|---|---|
| Quét secret trong diff (token bot `\d{8,10}:AA…`, `sk-`, `ghp_`, chuỗi kết nối Postgres) | Lộ bí mật trên repo công khai |
| `docker-compose.yml` không có `ports:` trong `opencode-server` | Lộ shell của agent ra host/Internet (§34) |
| Mọi service đều có `mem_limit` và `logging.max-size` | OOM giết `derper`; log phình như vpn6 (2.5 GB) |
| Không mount `/`, `docker.sock`, `/opt/deployHeadscale` | Agent tự huỷ hạ tầng, mất token OAuth |
| Không có tag `:latest` trong compose | Deploy không tái lập được |
| Script workflow không chứa heredoc / `if…else` nhiều dòng | Deploy chết im lặng (§37.2) |
| Unit + integration test (Vitest) | Hồi quy chức năng |

Chuẩn kiểm thử giữ nguyên như §49, chạy trên GitHub Actions.

---

# 37.4 Vận hành và rủi ro

| Rủi ro | Dấu hiệu nhận biết | Xử lý |
|---|---|---|
| Tunnel PostgreSQL đứt | `/healthz` báo `db: down`; Telegram trả lỗi DB | `autossh` tự dựng lại trong ~45 s; quá 3 phút thì kiểm tra `sshd` của vpn6 và `permitopen` |
| vpn4 hết RAM | `free -m` khả dụng < 200 MB, container bị restart | Hạ `mem_limit` của `opencode-server`; tuyệt đối không gỡ `mem_limit` của service khác |
| cliproxy hết quota | HTTP 429/403 kéo dài, task treo | Kiểm tra `auths/`, đăng nhập lại theo `deployHeadscale/cliproxy/README.md` §4 |
| Log phình đĩa | `df -h` tăng nhanh | Đã chặn bằng `max-size 10m × 3` cho mỗi service |
| **DB không được backup** | — | **Việc phải làm:** thêm `opencode_remote` vào `/opt/dashboard-vn/backup-db.sh` trên vpn6, hiện script chỉ `pg_dump` DB `derp` |
| Agent push nhầm vào `main` | — | Khoá deploy chỉ có quyền hạn chế; policy nhánh feature (§33.1) |
| Deploy đè lên nhau | Workflow treo hoặc lỗi lock | `concurrency.group: deploy-vpn4-host` đã xếp hàng cùng các stack vpn4 khác |

**Chuyển sang máy khác** (khi nào vpn4 hết chỗ): stack này chỉ phụ thuộc vào (1) mạng docker
`edge` có `cliproxy`, (2) đường SSH tới vpn6, (3) thư mục `/opt/opencode`. Chuyển máy = tạo lại
3 thứ đó rồi đổi secret `SSH_HOST_VPN4` — không có ràng buộc nào khác vào phần cứng vpn4.

---

# 38. Telegram Bot Commands

Register:

```text
/start     Dashboard
/project   Select project
/session   Select session
/new       New OpenCode session
/model     Select provider/model
/agent     Select agent
/status    Current state/task
/diff      Current session diff
/files     Session artifacts
/abort     Abort active task
/help      Help
```

---

# 39. Callback Naming

Use compact callback prefixes.

Example:

```text
p:<project-id>
s:<session-row-id>
m:<lookup-id>
a:<agent-id>
ap:y:<approval-id>
ap:n:<approval-id>
pg:m:<page>
```

Never trust callback payload directly.

Every callback must reload and validate server-side state.

---

# 40. Concurrency

V1 recommendation:

One active OpenCode task per Telegram user/session.

If user submits another prompt while session is running:

```text
⚠️ This session is currently working.

[ 🛑 Abort Current ]
[ 💬 Use Another Session ]
```

Do not silently run conflicting writes concurrently in the same project/session.

Multiple different sessions may run concurrently if OpenCode/project policy allows it.

---

# 41. Error Handling

Telegram-facing errors must be concise.

Examples:

```text
❌ OpenCode is unavailable.
```

```text
❌ PostgreSQL connection failed.
```

```text
❌ Selected session no longer exists.
```

```text
❌ Telegram attachment exceeds 10 MB.
```

```text
❌ Model is unavailable.
```

Detailed exception goes to application logs, not Telegram.

---

# 42. Reconnect Strategy

SSE connection must reconnect automatically.

Use:

```text
exponential backoff
with maximum retry delay
```

On reconnect:

- re-subscribe events
- reconcile running tasks
- query OpenCode session status where required
- do not duplicate completion messages

Task processing must be idempotent enough to handle duplicate SSE events.

---

# 43. Telegram Message Idempotency

Store:

```text
telegram_input_message_id
telegram_status_message_id
opencode_message_id
```

Avoid processing the same Telegram update twice.

Use update ID or message ID tracking if needed.

---

# 44. Security Requirements

MUST:

- whitelist Telegram users
- reject group chats
- keep OpenCode private
- use env secrets
- validate project paths
- validate callback ownership
- validate session ownership
- validate approval ownership
- cap attachment size
- sanitize Telegram formatting
- prevent arbitrary filesystem access
- never auto-approve destructive permission

SHOULD:

- rotate bot token if leaked
- use PostgreSQL least-privilege DB user
- use non-root Docker user
- retain audit logs
- configure log retention

---

# 45. V1 Scope

## 45.0 Hạ tầng (mới — phải xong trước phần chức năng)

- [ ] Publish `127.0.0.1:5432` cho `derp-postgres` trên vpn6
- [ ] Tạo DB `opencode_remote` + role `opencode` least-privilege (§4.1)
- [ ] Thêm `opencode_remote` vào `/opt/dashboard-vn/backup-db.sh`
- [ ] User `pgtunnel` + khoá SSH riêng có `permitopen` trên vpn6 (§7.11)
- [ ] Image `pg-tunnel`, tunnel sống với healthcheck
- [ ] Image `opencode-server`, `opencode serve` chạy được trên vpn4
- [ ] `opencode.json` trỏ provider `cliproxy` → `http://cliproxy:8317/v1`, gọi thật ra kết quả
- [ ] Bước đồng bộ model từ `GET /v1/models` lúc deploy (§12.1)
- [ ] `git clone` project thử nghiệm vào `/opt/opencode/workspace/TelegramAgent`
- [ ] `mem_limit` + `logging` đủ cho cả 3 service; RAM khả dụng còn > 300 MB sau khi lên
- [ ] Workflow deploy + bước verify (§37.2), `concurrency: deploy-vpn4-host`

## 45.1 Chức năng

V1 MUST include:

- [ ] Telegram `/start` dashboard
- [ ] user whitelist
- [ ] private chats only
- [ ] PostgreSQL integration
- [ ] project selector
- [ ] create session
- [ ] select session
- [ ] continue same session
- [ ] dynamic provider/model list
- [ ] model pagination
- [ ] favorite models
- [ ] dynamic agent selection
- [ ] text prompt
- [ ] image input
- [ ] file input
- [ ] async OpenCode prompt
- [ ] SSE event listener
- [ ] realtime status message editing
- [ ] final text output
- [ ] image output
- [ ] file output
- [ ] artifacts list
- [ ] session diff
- [ ] permission Approve/Reject
- [ ] abort
- [ ] audit logging
- [ ] Docker deployment
- [ ] README
- [ ] database migration scripts
- [ ] automated tests

---

# 46. Out of Scope V1

Do NOT implement unless needed for V1 completion:

```text
multi-agent supervisor
web UI
Telegram group support
voice messages
scheduled tasks
GitHub integration
CI/CD integration
multi-server OpenCode orchestration
production deployment automation
full RBAC
billing
model cost accounting
```

Design code so these can be added later.

---

# 47. Phase 2 Candidates

Future:

```text
Model Profiles

FAST
CODING
DEEP
REVIEW
```

Example profile:

```text
CODING
provider = cliproxy
model = gpt-5.6-sol
agent = build
```

Other Phase 2:

- web dashboard
- multi-agent orchestration
- task queue
- GitHub PR controls
- notifications
- per-project permission policies
- model usage/cost metrics
- search session history
- production action workflows

---

# 48. Acceptance Criteria

## AC-01 Start

Given authorized Telegram user

When:

```text
/start
```

Then dashboard displays:

- current project
- current session
- current model
- current agent
- current status

---

## AC-02 Unauthorized User

Given non-whitelisted user

When any bot command is sent

Then:

```text
⛔ Unauthorized
```

No OpenCode action occurs.

---

## AC-03 Select Project

Given enabled project `MPS`

When user selects MPS

Then:

```text
user_state.current_project_id = MPS
```

and dashboard updates.

---

## AC-04 New Session

When user selects:

```text
➕ New Session
```

Then:

- OpenCode session created
- mapping stored in PostgreSQL
- current session updated
- session is associated with selected project

---

## AC-05 Dynamic Model

When `/model` is opened

Then bot displays models currently returned by OpenCode.

Adding a model to OpenCode must not require source code changes in bot.

---

## AC-06 Switch Model

Given session A currently using model X

When model Y is selected

Then next prompt uses Y while session A/context remains unchanged.

---

## AC-07 Text Prompt

Given valid project/session/model/agent

When text is sent

Then:

- task row created
- Telegram status appears immediately
- prompt sent asynchronously to OpenCode
- same session is used
- final result appears after completion

---

## AC-08 Image Prompt

Given a Telegram screenshot < 10 MB

When user sends image + caption

Then both text and image are sent to OpenCode in the active session.

---

## AC-09 Status

During OpenCode execution

Telegram must update the same status message and must not emit one message per OpenCode event.

---

## AC-10 Permission

When OpenCode requests permission

Then Telegram displays:

```text
Approve
Reject
```

Agent must not proceed until permission is resolved.

---

## AC-11 Approval Security

A Telegram user must not be able to approve another user's session permission.

---

## AC-12 Image Output

When OpenCode returns an image artifact

Then image is visible directly in Telegram.

---

## AC-13 File Output

When OpenCode returns a document artifact

Then user can receive/download the document through Telegram.

---

## AC-14 Continue Context

Given an existing OpenCode session

When user sends a second prompt

Then same OpenCode session ID is reused.

---

## AC-15 Diff

When user requests `/diff`

Then bot returns session diff summary and full diff file if required.

---

## AC-16 Abort

Given active task

When user presses Abort

Then OpenCode execution is aborted and task state becomes:

```text
aborted
```

---

## AC-17 Restart Gateway

After Telegram Gateway restart:

- PostgreSQL state remains
- existing OpenCode session mappings remain usable
- user can continue an existing session
- task đang `running` lúc bị tắt được hoà giải theo §7.10, không kẹt vĩnh viễn ở `running`

---

## AC-18 Ngân sách độ trễ DB

Khi người dùng gửi một prompt văn bản, Gateway phải hiện tin nhắn trạng thái đầu tiên trong
**≤ 1 giây**, tương ứng **≤ 2 lượt truy vấn DB** (§7.10).

Cách đo: bật log `duration_ms` cho từng truy vấn, gửi 10 prompt, lấy p95.

---

## AC-19 OpenCode không lộ ra ngoài

Trên vpn4, sau khi deploy:

```text
ss -tlnp | grep ':4096'   → không có kết quả
```

và gọi `http://149.104.66.174:4096` từ Internet phải thất bại ở tầng kết nối.

---

## AC-20 Tunnel đứt thì suy giảm có kiểm soát

Khi dừng container `pg-tunnel`:

- Gateway **không** thoát tiến trình
- Telegram nhận thông báo lỗi DB rõ ràng, không phải stack trace
- nút **Abort** vẫn hoạt động (§28)
- tunnel sống lại thì Gateway tự phục hồi, không cần khởi động lại tay

---

## AC-21 Không đụng hạ tầng đang chạy

Sau khi deploy stack này:

- `derper`, `edge-nginx`, `caddy-edge`, `cliproxy`, `vpn-gw` trên vpn4 **không restart lần nào**
- `headscale`, `derp-postgres`, `derp-backend` trên vpn6 **không restart lần nào**
- DB `derp` và `headscale` không có bảng nào mới
- RAM khả dụng của vpn4 còn > 300 MB

---

# 49. Testing Requirements

## Unit tests

Cover:

```text
authorization
project validation
callback parsing
model pagination
Telegram escaping
MIME detection
attachment limit
permission ownership
session ownership
event aggregation
status rendering
```

---

## Integration tests

Mock Telegram + OpenCode.

Test:

```text
create session
select model
send prompt
receive SSE
permission approval
abort
image input
image output
file output
```

---

## Database tests

Test migrations and repositories against PostgreSQL test database.

Migration phải chạy **xong trước khi** bot bắt đầu polling — bài học từ dự án trước: gọi
`migrate()` sau khi mở cổng phục vụ khiến request đầu tiên đập vào schema chưa có.

## Tests riêng cho ràng buộc hạ tầng (mới)

```text
độ trễ        giả lập driver DB trễ 307 ms → khẳng định luồng prompt vẫn ≤ 2 truy vấn (AC-18)
cache         sửa user_state → đọc lại phải ra từ cache, không sinh truy vấn mới
hàng đợi ghi  100 dòng audit → gộp thành ≤ 2 câu INSERT, và flush hết khi nhận SIGTERM
mất DB        đóng kết nối giữa chừng → không thoát tiến trình, Abort vẫn chạy (AC-20)
hoà giải      task "running" cũ khi khởi động → chuyển sang trạng thái xác định (AC-17)
compose       phân tích docker-compose.yml: không "ports:" ở opencode-server, đủ mem_limit +
              logging, không mount cấm (AC-19, §37.3)
```

---

# 50. Implementation Order

Agent should implement in this order.

## Milestone 0 — Hạ tầng (MỚI, phải xong trước mọi thứ khác)

Spec gốc không có milestone này vì nó tưởng OpenCode và PostgreSQL đã sẵn sàng. Thực tế
**OpenCode chưa tồn tại** và **DB ở cách 307 ms**, nên đây là phần rủi ro cao nhất — làm trước,
sai thì biết sớm.

Thứ tự bắt buộc:

1. **Đường DB trước tiên.** Publish loopback trên vpn6 → user `pgtunnel` → image `pg-tunnel` →
   từ vpn4 chạy được `psql 'postgresql://opencode@127.0.0.1:5433/opencode_remote' -c 'SELECT 1'`.
   Đo thời gian thật của câu lệnh đó và ghi vào tài liệu — nếu không xấp xỉ 307 ms thì có gì đó
   khác với giả định.
2. **OpenCode chạy được.** Image + `opencode serve` + `opencode.json` trỏ cliproxy → gọi thử
   một prompt `claude-opus-5` và nhận được câu trả lời tiếng Việt có dấu (mượn đúng phép thử
   trong `deploy-cliproxy.yml`, nó bắt được cả lỗi OOM lẫn lỗi mojibake).
3. **Ngân sách RAM.** Cho cả stack chạy 30 phút, xem `docker stats` và `free -m`; RAM khả dụng
   phải còn > 300 MB và `derper` không được restart lần nào.

Deliverable:

```text
psql qua tunnel: SELECT 1 → OK (~307 ms)
opencode: prompt thật → trả lời đúng tiếng Việt
free -m: khả dụng > 300 MB, derper vẫn up
```

**Không viết một dòng code Telegram nào trước khi 3 dòng trên xanh.**

---

## Milestone 1 — Bootstrap

- TypeScript project
- config
- logging
- PostgreSQL
- migrations
- Telegram bot startup
- authorization middleware

Deliverable:

```text
/start works for authorized user
```

---

## Milestone 2 — OpenCode Connection

- OpenCode client
- health connectivity
- providers/models
- agents
- project-aware client handling

Deliverable:

```text
/model displays live OpenCode models
/agent displays live OpenCode agents
```

---

## Milestone 3 — Projects + Sessions

- project repository
- project selector
- session create/list/select
- user state

Deliverable:

```text
user can select project
create OpenCode session
continue session after restart
```

---

## Milestone 4 — Text Agent Execution

- async prompt
- tasks
- SSE
- progress aggregator
- Telegram status editor
- final response

Deliverable:

```text
Telegram text → OpenCode → realtime status → final result
```

---

## Milestone 5 — Image + File

- Telegram attachment downloader
- size validation
- FilePart adapter
- artifact renderer
- `/files`

Deliverable:

```text
Telegram screenshot → OpenCode
OpenCode image/file → Telegram
```

---

## Milestone 6 — Diff + Approval + Abort

- diff
- permission listener
- approval DB
- inline buttons
- abort

Deliverable:

```text
safe remote OpenCode control
```

---

## Milestone 7 — Hardening

- error handling
- SSE reconnect
- idempotency
- rate limiting/throttling
- Docker
- README
- tests

---

# 51. Definition of Done

Project is complete when:

1. Authorized user can use Telegram as OpenCode remote UI.
2. User can select project/session/model/agent.
3. Model list is dynamic.
4. Text/image/file input works.
5. Text/image/file output works.
6. Context survives between Telegram prompts.
7. Status is realtime without Telegram spam.
8. Permissions can be approved/rejected remotely.
9. Diff and artifacts can be viewed.
10. OpenCode is not publicly exposed.
11. PostgreSQL stores state/control data.
12. Gateway survives restart and session can continue.
13. Docker deployment is documented.
14. Automated tests pass.
15. Cả 3 service chạy trên vpn4 trong ngân sách RAM ở §37.1, `derper` không restart lần nào.
16. Truy vấn DB đạt ngân sách ở AC-18 dù DB cách 307 ms.
17. Tunnel PostgreSQL có healthcheck và tự phục hồi (AC-20).
18. Không hạ tầng đang chạy nào bị ảnh hưởng (AC-21).
19. DB `opencode_remote` nằm trong lịch backup của vpn6.

---

# 52. Important Agent Instructions

The implementation agent MUST follow these constraints:

1. Do not replace OpenCode session handling with a custom chat history.
2. Do not store full OpenCode conversation in PostgreSQL.
3. Do not hard-code models.
4. Do not hard-code agents.
5. Do not start a new OpenCode session for every Telegram message.
6. Do not expose OpenCode server publicly.
7. Do not allow arbitrary project paths from Telegram.
8. Do not auto-approve destructive actions.
9. Do not spam Telegram with raw SSE/tool events.
10. Do not expose private reasoning/chain-of-thought.
11. Support image/file content as a first-class feature.
12. Use async prompt + event-driven updates.
13. Make callbacks ownership-safe.
14. Make project/session mapping persistent across Gateway restart.
15. Prefer OpenCode official SDK/API rather than terminal scraping.

Bổ sung theo hạ tầng thật (vi phạm những điều dưới đây là làm hỏng hệ thống đang chạy):

16. **Coi mỗi truy vấn PostgreSQL là 307 ms.** Không viết vòng lặp gọi DB, không gọi DB trong
    trình xử lý sự kiện SSE. Tuân thủ §7.10.
17. **Không thêm `ports:` cho `opencode-server`.** Không bao giờ.
18. **Không mount `/`, `docker.sock`, hay `/opt/deployHeadscale`** vào bất kỳ container nào.
19. **Không bỏ `mem_limit` hay `logging`** của bất kỳ service nào — vpn4 chỉ có 1968 MB RAM và
    không có `daemon.json` giới hạn log.
20. **Không bật `logging-to-file` của CLIProxy** để gỡ lỗi (§0.4 — từng gây OOM).
21. **Không dùng heredoc / `if…else` nhiều dòng** trong script `appleboy/ssh-action` (§37.2).
22. **Không commit secret** — repo này công khai.
23. **Không tự ý dời sang vpn6.** vpn6 giữ headscale control plane (QĐ-2).
24. Khi thực tế lệch tài liệu, **đo lại rồi sửa §0 trước**, sửa code sau.

---

# 53. Expected User Experience

Final target flow:

```text
User opens Telegram
        ↓
/start
        ↓
📁 MPS
💬 Oracle leak
🧠 GPT-5.6 Sol
🤖 Build
        ↓
User sends screenshot
        ↓
"kiểm tra lỗi này và sửa"
        ↓
🔄 OpenCode working...
        ↓
🔍 Reading source
🔧 Modifying code
🧪 Running tests
        ↓
⚠️ Permission requested
docker restart mps

[Approve] [Reject]
        ↓
Approve
        ↓
✅ Completed

2 files changed
Tests 24/24 passed

[Diff] [Files]
        ↓
🖼 result.png
        ↓
User:
"ok sửa thêm case timeout"
        ↓
Same OpenCode session continues
```

This is the required V1 product behavior.
