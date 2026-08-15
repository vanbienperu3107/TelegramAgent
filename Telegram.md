# OpenCode Telegram Remote Gateway — Implementation Specification

> **Bản cập nhật 2026-08-13 — neo vào hạ tầng thật.**
> Spec gốc giả định OpenCode + PostgreSQL + CLIProxy nằm chung một máy (`127.0.0.1:4096`).
> Khảo sát trực tiếp vpn4 và vpn6 cho thấy điều đó không đúng: CLIProxy ở vpn4 (Peru),
> PostgreSQL ở vpn6 (Việt Nam), cách nhau **307 ms**, và **OpenCode chưa được cài ở đâu cả**.
> Các mục 0, 2, 4, 6, 7.10, 7.11, 12.1, 17, 18, 23, 26, 28, 33.1–33.3, 34–37.5, 40, 45, 46,
> 49, 50 và AC-18…AC-21 đã được viết lại theo số liệu đo được. Phần đặc tả trải nghiệm Telegram
> (mục 9–32, 38–44) giữ nguyên vì không phụ thuộc hạ tầng.
>
> **Vòng review 1 (MEDIUM) đã chạy và FAIL với 24 phát hiện; bản này là kết quả sửa.** Thay đổi
> lớn nhất: **không** publish cổng Postgres trên vpn6 nữa (§7.11.1) — cách cũ bắt buộc recreate
> `derp-postgres`, tức khởi động lại DB của headscale, vi phạm chính AC-21 của tài liệu này.

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

**Thiếu gì (đã kiểm bằng `command -v`):** không có `node`, không có `opencode`, **không có
`jq`**, **không có watchtower** (khác vpn6 — deploy phải gọi workflow tường minh), và **không có
`/etc/docker/daemon.json`** → log driver mặc định không giới hạn dung lượng.

**Có sẵn trên host vpn4 (đã kiểm bằng `command -v`):**

```text
/usr/bin/flock   /usr/bin/curl   /usr/bin/git    /usr/bin/chown
/usr/bin/diff    /usr/bin/awk    /usr/bin/python3
ss, docker (+ docker compose)
```

Trong container alpine có `getent`. **Mọi lệnh dùng trong workflow phải nằm trong danh sách này
hoặc trong image tương ứng** — §37.2 có bảng đối chiếu và §37.3 có phép kiểm tự động. Lớp lỗi
này đã tái phát 4 vòng review liên tiếp, nên nó là luật chứ không phải lời khuyên.

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
Số model          25 (ghi nhận 2026-08-02) — phải đọc lại bằng GET /v1/models lúc deploy
Secret          CLIPROXY_API_KEY (GitHub secret của repo deployHeadscale)
```

Bài học đã trả giá: **`/v1/models` trả 200 kèm 25 model KHÔNG chứng minh gọi được model nào.**
Bước verify của deploy phải gọi thật một completion — đó mới là phép thử bắt được OOM và lỗi
mã hoá UTF-8.

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
| QĐ-7 | Tunnel trỏ **thẳng vào IP container** `172.21.0.2:5432`, **không** publish cổng trên vpn6 | Thêm `ports:` bắt buộc recreate `derp-postgres` — tức khởi động lại DB của headscale. Đo được: host vpn6 có `br-352b68159731` mang `172.21.0.1/16`, `ip route get 172.21.0.2` đi thẳng qua bridge, `DOCKER-USER` rỗng → **không cần đụng gì vào stack đang chạy** |
| QĐ-8 | Agent **không build/test cục bộ**; mọi build/test đẩy lên GitHub Actions | vpn4 chỉ còn ~1275 MB; `tsc`+`vitest` dễ vượt 512 MB và bị OOM-kill giữa task. Cũng đúng luật chung của tất cả repo khác |
| QĐ-9 | Workspace V1 là **repo sandbox riêng**, không phải chính `TelegramAgent` | Để agent sửa chính mã nguồn sẽ deploy lên máy đang chạy DERP relay là vòng tự sửa đổi. Sandbox trước, đổi sau khi ổn định |
| QĐ-5 | Telegram dùng **long polling**, không webhook | Cổng 443 của vpn4 đã thuộc `edge-nginx`/derper; thêm webhook phải sửa SNI router của hạ tầng đang chạy |
| QĐ-6 | V1 chỉ đăng ký **1 project thử nghiệm** | Người dùng chốt — chạy thông end-to-end trước, mở rộng sau |

## 0.6 Ràng buộc bắt buộc (rút từ sự cố đã xảy ra trên chính hạ tầng này)

1. **Mọi service mới phải có `mem_limit`.** Tổng ngân sách cho stack này ≤ 900 MB (§37.1).
2. **Mọi service mới phải có `logging: json-file, max-size 10m, max-file 3`.** Trên vpn6
   `derp-backend` từng phình 2.5 GB log, đọc log lớn làm nghẽn Postgres và dashboard trả 500.
   vpn4 không có `daemon.json` nên phải khai báo ở từng service.
3. **Không bật `logging-to-file` của cliproxy** (§0.4).
4. **Trong script `appleboy/ssh-action`, MỌI cấu trúc trải nhiều dòng đều bị cấm** — không chỉ
   heredoc. Action chèn `DRONE_SSH_PREV_COMMAND_EXIT_CODE=$? ; …` sau **mỗi dòng**, nên bất kỳ
   cấu trúc nào chưa đóng ở cuối dòng đều bị dòng chèn rơi vào giữa và **chết im lặng**:

   ```text
   CẤM: heredoc (<<EOF)          CẤM: khối if/else nhiều dòng
   CẤM: chuỗi trích dẫn nhiều dòng ('…\n…' hoặc "…\n…")   ← lớp lỗi hay bị bỏ sót nhất
   CẤM: for/while nhiều dòng      CẤM: nối dòng bằng dấu \
   ĐƯỢC: mỗi lệnh gọn trong ĐÚNG MỘT dòng; điều kiện viết phẳng [ -z "$X" ] || lệnh
   ĐƯỢC: logic dài -> đưa vào file script trong repo, gọi bằng một dòng
   ```

5. **Mọi lệnh, biến và cú pháp trong workflow phải có bằng chứng tồn tại** (§37.3 có phép kiểm
   tự động). Ba lớp phải kiểm, không chỉ lớp đầu:
   - **tên lệnh** — đối chiếu §0.1 (kiểm kê vpn4) và §36 (spec image)
   - **biến môi trường** — mọi `$VAR` phải có trong `.env` hoặc được gán trước đó trong script
   - **hình dạng cú pháp** — theo quy tắc 4 ở trên

   Ba lớp này tương ứng ba lần lớp lỗi đã tái phát: `jq` không có trên vpn4 (tên lệnh),
   `$OPENCODE_PG_PASSWORD` không có trong `.env` (biến), `node -e '…'` 11 dòng (cú pháp).
6. **Repo `TelegramAgent` là repo PUBLIC** → không commit `.env`, không hardcode token/API key;
   CI phải có bước quét secret.
7. **Trước khi restart container đã chạy lâu ngày**, so `docker inspect` env với file `.env`
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
                     ┌──────────────────────┐
                     │ OpenCode Server      │
                     │ opencode-server:4096 │
                     │ (opencode_net)       │
                     └──────────┬───────────┘
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
   │ Node 22 · mem 256 MB  │ opencode-server: │ opencode serve · mem 512 MB  │  ║
   │                       │ 4096 (opencode_  │ KHÔNG publish cổng nào       │  ║
   │                       │ net, không lộ)   │                              │  ║
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
   ┌──────▼────────────────┐   chỉ Gateway + tunnel ở mạng db_net (§37)         ║
   │ pg-tunnel (autossh)   │   pg-tunnel:5433 → SSH → 172.21.0.2:5432           ║
   │ mem 64 MB             │   opencode-server KHÔNG được ở mạng này            ║
   └──────┬────────────────┘                                                    ║
══════════╪══════════════════════════════════════════════════════════════════════
          ┆ SSH, đường công cộng, đo được 307 ms ổn định (QĐ-4)
══════════╪════════════ vpn6 · 45.119.87.220 · Việt Nam ═════════════════════════
          ▼                                                                     ║
   sshd (user pgtunnel, permitopen 172.21.0.2:5432, không shell)                ║
          │                                                                     ║
          │ qua bridge br-352b68159731 (172.21.0.1/16) — KHÔNG publish cổng nào ║
          ▼                                                                     ║
   ┌─────────────────────────────────────────────────┐                          ║
   │ derp-postgres (postgres:18-alpine, đã chạy sẵn) │                          ║
   │   172.21.0.2:5432 — KHÔNG restart, KHÔNG sửa    │                          ║
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
OpenAPI tại `http://opencode-server:4096/doc` — API bề mặt nhỏ (§17, §18, §26, §28) nên không phụ
thuộc SDK cũng không tốn kém.

## 4.1 PostgreSQL — dùng lại, không dựng mới

Không deploy PostgreSQL mới. Dùng lại `derp-postgres` (`postgres:18-alpine`) đang chạy trên
vpn6, nhưng **tạo database và role riêng** để không đụng dữ liệu DERP/headscale:

```sql
-- Chạy một lần trên vpn6, bằng superuser "derp"
CREATE ROLE opencode LOGIN PASSWORD '<OPENCODE_PG_PASSWORD>';
CREATE DATABASE opencode_remote OWNER opencode;
REVOKE ALL ON DATABASE opencode_remote FROM PUBLIC;
```

**Nói cho đúng về mức cách ly đạt được** (đừng tin nhầm rồi ghi sai vào tài liệu):

`REVOKE CONNECT ON DATABASE derp FROM opencode` **không có tác dụng gì** — role `opencode` chưa
từng được cấp quyền trực tiếp, quyền `CONNECT` của nó đến từ `PUBLIC`. Chạy câu đó xong, role
`opencode` **vẫn kết nối được** vào `derp` và `headscale`.

Mức cách ly thật sự đang có, và nó đủ dùng:

- `opencode` **không sở hữu** bảng nào trong `derp`/`headscale`, và không được `GRANT` gì → kết
  nối vào được nhưng `SELECT` bất kỳ bảng nào đều bị từ chối.
- `opencode_remote` do `opencode` sở hữu, đã `REVOKE ALL … FROM PUBLIC` → role khác không vào được.

Muốn chặn luôn ở tầng `CONNECT` thì phải làm thế này, và **chỉ trong cửa sổ bảo trì có kế hoạch**
vì nó đụng tới quyền của dịch vụ đang chạy:

```sql
REVOKE CONNECT ON DATABASE derp      FROM PUBLIC;
GRANT  CONNECT ON DATABASE derp      TO derp;
REVOKE CONNECT ON DATABASE headscale FROM PUBLIC;
GRANT  CONNECT ON DATABASE headscale TO headscale;
```

Quên `GRANT` lại là `headscale` và `derp-backend` mất kết nối ngay lập tức. Kiểm chứng bắt buộc
sau khi chạy: `psql postgresql://opencode:…@pg-tunnel:5433/headscale -c 'select 1'` phải **fail**,
đồng thời dashboard và `headscale nodes list` phải vẫn chạy. V1 **không bắt buộc** làm bước này.

Chuỗi kết nối đi qua tunnel (§7.11), nên host là **tên service `pg-tunnel`** trong mạng
`db_net` — không phải loopback của container Gateway (§7.11.4 có bước fail-fast chặn nhầm này):

```env
DATABASE_URL=postgresql://opencode:<password>@pg-tunnel:5433/opencode_remote
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
│   ├── migrate.ts               ← chạy độc lập trong deploy (§37.2); PHẢI có backoff riêng
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
│   │   │   ├── reload.ts        ← admin: làm mới cache (§7.10)
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
├── docker/                          ← BA image, không phải một (§36)
│   ├── Dockerfile.gateway
│   ├── Dockerfile.opencode-server
│   └── Dockerfile.pg-tunnel
│
├── scripts/
│   ├── verify-opencode-config.js    ← bake vào image opencode-server tại /opt/ (§37.2 bước 5)
│   ├── sync-models.js               ← bake vào image GATEWAY tại /app/scripts/ (§36.1, §37.2 bước 4)
│   ├── gen-env.py                   ← chạy trên host vpn4 bằng python3, sinh .env (§37.2 bước 4)
│   ├── readenv.py                   ← đọc MỘT biến từ .env theo đúng luật dotenv của compose;
│   │                                  thay cho `source .env` để chỉ còn một cách hiểu file
│   └── vpn6/                        ← cài THỦ CÔNG lên vpn6 một lần (§45.0), không deploy tự động
│       ├── update-permitopen.sh     ← nhận IP, validate bằng regex
│       ├── create-opencode-db.sh    ← không nhận tham số
│       └── snapshot-vpn6.sh         ← không nhận tham số
│
├── .github/workflows/               ← BỐN workflow (§37.2)
│   ├── deploy.yml
│   ├── build-gateway.yml
│   ├── build-opencode-server.yml
│   └── build-pg-tunnel.yml
│
├── docs/                            ← artifact bắt buộc của Milestone 0
│   ├── opencode-openapi.json        ← từ GET /doc (§17.2)
│   ├── opencode-events-sample.jsonl ← luồng SSE thật (§17.2)
│   └── models-unverified.md         ← model trượt phép thử (§12.1). Bản trên vpn4 chỉ giữ trạng
│                                      thái mới nhất và bị ghi đè mỗi lần deploy, nên workflow
│                                      upload thành artifact để có LỊCH SỬ theo run (§37.2 b5d)
│
├── opencode.json.template           ← `sync-models.js` đọc file này, chèn khối models + agent,
│                                      ghi ra /opt/opencode/opencode.json (§12.1, §37.2 bước 4)
├── docker-compose.yml
├── .env.example
├── drizzle.config.ts
├── package.json
├── tsconfig.json
└── README.md
```

Ba script trong `scripts/vpn6/` **không** được deploy tự động: chúng chạy trên máy giữ headscale
và nằm trong sudoers whitelist (§6.3), nên cài bằng tay một lần ở §45.0. Đưa chúng vào đường
deploy tự động là mở lại đúng lỗ hổng mà việc siết `SSH_KEY_VPN6_B64` sinh ra để bịt.

---

# 6. Environment Variables

Giá trị dưới đây là **giá trị thật sẽ chạy trên vpn4**, không phải ví dụ. Chỗ nào là bí mật
thì để trống trong `.env.example` và nạp từ GitHub Secrets lúc deploy.

```env
# ─── Telegram ────────────────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=                      # secret: TELEGRAM_BOT_TOKEN
TELEGRAM_ALLOWED_USER_IDS=               # secret: TELEGRAM_ALLOWED_USER_IDS (danh sách, phân tách bằng dấu phẩy)
TELEGRAM_ADMIN_USER_IDS=                 # secret: tập con của danh sách trên. Được dùng cho:
                                         #   - lệnh /reload (§38)
                                         #   - người nhận cảnh báo mất DB / RAM thấp (§7.11.3)
                                         # Rỗng = không ai gọi được /reload và cảnh báo rơi vào hư không
TELEGRAM_MODE=polling                    # QĐ-5: 443 của vpn4 đã thuộc edge-nginx/derper

# ─── PostgreSQL (derp-postgres trên vpn6, qua tunnel — §7.11) ────────────────
DATABASE_URL=postgresql://opencode:__OPENCODE_PG_PASSWORD__@pg-tunnel:5433/opencode_remote
OPENCODE_PG_PASSWORD=                    # secret: OPENCODE_PG_PASSWORD — CÙNG giá trị đã nhúng
                                         # trong DATABASE_URL. Cần dưới dạng biến RỜI vì bước
                                         # verify chạy psql bằng PGPASSWORD (không truyền chuỗi
                                         # kết nối trên dòng lệnh — set -x sẽ in mật khẩu ra log
                                         # của một repo CÔNG KHAI).
                                         # Bộ ký tự [A-Za-z0-9_-] là LỚP PHÒNG THỦ THỪA, không
                                         # phải điều kiện đúng đắn: KHÔNG bước nào `source .env`
                                         # nữa (đọc bằng scripts/readenv.py — §37.2), nên .env
                                         # chỉ còn MỘT cách hiểu là cú pháp dotenv của compose.
PG_POOL_MAX=4                            # RTT 307 ms → ít kết nối nhưng giữ ấm, đừng mở/đóng liên tục
PG_CONNECT_TIMEOUT_S=15                  # phải > 2×RTT + bắt tay TLS/SSH
PG_IDLE_TIMEOUT_S=0                      # 0 = không đóng kết nối rỗi, tránh trả giá bắt tay 307 ms
PG_STATEMENT_TIMEOUT_MS=8000

# ─── OpenCode server (cùng máy vpn4, mạng docker opencode_net) ───────────────
OPENCODE_URL=http://opencode-server:4096        # KHÔNG publish ra host (§34)
OPENCODE_SERVER_PASSWORD=                # secret: OPENCODE_SERVER_PASSWORD — basic auth của opencode serve
CLIPROXY_BASE_URL=http://cliproxy:8317/v1  # đường NỘI BỘ qua mạng docker "edge" (§34.2).
                                         # KHÔNG dùng cổng công cộng 28417: đó là HTTP trần,
                                         # gửi API key qua đó là đẩy key ra khỏi máy.
CLIPROXY_API_KEY=                        # secret: CLIPROXY_API_KEY — copy từ repo deployHeadscale.
                                         # compose khai ${CLIPROXY_API_KEY:?} nên THIẾU LÀ COMPOSE DỪNG
OPENCODE_EVENT_PATH=/global/event        # SSE — đúng theo tài liệu, không phải /event
OPENCODE_HEALTH_PATH=/global/health

# ─── Model mặc định ──────────────────────────────────────────────────────────
DEFAULT_PROVIDER=cliproxy
DEFAULT_MODEL=claude-opus-5              # model DUY NHẤT đã kiểm chứng gọi thật được qua cliproxy
DEFAULT_AGENT=build

# ─── Workspace (V1 chỉ 1 project — QĐ-6 + QĐ-9) ──────────────────────────────
WORKSPACE_ROOT=/workspace
DEFAULT_PROJECT_NAME=sandbox
DEFAULT_PROJECT_PATH=/workspace/opencode-sandbox   # KHÔNG phải repo TelegramAgent (QĐ-9)

# ─── Thời hạn và trần hàng đợi (§7.6, §7.10) ─────────────────────────────────
TASK_MAX_DURATION_MIN=30                 # quá hạn → tự abort + nhả khoá 1-task
APPROVAL_TIMEOUT_MIN=10                  # quá hạn → approvals.status='expired'
AUDIT_QUEUE_MAX_ROWS=5000                # hàng đợi AUDIT — khi đầy bỏ dòng cũ nhất
AUDIT_QUEUE_MAX_BYTES=8388608            # 8 MB
CONTROL_QUEUE_MAX_ROWS=2000              # hàng đợi ĐIỀU KHIỂN — gộp theo khoá, không bao giờ bỏ
CONTROL_QUEUE_MAX_BYTES=4194304          # 4 MB; đầy thì từ chối lệnh mới, xem §7.10 kỹ thuật 3
NODE_OPTIONS=--max-old-space-size=192    # để lỗi heap đọc được thay vì OOM câm (§37.1)

# ─── Giới hạn ────────────────────────────────────────────────────────────────
MAX_PROMPT_BODY_MB=8                     # trần thân request gửi sang OpenCode. Chặn từ phía ta
                                         # vì body khổng lồ từng làm OOM cliproxy (§0.4)
MAX_INPUT_ATTACHMENT_MB=5                # = floor(MAX_PROMPT_BODY_MB / 1.37). KHÔNG đặt tuỳ ý:
                                         # base64 phình 33% + khung JSON, nên tệp 10 MB thành
                                         # thân ~13.4 MB và bị chính MAX_PROMPT_BODY_MB chặn.
                                         # Đổi một trong hai số thì phải tính lại số kia.

# ─── Telegram UI ─────────────────────────────────────────────────────────────
MODEL_PAGE_SIZE=8
SESSION_PAGE_SIZE=8
PROJECT_PAGE_SIZE=8

# ─── Runtime ─────────────────────────────────────────────────────────────────
LOG_LEVEL=info
NODE_ENV=production
HEALTH_PORT=8790                         # cổng NỘI BỘ container, không publish → chọn tuỳ ý.
                                         # compose nội suy ${HEALTH_PORT:?} trong healthcheck:
                                         # thiếu là URL thành "127.0.0.1:/healthz" (hỏng im lặng)
```

## 6.1 Hợp đồng `/healthz`

Phải chốt ở đây vì cả healthcheck của Docker lẫn bước verify của deploy đều gọi nó:

```text
Mã trạng thái   200 khi TIẾN TRÌNH Gateway còn sống — kể cả khi mất DB
                503 CHỈ khi bản thân Gateway hỏng
Thân phản hồi   { "db": "up" | "down", "ramAvailableMB": n, "uptimeS": n,
                  "auditQueue": n, "controlQueue": n }   ← độ sâu 2 hàng đợi (§7.10)
```

`ramAvailableMB` phải đọc **`MemAvailable`** từ `/proc/meminfo`, **không** dùng `os.freemem()`
của Node — hàm đó trả `MemFree`, thấp hơn nhiều vì không tính page cache, và sẽ sinh cảnh báo
giả liên tục. Ngưỡng 300 MB ở §37.1 cũng lấy theo cột *available* của `free -m`, phải cùng
đơn vị đo thì so sánh mới có nghĩa.

Vì sao 200 khi mất DB: `wget --spider` coi mọi mã ≠ 2xx là hỏng. Nếu `/healthz` trả 503 lúc DB
down thì (a) container vĩnh viễn `unhealthy`, (b) **bước verify của deploy đỏ** — đúng vào kịch
bản AC-20b mà thiết kế nói phải chấp nhận chế độ suy giảm. Trạng thái DB là **dữ liệu trong
thân phản hồi**, không phải mã HTTP. Cảnh báo admin đọc từ trường `db` này (§7.11.3).

Ngoài ra `.env` trên vpn4 còn chứa các giá trị do **workflow deploy sinh ra**, không đặt tay:

```env
PG_REMOTE_HOST=172.21.0.2                # IP container derp-postgres, đọc lại mỗi lần deploy (§7.11.3)
GATEWAY_TAG=<github.run_number>          # tag cụ thể, KHÔNG dùng "stable"/"latest"
OPENCODE_TAG=<phiên bản opencode đã ghim>   # nguồn DUY NHẤT: repo variable vars.OPENCODE_TAG
TUNNEL_TAG=<github.run_number>           # compose khai ${TUNNEL_TAG:?} — thiếu là compose dừng ngay
```

## 6.2 Bảy biến compose khai `${VAR:?}` — thiếu một là `docker compose up` dừng ngay

Đây là danh sách đóng, phải khớp **chính xác** với §37. Bước sinh `.env` trong deploy ghi đủ cả bảy:

```text
1. GATEWAY_TAG              ← workflow sinh (run_number)
2. OPENCODE_TAG             ← repo variable `vars.OPENCODE_TAG` (KHÔNG phải secret, KHÔNG phải
                              workflow sinh) — phải khớp tag mà build-opencode-server.yml đẩy lên
3. TUNNEL_TAG               ← workflow sinh (run_number)
4. PG_REMOTE_HOST           ← workflow đọc lại từ vpn6 mỗi lần deploy (§7.11.3)
5. OPENCODE_SERVER_PASSWORD ← GitHub Secret
6. CLIPROXY_API_KEY         ← GitHub Secret (copy từ repo deployHeadscale)
7. HEALTH_PORT              ← hằng số, mặc định 8790
```

Ngoài bảy biến trên, `.env` còn có các biến **không** ở dạng `${VAR:?}` nhưng **bước verify của
deploy vẫn dùng tới**, nên chúng cũng bắt buộc phải có mặt:

```text
DATABASE_URL           ← Gateway dùng
OPENCODE_PG_PASSWORD   ← bước verify dùng cho PGPASSWORD (§37.2 bước 5)
CLIPROXY_BASE_URL      ← bước 4 đọc bằng readenv.py rồi export cho docker run sync-models.js
```

Quy tắc chung: **mọi `$VAR` trong script workflow phải truy được về một nguồn GIÁ TRỊ thật**:
(1) khối **`env:`** của chính step, (2) `.env` đã được đọc **trong chính step đó**, (3) một phép
gán trước đó trong chính script.

**`envs:` của `appleboy/ssh-action` KHÔNG phải nguồn giá trị** — nó chỉ là bộ chọn tên để chuyển
tiếp sang máy xa. Một step ssh-action cần **cả hai**: `env:` để có giá trị trên runner, và `envs:`
để đẩy sang. Phép kiểm §37.3 phải kiểm **cả hai tầng**; kiểm mỗi `envs:` thì nó sẽ cho qua đúng
cái workflow làm deploy đỏ 100%.

**`.env.example` phải liệt đủ cả bảy**, kể cả bốn biến do workflow sinh (để trống, kèm chú thích
"workflow sinh"). Phép kiểm ở §37.3 so `${VAR:?}` trong compose với `.env.example`, nên biến nào
chỉ tồn tại trong `.env` thật trên vpn4 mà không có trong `.env.example` sẽ làm CI đỏ.

Dạng `${VAR:?}` là cố ý: thà dừng ngay còn hơn chạy với giá trị rỗng rồi hỏng theo kiểu khó
đoán. Nhưng nó cũng có nghĩa **quên một trong bảy biến khi sinh `.env` là deploy đỏ 100%** — nên
§37.3 có một phép kiểm tự động: mọi `${VAR:?}` trong `docker-compose.yml` phải có mặt trong
`.env.example`.

## 6.3 Bảng secret cần tạo trong repo

| GitHub Secret | Dùng ở đâu | Ghi chú |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Gateway | Lấy từ @BotFather. Lộ = đổi token ngay |
| `TELEGRAM_ALLOWED_USER_IDS` | Gateway | Không hardcode vào repo public |
| `TELEGRAM_ADMIN_USER_IDS` | Gateway | Tập con của danh sách trên. **Rỗng thì hỏng im lặng**: `/reload` không ai gọi được, cảnh báo mất DB không có người nhận (§8.1). Bước 1 của `deploy.yml` phải kiểm biến này khác rỗng |
| `OPENCODE_PG_PASSWORD` | Gateway + lệnh tạo role trên vpn6 | Role `opencode`, không dùng lại mật khẩu của `derp` |
| `OPENCODE_SERVER_PASSWORD` | opencode-server + Gateway | Basic auth nội bộ giữa 2 container |
| `CLIPROXY_API_KEY` | opencode-server | **Đã tồn tại** ở repo `deployHeadscale` — copy sang repo này |
| `SSH_HOST_VPN4`, `SSH_USER`, `SSH_KEY`, `SSH_PORT` | Workflow deploy | Cùng bộ với các stack vpn4 khác. **`SSH_USER` là `root` trên vpn4** — nói thẳng vì bước 4 cần: `install -d` trong `/opt` (thuộc root), `chown -R 1000:1000`, và `chmod` file do container `--user 0:0` tạo. Đây là bất đối xứng **có ý thức** so với vpn6: mọi stack vpn4 hiện hữu đều deploy bằng root, và khoá root vpn4 vốn đã nằm trong secret của repo `deployHeadscale`; đổi riêng stack này sang user hạn chế làm lệch khuôn mà không giảm rủi ro thật. Bù lại: `flock`, `script_stop: true`, và §37.3 quét mọi lệnh trước khi merge |
| `SSH_KEY_VPN6_B64`, `VPN6_HOST_KEY_B64`, `PG_TUNNEL_KEY_B64` | Bước 3 (runner) và bước 4 (vpn4) | **Lưu giá trị ĐÃ base64**, sinh bằng `base64 -w0 < file`. Lý do: `envs:` của ssh-action là `export NAME=VALUE` phẳng, giá trị **nhiều dòng bị cắt** — mà khoá ed25519 và output `ssh-keyscan -H` đều nhiều dòng. Base64 cũng tránh luôn bẫy `printf '%s'` thiếu newline cuối làm OpenSSH từ chối khoá |
| `SSH_USER_VPN6` | Bước 3 (runner) | User deploy trên vpn6 — **không phải** `pgtunnel` (user đó chỉ để tunnel, có `command="/bin/false"`) |
| `SSH_HOST_VPN6`, `SSH_KEY_VPN6_B64` | Workflow tạo DB + đọc lại IP container | **KHÔNG được là khoá root.** vpn6 giữ headscale của cả fleet, còn repo này PUBLIC — một PR sửa workflow được merge là đủ để lấy root. Tạo user riêng (`SSH_USER_VPN6`) với `sudoers` giới hạn **đúng 3 script, và bắt buộc `NOPASSWD`** — `ssh … sudo …` không có TTY, thiếu `NOPASSWD` là `sudo: a terminal is required to read the password` và bước 3 đỏ 100%. Dòng sudoers chính xác:<br>`<SSH_USER_VPN6> ALL=(root) NOPASSWD: /usr/local/bin/create-opencode-db.sh, /usr/local/bin/update-permitopen.sh, /usr/local/bin/snapshot-vpn6.sh`<br>Ba script không nhận tham số từ ngoài; `update-permitopen.sh` tự đọc IP, validate regex, in ra đúng một dòng `PG_REMOTE_HOST=<ip>`. **Không** cấp `docker inspect` trực tiếp: nó đã nằm bên trong `update-permitopen.sh` |
| `VPN4_HOST_KEY_B64` | Bước 5d (runner) | `ssh-keyscan -H <vpn4> \| base64 -w0`. Bước 5d dùng `scp` từ runner về, cần `known_hosts` của **vpn4** — khác hoàn toàn `VPN6_HOST_KEY_B64` |

**Ba secret bản thô đã bị thay hoàn toàn bởi bản `_B64`, đừng tạo chúng:** `SSH_KEY_VPN6`,
`PG_TUNNEL_KEY`, `VPN6_HOST_KEY`. Nội dung vẫn như mô tả cũ (khoá SSH riêng của tunnel; kết quả
`ssh-keyscan -H 45.119.87.220`), nhưng **giá trị lưu vào GitHub phải là bản base64**, vì `envs:`
của ssh-action cắt mất giá trị nhiều dòng. Bước 1 của `deploy.yml` kiểm secret theo **đúng bảng
này**, nên để sót tên cũ ở đây là làm bước 1 đỏ 100%.
| `GHCR_TOKEN` | Workflow deploy | `docker login ghcr.io` trên vpn4. Package GHCR của tài khoản cá nhân mặc định **private** → thiếu bước này thì `docker compose pull` fail |

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
    -- Khoá do ỨNG DỤNG sinh, bắt buộc: §8.2 cho phép hiện tin nhắn trạng thái trước
    -- khi hàng ghi kịp xuống DB, nên Gateway cần một định danh có ngay trong RAM.
    -- Chỉ dựa vào BIGSERIAL thì không tra ngược được task vừa tạo.
    client_task_id UUID NOT NULL UNIQUE,
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

**Ai đặt `expired`:** spec gốc khai trạng thái này mà không nói ai sinh ra nó, và không đặt thời
hạn cho task. Với ràng buộc "đúng 1 task toàn hệ thống" (§40), **một task treo là cả bot treo**.
Chốt hai mốc thời gian trong `.env`:

```env
TASK_MAX_DURATION_MIN=30       # quá hạn → tự abort + sửa status message + nhả khoá
APPROVAL_TIMEOUT_MIN=10        # quá hạn → approvals.status='expired' + task failed
```

Kịch bản đứng sau: cliproxy 429 kéo dài (§37.4 đã liệt là rủi ro có thật) làm task đứng ở
`running` vĩnh viễn; mọi prompt sau đó nhận "⚠️ Đang có một task chạy" và người dùng phải tự
đoán ra là phải bấm Abort.

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
**và** đẩy xuống DB.

Cache này lệch được trong đúng một trường hợp: **quản trị viên `INSERT` thẳng vào DB** để thêm
project (§33.1). Vì vậy phải có lệnh admin **`/reload`** làm mới cache từ DB, và §33.1 ghi rõ
"thêm project = `git clone` + `INSERT` + `/reload`". Không có `/reload` thì project mới chỉ xuất
hiện sau khi khởi động lại Gateway — mà không tài liệu nào nói phải khởi động lại.

**Ba thời điểm nạp cache, phải có đủ cả ba:**

```text
1. lúc khởi động (nếu DB sống)
2. khi admin gõ /reload
3. khi trạng thái DB chuyển down → up   ← thời điểm dễ quên nhất
```

Thiếu điểm 3 thì AC-20b đạt trên giấy mà hỏng trên máy: Gateway khởi động lúc vpn6 đang bảo trì
→ cache rỗng → 20 phút sau tunnel sống lại, `/healthz` báo `db: up`, nhưng `projects` và
`user_state` **vẫn rỗng trong RAM** → `/start` hiện "❌ No project selected", `/project` hiện
danh sách trống, và người dùng không có cách nào biết là phải nhờ admin gõ `/reload`. Dùng đúng
hàm nạp của `/reload`, gắn vào chuyển trạng thái của bộ theo dõi kết nối.

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
  -- Đếm TOÀN HỆ THỐNG, không theo session: §40 khoá 1 task cho cả máy (RAM 1968 MB).
  -- Đếm theo session là van kiểm sai phạm vi — cho phép 2 task song song ở 2 session.
  'running', (SELECT count(*) FROM tasks t
              WHERE t.status IN ('queued','running','waiting_permission'))
) AS bundle;
```

**3. Ghi bất đồng bộ theo lô cho dữ liệu không chặn người dùng**

`audit_logs` và `artifacts` không ai chờ. Đẩy vào hàng đợi trong bộ nhớ, flush theo lô
(≥ 50 dòng hoặc mỗi 2 giây) bằng một câu `INSERT ... VALUES (...),(...)`. Khi tắt tiến trình
phải flush nốt hàng đợi (`SIGTERM` handler). Mất vài dòng audit khi máy sập là chấp nhận được;
làm chậm phản hồi Telegram thì không.

**Hàng đợi phải có trần cứng.** AC-20 bắt Gateway sống tiếp khi mất DB, nghĩa là flush thất bại
liên tục mà dòng mới vẫn chảy vào:

```text
AUDIT_QUEUE_MAX_ROWS   5000
AUDIT_QUEUE_MAX_BYTES  8 MB
khi đầy                bỏ dòng CŨ NHẤT, ghi một dòng WARN gộp ("đã bỏ N dòng audit")
khi db: down           không xếp hàng payload JSONB lớn, chỉ giữ trường định danh
```

**Hàng đợi này CHỈ chứa `audit_logs` và `artifacts`.** Ghi vào `tasks`, `telegram_users`,
`user_state`, `opencode_sessions`, `approvals` là **ghi điều khiển** — chúng đi qua một hàng đợi
riêng **không bao giờ bị cắt bỏ**, chỉ thử lại có backoff:

| Loại ghi | Hàng đợi | Trần | Khi đầy / lỗi |
|---|---|---|---|
| `audit_logs`, `artifacts` | audit | 5000 dòng / 8 MB | bỏ dòng **cũ nhất** (mất audit chấp nhận được) |
| `tasks`, `telegram_users`, `user_state`, `opencode_sessions`, `approvals` | điều khiển | 2000 dòng / 4 MB | **gộp theo khoá** trước; vẫn đầy thì **từ chối thao tác mới** ở tầng Telegram |

**Hàng đợi điều khiển cũng phải có trần** — "không bao giờ bỏ" mà không có trần thì chính nó tái
lập vòng hỏng mà mục này vừa mô tả: tunnel chết lúc 2 giờ sáng → hàng đợi phình → OOM trong
cgroup 256 MB → **mất sạch**, tệ hơn hẳn việc cắt có kiểm soát.

Chính sách khi đầy khác hẳn hàng đợi audit, và khác là có lý do:

```text
1. GỘP THEO KHOÁ trước khi tính đầy — mọi ghi điều khiển đều là UPSERT idempotent:
   giữ bản mới nhất cho mỗi client_task_id / telegram_user_id / session_id.
   Một task đổi trạng thái 4 lần khi mất DB chỉ chiếm 1 chỗ, không phải 4.
2. Vẫn đầy sau khi gộp → TỪ CHỐI thao tác mới ở tầng Telegram:
   "❌ Mất kết nối cơ sở dữ liệu, tạm thời không nhận lệnh mới. Nút Abort vẫn dùng được."
   Từ chối sớm vẫn giữ được AC-20 (Abort không cần DB) và không mất dữ liệu đã nhận.
3. TUYỆT ĐỐI không bỏ dòng — mất một dòng ở đây là mất một task khỏi bảng `tasks`,
   khiến bước hoà giải lúc khởi động không thấy nó và tin nhắn trạng thái mồ côi vĩnh viễn.
```

Hai biến trần này (`CONTROL_QUEUE_MAX_ROWS`, `CONTROL_QUEUE_MAX_BYTES`) phải có trong §6, và
`/healthz` phải báo độ sâu hai hàng đợi để phát hiện sớm.

Trộn hai loại là lỗi nghiêm trọng: nếu `INSERT tasks` bị chính sách "bỏ dòng cũ nhất" nuốt mất
thì sau khi Gateway restart, bước hoà giải (§7.10) **không thấy task nào**, khoá 1-task đã mất
theo RAM, và tin nhắn "🤖 Working..." mồ côi vĩnh viễn — tức AC-17 hỏng đúng chỗ §7.10 tuyên bố
đã xử lý. Tương tự, đồng bộ `role` (§8.1) mà bị bỏ thì admin mất quyền `/reload` một cách ngẫu nhiên.

Không có trần thì kịch bản tunnel chết lúc 2 giờ sáng sẽ tích tụ hàng chục nghìn dòng trong
cgroup 256 MB → Gateway bị OOM-kill → **mất toàn bộ hàng đợi** (nhiều hơn hẳn "vài dòng" mà mục
này tuyên bố chấp nhận) → restart → kéo theo bước hoà giải task ở trên. Ba mục ghép lại thành
một vòng hỏng, nên trần này không phải chi tiết tuỳ chọn.

**4. Không ghi DB theo từng sự kiện SSE**

Một task OpenCode sinh hàng trăm sự kiện. Bộ đếm tiến độ (`TaskProgress` ở §20) sống **hoàn
toàn trong bộ nhớ**. DB chỉ được ghi tại các mốc chuyển trạng thái: `queued → running →
waiting_permission → completed/failed/aborted`. Tối đa 4 lần ghi cho một task, thay vì hàng trăm.

**Hệ quả bắt buộc với `tasks`:** vì tiến độ nằm trong RAM, Gateway khởi động lại giữa chừng sẽ
để lại task treo ở trạng thái `running`. Lúc khởi động phải chạy bước **hoà giải** cho **mọi**
task chưa kết thúc (`running`/`queued`/`waiting_permission`) — **không đặt ngưỡng tuổi**:

```text
mỗi task chưa kết thúc
    ↓
hỏi OpenCode trạng thái thật (§17.2 dòng "trạng thái session")
    ↓
còn chạy   → nhận lại quyền theo dõi, khôi phục khoá 1-task, cập nhật status message đã lưu
             (chờ SSE tái nhận tối đa 15 giây trước khi kết luận — cùng ngưỡng với §17.2)
đã xong    → đánh dấu completed/failed theo kết quả
không rõ   → POST /session/:id/abort rồi đánh dấu aborted, sửa status message
```

**Vì sao bỏ ngưỡng 10 phút:** ngưỡng đó chỉ đúng cho việc phát hiện task *đang chạy mà im lặng*.
Dùng nó lúc khởi động thì task 3 phút tuổi bị bỏ nguyên trạng `running`, trong khi khoá "1 task
toàn hệ thống" (§40) sống trong RAM và đã mất theo tiến trình. Kết quả: người dùng gửi prompt
mới → **hai task chạy song song** trên máy 1968 MB, đúng thứ §40 sinh ra để cấm. Kèm theo,
status message của task cũ treo mãi ở "🤖 Working..." vì bảng tra `sessionID → task` cũng nằm
trong RAM.

`telegram_status_message_id` đã có sẵn trong bảng `tasks` (§7.5) chính là để sửa được tin nhắn
đó sau khi khởi động lại — dùng nó, đừng để tin nhắn mồ côi (liên quan AC-17).

---

## 7.11 Đường kết nối tới PostgreSQL: SSH tunnel

Gateway ở vpn4 (Peru), DB ở vpn6 (Việt Nam), và `derp-postgres` **không publish cổng nào**.
Ba cách nối, chọn cách 1:

| Cách | Độ trễ đo được | Việc phải làm trên vpn6 | Rủi ro |
|---|---|---|---|
| **1. SSH tunnel → thẳng IP container (CHỌN)** | 307 ms, ổn định ±0.1 ms | Thêm 1 user SSH hạn chế + 3 script whitelist ở `/usr/local/bin` + sudoers; sửa `backup-db.sh`; `authorized_keys` cập nhật mỗi lần deploy. **Không sửa compose, không restart container nào** | Thấp — mọi thứ đều là thêm mới, rollback là xoá (§37.5.5) |
| 2. Qua tailnet | 312–627 ms, jitter lớn | Gắn `ts-vpn6` vào `dashnet` + `tailscale serve --tcp` | Chạm vào node tailnet của control plane |
| 3. Mở Postgres ra Internet + TLS | 307 ms | Publish `0.0.0.0:5432`, cấu hình cert, iptables allowlist | Cao — DB lộ ra Internet |

Cách 2 vừa chậm hơn vừa nguy hiểm hơn, nên bị loại bằng số đo chứ không phải bằng cảm tính.

## 7.11.1 Vì sao KHÔNG publish cổng trên vpn6

Bản kế hoạch đầu tiên định thêm `ports: ['127.0.0.1:5432:5432']` vào
`/opt/dashboard-vn/docker-compose.yml`. **Đó là sai lầm nghiêm trọng:** đổi `ports` bắt buộc
Docker **recreate container**, mà container đó là DB của `headscale` (control plane toàn fleet),
`derp-backend` và 3 `pgweb`. Nó vi phạm chính AC-21 của tài liệu này, và §0.6 quy tắc 6 đã cảnh
báo: recreate container chạy lâu ngày sẽ nạp env mới — đúng cơ chế từng làm 401 toàn bộ client.

Không cần làm vậy. Đo được trên vpn6:

```text
ip -4 -br addr show | grep 172.21   →  br-352b68159731  UP  172.21.0.1/16
ip route get 172.21.0.2             →  dev br-352b68159731 src 172.21.0.1
iptables -L DOCKER-USER -n          →  chain rỗng, không có rule chặn
```

Host vpn6 **đã có sẵn** một chân trên bridge `dashboard-vn_dashnet` và định tuyến thẳng tới
container. `sshd` chạy trên host, nên `-L …:172.21.0.2:5432` mở được ngay mà **không sửa một
dòng nào** trong stack đang chạy.

## 7.11.2 Bước một lần trên vpn6 (chỉ thêm, không sửa)

```bash
# Tài khoản SSH chuyên dụng: không shell, chỉ được forward đúng một cổng
adduser --system --shell /usr/sbin/nologin --home /home/pgtunnel pgtunnel
install -d -m 700 -o pgtunnel /home/pgtunnel/.ssh
# /home/pgtunnel/.ssh/authorized_keys — khoá riêng, KHÔNG dùng lại khoá deploy:
# restrict,port-forwarding,permitopen="172.21.0.2:5432",command="/bin/false" ssh-ed25519 AAAA... pg-tunnel
```

`restrict` + `port-forwarding` + `permitopen` + `command="/bin/false"` nghĩa là khoá này **chỉ**
mở được đúng một cổng chuyển tiếp, không mở được shell, không chạy được lệnh. Khoá rò rỉ cũng
không thành RCE.

**Không được bỏ `port-forwarding`.** Trong OpenSSH, `restrict` bật **mọi** hạn chế — bao gồm
`no-port-forwarding` — còn `permitopen` chỉ **lọc đích đến** chứ không bật lại quyền forward.
Viết `restrict,permitopen=...` mà thiếu `port-forwarding` thì sshd từ chối mở forward, `ssh` với
`ExitOnForwardFailure=yes` thoát ngay, `autossh` (`GATETIME=0`) dựng lại vô hạn mà không bao giờ
báo lỗi vĩnh viễn → tunnel **không bao giờ** lên, `pg_isready` đỏ vĩnh viễn, và triệu chứng
("ssh im lặng thoát") rất dễ bị đổ oan cho `known_hosts` hoặc IP trong `permitopen`.

Phép thử phân biệt, bắt buộc chạy ở Milestone 0 bước 1:

```bash
ssh -v -i keys/pg_tunnel_key -N -L 5433:172.21.0.2:5432 pgtunnel@45.119.87.220
# Thấy "administratively prohibited: open failed" = thiếu port-forwarding, KHÔNG phải lỗi IP.
```

Rollback: `deluser pgtunnel && rm -rf /home/pgtunnel`. Không có gì khác để hoàn tác.

**Một ẩn số chưa đo: `pg_hba.conf` của `derp-postgres`.** Kết nối tới đích đến từ `172.21.0.1`
(chân bridge của host vpn6), **không** phải từ trong `dashnet` như `derp-backend`. Nếu `pg_hba`
giới hạn theo dải container hoặc dùng `trust`/`peer`, bước 1 của Milestone 0 sẽ đỏ. Đo trước:

```bash
docker exec derp-postgres cat /var/lib/postgresql/data/pg_hba.conf
```

Ghi kết quả vào §0.2. Khi tunnel không lên, xét nguyên nhân theo đúng thứ tự này: (1) **file khoá
hỏng** (thiếu newline cuối hoặc bị `envs:` cắt — đây là nguyên nhân xác suất cao nhất, và
`ssh-keygen -y -f` ở §37.2 bắt được ngay), (2) thiếu `port-forwarding` trong `authorized_keys`,
(3) `pg_hba` không cho dải `172.21.0.1`, (4) sai IP container, (5) host key vpn6 đã đổi.

**Nhánh dự phòng nếu `pg_hba` chặn** — viết sẵn ở đây vì đây là chỗ duy nhất còn lại chưa có,
và nếu trúng thì cách khắc phục lại **chạm vào DB của headscale**:

```text
Đo được pg_hba cho phép 172.21.0.0/16 hoặc 0.0.0.0/0 với scram-sha-256
    → không phải làm gì, đi tiếp

Đo được pg_hba KHÔNG cho dải đó
    → thêm ĐÚNG MỘT dòng hẹp nhất có thể:
      host  opencode_remote  opencode  172.21.0.1/32  scram-sha-256
    → nạp lại bằng RELOAD, tuyệt đối KHÔNG restart container:
      docker exec derp-postgres psql -U derp -c "SELECT pg_reload_conf()"
    → AC-21 vẫn giữ nguyên: reload không làm RestartCount tăng
    → rollback: xoá dòng vừa thêm + reload lại (ghi vào §37.5.5)
```

Dòng thêm vào phải hẹp tới mức **một IP, một DB, một role** — không nới rộng cho tiện.

## 7.11.3 IP container có thể đổi — xử lý thế nào

`derp-postgres` **không** được ghim `ipv4_address` trong compose; IP `172.21.0.2` là do IPAM cấp
theo thứ tự khởi tạo. Nếu stack vpn6 được recreate, IP có thể đổi và tunnel sẽ chết.

Cách xử lý (không đụng vào vpn6):

1. **Bước deploy tự đọc lại IP.** Workflow vốn đã SSH vào vpn6 (bước tạo DB), nên đọc luôn —
   phải lọc **đúng tên mạng**, vì nếu container về sau được gắn thêm mạng thứ hai thì `range`
   trên toàn bộ `Networks` sẽ nối chuỗi hai IP không dấu phân tách:

   ```bash
   docker inspect derp-postgres \
     --format '{{ (index .NetworkSettings.Networks "dashboard-vn_dashnet").IPAddress }}'
   ```

   Ghi kết quả vào `.env` của vpn4 dưới dạng `PG_REMOTE_HOST`. Mỗi lần deploy là một lần tự chữa.
2. **`permitopen` phải khớp IP mới** — cập nhật `authorized_keys` trong cùng bước đó.
3. **Tunnel chết thì healthcheck bắt được trong 30 giây**, Gateway vào chế độ suy giảm (§41),
   và cách sửa là chạy lại workflow deploy.
4. **Ai biết mà chạy lại?** Cơ chế tự chữa chỉ kích hoạt khi có người bấm `workflow_dispatch`,
   nên phải có đường báo động: Gateway **tự nhắn Telegram cho admin** khi `/healthz` chuyển sang
   `db: down` quá 3 phút, kèm câu gợi ý "chạy lại `deploy.yml` để đọc lại IP". Không có bước
   này thì lỗi chỉ lộ ra lúc người dùng gõ lệnh và thấy bot báo mất DB.

## 7.11.4 Định nghĩa container `pg-tunnel`

Định nghĩa đầy đủ **chỉ nằm ở §37** (một bản duy nhất, tránh hai bản lệch nhau). Các tuỳ chọn
quan trọng và lý do:

- `ServerAliveInterval=15` + `ServerAliveCountMax=3` → phát hiện đứt kết nối trong ~45 giây.
  Không có nó, TCP treo có thể giữ tunnel "sống giả" hàng chục phút.
- `ExitOnForwardFailure=yes` → tunnel không mở được cổng thì thoát để `autossh` dựng lại, thay
  vì chạy tiếp mà không forward gì.
- `StrictHostKeyChecking=yes` + `known_hosts` ghim sẵn → chống MITM trên đường công cộng.
  `known_hosts` sinh bằng `ssh-keyscan -H 45.119.87.220 | base64 -w0`, lưu thành secret `VPN6_HOST_KEY_B64`.
- Gateway trỏ `DATABASE_URL` tới **`pg-tunnel:5433`** (tên service trong mạng `db_net`), không
  phải `127.0.0.1` — tunnel nằm ở container khác, `127.0.0.1` sẽ là `ECONNREFUSED`.
  Gateway phải **fail-fast lúc khởi động** nếu `DATABASE_URL` chứa `127.0.0.1`/`localhost`.
- `opencode-server` **không** được nằm trong `db_net`. Nó là tiến trình chạy `bash` tuỳ ý; cho
  nó thấy cổng 5433 là cho nó một đường tới Postgres của headscale (§37).

**Khi tunnel chết:** Gateway không được sập theo. Nó phải trả lời Telegram bằng
`❌ Mất kết nối cơ sở dữ liệu, đang thử lại...`, thử lại có backoff, và **vẫn cho phép** người
dùng bấm Abort (đường này chỉ cần OpenCode, không cần DB). Vì vậy `depends_on` của Gateway dùng
`condition: service_started`, **không** dùng `service_healthy` — nếu không, tunnel chết lúc khởi
động sẽ khiến Gateway không bao giờ lên và người dùng mất luôn nút Abort.

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

## 8.1 Hàng trong `telegram_users` được sinh ra lúc nào

Spec gốc không nói, và thiếu chỗ này thì `role='admin'` **không bao giờ tồn tại** → `/reload`
không ai gọi được và cảnh báo mất DB không có người nhận.

Quy tắc:

UPSERT nằm ở **auth middleware**, không phải ở lệnh `/start`. Nếu chỉ tạo hàng khi gõ `/start`
thì người dùng whitelisted mà nhắn tin đầu tiên không phải `/start` sẽ rơi vào nhánh
`telegram_users.enabled? → no → Unauthorized` của §8 và **không có đường tự thoát**.

```text
user có trong TELEGRAM_ALLOWED_USER_IDS gửi bất kỳ update nào
        ↓
auth middleware: UPSERT telegram_users(telegram_user_id, telegram_username, display_name, role)
        ↓
role = 'admin' nếu id nằm trong TELEGRAM_ADMIN_USER_IDS, ngược lại 'user'
        ↓
cột enabled dùng để KHOÁ người đã có (không dùng để cấp quyền);
CHƯA có hàng ≠ bị khoá — hàng được tạo ngay trong middleware rồi mới kiểm enabled
```

Env là nguồn cấp quyền, DB là nguồn khoá quyền. Không đảo ngược: sửa `role` thẳng trong DB rồi
deploy lại sẽ bị env ghi đè — đúng loại bẫy của bài học "đổi mật khẩu admin trong env vô tác
dụng vì user đã tồn tại" ở dự án dashboard. Vì vậy **luôn đồng bộ `role` theo env**, không chỉ
lúc tạo mới.

## 8.2 UPSERT này KHÔNG được tốn round-trip (ràng buộc AC-18)

UPSERT ở middleware chạy cho **mọi** update, mà mỗi lượt chạm DB tốn 307 ms. Nếu viết ngây thơ
thì một prompt văn bản tốn: UPSERT (1) + bundle §7.10 (1) + `INSERT tasks` (1) = **3 lượt ≈ 921 ms**
— vượt ngân sách 2 lượt của §7.10 và làm **test AC-18 đỏ vì đặc tả**, không phải vì code.

Ba quy tắc để giữ 2 lượt:

1. **UPSERT đi qua cache ghi-xuyên** (§7.10 kỹ thuật 1). `telegram_users` đã nằm trong cache, nên
   so sánh `telegram_username` / `display_name` / `role` với bản trong RAM trước; **chỉ chạm DB
   khi khác**. Trường hợp thường gặp: **0 lượt**.
2. **UPSERT không bao giờ chặn.** Kể cả khi phải ghi, đẩy qua **hàng đợi điều khiển** (§7.10
   kỹ thuật 3, bảng phân loại) — người dùng không chờ nó. Nhấn mạnh **điều khiển**, không phải
   hàng đợi audit: hàng đợi audit bỏ dòng cũ nhất khi đầy, mà mất một lần đồng bộ `role` nghĩa
   là admin mất quyền `/reload` một cách ngẫu nhiên.
3. **`INSERT tasks` cũng bất đồng bộ** — nhưng qua **hàng đợi điều khiển** (§7.10), loại không
   bao giờ bị cắt bỏ. Sinh `client_task_id` (UUID) ở tầng ứng dụng, hiện tin nhắn trạng thái
   ngay, ghi DB sau. Cột `client_task_id` đã có trong §7.5 chính là để làm việc này —
   `BIGSERIAL` do DB sinh thì Gateway không có gì để tra ngược trong lúc chờ ghi.
   Phương án thay thế, đơn giản hơn và vẫn đạt AC-18: gộp vào cùng câu với bundle bằng CTE
   `INSERT ... RETURNING` (vẫn 1 round-trip).

Kết quả: prompt văn bản = **1 lượt bắt buộc** (bundle) + tối đa 1 lượt tuỳ ngữ cảnh. Con số này
phải khớp với AC-18, nếu sửa thiết kế thì sửa cả AC.

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

**V1 thực tế chỉ có đúng một dòng** — `sandbox` (QĐ-6 + QĐ-9, §33.1). Vẫn phải viết luồng chọn
project cho tổng quát: thêm project thứ hai là `git clone` + `chown` + một dòng `INSERT` +
lệnh `/reload`, không sửa code — **với điều kiện** API OpenCode cho phép gắn session vào thư mục
project (dòng 7 bảng §17.2). Nếu không, mỗi project cần một container riêng; xem §33.1.

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

File thật **phải là JSON hợp lệ, không có bình luận** (bước verify dùng `require()` của Node,
nó chết với `//`). Bản dưới đây chú thích để giải thích, khi sinh ra thì bỏ hết chú thích:

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
  },
  "permission": {                                   // BẮT BUỘC — xem giải thích bên dưới
    "read": "allow", "grep": "allow", "glob": "allow", "lsp": "deny",
    "edit": "allow", "skill": "ask", "question": "allow", "doom_loop": "deny",
    "bash": { "*": "ask", "git status": "allow", "git diff*": "allow", "rm *": "deny", "sudo *": "deny" },
    "webfetch": "ask", "websearch": "ask",
    "external_directory": "ask", "task": "ask"
  }
}
```

**Tên khoá đã đối chiếu tài liệu chính thức ngày 2026-08-14**
(`https://opencode.ai/docs/permissions/`). Khoá hợp lệ, đầy đủ:

```text
read · edit · glob · grep · bash · task · skill · lsp · question
webfetch · websearch · external_directory · doom_loop
giá trị: "allow" | "ask" | "deny"   (riêng bash và edit nhận map mẫu → giá trị)
```

**Đặt đủ CẢ 13 khoá, kể cả khoá chọn `allow`.** Khoá không được đặt sẽ chạy theo **mặc định của
OpenCode** — đúng lập luận đã dùng để bác bốn tên bịa bên dưới. Bỏ trống `skill`/`question`/
`doom_loop` nghĩa là §34.1 tuyên bố "mọi đường ra đều qua Approve" mà không kiểm chứng được:
một `skill` mặc định `allow` có thể gọi tool nặng mà không hiện nút nào.
`verify-opencode-config.js` vì vậy có phép kiểm thứ 5: **đủ 13 khoá, không thiếu không thừa**.

**Bốn tên KHÔNG tồn tại, đừng viết vào:** `write` (đã gộp trong `edit`), `search`, `apply_patch`,
`external` (tên thật là `external_directory`). Bản kế hoạch trước từng dùng đúng bốn tên bịa này
— OpenCode sẽ bỏ qua chúng, và hậu quả không phải lỗi cấu hình mà là **lỗ hổng im lặng**: các
khoá không được đặt sẽ chạy theo mặc định của OpenCode.

**Khối `permission` không được quên.** Nó là lớp bù số 1 của mô hình đe doạ §34.1 và là điều
kiện để §37.1 dám giới hạn 512 MB ("mọi lệnh nặng đều phải qua nút Approve"). Nhưng nó chỉ có
hiệu lực khi **thật sự nằm trong `opencode.json`** — mà file này bị **sinh lại mỗi lần deploy**,
nên thêm tay là mất ở lần deploy sau.

Ba chỗ phải khớp: mẫu này, bước sinh file ở §37.2, và một phép kiểm trong bước verify:

```bash
# Kiểm bằng script bake sẵn trong image (KHÔNG viết inline nhiều dòng — §0.6 quy tắc 4).
# scripts/verify-opencode-config.js kiểm 4 việc:
#   0. đọc ĐÚNG /home/node/.config/opencode/opencode.json (đường dẫn tuyệt đối, không dùng cwd —
#      working_dir của container là /workspace nên ./opencode.json sẽ trỏ nhầm chỗ)
#   1. file parse được
#   2. mọi khoá permission thuộc danh sách hợp lệ (bắt được write/search/apply_patch/external)
#   3. bash["*"], webfetch, websearch, external_directory đều là "ask"
#   4. lsp là "deny" (ngân sách RAM 512 MB ở §37.1 đứng trên khoá này — thiếu phép kiểm này
#      thì bước sinh file làm rơi khoá lsp mà deploy vẫn xanh, OOM đến sau)
#   5. ĐỦ 13 khoá permission, không thiếu không thừa — khoá không đặt sẽ chạy theo mặc định
#      của OpenCode, đúng "lỗ hổng im lặng" mà §12.1 mô tả
docker exec opencode-server node /opt/verify-opencode-config.js
```

Thiếu nó thì OpenCode chạy theo mặc định của nó: nếu mặc định là allow, agent chạy `npm install`
không hỏi ai → vượt cgroup 512 MB → OOM-kill giữa task → người dùng thấy "Thinking" treo (đúng
triệu chứng sự cố 2026-08-02), đồng thời nút `[Approve]/[Reject]` không bao giờ hiện nên **AC-10
và §26 không đạt** — mà CI vẫn xanh vì không có test nào cho việc đó.

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

- **Bước đồng bộ model lúc deploy (bắt buộc):** workflow gọi `GET /v1/models` trên cliproxy →
  **gọi thử một completion cực ngắn cho từng model** (song song, `max_tokens: 8`, timeout 20 s)
  → chỉ ghi vào `opencode.json` những model trả 200 → khởi động lại `opencode-server`.
  **Giới hạn đồng thời ≤ 3 và chỉ probe model MỚI** (so với `opencode.json` hiện có): 25 request
  song song vào một cliproxy giới hạn 1 GB đã từng OOM có thể làm `cliproxy` restart — tức bước
  xác thực model tự kích hoạt tiêu chí huỷ deploy ở §37.2 bước 6. Mỗi lần probe cũng là một lần
  đốt quota thật của 2 credential OAuth. Thêm
  model mới vào CLIProxy thì chạy lại workflow, **không sửa code Gateway** (đúng tinh thần AC-05).
- **Vì sao phải gọi thử chứ không chép thẳng danh sách:** §0.4 đã ghi — `/v1/models` trả 200 kèm
  25 model **không** chứng minh gọi được model nào. Chép thẳng cả 25 model vào `opencode.json`
  nghĩa là người dùng bấm chọn rồi mới phát hiện lỗi giữa task. Model không qua được phép thử
  ghi ra `docs/models-unverified.md` kèm mã lỗi để biết đường xử lý.
- **Kiểm chứng đã có:** hiện chỉ có 2 credential (Claude + Codex). Model duy nhất đã được gọi
  thật thành công là `claude-opus-5` — đó là lý do nó làm `DEFAULT_MODEL`.
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
5 MB   (dẫn xuất từ MAX_PROMPT_BODY_MB = 8 MB, xem §6)
```

If over limit:

```text
❌ File too large.
Maximum supported input attachment: 5 MB.
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

- gửi kèm prompt dạng base64 như §15 (Gateway không mount workspace nên **không tự ghi** vào
  thư mục tạm của project — xem hợp đồng §33.3)
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

**Câu hỏi phải trả lời trong Milestone 0:** basic auth có phủ luôn `/global/health` không?
Đây không phải chi tiết vụn — nếu có phủ thì healthcheck của compose gọi không kèm credential sẽ
luôn 401 và container không bao giờ `healthy`. Kiểm bằng `curl -i` hai lần (có và không có
credential), ghi kết quả vào chính mục này. Mặc định an toàn cho tới khi biết chắc: healthcheck
**kiểm TCP** cổng 4096 thay vì gọi HTTP. **Lệnh cụ thể chỉ nằm ở §37** (bản định nghĩa duy nhất)
— đừng chép lệnh vào đây, vì hai bản sẽ lệch nhau ngay lần sửa sau.

## 17.2 Tám nhóm endpoint CHƯA đối chiếu — phải chốt trong Milestone 0

Bảng §17.1 mới phủ 8 endpoint. Tám hạng mục V1 bắt buộc dưới đây **chưa có endpoint nào được
xác nhận**, và không được code chúng dựa trên phỏng đoán:

**Mỗi dòng đều có nhánh dự phòng viết sẵn** — giống cách §36.2 xử lý rủi ro musl. Không dòng nào
được để trống cột cuối, vì "thiết kế lại giữa chừng" là thứ đắt nhất:

| Tính năng V1 | Mục | Endpoint | Nếu KHÔNG có endpoint |
|---|---|---|---|
| Danh sách provider + model | §12, AC-05 | ? | Đọc `opencode.json` đã mount (nhánh A+ của §33.3) — vẫn thoả AC-05 vì file đó do bước đồng bộ sinh, không phải hard-code |
| Danh sách agent | §13 | ? | Ba phương án, theo thứ tự ưu tiên: (1) endpoint liệt agent nếu `GET /doc` có — chốt ở Milestone 0; (2) mount `~/.config/opencode/agent/` `:ro` rồi liệt file; (3) khai agent thành **hằng số cấu hình** trong `opencode.json.template` — `sync-models.js` chỉ chép qua, không sinh từ đâu cả. Phương án 3 là **ngoại lệ có phạm vi** của §52 quy tắc 4 ("không hard-code agent"): cấm hard-code trong **mã nguồn Gateway**, còn file cấu hình do vận hành sửa được mà không cần build lại thì chấp nhận. Ghi rõ ngoại lệ này vào §52 nếu chọn (3) |
| **Gắn session vào thư mục project** | §10, §33, AC-03 | ? | Đây là dòng dễ bị quên nhất mà lại đỡ cả "chọn project": `POST /session` trong §17.1 không có tham số thư mục nào. Nếu API không hỗ trợ → V1 chạy **một OpenCode server cho một project** và đặt `working_dir` = đúng project path; ghi rõ hệ quả: mở project thứ hai cần thêm một container, không còn là "chỉ INSERT một dòng" |
| **Hình dạng payload của `/global/event`** | §18–20, §26, AC-09/10/12/16 | ? | Không có nhánh dự phòng — bốn AC đều đứng trên nó. Bắt buộc **chụp luồng sự kiện thật** ở Milestone 0: `curl -N /global/event > docs/opencode-events-sample.jsonl` trong lúc chạy một prompt có sửa file và có xin quyền, rồi liệt kê các `type` quan sát được và ánh xạ sang §18/§19/§26. **Không viết Event Processor trước khi có file mẫu này** |
| Liệt kê session | §11 | ? | Dùng bảng `opencode_sessions` của ta làm nguồn (đã lưu mọi session do bot tạo) — mất session tạo ngoài bot, chấp nhận ở V1 |
| Trạng thái session (hoà giải) | §7.10, AC-17 | ? | **Quyết định ngay lúc khởi động, không chờ ngưỡng nào**: task nào SSE không tái nhận trong 15 giây → `POST /session/:id/abort` (endpoint đã xác nhận, §17.1) → đánh dấu `aborted`, sửa `telegram_status_message_id`, **nhả khoá 1-task**. Ngưỡng 10 phút chỉ dùng cho task đang chạy mà im lặng, tuyệt đối không dùng lúc khởi động — §7.10 giải thích vì sao (hai task song song) |
| Diff của session | §25, AC-15 | ? | `git diff` trong workspace → **kéo theo nhánh B của §33.3** (Gateway phải mount `:ro`). Ghi rõ ràng buộc kèm nhau này |
| **Lấy nội dung artifact** | §23, AC-12/13 | ? | Nhánh B của §33.3: mount `./workspace:/workspace:ro` cho Gateway, `§23` được `readFile` trong phạm vi `WORKSPACE_ROOT` |

Việc đầu tiên: gọi `GET /doc`, lưu `docs/opencode-openapi.json`, điền đủ 8 dòng trên và ghi
ngày kiểm chứng.

**Hai dòng cuối buộc nhau:** cả diff lẫn artifact đều rơi về nhánh B, nên nếu một trong hai
thiếu endpoint thì §33.3 chuyển nhánh B và §37 phải thêm `- ./workspace:/workspace:ro` cho
`telegram-gateway`. Quyết định này chốt ở **Milestone 0**, trước khi viết code Telegram.

**Việc đầu tiên của Milestone 0:** gọi `GET /doc`, lưu bản OpenAPI vào `docs/opencode-openapi.json`
và sinh kiểu TypeScript từ đó. Đó là nguồn chân lý, không phải mục này — nếu lệch thì sửa mục này.
Bảng §17.2 phải được điền đủ trong cùng bước, vì hai dòng cuối của nó quyết định §33.3 chọn
nhánh A hay B — thứ ảnh hưởng thẳng tới compose.

## 17.3 Nội dung prompt

Prompt must include:

```text
providerID   → "cliproxy"
modelID      → ví dụ "claude-opus-5"
agent        → ví dụ "build"
parts[]      → TextPart + FilePart (§15)
```

Do not create a new OpenCode session for each prompt.

**Chặn kích thước trước khi gửi:** Gateway từ chối **ngay khi nhận tệp** nếu vượt
`MAX_INPUT_ATTACHMENT_MB` (5 MB) — không tải về rồi mới chặn ở bước cuối, vì như thế vừa tốn RAM
vừa cho thông điệp lỗi sai chỗ. Body sau khi ghép vượt `MAX_PROMPT_BODY_MB` (8 MB) thì từ chối tại
chỗ. Sự cố 2026-08-02: OpenCode Desktop đẩy body **57 MB** vào CLIProxy và làm nó bị OOM-kill
(nguồn: chú thích trong `deployHeadscale/.github/workflows/deploy-cliproxy.yml` — "OpenCode
Desktop tung gui body 57MB toan mojibake", chính là lý do workflow đó có bước kiểm UTF-8).
CLIProxy vẫn giới hạn 1 GB RAM, Gateway phải là lớp chặn đầu tiên.

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
🔎 Searching references

[ 📑 Diff ] [ 🛑 Abort ]
```

Ví dụ gốc ghi `🧪 Running unit tests`. **V1 không có trạng thái đó** — agent không chạy test cục
bộ (QĐ-8, §37.1). Các trạng thái hợp lệ ở V1: đọc file, tìm kiếm, sửa file, chờ duyệt quyền,
sinh artifact.

Throttle edits.

Recommended:

```text
maximum one Telegram status edit every 1–2 seconds
```

Avoid Telegram flood/rate-limit issues.

**Bẫy `editMessageText`:** gửi nội dung **giống hệt** lần trước sẽ nhận
`400 Bad Request: message is not modified`. Với bộ đếm ít thay đổi và nhịp 1–2 giây, lỗi này nổ
liên tục. Xử lý: so chuỗi đã render với chuỗi lần trước, **giống nhau thì bỏ qua, không gọi API**;
và vẫn bắt riêng mã 400 đó để nuốt lặng thay vì đẩy lên Telegram (§41).

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
Editing configuration
Waiting for permission
Generating artifact
```

Danh sách này đã bỏ `Running tests`: V1 không chạy test cục bộ (QĐ-8, §37.1), nên không bao giờ
có trạng thái đó để hiển thị.

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

2 files changed
+31 / -14
```

Buttons:

```text
[ 📑 Diff ]
[ 📎 Files ]
[ ▶ Continue ]
```

**Về kết quả test và nút `[ 🧪 Test Again ]` có trong spec gốc:** V1 **không có** chúng — ví dụ
bên trên đã được lược bỏ cho khớp.
QĐ-8 quy định agent không chạy build/test cục bộ (RAM vpn4 chỉ 1968 MB, worker `vitest` dễ vượt
`mem_limit` 512 MB và bị OOM-kill giữa task — §37.1). Chỉ hiển thị kết quả test khi agent thật
sự chạy được test; ở V1 thì không, nên phần đó bị lược khỏi bản render. Bật lại ở Phase 2 cùng
lúc với việc nới ngân sách RAM.

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
lấy nội dung QUA API OpenCode  ← không đọc thẳng đường dẫn trên đĩa (§33.3)
   ↓
validate nguồn hợp lệ
   ↓
detect MIME
   ↓
Telegram output renderer
```

Gateway **không mount workspace** (§33.3), nên `url/path` trong FilePart chỉ là định danh để
hỏi OpenCode, không phải đường dẫn để `fs.readFile`. Viết theo kiểu đọc thẳng đĩa sẽ chạy được
lúc dev trên máy cá nhân rồi chết trên vpn4 — đúng loại lỗi khó truy nhất.

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

Baseline dùng **đúng tên khoá có thật** (đã đối chiếu 2026-08-14, xem §12.1):

```text
read                allow
grep                allow
glob                allow
lsp                 deny       ← V1 tắt để tiết kiệm RAM (§37.1); xem cảnh báo bên dưới
edit                allow      ← đã bao gồm write và apply_patch, KHÔNG có hai khoá đó

bash                ask        ← nhận map mẫu lệnh, xem bên dưới
webfetch            ask        ← BẮT BUỘC ask: đây mới là đường ra Internet của agent
websearch           ask
external_directory  ask        ← chạm ra ngoài project root
task                ask
```

`webfetch`/`websearch` phải là `ask` chứ không được để mặc định: agent lấy dữ liệu ra ngoài
bằng `webfetch` **mà không cần `bash`**, nên nếu chỉ đặt `bash: ask` thì đường rò rỉ vẫn mở
toang (§34.1 đã sửa lại cho đúng điều này).

**Cảnh báo về `lsp: deny` — chưa kiểm chứng.** §37.1 dựa vào việc tắt LSP để giữ `mem_limit`
512 MB (language server tốn 150–400 MB **trong cùng cgroup**). Nhưng `permission.lsp` là quyền
của **tool** `lsp`, chưa chắc đã ngăn OpenCode **spawn** language server ở nền. Đây là câu hỏi
chặn của Milestone 0: đặt `lsp: deny`, chạy một prompt đọc file `.ts`, rồi `docker exec
opencode-server ps aux` xem có `typescript-language-server` không. Nếu vẫn spawn thì hoặc tìm
đúng công tắc trong cấu hình OpenCode, hoặc **nâng `mem_limit` và đo lại** — không được giả định.

`bash` nhận **map mẫu → giá trị**, nên danh sách lệnh nhạy cảm không còn là lời khuyên suông mà
là cấu hình thi hành được:

```json
"bash": {
  "*": "ask",
  "git status": "allow", "git diff*": "allow", "git log*": "allow",
  "rm *": "deny", "sudo *": "deny", "systemctl *": "deny",
  "docker *": "deny", "kubectl *": "deny",
  "git push*": "deny", "git reset --hard*": "deny"
}
```

`deny` cho `docker *` là cố ý: máy này chạy DERP relay của cả fleet. `git push` cũng `deny` vì
V1 không cấp quyền đẩy code (§33.1).

Các lệnh nguy hiểm khác không khớp mẫu nào sẽ rơi vào `"*": "ask"` — người dùng vẫn là chốt cuối.
Câu lệnh SQL huỷ dữ liệu (`DROP TABLE`, `TRUNCATE`, `DELETE` không ràng buộc) không đi qua `bash`
nếu agent dùng tool khác, nên đừng coi danh sách này là hàng rào duy nhất.

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

Reject symlink/path traversal escape — **tuyệt đối, không phải "where feasible"**. Ở nhánh B của
§33.3, workspace được mount vào chính container đang giữ `TELEGRAM_BOT_TOKEN` trong biến môi
trường, nên một symlink trỏ `/proc/self/environ` là đường rò token. Bắt buộc `fs.realpath` rồi
kiểm tiền tố `WORKSPACE_ROOT` **sau khi resolve**, cộng `lstat` từ chối symlink. Có phép thử
riêng ở §49.

**Áp dụng theo nhánh (§33.3):**

```text
nhánh A  Gateway KHÔNG mount workspace → không có đĩa để resolve. Validate bằng so chuỗi
         đã chuẩn hoá trên giá trị lấy từ bảng projects, KHÔNG chạm filesystem
         (gọi realpath ở đây sẽ ném ENOENT vì đường dẫn không tồn tại trong namespace của nó)
nhánh B  Gateway mount :ro → BẮT BUỘC realpath + lstat như trên
```

Uploaded temporary files (chỉ áp dụng cho file do **OpenCode** ghi — Gateway không mount
workspace nên tự nó không ghi được vào đây, xem hợp đồng §33.3):

```text
<project>/.opencode-telegram/uploads/<task-id>/
```

or another controlled temp path.

Clean temporary Telegram files after they are no longer required.

**Ai dọn:** ở nhánh A (mặc định), Gateway không mount workspace nên **không dọn được** — file tạm
chỉ do OpenCode ghi và OpenCode tự dọn theo vòng đời session. Ở nhánh B, Gateway mount `:ro` nên
cũng không xoá được. Kết luận: V1 **không có** cơ chế dọn từ phía Gateway; nếu
`.opencode-telegram/uploads/` phình thì xử lý bằng một `find -mtime +7 -delete` trong cron trên
vpn4 và ghi vào runbook. Đừng để câu này treo như một yêu cầu không ai thực hiện.

## 33.1 Workspace thật trên vpn4 (V1 — đúng 1 project, QĐ-6 + QĐ-9)

```text
Trên host vpn4          /opt/opencode/workspace/opencode-sandbox
Trong container         /workspace/opencode-sandbox      (mount rw)
Đăng ký trong DB        projects(name='sandbox', project_path='/workspace/opencode-sandbox')
Nguồn                   https://github.com/vanbienperu3107/opencode-sandbox
                        ← repo CHƯA TỒN TẠI, phải tạo (§45.0). Để PUBLIC để khỏi
                          phải cấp credential clone trên vpn4.
                          Nội dung BẮT BUỘC là một project TypeScript nhỏ, có
                          tsconfig.json + vài file .ts — KHÔNG phải "README + vài
                          file nhỏ". Lý do: phép đo RAM dưới tải (Milestone 0 bước 5)
                          và câu hỏi "lsp: deny có ngăn spawn language server không"
                          (§27) đều cần LSP thật khởi động. Sandbox không có .ts thì
                          typescript-language-server không bao giờ chạy → số đo xanh
                          giả → ngân sách 512 MB chốt sai → OOM ở tải thật.
Chủ sở hữu thư mục      uid 1000 (xem 33.2)
Dung lượng còn lại      35 GB khả dụng trên vpn4 (df: 50G, dùng 15G) — dư, vẫn phải theo dõi (§37.4)
```

**Vì sao không dùng chính repo `TelegramAgent` làm workspace (QĐ-9):** như thế agent sẽ sửa
đúng mã nguồn sắp được deploy lên máy đang chạy DERP relay của cả fleet — một vòng tự sửa đổi.
Chạy thông end-to-end trên sandbox trước; sau Milestone 7 mới cân nhắc đổi, và khi đó phải ghi
rủi ro tự sửa đổi vào §37.4.

Chỉ mount đúng thư mục workspace. **Không** mount `/`, không mount `/opt/deployHeadscale` (chứa
`cliproxy/auths` — token OAuth Claude/Codex, mất là phải đăng nhập lại toàn bộ), không mount
`/var/run/docker.sock` (cho agent quyền docker trên máy đang chạy DERP relay là mở đường tự
huỷ hạ tầng).

**V1 agent KHÔNG có quyền `git push`.** Nó đọc/sửa file trong workspace; người dùng xem `/diff`
rồi tự quyết định đẩy đi. Lý do: đẩy code lên GitHub không nằm trong yêu cầu gốc, §46 vẫn liệt
"GitHub integration" là ngoài phạm vi V1, và trao khoá đẩy cho một tiến trình chạy `bash` là mở
rộng bề mặt rủi ro không cần thiết. Muốn bật ở Phase 2 thì phải kèm secret `WORKSPACE_DEPLOY_KEY`,
mount `:ro`, và sửa §46 cho nhất quán.

Mở rộng sang project thứ hai: `git clone` vào `/opt/opencode/workspace/<tên>` → `chown -R 1000:1000`
→ `INSERT` một dòng vào bảng `projects` → gửi lệnh **`/reload`** cho bot (§7.10 kỹ thuật 1).
Không phải sửa code, không phải deploy lại.

**Điều kiện của câu trên:** nó chỉ đúng nếu API OpenCode cho phép gắn session vào thư mục project
(dòng 7 bảng §17.2). Nếu không, mỗi project cần một container `opencode-server` riêng với
`working_dir` riêng — lúc đó thêm project **có** phải sửa compose và deploy lại. Chốt ở Milestone 0.

## 33.2 Quyền thư mục — chỗ dễ chết nhất khi dựng lần đầu

`git clone` chạy trên host bằng `root` → thư mục thuộc `root:root`. Container chạy `USER node`
(uid 1000) → **agent không ghi được file nào**: sửa code lỗi, tạo artifact lỗi, và `git` báo
`detected dubious ownership in repository`. Toàn bộ chức năng lõi chết mà thông báo lỗi rất khó
đọc từ phía Telegram.

Bắt buộc trong script deploy (viết phẳng, không `if/else` — §0.6 quy tắc 4):

```bash
chown -R 1000:1000 /opt/opencode/workspace
```

Và trong image `opencode-server`: `git config --global --add safe.directory '*'`.

Phép thử bắt buộc của Milestone 0:

```bash
docker exec opencode-server touch /workspace/opencode-sandbox/.wtest
docker exec opencode-server rm /workspace/opencode-sandbox/.wtest
```

## 33.3 Hợp đồng: Gateway KHÔNG chạm filesystem

Chọn dứt khoát để tránh mô tả hai đằng:

**Nhánh A (mặc định, áp dụng nếu §17.2 xác nhận có API đọc artifact):**

| Chiều | Cách làm | Hệ quả |
|---|---|---|
| Telegram → OpenCode | Tải file về bộ nhớ, gửi kèm prompt dưới dạng `data:` base64 (§15) | Gateway **không** cần mount workspace |
| OpenCode → Telegram | Lấy nội dung artifact **qua API OpenCode**, không đọc thẳng đường dẫn | Gateway **không** cần mount workspace |

Vì vậy compose **không** mount `./workspace` vào `telegram-gateway` (§37), và đường dẫn tạm
`<project>/.opencode-telegram/uploads/<task-id>/` nêu ở §33 chỉ áp dụng khi **OpenCode** tự ghi
file, không phải Gateway. Bảng `artifacts` lưu metadata + tham chiếu, không lưu nội dung.

**Nhánh B (dự phòng, nếu §17.2 cho thấy KHÔNG có API đọc artifact hoặc không có API diff):**
thêm `- ./workspace:/workspace:ro` cho `telegram-gateway` trong §37; §23 được phép `readFile`
nhưng chỉ trong phạm vi `WORKSPACE_ROOT` đã resolve, chặn symlink và path traversal như §33 quy
định. Chiều tải lên vẫn dùng base64, không đổi.

**Nhánh A+ (độc lập với A/B, nếu §17.2 cho thấy không có API liệt kê provider/model/agent):**
thêm `- ./opencode.json:/app/opencode.json:ro` cho `telegram-gateway` — Gateway đọc danh sách
model/agent thẳng từ file cấu hình do bước đồng bộ sinh ra (§12.1). Vẫn thoả AC-05 vì danh sách
không nằm trong mã nguồn. Mount này **chỉ đọc** và không dẫn tới workspace.

Ba nhánh có thể kết hợp. Bảng mount hợp lệ mà CI kiểm (§37.3) phải liệt cả ba khả năng, nếu
không thì đúng lúc chọn nhánh dự phòng lại là lúc CI chặn.

Quyết định chọn nhánh nào phải ghi lại vào chính mục này kèm ngày và bằng chứng từ `GET /doc`.

---

# 34. OpenCode Connectivity

OpenCode chỉ tồn tại trong mạng docker riêng `opencode_net`. **Không có dòng `ports:` nào cho
service `opencode-server`** — đây là điều kiện kiểm tra được, và CI phải chặn nếu ai đó thêm vào.

```text
Trong opencode_net      http://opencode-server:4096       ← Gateway gọi bằng đường này
Trên host vpn4          không có gì cả             ← ss -tlnp không được thấy 4096
Từ Internet             không có gì cả
Xác thực                basic auth qua OPENCODE_SERVER_PASSWORD (kể cả trong mạng nội bộ)
```

Vì sao siết chặt đến vậy: vpn4 đang mở 3 cổng ra Internet (80, 443, 28417) và chạy DERP relay
phục vụ toàn bộ fleet. OpenCode là tiến trình **được phép chạy `bash` và sửa file** — lộ nó ra
ngoài đồng nghĩa trao shell trên máy hạ tầng cho bất kỳ ai.

Cách kiểm chứng sau khi deploy (đưa vào bước verify của workflow):

```bash
# Đúng cú pháp: "grep -c" trả exit 1 khi đếm được 0 — mà 0 mới là trạng thái ĐÚNG.
# Viết theo kiểu dưới đây thì trạng thái đúng không làm script chết (script_stop: true).
test "$(ss -Hltn | awk '{print $4}' | grep -c ':4096$')" -eq 0 && echo "OK: 4096 không lộ ra host"
docker exec opencode-gateway getent hosts opencode-server && echo "OK: DNS nội bộ phân giải được"
```

Telegram Gateway là control plane duy nhất hướng ra ngoài — và bản thân nó cũng **chủ động gọi
ra** (long polling) chứ không mở cổng nhận vào.

## 34.1 Chiều đi ra — nói thẳng thứ V1 chấp nhận

Mục trên chỉ nói về chiều **vào**. Chiều **ra** cũng phải nói rõ, không được im lặng:

`opencode_net` và `edge` là bridge thường, không `internal: true`, nên `opencode-server` — tiến
trình **được phép chạy `bash`** — có đường ra Internet từ một máy đang chạy DERP relay của cả
fleet và giữ token OAuth Claude/Codex ở `/opt/deployHeadscale/cliproxy/auths`.

**V1 chấp nhận điều này một cách có ý thức**, vì đó là bản chất của công cụ: agent cần `git
fetch`, tải dependency, đọc tài liệu. Các lớp bù đang có:

1. `bash` ở mức **ask** (§27) — mọi lệnh shell đều phải qua nút Approve của người dùng.
   **Nhưng `bash: ask` KHÔNG chặn được đường ra Internet**: agent có tool `webfetch`/`websearch`
   riêng, chạy mà không cần shell. Vì vậy hai khoá đó cũng phải để `ask` (§27) — nếu không, câu
   "mọi đường ra đều qua Approve" là sai sự thật. Đây là chỗ bản kế hoạch trước nói quá.
2. `cap_drop: [ALL]` + `no-new-privileges` + `pids_limit` (§37).
3. Không mount `/opt/deployHeadscale`, không mount `docker.sock` (§33.1) — agent không đọc được
   **file** token OAuth Claude/Codex.
   **Nói cho đúng phần còn lại:** `CLIPROXY_API_KEY` và `OPENCODE_SERVER_PASSWORD` nằm ngay
   trong `environment:` của chính `opencode-server` (§37), mà §27 đặt `read` ở mức **allow** —
   agent đọc `/proc/self/environ` là có cả hai, không cần tới `bash`. Vậy phải coi như **agent
   biết hai giá trị đó**. Hệ quả thực tế: `CLIPROXY_API_KEY` rò rỉ = người khác dùng chùa quota
   Claude/Codex qua cổng công cộng `149.104.66.174:28417`. Nghi ngờ thì xoay key (đổi secret rồi
   chạy lại `deploy-cliproxy.yml`, key cũ chết ngay). Phase 2 có thể chuyển sang `secrets:` file
   mount `:ro` để ra ngoài tầm với của `read`.
4. Không nằm trong `db_net` (§37) — không thấy cổng tới Postgres của headscale.
5. Audit log mọi lệnh được duyệt (§32).

Phương án siết chặt hơn cho Phase 2 (cần đo trước): `opencode_net: internal: true` và chỉ để
`edge` làm đường ra — với điều kiện kiểm chứng `edge` có ra Internet hay không, vì `cliproxy`
nằm trên đó và **nó cần** gọi upstream Claude/OpenAI.

---

## 34.2 Nối OpenCode với CLIProxy

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
| PostgreSQL | ✅ đang chạy trên vpn6 (`derp-postgres` 18.4) | **Chỉ** tạo DB + role (§4.1). KHÔNG publish cổng, KHÔNG sửa compose, KHÔNG recreate container (§7.11.1) |
| Repo sandbox | ❌ **chưa tồn tại** | Tạo `vanbienperu3107/opencode-sandbox` (PUBLIC, **project TypeScript nhỏ có `tsconfig.json` + vài file `.ts`** — không phải README suông; lý do ở §33.1) |
| Workspace project | ❌ chưa có | `git clone` repo sandbox vào `/opt/opencode/workspace/opencode-sandbox` + `chown 1000:1000` |
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
    └── opencode-sandbox/       ← project duy nhất của V1 (QĐ-9, KHÔNG phải repo TelegramAgent)
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
│  sshd → bridge 172.21.0.1 ──▶ 172.21.0.2:5432 derp-postgres               │
│                                    └──▶ DB opencode_remote (KHÔNG publish) │
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
| `ghcr.io/vanbienperu3107/pg-tunnel` | alpine + `autossh` + **`postgresql-client`** (§7.11) | GHCR, đổi rất hiếm |

## 36.1 Gateway

Multi-stage build, `node:22-alpine`.

Runtime:

- `WORKDIR /app`, và **`COPY --chown=node:node scripts/sync-models.js /app/scripts/sync-models.js`**
  — bước 4 của deploy gọi `node /app/scripts/sync-models.js` trong chính image này; thiếu dòng
  COPY thì `Cannot find module` và deploy đỏ 100%
- chạy bằng user không phải root (riêng `sync-models.js` được gọi kèm `--user 0:0` vì nó ghi vào
  `/opt/opencode` thuộc root — §37.2)
- chỉ dependency production
- **nếu §33.3 chọn nhánh B** (Gateway tự chạy `git diff`): image phải có `git` +
  `git config --global --add safe.directory '*'`. §37.3 có phép kiểm "mount nào được bật thì
  lệnh tương ứng phải có trong image tương ứng" — bật mount mà quên gói thì `/diff` trả
  `git: not found` và AC-15 hỏng
- **không khai `HEALTHCHECK` trong Dockerfile** — compose (§37) là bản định nghĩa duy nhất.
  Khai ở cả hai chỗ thì lần sửa sau chắc chắn lệch, và bản trong image âm thầm thắng khi ai đó
  chạy `docker run` tay
- không copy secret nào vào image
- lệnh chạy: `node dist/index.js`

## 36.2 opencode-server

Phải cài thêm công cụ mà agent thực sự cần, nếu không mọi tool của nó đều lỗi:

```dockerfile
FROM node:22-alpine
RUN apk add --no-cache git openssh-client ripgrep bash tini
RUN npm i -g opencode-ai@<phiên bản ghim>   # kiểm chứng tên gói + version ở Milestone 0
RUN git config --global --add safe.directory '*'
# Script verify chạy ở bước 5 của deploy (§37.2). Phải COPY vào ĐÂY, trước USER node —
# "docker exec … node /opt/verify-opencode-config.js" chỉ chạy được nếu đường dẫn có thật.
COPY --chown=node:node scripts/verify-opencode-config.js /opt/verify-opencode-config.js
# Docker tự tạo thư mục cha của bind mount và gán root:root. Thiếu dòng dưới thì OpenCode không
# ghi được state/auth vào ~/.config/opencode và IM LẶNG chạy không provider -> /model rỗng.
RUN mkdir -p /home/node/.config/opencode && chown -R node:node /home/node/.config
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["opencode", "serve", "--port", "4096", "--hostname", "0.0.0.0"]
```

**Rủi ro musl — có phương án dự phòng sẵn, không debug tại chỗ:** `opencode-ai` phân phối
binary biên dịch sẵn; alpine dùng **musl** chứ không phải glibc. Nếu binary không có bản musl
thì `opencode --version` sẽ lỗi ngay khi build image. Quy tắc go/no-go của Milestone 0:

```text
opencode --version chạy được trên alpine   → giữ node:22-alpine
lỗi liên quan musl / không chạy            → ĐỔI NGAY sang node:22-bookworm-slim (glibc)
                                             + apt-get install -y git openssh-client ripgrep bash
                                             KHÔNG dành thời gian vá musl
```

Nhánh bookworm phải cài **đủ mọi công cụ mà healthcheck dùng** (§37), không chỉ công cụ của
agent. Và phải thử **chạy thật**, không chỉ kiểm lệnh có tồn tại — `/dev/tcp` là tính năng biên
dịch của bash, có `bash` chưa chắc có nó:

```bash
docker run --rm <image> bash -c 'exec 3<>/dev/tcp/127.0.0.1/4096' ; echo "rc=$?"
# rc=1 (từ chối kết nối) = TỐT: bash hỗ trợ /dev/tcp
# rc=127 hoặc "No such file or directory" = image này KHÔNG dùng được đầu dò đó
```

Image lớn hơn ~80 MB, mà vpn4 còn 35 GB đĩa — đây không phải thứ đáng tối ưu.

Ghi chú:

- **Ghim version**, không dùng `latest`. CI của repo `deployHeadscale` đã chặn `:latest` — giữ
  cùng chuẩn ở đây. Điều này áp dụng cho **cả tag image lẫn gói npm**.
- `tini` để tiến trình con (bash tool, git) không thành zombie khi agent huỷ task giữa chừng.
- `--hostname 0.0.0.0` chỉ có nghĩa trong không gian mạng container; không có `ports:` nên vẫn
  không lộ ra host (§34).
- Cấu hình provider nằm ở `opencode.json` **mount vào** (read-only), không nướng vào image —
  vì khối `models` được sinh lại mỗi lần deploy (§12.1).

---

# 37. docker-compose.yml

**Không tạo container PostgreSQL.** Đây là **bản định nghĩa duy nhất** của stack (§7.11 chỉ giải
thích, không lặp lại). Ba service, đặt tại `/opt/opencode` trên vpn4:

```yaml
services:
  telegram-gateway:
    image: ghcr.io/vanbienperu3107/opencode-telegram-gateway:${GATEWAY_TAG:?dat tag cu the}
    container_name: opencode-gateway
    restart: unless-stopped
    mem_limit: 256m
    pids_limit: 256
    security_opt: ["no-new-privileges:true"]
    cap_drop: [ALL]
    env_file: .env
    depends_on:
      # service_started, KHÔNG phải service_healthy: tunnel chết thì Gateway vẫn
      # phải lên để người dùng còn bấm được Abort (AC-20).
      pg-tunnel: { condition: service_started }
      opencode-server: { condition: service_started }
    networks: [opencode_net, db_net]
    # KHÔNG publish cổng: bot chủ động gọi ra Telegram (long polling).
    healthcheck:
      # Dùng wget của busybox (~1 MB), KHÔNG dùng "node -e": mỗi lần chạy node tốn
      # ~45 MB RSS TRONG CHÍNH cgroup 256m này — healthcheck sẽ tự gây ra cái OOM
      # mà nó sinh ra để phát hiện (§37.1). CMD-SHELL để ${HEALTH_PORT} được nội suy.
      test: ["CMD-SHELL", "wget -q --spider http://127.0.0.1:${HEALTH_PORT:?}/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  opencode-server:
    image: ghcr.io/vanbienperu3107/opencode-server:${OPENCODE_TAG:?dat tag cu the}
    container_name: opencode-server
    restart: unless-stopped
    mem_limit: 512m           # xem §37.1 — kèm điều kiện QĐ-8 (không build/test cục bộ)
    pids_limit: 512           # agent chạy bash; chặn fork bomb do lệnh hỏng
    security_opt: ["no-new-privileges:true"]
    cap_drop: [ALL]
    environment:
      OPENCODE_SERVER_PASSWORD: ${OPENCODE_SERVER_PASSWORD:?bat buoc}
      CLIPROXY_API_KEY: ${CLIPROXY_API_KEY:?bat buoc}
    volumes:
      - ./opencode.json:/home/node/.config/opencode/opencode.json:ro
      - ./workspace:/workspace                # CHỈ thư mục này (§33.1), chown 1000 (§33.2)
    # /workspace là thư mục CHA. Nếu Milestone 0 xác nhận API không có tham số gắn
    # session vào thư mục project (dòng 7 bảng §17.2), phải đổi thành
    # /workspace/opencode-sandbox, nếu không agent làm việc ngoài repo và `git diff` hỏng.
    working_dir: /workspace
    # KHÔNG có db_net: agent chạy bash tuỳ ý, không được thấy cổng 5433 (§37.1)
    networks: [opencode_net, edge]            # edge = nói chuyện với cliproxy
    # KHÔNG có "ports:" — bất biến bắt buộc, CI kiểm tra (§34)
    healthcheck:
      # Kiểm TCP thuần, KHÔNG gọi HTTP: chưa biết chắc basic auth có phủ
      # /global/health và /doc không (§17.1) — nếu có thì mọi lệnh HTTP đều 401 và
      # container không bao giờ healthy.
      # Dùng /dev/tcp của bash (~4 MB) thay vì "node -e" (~45 MB): 45 MB chạy trong
      # chính cgroup 512m sẽ ăn vào ngân sách của agent (§37.1). bash có sẵn ở CẢ HAI
      # base image ứng viên: alpine đã "apk add bash" (§36.2), bookworm-slim có sẵn.
      # Đổi sang gọi /global/health sau khi Milestone 0 xác nhận endpoint đó miễn auth.
      test: ["CMD", "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/4096"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 40s
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  pg-tunnel:
    image: ghcr.io/vanbienperu3107/pg-tunnel:${TUNNEL_TAG:?dat tag cu the}
    container_name: opencode-pg-tunnel
    restart: unless-stopped
    mem_limit: 64m
    pids_limit: 64
    security_opt: ["no-new-privileges:true"]
    cap_drop: [ALL]
    environment:
      PG_REMOTE_HOST: ${PG_REMOTE_HOST:?doc lai moi lan deploy}   # §7.11.3
      # Mặc định autossh coi phiên chết trong 30 giây đầu là "lỗi vĩnh viễn" và TỰ THOÁT.
      # Đúng kịch bản AC-20b (vpn6 bảo trì lúc vpn4 khởi động lại) sẽ rơi vào đó.
      # GATETIME=0 tắt luật này -> autossh thử lại mãi, đúng như §37.4 mô tả.
      AUTOSSH_GATETIME: "0"
    command: >
      autossh -M 0 -N
      -o ServerAliveInterval=15 -o ServerAliveCountMax=3
      -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=yes
      -o UserKnownHostsFile=/keys/known_hosts
      -i /keys/pg_tunnel_key
      -L 0.0.0.0:5433:${PG_REMOTE_HOST}:5432
      pgtunnel@45.119.87.220
    volumes:
      - ./keys:/keys:ro
    # CỐ Ý chạy root: keys/pg_tunnel_key là chmod 600 do root sở hữu trên host.
    # Thêm "user: 1000" sẽ làm tunnel chết với lỗi permissions rất khó đọc.
    # Bù lại đã có cap_drop ALL + no-new-privileges + pids_limit.
    networks: [db_net]
    healthcheck:
      # pg_isready đi qua tunnel tới Postgres thật: bắt được cả "tunnel chết" lẫn
      # "tunnel sống nhưng DB không trả lời". Đây là lý do image pg-tunnel BẮT BUỘC
      # có postgresql-client (§36) — bước verify ở §37.2 cũng dùng đúng lệnh này.
      # KHÔNG dùng wget: Postgres không nói HTTP nên wget luôn thoát khác 0, tunnel
      # sẽ vĩnh viễn unhealthy dù đang chạy tốt.
      test: ["CMD", "pg_isready", "-h", "127.0.0.1", "-p", "5433"]
      # 60s chứ không phải 30s: mỗi lần chạy là một kết nối tới derp-postgres —
      # DB dùng chung với headscale. 60s = 1440 lần/ngày thay vì 2880 (§37.4).
      interval: 60s
      timeout: 5s
      retries: 3
      start_period: 15s
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

networks:
  opencode_net:            # Gateway ↔ OpenCode
    driver: bridge
  db_net:                  # Gateway ↔ tunnel. opencode-server KHÔNG được vào đây
    driver: bridge
  edge:
    external: true         # do stack edge-vpn4 sở hữu — chỉ tham gia, KHÔNG tạo/xoá
```

**Vì sao tách `db_net`:** `opencode-server` là tiến trình được phép chạy `bash` tuỳ ý. Nếu nó
chung mạng với `pg-tunnel`, agent nhìn thấy cổng 5433 — cổng đó dẫn thẳng tới **Postgres của
headscale và DERP**, không chỉ DB của dự án này. Tách mạng là ranh giới rẻ nhất và chắc nhất.

Cấm tuyệt đối trong file này: mount `/`, mount `/var/run/docker.sock`, mount
`/opt/deployHeadscale`, thêm `ports:` cho `opencode-server`, cho `opencode-server` vào `db_net`,
bỏ `mem_limit`, bỏ `logging`, dùng tag trôi (`latest`/`stable`/`pinned`).

---

## 37.1 Ngân sách RAM trên vpn4

vpn4 chỉ có **1968 MB** RAM. Đây là ràng buộc cứng nhất của cả dự án.

| Khoản | RAM |
|---|---|
| Hệ điều hành + các container đang chạy (đo được) | ~692 MB |
| `opencode-server` (giới hạn) | 512 MB |
| `telegram-gateway` (giới hạn) | 256 MB |
| `pg-tunnel` (giới hạn) | 64 MB |
| **Tổng sau khi thêm stack này** | **~1524 MB / 1968 MB** |
| Còn lại cho đỉnh tải + page cache | ~444 MB |

**Tiến trình healthcheck cũng nằm trong cgroup của service** — khoản này dễ bị bỏ quên và đã suýt
gây lỗi trong chính bản kế hoạch này:

| Đầu dò | RSS mỗi lần chạy | Dùng ở đâu |
|---|---|---|
| `node -e …` | **~45 MB** | ❌ không dùng — 45 MB trong cgroup 256m của Gateway đủ để kích OOM |
| `bash -c '</dev/tcp/…'` | ~4 MB | `opencode-server` (bash có sẵn, §36.2) |
| `wget --spider` (busybox) | ~1 MB | `telegram-gateway` |
| `pg_isready` | ~3 MB | `pg-tunnel` |

Quy tắc rút ra: **đầu dò phải rẻ hơn nhiều lần phần dư của cgroup nó chạy trong đó.** Một
healthcheck tự gây OOM là loại lỗi khó chẩn đoán nhất, vì bằng chứng duy nhất là container
restart mỗi 30 giây mà log không nói gì.

Cộng thêm **3915 MB swap** (hiện mới dùng 32 MB) làm lớp đệm. Swap chậm nhưng ở đây nó cứu
mạng: thà agent chạy chậm còn hơn kernel OOM-killer chọn nhầm `derper` và làm cả fleet mất
DERP relay.

> **Hai con số 512m và 256m hiện là PHỎNG ĐOÁN, không phải số đo.** Cả tài liệu này neo vào số
> đo thật, riêng hai con số quan trọng nhất thì chưa. Milestone 0 bước 5 phải đo **dưới tải**
> (một prompt sửa file + một đính kèm sát trần), ghi `docker stats` đỉnh của cả 3 service vào
> đúng bảng này, rồi mới coi là chốt.

Hai nguồn ngốn RAM dễ bị bỏ sót khi ước lượng:

1. **OpenCode sinh tiến trình con.** Mở một project TypeScript thường kéo theo LSP server
   (`typescript-language-server`) và file watcher — mỗi cái 150–400 MB, và chúng nằm trong
   **chính cgroup 512m**. V1 **tắt LSP** bằng `"lsp": "deny"` trong khối `permission` của
   `opencode.json` (§12.1) — agent vẫn đọc/sửa/tìm kiếm bình thường, chỉ mất gợi ý kiểu.
   Bật lại cùng lúc với việc nới ngân sách RAM, và phải đo lại (§45.0 có ô checklist).
2. **Đường đính kèm của Gateway nhân bản bộ nhớ.** Tệp 5 MB → `Buffer` 5 MB → chuỗi base64
   (~6.7 MB, lưu UTF-16 nên ~13 MB) → bản sao khi `JSON.stringify` → thân request: đỉnh tức
   thời gấp 4–6 lần kích thước tệp. `Buffer` **không** nằm trong heap V8 nên đặt
   `--max-old-space-size` không cứu được cgroup; nó chỉ giúp lỗi đọc được thay vì OOM câm.
   Đặt `NODE_OPTIONS=--max-old-space-size=192` cho Gateway và **stream** tệp thay vì giữ ba bản
   sao trong RAM.

**512 MB có đủ cho OpenCode không? Chỉ đủ khi tuân thủ QĐ-8.** `tsc` thường ngốn 300–600 MB và
worker của `vitest` dễ vượt 512 MB — chạy trong chính cgroup của `opencode-server` thì agent bị
OOM-kill giữa task, và người dùng chỉ thấy "Thinking" treo (đúng triệu chứng sự cố 2026-08-02).
Vì vậy:

- **V1 agent không build/test cục bộ** (QĐ-8). Nó đọc, sửa, tìm kiếm, chạy lệnh nhẹ; build và
  test đẩy lên GitHub Actions — đúng luật chung đang áp dụng cho mọi repo khác.
- §27 đã đặt `bash` ở mức **ask**, nên mọi lệnh nặng đều phải qua nút Approve của người dùng.
  Đây là chốt chặn thứ hai, không phải chốt duy nhất.
- Nếu sau này thật sự cần build cục bộ: nâng `opencode-server` lên 1g, hạ Gateway xuống 192m,
  khai `memswap_limit: 2g` tường minh, và **đo lại** trước khi tin.

Quy tắc:

1. **Không service nào của stack này được thiếu `mem_limit`.** Không đặt = mặc định lấy hết RAM
   máy = kernel có quyền giết `derper`.
2. **`derper` và `cliproxy` được ưu tiên hơn stack này.** Nếu phải hy sinh, hy sinh OpenCode.
3. **Cảnh báo khi RAM khả dụng < 300 MB** — đưa vào `/healthz` của Gateway.
4. **V1 chỉ cho phép 1 task đang chạy trên toàn hệ thống**, không phải 1 task/session (§40) —
   hai task song song là hai lần ngân sách RAM.
5. **Đo lại sau tuần đầu.** Nếu `opencode-server` thường xuyên chạm trần 512 MB thì nâng lên
   640 MB và hạ Gateway xuống 192 MB, chứ không phải nâng tổng.

---

## 37.2 CI/CD — theo đúng khuôn đã chạy được của repo `deployHeadscale`

Không phát minh quy trình mới. Sao chép khuôn `deploy-cliproxy.yml` vì nó đã chạy ổn định trên
chính máy này.

### 37.2.0 Ba luật chi phối mọi dòng trong mục này

Bốn vòng review liên tiếp đều bắt cùng một lớp lỗi ở đây, nên ba luật dưới đây là **điều kiện
đọc hiểu** phần còn lại:

```text
L1  MỘT LỆNH = MỘT DÒNG. Không heredoc, không chuỗi trích dẫn nhiều dòng, không if/else
    nhiều dòng, không for/while nhiều dòng, KHÔNG nối dòng bằng dấu \.
    Lý do: ssh-action chèn "DRONE_SSH_PREV_COMMAND_EXIT_CODE=$? ; ..." sau MỖI dòng.
    Logic dài -> đưa vào file script trong repo, gọi bằng một dòng.

L2  MỖI BƯỚC ssh-action LÀ MỘT SHELL RIÊNG. Biến không chảy từ bước này sang bước khác.
    Bước nào cần $VAR thì bước đó phải tự nạp .env (bọc set +x), hoặc nhận qua "envs:".
    Dữ liệu chảy giữa hai bước KHÁC MÁY phải đi qua $GITHUB_OUTPUT.

L3  MỌI LỆNH PHẢI CÓ BẰNG CHỨNG TỒN TẠI đúng nơi nó chạy — §0.1 (host vpn4), §36 (image),
    hoặc runner GitHub. "Có ở đâu đó" không đủ: phải có ở ĐÚNG shell / ĐÚNG image /
    ĐÚNG đường dẫn / ĐÚNG máy.

L4  KHI MỘT BƯỚC ĐỔI MÁY THỰC THI, phải rà lại đủ BỐN thứ:
      (a) file được GHI ở máy nào     (b) file được ĐỌC ở máy nào
      (c) nguồn của mọi $VAR ở máy đó (d) dòng bằng chứng lệnh trong bảng L3 cho máy đó
    Luật này ra đời vì đúng một lần đổi bước 3 từ ssh-action sang ssh trần đã sinh ra
    hai lỗi deploy-đỏ-100%: redirect rơi về runner trong khi diff đọc trên vpn6, và
    known_hosts không được tạo ở phía runner.
```

**Nguồn hợp lệ của một biến — `envs:` KHÔNG phải nguồn:**

```text
`envs:` của appleboy/ssh-action chỉ là BỘ CHỌN TÊN — nó nói "chuyển tiếp các biến này
sang máy xa". GIÁ TRỊ vẫn phải đến từ khối `env:` của chính step (hoặc env cấp job).
Khai tên trong `envs:` mà không định nghĩa trong `env:` = biến rỗng ở đầu bên kia.

step ssh-action:  giá trị đến từ `env:` của step  → tên được liệt trong `envs:`
                  hoặc: .env đã source TRONG CHÍNH step
                  hoặc: gán trước đó trong chính script
step run: runner: `env:` của step, hoặc gán trước đó trong script
```

Vì vậy **mỗi step ssh-action phải có ĐỦ HAI khối**: `env:` (định nghĩa) và `envs:` (chọn chuyển
tiếp). Thiếu `env:` là lỗi im lặng — không cảnh báo, chỉ là chuỗi rỗng ở phía xa.

### 37.2.1 Ba workflow build

```text
build-gateway.yml          docker/Dockerfile.gateway          -> ghcr.io/…/opencode-telegram-gateway:<github.sha>
build-opencode-server.yml  docker/Dockerfile.opencode-server  -> ghcr.io/…/opencode-server:<phiên bản opencode>
build-pg-tunnel.yml        docker/Dockerfile.pg-tunnel        -> ghcr.io/…/pg-tunnel:<github.sha>
```

Mỗi workflow một image, không gộp. Tag luôn là giá trị **cụ thể**, không bao giờ là tag trôi.

### 37.2.2 `deploy.yml`

```yaml
concurrency:
  group: deploy-vpn4-host
  cancel-in-progress: false
```

**Cảnh báo về giới hạn của `concurrency`:** nó chỉ xếp hàng **trong cùng một repository**. Các
workflow `deploy-cliproxy` / `deploy-derp-vpn4` / `deploy-vpn-gw` nằm ở repo `deployHeadscale`
nên **không bao giờ** chung hàng đợi với repo này — dù đặt cùng tên group. Khoá thật nằm ở tầng
host, và phải là **hai dòng đầu tiên** của mọi script chạy trên vpn4:

```bash
exec 9>/var/lock/vpn4-deploy
flock -w 600 9 || exit 1
```

`flock` có sẵn tại `/usr/bin/flock` (§0.1). Phạm vi: khoá chỉ có tác dụng khi **mọi** workflow
đụng vpn4 đều lấy nó — ba workflow bên `deployHeadscale` hiện **chưa** có `flock`, nên tới khi
thêm vào đó thì đây mới là "giảm xác suất", chưa phải "loại trừ".

**Bước 1 — kiểm secret VÀ repo variable bắt buộc** (chạy trên runner): thiếu thì fail sớm, đừng
để chết giữa chừng trên server. Danh sách secret lấy từ §6.3, gồm cả `TELEGRAM_ADMIN_USER_IDS`
(rỗng thì hỏng im lặng) và `GHCR_TOKEN`. **Kiểm thêm repo variable `vars.OPENCODE_TAG`** — nó
không nằm trong bảng secret nhưng compose khai `${OPENCODE_TAG:?}`, thiếu là `docker compose pull`
dừng giữa bước 4.

**Bước 2 — ảnh chụp baseline vpn4** (ssh-action vào vpn4):

```bash
exec 9>/var/lock/vpn4-deploy
flock -w 600 9 || exit 1
docker inspect -f '{{.Name}} {{.RestartCount}} {{.State.StartedAt}}' derper edge-nginx caddy-edge cliproxy vpn-gw ts-vpngw ping-reporter-vpn4 ts-vpn4 > /tmp/baseline-before.txt
```

Hai dòng `flock` phải mở đầu **mọi** step ssh-action vào vpn4 (bước 2, 4, 5).

**Nói cho đúng mức bảo vệ mà nó cho:** vì mỗi step là một shell riêng (L2), fd 9 đóng và khoá
nhả khi step kết thúc — nên `flock` per-step **chỉ chống hai deploy xen kẽ nhau trong lúc một
step đang chạy**, nó **không** khoá được cửa sổ từ bước 2 tới bước 5. Cửa sổ đó vẫn hở, và AC-21
chấp nhận giới hạn này. Muốn khoá cả cửa sổ thì phải gộp bước 2/4/5 thành một step, hoặc dùng
một cơ chế khoá có tiến trình giữ sống qua các step — cả hai đều đắt hơn lợi ích ở quy mô V1.

Danh sách container gồm cả `ping-reporter-vpn4` và `ts-vpn4` để phủ hết §0.1.

**Bước 3 — vpn6** (step `run:` trên **runner**, dùng `ssh` trần, `id: vpn6`, khoá
`SSH_KEY_VPN6_B64`). Chỉ đọc và tạo, không sửa gì đang chạy. Ba script đều nằm trong sudoers
whitelist (§6.3):

- `snapshot-vpn6.sh` — chụp ảnh **trước**, phải chạy **đầu tiên**, trước mọi hành động mutate.
  **Nội dung phải đặc tả rõ, nếu không `diff` ở bước 5b sẽ đỏ ngay lần deploy đầu tiên** (giữa
  hai lần chụp, bước 3 cố ý tạo DB `opencode_remote`, role `opencode`, và sửa một dòng
  `authorized_keys`). Script chụp đúng ba nhóm, và **loại trừ tường minh** những thay đổi hợp lệ:

  ```text
  CHỤP:     RestartCount + StartedAt của headscale, derp-postgres, derp-backend
            count(*) pg_tables schemaname='public' của DB derp và DB headscale
            danh sách database (lọc BỎ opencode_remote) và role (lọc BỎ opencode)
  KHÔNG chụp: nội dung authorized_keys, dòng permitopen, dung lượng DB
  ```

  Ba nhóm này đúng bằng những gì AC-21 khẳng định, không hơn: hạ tầng đang chạy không restart,
  và hai DB kia không có bảng mới.
- `create-opencode-db.sh` — tạo DB + role nếu chưa có (§4.1), **không** động vào compose vpn6
- `update-permitopen.sh` — tự đọc IP container bằng lệnh có lọc tên mạng (§7.11.3),
  `cp authorized_keys authorized_keys.bak` trước khi sửa, rồi in ra **đúng một dòng**
  `PG_REMOTE_HOST=<ip>`

**Đường truyền `PG_REMOTE_HOST` sang bước 4** — bước 4 chạy trên **máy khác** nên biến không tự
chảy (L2).

**Không dùng `capture_stdout` của `appleboy/ssh-action`:** tuỳ chọn đó **không tồn tại ở
`@v1.2.0`** (đối chiếu `action.yml` của chính tag đó: 33 input, không có `capture_stdout`, không
có khối `outputs:`); nó chỉ có từ `v1.2.1`. Khai một input lạ chỉ sinh warning, `outputs.stdout`
sẽ là **chuỗi rỗng**, `PG_REMOTE_HOST` rỗng, và `${PG_REMOTE_HOST:?}` làm `docker compose` dừng —
deploy đỏ 100% mà nguyên nhân nằm cách đó ba bước.

Bước 3 vì vậy **không dùng ssh-action**, mà dùng `ssh` trần trong một step `run:` trên runner —
stdout bắt được tự nhiên, không phụ thuộc tính năng của action bên thứ ba:

```yaml
- name: vpn6 - chup anh truoc, tao DB, cap nhat permitopen
  id: vpn6
  env:
    SSH_KEY_VPN6_B64:  ${{ secrets.SSH_KEY_VPN6_B64 }}
    VPN6_HOST_KEY_B64: ${{ secrets.VPN6_HOST_KEY_B64 }}
    SSH_USER_VPN6:     ${{ secrets.SSH_USER_VPN6 }}
    SSH_HOST_VPN6:     ${{ secrets.SSH_HOST_VPN6 }}
  run: |
    install -m 600 /dev/null key && echo "$SSH_KEY_VPN6_B64" | base64 -d > key
    install -m 644 /dev/null known_hosts && echo "$VPN6_HOST_KEY_B64" | base64 -d > known_hosts
    ssh-keygen -y -f key > /dev/null
    SSHV6="ssh -i key -o StrictHostKeyChecking=yes -o UserKnownHostsFile=known_hosts $SSH_USER_VPN6@$SSH_HOST_VPN6"
    $SSHV6 "sudo /usr/local/bin/snapshot-vpn6.sh > /tmp/vpn6-before.txt"
    $SSHV6 sudo /usr/local/bin/create-opencode-db.sh
    $SSHV6 sudo /usr/local/bin/update-permitopen.sh > permitopen.out
    grep -oE '^PG_REMOTE_HOST=([0-9]{1,3}\.){3}[0-9]{1,3}$' permitopen.out >> "$GITHUB_OUTPUT"
```

Bốn chỗ trong khối này là **kết quả của luật L4**, đừng sửa lại thành bản "gọn hơn":

1. **`known_hosts` phải được tạo NGAY TẠI RUNNER.** `StrictHostKeyChecking=yes` mà thiếu file
   này thì `Host key verification failed` ngay lệnh `ssh` đầu tiên. Secret `VPN6_HOST_KEY_B64`
   trước đây chỉ được ghi ở phía **vpn4**, không phải phía runner — đúng loại lỗi mà L4(a)/(b)
   sinh ra để bắt.
2. **Redirect `> /tmp/vpn6-before.txt` nằm TRONG dấu nháy**, tức chạy ở **vpn6**. Để ngoài nháy
   thì file rơi về workspace của runner, còn bước 5b lại `diff` trên vpn6 → `No such file` →
   deploy đỏ 100% ở bước cuối, sau khi đã sửa `.env`, `authorized_keys`, tạo DB và dựng 3
   container. Hai lệnh còn lại **không** cần nháy vì không có redirect phía xa.
3. **`snapshot-vpn6.sh` chạy TRƯỚC `create-opencode-db.sh`.** Ảnh "trước" mà chụp sau hành động
   mutate đầu tiên thì mọi thay đổi do nó gây ra đã nằm trong baseline, và `diff` không bao giờ
   thấy — trong khi AC-21 lại đếm `pg_tables` bằng chính script đó.
4. **`ssh-keygen -y -f key`** bắt khoá hỏng ngay tại chỗ, đối xứng với phép kiểm ở phía vpn4.

`update-permitopen.sh` phải in **đúng một dòng** `PG_REMOTE_HOST=<ip>`. `grep -oE` vừa trích vừa
**validate định dạng IP**; không khớp thì `grep` trả exit 1 và **step 3 đỏ ngay** (shell của
`run:` là `bash -e`) — đỏ sớm là đúng ý đồ. **Đừng thêm `|| true`**: làm thế thì
`PG_REMOTE_HOST` rỗng sẽ trôi tới `docker compose` ở bước 4 và hỏng ở nơi khó truy hơn nhiều.

Không `tail -1`, không nội suy `${{ }}` vào trong nháy đơn: nội dung đó đến từ **máy khác**, một
dấu nháy trong đó là một đường tiêm lệnh vào runner.

Luật L1 (một lệnh một dòng) **không áp cho step `run:` của runner** — nó chỉ áp cho `script:` của
ssh-action. Biến `SSHV6` gom tham số chung là hợp lệ ở đây.

**Không được hardcode** `172.21.0.2`: làm thế thì cơ chế tự chữa IP ở §7.11.3 thành vòng lặp vô
nghĩa — admin nhận cảnh báo "chạy lại deploy để đọc lại IP", chạy lại, vẫn ghi IP cũ, tunnel vẫn
chết.

**Bước 4 — deploy trên vpn4** (`appleboy/ssh-action@v1.2.0`, `script_stop: true`). Mỗi dòng dưới
đây là một lệnh trọn vẹn:

Bước này cần **đủ hai khối**. `env:` cho giá trị, `envs:` chọn tên để chuyển tiếp sang vpn4 —
thiếu `env:` thì mọi biến sang tới nơi đều rỗng, và `docker login` ở dòng thứ ba đã đỏ:

```yaml
- name: vpn4 - deploy
  uses: appleboy/ssh-action@v1.2.0
  with:
    host: ${{ secrets.SSH_HOST_VPN4 }}
    username: ${{ secrets.SSH_USER }}
    key: ${{ secrets.SSH_KEY }}
    port: ${{ secrets.SSH_PORT || '22' }}
    script_stop: true
    command_timeout: 20m
    envs: GHCR_TOKEN,DEPLOY_REF,PG_TUNNEL_KEY_B64,VPN6_HOST_KEY_B64,PG_REMOTE_HOST,GATEWAY_TAG,OPENCODE_TAG,TUNNEL_TAG,OPENCODE_SERVER_PASSWORD,CLIPROXY_API_KEY,OPENCODE_PG_PASSWORD,TELEGRAM_BOT_TOKEN,TELEGRAM_ALLOWED_USER_IDS,TELEGRAM_ADMIN_USER_IDS
    script: |
      # ... xem bên dưới
  env:
    GHCR_TOKEN:                ${{ secrets.GHCR_TOKEN }}
    DEPLOY_REF:                ${{ github.ref_name }}
    PG_TUNNEL_KEY_B64:         ${{ secrets.PG_TUNNEL_KEY_B64 }}
    VPN6_HOST_KEY_B64:         ${{ secrets.VPN6_HOST_KEY_B64 }}
    PG_REMOTE_HOST:            ${{ steps.vpn6.outputs.PG_REMOTE_HOST }}
    GATEWAY_TAG:               ${{ github.sha }}
    TUNNEL_TAG:                ${{ github.sha }}
    OPENCODE_TAG:              ${{ vars.OPENCODE_TAG }}
    OPENCODE_SERVER_PASSWORD:  ${{ secrets.OPENCODE_SERVER_PASSWORD }}
    CLIPROXY_API_KEY:          ${{ secrets.CLIPROXY_API_KEY }}
    OPENCODE_PG_PASSWORD:      ${{ secrets.OPENCODE_PG_PASSWORD }}
    TELEGRAM_BOT_TOKEN:        ${{ secrets.TELEGRAM_BOT_TOKEN }}
    TELEGRAM_ALLOWED_USER_IDS: ${{ secrets.TELEGRAM_ALLOWED_USER_IDS }}
    TELEGRAM_ADMIN_USER_IDS:   ${{ secrets.TELEGRAM_ADMIN_USER_IDS }}
```

`DEPLOY_REF` lấy từ `github.ref_name` — **không** đặt mặc định `:-main`: deploy từ nhánh feature
mà âm thầm triển khai `main` là lỗi khó truy hơn nhiều so với việc fail ngay.
**`GATEWAY_TAG`/`TUNNEL_TAG` dùng `github.sha`, KHÔNG dùng `github.run_number`.** `run_number` là
bộ đếm **riêng cho từng workflow**, nên `run_number` của `deploy.yml` không bao giờ bằng
`run_number` của `build-gateway.yml`. Hậu quả có hai nhánh, nhánh thứ hai tệ hơn nhiều:
(1) tag không tồn tại → `docker compose pull` đỏ giữa bước 4, sau khi đã đụng vpn6; (2) **tag
trùng số tình cờ** (deploy #7 và build #7 cùng tồn tại) → pull thành công, deploy xanh, nhưng
**triển khai đúng một build khác** — không phép kiểm nào trong §37.3 hay bước 5 bắt được, và bảng
rollback §37.5.3 ("đặt lại `GATEWAY_TAG` cũ") cũng dựa trên giả định "tag = phiên bản mã" vốn đã
sai từ gốc. `github.sha` là **cùng một giá trị ở cả hai phía** cho cùng một commit nên tự khớp.

**Bước 1 phải kiểm tag tồn tại trước khi đụng vào máy nào:**
`docker manifest inspect ghcr.io/vanbienperu3107/opencode-telegram-gateway:${GATEWAY_TAG}` và
tương tự cho hai image kia. Đỏ ở runner rẻ hơn đỏ giữa bước 4 rất nhiều.

`OPENCODE_TAG` vẫn là biến repo (`vars`) vì image đó gắn với **phiên bản OpenCode đã ghim**, không
gắn với commit của repo này — nó chỉ build lại khi nâng version.

Script (mỗi dòng là một lệnh trọn vẹn — L1):

```bash
exec 9>/var/lock/vpn4-deploy
flock -w 600 9 || exit 1
echo "$GHCR_TOKEN" | docker login ghcr.io -u vanbienperu3107 --password-stdin
[ -d /opt/opencode/.git ] || git clone https://github.com/vanbienperu3107/TelegramAgent.git /opt/opencode
cd /opt/opencode
git fetch --all --prune
git reset --hard "origin/$DEPLOY_REF"
install -d -m 700 keys
install -m 600 /dev/null keys/pg_tunnel_key
echo "$PG_TUNNEL_KEY_B64" | base64 -d > keys/pg_tunnel_key
ssh-keygen -y -f keys/pg_tunnel_key > /dev/null
echo "$VPN6_HOST_KEY_B64" | base64 -d > keys/known_hosts
cp -f .env .env.bak 2>/dev/null || true
install -m 600 /dev/null .env
python3 scripts/gen-env.py > .env
set +x
CLIPROXY_API_KEY=$(python3 scripts/readenv.py CLIPROXY_API_KEY)
CLIPROXY_BASE_URL=$(python3 scripts/readenv.py CLIPROXY_BASE_URL)
export CLIPROXY_BASE_URL
[ -n "$CLIPROXY_API_KEY" ] || exit 1
[ -n "$CLIPROXY_BASE_URL" ] || exit 1
set -x
[ -d workspace/opencode-sandbox ] || git clone https://github.com/vanbienperu3107/opencode-sandbox.git workspace/opencode-sandbox
chown -R 1000:1000 /opt/opencode/workspace
cp -f opencode.json opencode.json.bak 2>/dev/null || true
docker compose pull
docker run --rm --user 0:0 --network edge -v /opt/opencode:/work -w /work -e CLIPROXY_API_KEY -e CLIPROXY_BASE_URL ghcr.io/vanbienperu3107/opencode-telegram-gateway:${GATEWAY_TAG} node /app/scripts/sync-models.js
chmod 644 opencode.json
python3 -m json.tool opencode.json > /dev/null
docker compose up -d pg-tunnel
i=0; until docker exec opencode-pg-tunnel pg_isready -h 127.0.0.1 -p 5433; do i=$((i+1)); [ "$i" -lt 30 ] || exit 1; sleep 2; done
docker compose run --rm --no-deps --entrypoint node telegram-gateway dist/migrate.js
docker run --rm -v /opt/opencode/opencode.json:/home/node/.config/opencode/opencode.json:ro ghcr.io/vanbienperu3107/opencode-server:${OPENCODE_TAG} node /opt/verify-opencode-config.js
docker compose up -d --remove-orphans
docker compose up -d --force-recreate opencode-server
```

Ghi chú từng chỗ dễ sai:

- **`/opt/opencode` là một git working copy của chính repo `TelegramAgent`** (§35.2). Dòng
  `[ -d …/.git ] || git clone …` là bắt buộc: không có nó thì lần deploy **đầu tiên** chết ngay
  ở `cd /opt/opencode`. §45.0 có ô checklist tương ứng cho lần cài tay.
- **Khoá SSH truyền dạng base64.** `envs:` của ssh-action là cơ chế `export NAME=VALUE` phẳng,
  giá trị **nhiều dòng bị cắt** — mà khoá ed25519 và output `ssh-keyscan -H` đều nhiều dòng.
  Thêm nữa `printf '%s'` **không thêm newline cuối**, và OpenSSH từ chối private key thiếu
  newline sau dòng `-----END …-----`. Base64 giải quyết cả hai. `ssh-keygen -y -f` ngay sau đó
  bắt khoá hỏng **tại chỗ**, thay vì để tunnel im lặng thử lại vô hạn 60 giây sau (§37.4).
- **`gen-env.py`** sinh `.env` bằng `python3` (có trên vpn4 — §0.1) thay vì `printf` nhiều dòng.
  Hợp đồng của nó: **đọc `.env.example` làm khuôn**, thay giá trị bí mật và giá trị sinh động,
  ghi ra `.env`. **Không liệt tay danh sách biến**: `env_file: .env` là nguồn env **duy nhất**
  của Gateway (§37) mà §6 định nghĩa hơn 30 biến; liệt tay thì sót là chuyện chắc chắn, và phép
  kiểm §37.3 chỉ so `${VAR:?}` nên không bắt được phần sót. §49 có test "mọi biến trong
  `.env.example` đều có mặt trong `.env` sinh ra".
- **Quy tắc ghi `.env`:** chỉ **một** cách hiểu file này — cú pháp dotenv của compose (`env_file:`),
  và `scripts/readenv.py` dùng đúng luật đó. `gen-env.py` chỉ cần tuân thủ dotenv: `KEY=value`,
  giá trị có ký tự đặc biệt thì bọc nháy kép và escape `"` `\`. Nó **escape** chứ không **từ
  chối**: `CLIPROXY_API_KEY` là secret có sẵn từ repo khác, ta không được chọn bộ ký tự của nó.
  Ràng buộc bộ ký tự ở §6 chỉ áp cho giá trị **do ta sinh ra** (`OPENCODE_PG_PASSWORD`), như một
  lớp phòng thủ thừa chứ không phải điều kiện đúng đắn.
- **Thay chỗ giữ chỗ:** `.env.example` có
  `DATABASE_URL=postgresql://opencode:__OPENCODE_PG_PASSWORD__@…` — tên trong `__…__` **phải khớp
  đúng tên biến/secret**, nếu không thì quy tắc "thay `__TÊN__` bằng giá trị tương ứng" không tra
  được về đâu cả
  — chỗ giữ chỗ nằm **bên trong** một giá trị, nên "thay giá trị bí mật" theo từng khoá là không
  đủ. `gen-env.py` phải thay mọi chuỗi dạng `__TÊN__` bằng giá trị tương ứng, và §49 có test
  "`.env` sinh ra không còn chuỗi `__…__` nào". Thiếu bước này thì Gateway kết nối bằng mật khẩu
  literal `__OPENCODE_PG_PASSWORD__` → lỗi 28P01, trong khi bước verify dùng `PGPASSWORD` riêng nên **vẫn
  xanh**: deploy xanh, bot chết.
- **`cp -f .env .env.bak`** trước khi ghi đè: §37.5.3 quay lui bằng cách `sed` trên `.env`, tức
  nó giả định bản cũ còn nguyên. `opencode.json` đã có `.bak`, `.env` cũng phải có.
- **Ba biến ở dòng `docker run` đến từ ba đường khác nhau, đừng gộp:** `$GATEWAY_TAG` từ `env:` +
  `envs:` của step; `$CLIPROXY_API_KEY` và `$CLIPROXY_BASE_URL` đọc từ `.env` bằng `readenv.py`
  ngay trong bước này. **`CLIPROXY_BASE_URL` phải `export`** — `docker run -e VAR` (không có `=`)
  chỉ lấy được biến **đã export**, còn phép gán trần chỉ tạo biến shell; tệ hơn, `[ -n "$VAR" ]`
  vẫn PASS nên chốt chặn không bắt được và container im lặng chạy thiếu baseURL.
  `CLIPROXY_API_KEY` chạy đúng chỉ vì nó có trong `envs:` nên đã được export sẵn — đối xứng giả.
- **Verify `opencode.json` TRƯỚC khi `up -d`**, không đợi bước 5: giữa `up -d` và bước verify,
  agent đã sống với cấu hình chưa kiểm. Nếu `sync-models.js` đánh rơi khối `permission` thì trong
  cả cửa sổ đó agent chạy theo mặc định OpenCode — đúng "lỗ hổng im lặng" ở §12.1.
- **`sync-models.js` chạy trong container gateway** (host không có `node` — §0.1), **`--user 0:0`**
  vì `/opt/opencode` thuộc `root` còn image gateway chạy non-root: không có cờ này thì script
  không ghi được `opencode.json`. Nó gọi **`http://cliproxy:8317/v1`** qua mạng `edge` — đường
  nội bộ, không phải cổng công cộng 28417 — vẫn kèm API key. Gọi thử từng model **đồng thời ≤ 3
  và chỉ probe model mới**, sinh khối `models`. **Khối `agent` KHÔNG do script này sinh** — nó
  không có nguồn dữ liệu nào (cliproxy `/v1/models` chỉ trả model); nếu §17.2 dòng 2 rơi vào
  nhánh dự phòng thì khối `agent` nằm **tĩnh trong `opencode.json.template`**, script chỉ chép
  qua. Vẫn thoả §52 quy tắc 4 vì Gateway không hard-code gì — nó hỏi OpenCode, và danh sách sửa
  được bằng cách sửa file cấu hình rồi deploy lại, không cần build lại image. Ghi model trượt ra
  `docs/models-unverified.md`.
- **`cp -f … 2>/dev/null || true`**: lần deploy đầu tiên chưa có `opencode.json`, `cp` trần sẽ
  exit 1 và giết cả script.
- **`--force-recreate opencode-server`** bắt buộc: `opencode.json` là bind mount, compose không
  phát hiện nội dung file đổi. Nếu §33.3 chọn **nhánh A+ hoặc B** thì thêm một dòng
  `docker compose up -d --force-recreate telegram-gateway` nữa.
- **Migration chạy trước khi bot polling**: `CMD` của image là `node dist/index.js`, nên đặt
  migration sau `up -d` là để một cửa sổ vài chục giây cho `/start` đập vào schema chưa tồn tại.
  Vòng `until … pg_isready` là bắt buộc vì `depends_on` cố ý dùng `service_started` (§37).
  `dist/migrate.js` vẫn phải có backoff riêng cho kịch bản AC-20b.

**Bước 5 — verify trên vpn4.** Mỗi dòng một lệnh:

```bash
exec 9>/var/lock/vpn4-deploy
flock -w 600 9 || exit 1
cd /opt/opencode
set +x
HEALTH_PORT=$(python3 scripts/readenv.py HEALTH_PORT)
OPENCODE_PG_PASSWORD=$(python3 scripts/readenv.py OPENCODE_PG_PASSWORD)
[ -n "$HEALTH_PORT" ] || exit 1
[ -n "$OPENCODE_PG_PASSWORD" ] || exit 1
set -x
test "$(ss -Hltn | awk '{print $4}' | grep -c ':4096$')" -eq 0
docker exec opencode-gateway getent hosts opencode-server
docker exec opencode-pg-tunnel pg_isready -h 127.0.0.1 -p 5433
set +x
docker exec -e PGPASSWORD="$OPENCODE_PG_PASSWORD" opencode-pg-tunnel psql -h 127.0.0.1 -p 5433 -U opencode -d opencode_remote -c "select 1"
set -x
j=0; until docker exec opencode-gateway wget -q --spider "http://127.0.0.1:$HEALTH_PORT/healthz"; do j=$((j+1)); [ "$j" -lt 20 ] || exit 1; sleep 3; done
docker exec opencode-server node /opt/verify-opencode-config.js
docker compose ps
test "$(free -m | awk '/^Mem:/{print $7}')" -gt 300
test "$(docker exec opencode-server opencode models | grep -c cliproxy)" -ge 1
docker inspect -f '{{.Name}} {{.RestartCount}} {{.State.StartedAt}}' derper edge-nginx caddy-edge cliproxy vpn-gw ts-vpngw ping-reporter-vpn4 ts-vpn4 > /tmp/baseline-after.txt
diff /tmp/baseline-before.txt /tmp/baseline-after.txt
```

Ghi chú:

- **`cd /opt/opencode` là dòng thứ ba, ngay sau `flock`.** Bước 5 là một step ssh-action riêng
  (L2), shell của nó khởi động ở `$HOME` chứ không phải thư mục của bước 4 — thiếu dòng này thì
  `docker compose ps` trả `no configuration file provided` và deploy đỏ 100%.
- **KHÔNG `source .env` ở bất kỳ bước nào** (cả bước 4 lẫn bước 5). Đây là quyết định đã chốt,
  không phải sở thích: `source` bằng shell biến `.env` thành file bị **hai** bộ phân tích khác
  nhau đọc (shell ở một đầu, `env_file:` của compose ở đầu kia), và **không tồn tại** quy tắc
  escape thoả cả hai — dạng `'\''` là phép nối chuỗi liền kề của shell, dotenv của compose không
  hiểu như vậy; ngược lại `$` trong giá trị bị shell nội suy còn dotenv thì không.
  Thay vào đó, mọi bước đọc **đúng những giá trị nó cần** bằng `scripts/readenv.py` — một script
  10 dòng dùng cùng luật phân tích với dotenv của compose. Kết quả: **chỉ còn một cách hiểu
  `.env`**, và §6 không cần ràng buộc bộ ký tự như điều kiện đúng đắn nữa (giữ lại chỉ như lớp
  phòng thủ thừa cho giá trị **do ta sinh ra**). `CLIPROXY_API_KEY` — secret của repo khác, ta
  không chọn được bộ ký tự — khi đó không còn là vấn đề.
- **Mọi giá trị đọc ra đều kiểm rỗng ngay** (`[ -n "$X" ] || exit 1`, viết phẳng theo L1). §6 đã
  cảnh báo `HEALTH_PORT` rỗng làm URL thành `127.0.0.1:/healthz` — hỏng im lặng; chốt chặn phải
  nằm ở đây chứ không phải 60 giây sau trong vòng `until`.
- **`psql` chạy trong `pg-tunnel`**, vì đó là image duy nhất có `postgresql-client` (§36).
  Dùng `PGPASSWORD` + tham số rời, **không** truyền chuỗi kết nối trên dòng lệnh: `set -x` sẽ
  in nguyên mật khẩu vào log của một repo **công khai**. Bọc `set +x` quanh đúng dòng đó.
- **`pg_isready` không chứng minh đăng nhập được** — nó chỉ nói "có ai trả lời giao thức". Thiếu
  dòng `psql` thì đổi mật khẩu mà quên `ALTER ROLE` sẽ cho deploy xanh toàn tập.
- **`verify-opencode-config.js`** được `COPY` vào image tại `/opt/` (§36.2). Nó kiểm 4 việc:
  file parse được · mọi khoá `permission` thuộc danh sách hợp lệ · `bash["*"]`, `webfetch`,
  `websearch`, `external_directory` đều là `ask` · `lsp` là `deny` · **đủ 13 khoá**.
- **`opencode models`**: bọc trong `test … -ge 1` và bỏ neo `^` — `grep -c` trả exit 1 khi đếm 0,
  và **định dạng đầu ra chưa được chụp thật** (Milestone 0 phải chụp).
- **`grep -c ':4096$'`**: cũng vì lý do trên mà phải bọc trong `test … -eq 0`; ở đây 0 mới là
  trạng thái đúng.

**Bước 5b — ảnh chụp SAU của vpn6.** Chạy **trên runner** bằng `ssh` trần, đúng như bước 3 —
không dùng ssh-action. Cả hai file `/tmp/vpn6-{before,after}.txt` đều nằm **trên vpn6**, và `diff`
cũng chạy **trên vpn6**; đó là lý do redirect phải nằm trong dấu nháy ở cả hai bước:

```yaml
- name: vpn6 - chup anh sau
  if: always()          # PHẢI chạy cả khi bước 5 đỏ: đây là bằng chứng duy nhất cho AC-21 phía
                        # vpn6, và §37.5.5 lấy nó làm phép kiểm chứng cho "deploy chết giữa
                        # bước 4". Bỏ if: always() thì đúng lúc cần bằng chứng nhất lại không
                        # có, phải SSH tay vào máy đang giữ headscale.
  env:
    SSH_KEY_VPN6_B64:  ${{ secrets.SSH_KEY_VPN6_B64 }}
    VPN6_HOST_KEY_B64: ${{ secrets.VPN6_HOST_KEY_B64 }}
    SSH_USER_VPN6:     ${{ secrets.SSH_USER_VPN6 }}
    SSH_HOST_VPN6:     ${{ secrets.SSH_HOST_VPN6 }}
  run: |
    install -m 600 /dev/null key && echo "$SSH_KEY_VPN6_B64" | base64 -d > key
    install -m 644 /dev/null known_hosts && echo "$VPN6_HOST_KEY_B64" | base64 -d > known_hosts
    ssh-keygen -y -f key > /dev/null
    SSHV6="ssh -i key -o StrictHostKeyChecking=yes -o UserKnownHostsFile=known_hosts $SSH_USER_VPN6@$SSH_HOST_VPN6"
    $SSHV6 "sudo /usr/local/bin/snapshot-vpn6.sh > /tmp/vpn6-after.txt"
    $SSHV6 "diff /tmp/vpn6-before.txt /tmp/vpn6-after.txt"
```

**Khối `env:` và hai dòng dựng `key`/`known_hosts` phải lặp lại ở đây, không được dùng lại của
bước 3.** Nói cho chính xác về cơ chế, vì lý do sai từng dẫn thẳng tới lỗi thật: **biến shell**
(như `SSHV6`) không sống sang step khác, còn **file thì sống** — mọi step trong cùng một job dùng
chung `$GITHUB_WORKSPACE`. Nhưng file `key` của bước 3 là **khoá vpn6**; dùng lại nó cho máy khác
là sai máy, không phải sai vòng đời. Luật: **mỗi step tự khai đủ khoá của đúng máy nó nói chuyện**
(L2 + L4(c)).

Phải là bước riêng **sau bước 5**: hai ảnh chụp cách nhau vài giây trong cùng bước 3 thì `diff`
rỗng mà không chứng minh được gì.

**Bước 5c — kiểm từ Internet** (step `run:` trên runner, **không** trên vpn4): AC-19 đòi chứng
minh cổng 4096 không mở ra Internet, mà lệnh `ss` ở bước 5 chạy trên chính vpn4 nên không chứng
minh được điều đó. Mượn đúng khuôn của `deploy-cliproxy.yml`:

```yaml
- name: Kiem tu Internet
  env:
    SSH_HOST_VPN4: ${{ secrets.SSH_HOST_VPN4 }}
  run: |
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://$SSH_HOST_VPN4:4096/" || true); CODE=${CODE:-000}
    test "$CODE" = "000"
```

Cái bẫy đã biết: viết `|| echo 000` cho ra `000000` vì `curl` thất bại đã tự in `000`.

**Bước 5d — giữ lại `models-unverified.md`** (step `run:` trên runner). Mục đích: lưu **lịch sử
theo từng run** để so được giữa các lần deploy — bản trên vpn4 chỉ có trạng thái mới nhất và bị
ghi đè mỗi lần chạy. Không có nó thì mỗi lần deploy lại probe từ đầu, đốt quota OAuth mà không ai
biết model nào đang hỏng.

**`sync-models.js` LUÔN ghi file này, rỗng cũng ghi** — quyết định, không phải tuỳ chọn: nếu chỉ
ghi khi có model trượt thì trên đường happy-path (mọi model đều qua) `scp` không tìm thấy file và
step đỏ dù mọi thứ đều tốt.

```yaml
- name: Giu models-unverified
  env:
    SSH_KEY:           ${{ secrets.SSH_KEY }}
    VPN4_HOST_KEY_B64: ${{ secrets.VPN4_HOST_KEY_B64 }}
    SSH_USER:          ${{ secrets.SSH_USER }}
    SSH_HOST_VPN4:     ${{ secrets.SSH_HOST_VPN4 }}
    SSH_PORT:          ${{ secrets.SSH_PORT || '22' }}
  run: |
    install -m 600 /dev/null key_vpn4 && echo "$SSH_KEY" > key_vpn4
    ssh-keygen -y -f key_vpn4 > /dev/null
    install -m 644 /dev/null known_hosts_vpn4 && echo "$VPN4_HOST_KEY_B64" | base64 -d > known_hosts_vpn4
    scp -P "$SSH_PORT" -i key_vpn4 -o StrictHostKeyChecking=yes -o UserKnownHostsFile=known_hosts_vpn4 "$SSH_USER@$SSH_HOST_VPN4:/opt/opencode/docs/models-unverified.md" .
- uses: actions/upload-artifact@v4
  with: { name: models-unverified, path: models-unverified.md }
```

Ba chỗ dễ sai ở step này, đều là hệ quả của luật L4 (đổi máy → rà lại bốn thứ):

- **Khoá phải là khoá vpn4** (`secrets.SSH_KEY`), không phải file `key` còn sót từ bước 3 — file
  đó tồn tại thật trong workspace nhưng là **khoá vpn6**, dùng nhầm thì `scp` thất bại với thông
  điệp rất khó đọc.
- **`known_hosts_vpn4` phải được tạo ở đây**, từ secret riêng `VPN4_HOST_KEY_B64`.
- **Không bọc `|| true` và không dùng `if-no-files-found: ignore`.** Hai thứ đó nuốt lỗi và làm
  step luôn xanh trong khi artifact không bao giờ tồn tại — đúng thứ mục này sinh ra để tránh.
  Nếu chấp nhận thiếu file khi chưa có model nào trượt thì `sync-models.js` phải luôn tạo file
  (rỗng cũng được), chứ không phải để CI nuốt lỗi.

**Bước 6 — tiêu chí huỷ deploy (abort criteria)** — chạm một trong hai thì dừng ngay:

- `RestartCount` của `derper` (hoặc `cliproxy`) tăng
- `free -m` khả dụng < 200 MB

Hai ngưỡng RAM khác nhau và cố ý: **300 MB** là mức *chấp nhận được* để coi deploy thành công
(bước 5 `test … -gt 300` đỏ nếu thấp hơn); **200 MB** là mức *nguy hiểm* buộc huỷ và gỡ stack
ngay. Khoảng 200–300 MB là vùng "deploy đỏ nhưng chưa cần gỡ".

Quy trình huỷ, đúng thứ tự: §37.5.4 (gỡ stack bằng `docker compose down`) → kiểm `derper` hồi
lại → nếu đã kịp đụng vpn6 thì §37.5.1 → báo cáo. **Không** chạy §37.5.3 (quay lui tag) trong
tình huống này: vấn đề là tài nguyên máy, không phải phiên bản image.

### 37.2.3 Bảng đối chiếu lệnh — luật L3

| Lệnh / đường dẫn | Chạy ở đâu | Bằng chứng tồn tại |
|---|---|---|
| coreutils/util-linux cơ bản (`test`, `echo`, `cp`, `chmod`, `sleep`, `grep`, `free`, `install`, `base64`) + `flock`, `ss`, `awk`, `diff`, `curl`, `git`, `chown`, `python3`, `docker`, `ssh-keygen` | host vpn4 | `command -v` đã kiểm — §0.1 (coreutils/openssh có sẵn trên Ubuntu 24.04) |
| `ssh`, `ssh-keygen`, `base64`, `install`, `grep`, `curl` | **runner GitHub** (`ubuntu-latest`) | có sẵn trong image runner tiêu chuẩn — bước 3, 5b, 5c chạy ở đây, không phải trên vpn4 |
| `scripts/gen-env.py`, `scripts/readenv.py` | host vpn4, `python3`, cwd = `/opt/opencode` | file trong repo (§5), có mặt sau `git reset --hard` |
| `scp` | runner GitHub | bước 5d kéo `models-unverified.md` về; có sẵn trong image runner |
| `diff`, `docker`, `sudo`, `psql` (qua `docker exec`) | **host vpn6** | ba script whitelist + `diff` ở bước 5b chạy tại đây. §0.2 phải bổ sung kết quả `command -v` cho máy này — hiện chưa kiểm kê |
| `dist/migrate.js` | container gateway | build từ `src/migrate.ts` (§5); §36.1 phải giữ nó trong image chứ không chỉ `dist/index.js` |
| `/opt/opencode/.git` | host vpn4 | dòng `git clone` idempotent ở đầu bước 4 + ô checklist §45.0 |
| `jq` | — | **KHÔNG có trên vpn4** → không dùng ở bất kỳ đâu; thay bằng `python3 -m json.tool` hoặc `node` trong container |
| `getent`, `wget` | `telegram-gateway` | busybox của `node:22-alpine` |
| `pg_isready`, `psql` | `pg-tunnel` | image khai `postgresql-client` (§36) |
| `node`, `/opt/verify-opencode-config.js` | `opencode-server` | image cài `opencode-ai` qua npm; script được `COPY` vào (§36.2) |
| `opencode models` | `opencode-server` | lệnh có trong CLI chính thức (đối chiếu 2026-08-14) |
| `node /app/scripts/sync-models.js` | container gateway (`docker run --rm`) | script nằm trong image gateway (§36.1) |

`opencode config validate` **không tồn tại** — CLI chỉ có `agent, attach, auth, github, mcp,
models, run, serve, session, stats, export, import, web, acp, plugin, pr, db, debug, uninstall,
upgrade`. Với `script_stop: true`, một lệnh không tồn tại = **deploy đỏ 100%**.

vpn4 **không có watchtower**, nên không có cơ chế tự cập nhật: mỗi lần đổi image đều phải chạy
workflow. Đây là chủ đích — không để một agent có quyền `bash` được tự nâng cấp chính nó.
## 37.3 CI kiểm tra trước khi merge

Repo `TelegramAgent` là **public**, và stack này chạy trên máy hạ tầng. CI phải chặn được các
lỗi sau, mỗi lỗi là một bài kiểm thử:

| Kiểm tra | Chặn điều gì |
|---|---|
| Quét secret trong diff (token bot `\d{8,10}:AA…`, `sk-`, `ghp_`, chuỗi kết nối Postgres) | Lộ bí mật trên repo công khai |
| `docker-compose.yml` không có `ports:` trong `opencode-server` | Lộ shell của agent ra host/Internet (§34) |
| Mọi service đều có `mem_limit` và `logging.max-size` | OOM giết `derper`; log phình như vpn6 (2.5 GB) |
| **Mọi `${VAR:?}` trong compose đều có mặt trong `.env.example`** | Deploy đỏ 100% vì quên một biến (§6.2) |
| Lệnh trong healthcheck có thật trong image tương ứng | `pg_isready`/`wget`/`bash` không tồn tại → container vĩnh viễn unhealthy |
| Mount của `telegram-gateway` nằm trong tập cho phép: rỗng (nhánh A), `./workspace:ro` (B), `./opencode.json:ro` (A+) — §33.3 | Nhánh dự phòng bị CI chặn đúng lúc cần dùng |
| Không mount `/`, `docker.sock`, `/opt/deployHeadscale` | Agent tự huỷ hạ tầng, mất token OAuth |
| Không có tag `:latest` trong compose | Deploy không tái lập được |
| Script workflow không chứa heredoc / `if…else` nhiều dòng | Deploy chết im lặng (§37.2) |
| **Mọi lệnh KHÔNG-HIỂN-NHIÊN trong workflow có dòng bằng chứng trong bảng §37.2.3** (coreutils/util-linux cơ bản được allowlist sẵn, không cần khai từng cái) — đối chiếu §0.1, §36, và hàng "runner" | Lớp lỗi đã tái phát 3 lần: `psql` không có trong image Gateway, `opencode config validate` không tồn tại, `jq` không có trên vpn4. Với `script_stop: true` mỗi cái là deploy đỏ 100% |
| Migration chỉ additive. Phạm vi luật: **chỉ áp cho `ALTER TABLE … ADD COLUMN`** (bắt buộc kèm `DEFAULT` nếu `NOT NULL`), và cấm `DROP`/`RENAME` cột hoặc bảng. **`CREATE TABLE` KHÔNG thuộc phạm vi** — bảng mới thì `NOT NULL` thoải mái | Không có down-migration → quay lui tag cũ sẽ hỏng (§37.5.3). Không thu hẹp phạm vi thì migration khởi tạo §7 (10 cột `NOT NULL`) làm CI đỏ ngay lần đầu |
| Unit + integration test (Vitest) | Hồi quy chức năng |
| Job mutation riêng (Stryker), ngưỡng ≥ 75% | Test xanh nhưng không bắt được lỗi thật (§49) |
| **Mọi `$VAR` có nguồn GIÁ TRỊ thật: `env:` của chính step, `.env` đọc trong chính step, hoặc gán trước đó. Với step ssh-action phải kiểm ĐỦ HAI TẦNG: tên có trong `envs:` **và** được định nghĩa trong `env:`** | `$OPENCODE_PG_PASSWORD` từng được dùng ở bước verify trong khi không tồn tại ở đâu → deploy đỏ 100% |
| **Không có cấu trúc trải nhiều dòng nào** trong `script:` (heredoc, chuỗi trích dẫn nhiều dòng, if/else, for/while, nối dòng bằng `\`) | ssh-action chèn dòng exit-code sau mỗi dòng → chết im lặng (§0.6 quy tắc 4) |

Chuẩn kiểm thử giữ nguyên như §49, chạy trên GitHub Actions.

---

## 37.4 Vận hành và rủi ro

| Rủi ro | Dấu hiệu nhận biết | Xử lý |
|---|---|---|
| Tunnel PostgreSQL đứt | `/healthz` báo `db: down` trong thân JSON (mã vẫn 200 — §6.1); Telegram trả lỗi DB | `autossh` (`AUTOSSH_GATETIME=0`) tự dựng lại trong ~45 s; quá 3 phút thì admin nhận cảnh báo, kiểm `sshd` của vpn6 và `permitopen` |
| **Host key của vpn6 đổi** (dựng lại máy, xoay khoá) | `pg_isready` đỏ vĩnh viễn; log tunnel báo host key mismatch | `StrictHostKeyChecking=yes` + `VPN6_HOST_KEY_B64` ghim cứng nên tunnel chết **vĩnh viễn**, còn `autossh` (`GATETIME=0`) thử lại vô hạn mà không bao giờ báo lỗi cuối. Sửa: chạy lại `ssh-keyscan -H 45.119.87.220`, cập nhật secret `VPN6_HOST_KEY_B64`, deploy lại |
| Healthcheck gõ cửa DB dùng chung | — | Đã cân nhắc: `pg_isready` 60 s/lần = 1440 kết nối/ngày tới `derp-postgres`. Chi phí nhỏ so với việc phát hiện tunnel chết, nhưng **không** hạ xuống dưới 60 s vì đó là DB của headscale |
| vpn4 hết RAM | `free -m` khả dụng < 200 MB, container bị restart | Hạ `mem_limit` của `opencode-server`; tuyệt đối không gỡ `mem_limit` của service khác |
| cliproxy hết quota | HTTP 429/403 kéo dài, task treo | Kiểm tra `auths/`, đăng nhập lại theo `deployHeadscale/cliproxy/README.md` §4 |
| Log phình đĩa | `df -h` tăng nhanh | Đã chặn bằng `max-size 10m × 3` cho mỗi service |
| **DB không được backup** | — | **Việc phải làm:** thêm `opencode_remote` vào `/opt/dashboard-vn/backup-db.sh` trên vpn6, hiện script chỉ `pg_dump` DB `derp` |
| Agent push nhầm vào `main` | — | **Không áp dụng ở V1**: agent không được cấp khoá push nào (§33.1). Bật Phase 2 thì phải thêm secret + mount `:ro` + policy nhánh |
| Agent gọi ra Internet tuỳ ý | Log lệnh `bash` bất thường | Chấp nhận có ý thức ở V1 (§34.1) — bù bằng `bash` ở mức **ask** (§27) và audit log |
| Deploy đè lên nhau | Workflow treo hoặc lỗi lock dpkg/docker | `concurrency` **chỉ có tác dụng trong cùng repo** — các stack vpn4 khác nằm ở repo `deployHeadscale` nên không chung hàng đợi. Khoá thật là `flock /var/lock/vpn4-deploy` trong script ssh-action (§37.2) |

**Chuyển sang máy khác** (khi nào vpn4 hết chỗ): stack này chỉ phụ thuộc vào (1) mạng docker
`edge` có `cliproxy`, (2) đường SSH tới vpn6, (3) thư mục `/opt/opencode`. Chuyển máy = tạo lại
3 thứ đó rồi đổi secret `SSH_HOST_VPN4` — không có ràng buộc nào khác vào phần cứng vpn4.

---

## 37.5 Rollback

Mỗi hành động không thể hoàn tác nhẹ nhàng phải có đường lui viết sẵn. Đọc mục này **trước khi**
chạy deploy lần đầu, không phải lúc đang cháy.

## 37.5.1 Trước khi đụng vào vpn6 (chỉ tạo DB + user)

```bash
# Ảnh chụp an toàn — chạy trên vpn6
docker exec derp-postgres pg_dump -U derp -d derp      --format=custom -f /tmp/derp-before.dump
docker exec derp-postgres pg_dump -U derp -d headscale --format=custom -f /tmp/hs-before.dump
docker inspect derp-postgres > /root/pg-inspect-before.json
```

Rollback: `DROP DATABASE opencode_remote; DROP ROLE opencode;` + `deluser pgtunnel`. Vì phương án
đã chọn **không sửa compose và không recreate container** (§7.11.1), không có gì khác phải hoàn
tác trên vpn6 — đó chính là lý do chọn phương án này.

Kiểm chứng sau rollback: `headscale nodes list` chạy được, dashboard trả 200.

## 37.5.2 Sau khi sửa `backup-db.sh`

Script backup hỏng thì backup DB `derp` **dừng âm thầm** — không ai biết cho tới lúc cần khôi
phục. Bắt buộc:

```bash
cp /opt/dashboard-vn/backup-db.sh /opt/dashboard-vn/backup-db.sh.bak-<ngày>
# sửa xong PHẢI chạy tay một lần và kiểm đủ 2 file dump được sinh ra
bash /opt/dashboard-vn/backup-db.sh && ls -la <thư mục backup>
```

Rollback: `cp` ngược lại bản `.bak` rồi chạy tay xác nhận.

## 37.5.3 Quay lui image trên vpn4

Tag theo `run_number` nên quay lui là ghim lại số cũ — cùng cơ chế "pin build" đang dùng cho
tính năng client auto-update:

```bash
cd /opt/opencode
cp .env .env.bak
sed -i 's/^GATEWAY_TAG=.*/GATEWAY_TAG=<run_number cũ>/' .env
sed -i 's/^OPENCODE_TAG=.*/OPENCODE_TAG=<tag cũ>/' .env
sed -i 's/^TUNNEL_TAG=.*/TUNNEL_TAG=<run_number cũ>/' .env
docker compose up -d
```

Đây là lý do §37 cấm tag trôi: `stable` không quay lui được.

**Nhưng ghim tag cũ KHÔNG quay lui được schema.** Tài liệu này không có down-migration ở bất kỳ
đâu, nên nếu bản mới đã chạy migration thì Gateway cũ có thể không tương thích với schema mới.
Hai ràng buộc bắt buộc:

1. **Migration chỉ được additive (expand-only) ở V1.** Phạm vi luật phải phát biểu giống hệt
   §37.3, đừng viết khác đi: **chỉ áp cho `ALTER TABLE … ADD COLUMN`** (kèm `DEFAULT` nếu
   `NOT NULL`), và cấm `DROP`/`RENAME` cột hoặc bảng. **`CREATE TABLE` không thuộc phạm vi** —
   áp cho cả `CREATE TABLE` thì migration khởi tạo §7 (hơn 10 cột `NOT NULL`) làm CI đỏ ngay lần
   đầu. CI có phép kiểm tĩnh cho luật này (§37.3). Nhờ vậy phiên bản N vẫn chạy được trên
   schema N+1.
2. **Phép kiểm chứng sau khi quay lui không được là `/healthz` trả 200** — §6.1 quy định nó trả
   200 **kể cả khi mất DB hoàn toàn**, nên nó không bao giờ đỏ. Dùng:

   ```bash
   docker exec opencode-gateway wget -qO- "http://127.0.0.1:$HEALTH_PORT/healthz" | grep '"db":"up"'
   ```

   cộng một phép thử thật từ Telegram: gõ `/start` và thấy dashboard.

## 37.5.4 Gỡ toàn bộ stack

```bash
cd /opt/opencode && docker compose down
```

Không đụng tới `derper`, `cliproxy`, `edge-nginx`, `caddy-edge` vì stack này chỉ **tham gia**
mạng `edge` chứ không sở hữu. Sau khi `down`, kiểm `docker network inspect edge` vẫn còn và
`cliproxy` vẫn `healthy`.

## 37.5.5 Bảng tra nhanh

| Đã làm gì | Quay lui thế nào | Kiểm chứng sau khi quay lui |
|---|---|---|
| Tạo DB + role trên vpn6 | `DROP DATABASE` + `DROP ROLE` | `headscale nodes list` chạy được |
| Thêm user `pgtunnel` | `deluser pgtunnel && rm -rf /home/pgtunnel` | `ss -tlnp` không còn forward lạ |
| Sửa `backup-db.sh` | `cp` bản `.bak` | Chạy tay, thấy đủ file dump |
| Deploy image mới | Đặt lại `GATEWAY_TAG` / `OPENCODE_TAG` / `TUNNEL_TAG` cũ + `up -d` | `/healthz` có `"db":"up"` **và** `/start` trên Telegram trả dashboard — KHÔNG dùng "trả 200" vì §6.1 quy định 200 kể cả khi mất DB |
| Sinh `opencode.json` | `cp opencode.json.bak opencode.json` + `--force-recreate opencode-server` | `python3 -m json.tool` parse được, `/model` có danh sách |
| Sửa `permitopen` trên vpn6 | `cp authorized_keys.bak authorized_keys` | `pg_isready` qua tunnel xanh lại |
| Cài 3 script + sudoers trên vpn6 | `rm /usr/local/bin/{update-permitopen,create-opencode-db,snapshot-vpn6}.sh` + xoá dòng sudoers | `sudo -l -U <user>` không còn dòng nào |
| Cron dọn uploads trên vpn4 | `crontab -r -u <user>` hoặc xoá dòng | `crontab -l` sạch |
| Thêm dòng vào `pg_hba.conf` (§7.11.2) | Xoá dòng vừa thêm + `SELECT pg_reload_conf()` | `RestartCount` của `derp-postgres` không đổi; headscale vẫn chạy |
| Sinh `.env` hỏng | `cp .env.bak .env` + `docker compose up -d` | `/healthz` có `"db":"up"` |
| Deploy chết giữa bước 4 | Chạy §37.5.4 (gỡ stack) rồi §37.5.1 nếu đã kịp đụng vpn6; `.env` và `opencode.json` khôi phục từ `.bak` | `derper` RestartCount không đổi; `snapshot-vpn6.sh` diff rỗng |
| Cả stack gây sự cố | `docker compose down` | `derper` `RestartCount` không đổi, `free -m` hồi lại |

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
/reload    Làm mới cache project/user từ DB — CHỈ role admin (§7.10)
/help      Help
```

`/reload` là mắt xích duy nhất chống lệch cache khi quản trị viên `INSERT` project thẳng vào DB
(§7.10, §33.1). Thiếu nó thì project mới chỉ xuất hiện sau khi khởi động lại Gateway. Kiểm tra
`telegram_users.role = 'admin'` trước khi thực thi; file `bot/commands/reload.ts` (§5).

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

**V1 trên vpn4: đúng MỘT task đang chạy trên toàn hệ thống**, không phải một task mỗi session.

**Nguồn chân lý của khoá là biến trong RAM của Gateway**, không phải cột `running` trong câu
bundle (§7.10). Lý do: `INSERT tasks` là ghi bất đồng bộ (§8.2), nên cột đó **trễ theo thiết kế**
— hai prompt liên tiếp đều có thể thấy `running = 0` và cùng được nhận. `bundle.running` chỉ
dùng đúng một chỗ: bước hoà giải lúc khởi động, khi RAM chưa có gì.

Đây là ràng buộc RAM, không phải lựa chọn thiết kế: `opencode-server` bị chặn 512 MB trong tổng
1968 MB của máy (§37.1); hai task song song là hai lần ngân sách bộ nhớ và sẽ đẩy máy vào swap
hoặc OOM — trên máy đang chạy DERP relay của cả fleet.

Khi có task khác đang chạy, prompt mới nhận phản hồi ngay lập tức (không xếp hàng ngầm):

```text
⚠️ Đang có một task chạy.

[ 🛑 Huỷ task hiện tại ]
[ 📊 Xem trạng thái ]
```

Nới lên nhiều task song song chỉ sau khi đo lại RAM thật (§37.1 quy tắc 5).

Khuyến nghị gốc (áp dụng khi đã nới):

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
❌ Telegram attachment exceeds 5 MB.
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

- [ ] `git clone https://github.com/vanbienperu3107/TelegramAgent.git /opt/opencode` một lần trên
      vpn4 (deploy dùng `cd /opt/opencode` + `git reset --hard`; thiếu bước này thì lần deploy
      đầu chết ngay dòng thứ tư)
- [ ] Tạo **repo variable** `OPENCODE_TAG` = phiên bản opencode đã ghim, **khớp đúng tag mà
      `build-opencode-server.yml` đẩy lên GHCR**. Đây là `vars`, không phải secret, nên bước 1
      của deploy phải kiểm riêng — thiếu nó thì `${OPENCODE_TAG:?}` dừng `docker compose pull`
      giữa bước 4
- [ ] Secret `VPN4_HOST_KEY_B64` (`ssh-keyscan -H <vpn4> | base64 -w0`) cho bước 5d
- [ ] Xác nhận version `appleboy/ssh-action` đang ghim **không** phụ thuộc `capture_stdout`
      (tuỳ chọn đó chỉ có từ v1.2.1; bước 3 đã chuyển sang `ssh` trần trên runner — §37.2)
- [ ] Chạy `command -v diff sudo docker` trên vpn6, dán kết quả vào §0.2 — bảng L3 §37.2.3 hiện
      ghi "chưa kiểm kê" ở cột bằng chứng, mà bằng chứng rỗng thì phép kiểm CI vẫn cho qua
- [ ] Đo `pg_hba.conf` của `derp-postgres` **trước mọi việc khác** (§7.11.2) — nếu không cho dải
      `172.21.0.1` thì QĐ-7 sập giữa chừng
- [ ] Tạo repo `vanbienperu3107/opencode-sandbox` (PUBLIC, **project TypeScript nhỏ có
      `tsconfig.json` + vài file `.ts`** — không phải README suông, xem §33.1) — làm trước,
      vì bước clone workspace phụ thuộc vào nó
- [ ] Tạo DB `opencode_remote` + role `opencode` (§4.1) — **không** sửa compose vpn6, **không**
      publish cổng, **không** recreate `derp-postgres`
- [ ] Thêm `opencode_remote` vào `/opt/dashboard-vn/backup-db.sh` + chạy tay xác nhận (§37.5.2)
- [ ] User `pgtunnel` + khoá SSH riêng: `restrict,**port-forwarding**,permitopen="172.21.0.2:5432",command="/bin/false"` — thiếu `port-forwarding` là tunnel không bao giờ lên (§7.11.2)
- [ ] `known_hosts` của vpn6 (`ssh-keyscan -H … | base64 -w0`) thành secret `VPN6_HOST_KEY_B64`
- [ ] Image `pg-tunnel` + workflow build riêng; tunnel sống với healthcheck
- [ ] Image `opencode-server` + workflow build riêng; go/no-go alpine vs bookworm (§36.2)
- [ ] Image gateway + workflow build riêng; tag theo `run_number`, không tag trôi
- [ ] `docker login ghcr.io` trên vpn4 (secret `GHCR_TOKEN`)
- [ ] `opencode.json` trỏ provider `cliproxy` → `http://cliproxy:8317/v1`, gọi thật ra kết quả
- [ ] Bước đồng bộ model có **gọi thử từng model**, đồng thời ≤ 3, chỉ probe model mới (§12.1)
- [ ] `opencode.json` sinh ra có khối `permission` đúng tên khoá + `scripts/verify-opencode-config.js` bake vào image và chạy được (§12.1, §37.2)
- [ ] Chụp `docs/opencode-events-sample.jsonl` và ánh xạ sự kiện SSE (§17.2)
- [ ] Đo RAM **dưới tải** rồi ghi số thật vào §37.1 (không để nguyên 512m/256m phỏng đoán)
- [ ] `git clone` repo sandbox vào `/opt/opencode/workspace/opencode-sandbox` + `chown 1000:1000`
- [ ] Bước chạy migration trong deploy, hoàn tất **trước khi** bot polling
- [ ] Tách mạng `db_net`: `opencode-server` không nhìn thấy cổng 5433 (§37)
- [ ] `mem_limit` + `pids_limit` + `logging` đủ cho cả 3 service; RAM khả dụng > 300 MB sau khi lên
- [ ] Workflow deploy + ảnh chụp baseline trước/sau + tiêu chí huỷ deploy (§37.2)
- [ ] `concurrency: deploy-vpn4-host` (chỉ chống chính repo này chạy 2 lần) **+ `flock /var/lock/vpn4-deploy`** trong script — `concurrency` KHÔNG xếp hàng được với repo `deployHeadscale` (§37.2)
- [ ] §37.5 Rollback đọc được và đã thử ít nhất bước gỡ stack
- [ ] `flock /var/lock/vpn4-deploy` là **dòng đầu tiên** của script trên vpn4 (§37.2)
- [ ] Tạo **user deploy** trên vpn6 (`SSH_USER_VPN6`) + `authorized_keys` từ `SSH_KEY_VPN6_B64` —
      khác hoàn toàn user `pgtunnel` (user kia có `command="/bin/false"`, không chạy được gì)
- [ ] Sudoers cho user đó, **bắt buộc `NOPASSWD`**, đúng 3 script (§6.3) — thiếu `NOPASSWD` là
      bước 3 đỏ 100% vì `ssh … sudo` không có TTY
- [ ] Ba secret dạng base64: `SSH_KEY_VPN6_B64`, `VPN6_HOST_KEY_B64`, `PG_TUNNEL_KEY_B64`
      (sinh bằng `base64 -w0 < file`) — giá trị nhiều dòng qua `envs:` sẽ bị cắt
- [ ] Script whitelist trên vpn6: `update-permitopen.sh`, `create-opencode-db.sh`, `snapshot-vpn6.sh`
      (đều không nhận tham số hoặc validate tham số bằng regex) + sudoers tương ứng (§6.3)
- [ ] Cron trên vpn4 dọn `.opencode-telegram/uploads` (`find -mtime +7 -delete`, §33)
- [ ] Milestone 0 trả lời: `permission.lsp = deny` có thật sự ngăn spawn language server không (§27)
- [ ] Đối chiếu **mọi lệnh** trong workflow với §0.1 + §36 trước khi merge (§37.3)

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
GitHub integration (agent tự commit/push — V1 chỉ đọc/sửa file, xem §33.1)
CI/CD integration (bot điều khiển pipeline của repo khác)
multi-server OpenCode orchestration
full RBAC
billing
model cost accounting
```

**Lưu ý để không hiểu nhầm:** "production deployment automation" ở đây **không** bao gồm
workflow deploy chính stack này lên vpn4 — cái đó là **bắt buộc** (§37.2, §45.0). Thứ nằm ngoài
phạm vi là việc bot đi deploy hộ các hệ thống khác.

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

Given a Telegram screenshot < 5 MB (trần dẫn xuất, §6)

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

**Biên đo:** đếm truy vấn **trên đường đi tới hàm gửi tin nhắn trạng thái**, loại trừ truy vấn
do hàng đợi nền flush (§7.10 flush theo lô "≥50 dòng hoặc mỗi 2 giây" — một lần flush rơi vào
cửa sổ đo sẽ làm test đỏ ngẫu nhiên nếu không loại trừ).

**Đo bằng máy, không đo bằng tay:** test tự động dùng driver DB bọc thêm 307 ms cho mỗi lượt và
**đếm số truy vấn** phát sinh trong luồng prompt. Khẳng định: `queryCount ≤ 2` và tổng thời gian
tới lúc gửi tin nhắn trạng thái `≤ 1000 ms`. Chạy trong CI, không phải quan sát bằng mắt.

---

## AC-19 OpenCode không lộ ra ngoài

Trên vpn4, sau khi deploy:

```text
ss -tlnp | grep ':4096'   → không có kết quả
```

và gọi `http://149.104.66.174:4096` từ Internet phải thất bại ở tầng kết nối. Phép thử này chạy
**trên runner GitHub** (tức từ ngoài Internet thật), không chạy trên vpn4 — cùng cách
`deploy-cliproxy.yml` kiểm "cổng 8317 không còn mở ra Internet". Cái bẫy đã biết ở đó: viết
`curl … || echo 000` cho ra `000000` vì curl thất bại đã tự in `000`; dùng `|| true` + `${VAR:-000}`.

---

## AC-20 Tunnel đứt thì suy giảm có kiểm soát

Khi dừng container `pg-tunnel`:

- Gateway **không** thoát tiến trình
- Telegram nhận thông báo lỗi DB rõ ràng, không phải stack trace
- nút **Abort** vẫn hoạt động (§28)
- tunnel sống lại thì Gateway tự phục hồi, không cần khởi động lại tay
- sau 3 phút mất DB, admin (`TELEGRAM_ADMIN_USER_IDS`) nhận **đúng một** tin cảnh báo kèm gợi ý
  chạy lại `deploy.yml`; **không** lặp lại mỗi chu kỳ healthcheck (§7.11.3)

---

## AC-20b Khởi động khi DB đã chết sẵn

Khởi động Gateway trong lúc `pg-tunnel` **đang chết**:

- Gateway vẫn lên (nhờ `depends_on: service_started`, không phải `service_healthy`)
- migration thử lại có backoff, quá hạn thì vào **chế độ suy giảm** thay vì thoát
- `/start` và `/abort` vẫn trả lời; các lệnh cần DB báo lỗi rõ ràng
- tunnel sống lại → migration chạy nốt → bot về bình thường mà không cần can thiệp

Kịch bản thật đứng sau AC này: vpn6 bảo trì đúng lúc vpn4 khởi động lại.

---

## AC-21 Không đụng hạ tầng đang chạy

So sánh **ảnh chụp trước/sau** (§37.2 bước 2 và 5) — kiểm bằng máy, không bằng quan sát:

```bash
diff /tmp/baseline-before.txt /tmp/baseline-after.txt   # phải rỗng
```

- `derper`, `edge-nginx`, `caddy-edge`, `cliproxy`, `vpn-gw`, `ts-vpngw`, `ping-reporter-vpn4`,
  `ts-vpn4` trên vpn4 — đúng 8 container mà lệnh `docker inspect` ở §37.2 đo: `RestartCount` và
  `StartedAt` **không đổi**
- `headscale`, `derp-postgres`, `derp-backend` trên vpn6: **không restart lần nào** — bảo đảm
  bằng thiết kế, vì phương án đã chọn không sửa compose vpn6 (§7.11.1)
- DB `derp` và `headscale` không có bảng nào mới — **bảo đảm bằng thiết kế, không phải bằng phép
  kiểm**: từ PostgreSQL 15 trở đi, `PUBLIC` không còn quyền `CREATE` trên schema `public`, nên
  role `opencode` kết nối vào được nhưng **không tạo được bảng** (PG ở đây là 18.4 — §0.2). Muốn
  kiểm bằng máy thì thêm `select count(*) from pg_tables where schemaname='public'` trước/sau vào
  `snapshot-vpn6.sh`
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

## Ngưỡng bắt buộc

```text
coverage dòng      >= 80%
coverage nhánh     >= 70%
mutation           >= 75%   (Stryker — phải có job riêng trong CI, §37.3)
```

DB dùng cho test chạy bằng `services: postgres:18-alpine` **trong workflow CI**, không phải DB
thật trên vpn6 — cùng phiên bản major với production (18.4).

## Nhóm test còn thiếu trong spec gốc (bổ sung)

```text
favorites     thêm/xoá/sắp xếp model yêu thích, model yêu thích biến mất khỏi provider (§30)
/files        liệt kê artifact rỗng, một nhóm, nhiều nhóm, tên file có ký tự cần escape (§24)
phân trang    biên MODEL_PAGE_SIZE: 0 model, đúng 1 trang, lẻ 1 phần tử, trang cuối (§12)
```

## Tests riêng cho ràng buộc hạ tầng (mới)

```text
độ trễ        driver DB bọc thêm 307 ms → đếm số truy vấn, khẳng định <= 2 và <= 1000 ms (AC-18)
cache         sửa user_state → đọc lại ra từ cache, không sinh truy vấn mới
/reload       INSERT project thẳng vào DB → trước /reload không thấy, sau /reload thấy (§7.10)
hàng đợi ghi  100 dòng audit → gộp thành <= 2 câu INSERT, và flush hết khi nhận SIGTERM
mất DB        đóng kết nối giữa chừng → không thoát tiến trình, Abort vẫn chạy (AC-20)
DB chết sẵn   khởi động khi tunnel đã chết → vẫn lên, vào chế độ suy giảm (AC-20b)
fail-fast     DATABASE_URL chứa 127.0.0.1/localhost → thoát ngay kèm thông báo rõ (§7.11.4)
cảnh báo      db down > 3 phút → gửi ĐÚNG MỘT tin cho admin, không lặp mỗi 30 giây (AC-20)
quyền admin   user thường gọi /reload → bị từ chối; user trong TELEGRAM_ADMIN_USER_IDS → chạy được
seed user     user whitelisted gõ /start lần đầu → sinh hàng telegram_users, role theo env (§8.1)
đồng bộ role  đổi TELEGRAM_ADMIN_USER_IDS rồi /start lại → role trong DB cập nhật theo env (§8.1)
env đầy đủ    mọi ${VAR:?} trong compose có mặt trong .env.example (§6.2)
env sinh đủ   mọi biến trong .env.example đều có mặt trong .env do gen-env.py sinh ra
env escape    giá trị chứa ' " $ ` khoảng trắng → `docker compose config` và `readenv.py` đọc ra
              ĐÚNG giá trị gốc (một cách hiểu duy nhất, không còn source bằng shell)
env placeholder  .env sinh ra không còn chuỗi dạng __TÊN__ nào (chống DATABASE_URL giữ nguyên
              __OPENCODE_PG_PASSWORD__ → deploy xanh mà bot chết vì 28P01)
diff          /diff: session không có thay đổi · có 1 file · diff quá dài → gửi .diff (AC-15)
chính sách    §27: mẫu lệnh nhạy cảm (rm -rf, git push, docker compose down, DROP TABLE) phải
              rơi vào nhánh ask/deny, không rơi vào allow
permission    opencode.json sinh ra: ĐỦ 13 khoá + mọi khoá thuộc danh sách hợp lệ (không write/search/
              apply_patch/external), bash["*"]=="ask", webfetch/websearch/external_directory=="ask",
              lsp=="deny" (ngân sách RAM 512 MB đứng trên khoá này — §37.1)
idempotent    gửi lại CÙNG một sự kiện completion qua SSE → chỉ MỘT tin nhắn kết quả (§42)
cache reload  DB down → up: cache tự nạp lại, /project thấy sandbox mà không cần gõ lệnh (AC-20b)
hàng đợi trần DB chết + bơm 100k sự kiện → RSS không vượt ngưỡng, hàng đợi cắt theo chính sách
hoà giải mọi  task 3 phút tuổi khi khởi động → vẫn được hoà giải (không chỉ task > 10 phút)
hết hạn       task quá TASK_MAX_DURATION_MIN → tự abort, nhả khoá; approval quá hạn → expired
symlink       (chỉ nhánh B) artifact là symlink trỏ ra ngoài WORKSPACE_ROOT → bị từ chối
kích thước    tệp đúng MAX_INPUT_ATTACHMENT_MB → qua; +1 byte → lỗi đúng thông điệp §41
cảnh báo RAM  RAM khả dụng < 300 MB → admin nhận đúng một tin (§37.1 quy tắc 3)
hoà giải      task "running" cũ khi khởi động → chuyển sang trạng thái xác định (AC-17)
compose       phân tích docker-compose.yml: không "ports:" ở opencode-server; opencode-server
              KHÔNG ở db_net; đủ mem_limit + pids_limit + logging; không mount cấm; không tag
              trôi (AC-19, AC-21, §37.3)
workflow      quét file .github/workflows: không heredoc, không if/else nhiều dòng (§0.6 quy tắc 4)
```

---

# 50. Implementation Order

Agent should implement in this order.

## Milestone 0 — Hạ tầng (MỚI, phải xong trước mọi thứ khác)

Spec gốc không có milestone này vì nó tưởng OpenCode và PostgreSQL đã sẵn sàng. Thực tế
**OpenCode chưa tồn tại** và **DB ở cách 307 ms**, nên đây là phần rủi ro cao nhất — làm trước,
sai thì biết sớm.

Thứ tự bắt buộc:

1. **Đường DB trước tiên.** User `pgtunnel` trên vpn6 (không sửa gì đang chạy) → image
   `pg-tunnel` → từ vpn4 chạy được
   `psql 'postgresql://opencode@pg-tunnel:5433/opencode_remote' -c 'SELECT 1'`.
   Đo thời gian thật của câu lệnh đó — không xấp xỉ 307 ms nghĩa là có gì đó khác giả định.
2. **OpenCode chạy được.** Go/no-go alpine vs bookworm (§36.2) → `opencode serve` →
   `opencode.json` trỏ cliproxy → gọi thử một prompt `claude-opus-5` và nhận câu trả lời tiếng
   Việt có dấu (mượn đúng phép thử trong `deploy-cliproxy.yml` — nó bắt được cả OOM lẫn mojibake).
   Đồng thời trả lời dứt điểm hai câu hỏi chặn:
   - **`/global/health` có bị basic auth phủ không** (§17.1)
   - **`GET /doc` có endpoint đọc nội dung artifact không** → quyết định nhánh A hay B của
     §33.3, và điền đủ 8 dòng bảng §17.2. Đây là điều kiện tiên quyết của Milestone 5.
3. **Quyền ghi workspace.** `docker exec opencode-server touch /workspace/opencode-sandbox/.wtest`
   phải thành công (§33.2) — đây là lỗi làm chết chức năng lõi mà thông báo rất khó đọc.
4. **Đường ra Telegram.** Từ trong container trên vpn4:
   `curl -s https://api.telegram.org/bot<TOKEN>/getMe` phải trả `"ok":true`, và đo một vòng
   `getUpdates`. Đây là thứ **duy nhất chưa từng chạy** trên máy đó — vpn4 ở Peru, đừng giả định.
5. **Ngân sách RAM — đo DƯỚI TẢI, không đo lúc rỗi.** Stack chạy rỗi 30 phút không chứng minh
   được gì: LSP server chỉ sinh ra khi agent mở project, và đường đính kèm chỉ phình khi có tệp
   thật. Kịch bản đo bắt buộc:

   ```text
   a. một prompt bắt agent đọc + sửa file trong sandbox (LSP sẽ khởi động)
   b. một đính kèm sát trần MAX_INPUT_ATTACHMENT_MB gửi kèm caption
   c. trong lúc đó: docker stats --no-stream, lặp mỗi 5 giây, lấy ĐỈNH của cả 3 service
   ```

   Ghi con số đỉnh đo được vào bảng §37.1 **thay cho** con số phỏng đoán 512m/256m. RAM khả dụng
   phải còn > 300 MB và `derper` không được restart lần nào.

Deliverable:

```text
psql qua tunnel: SELECT 1 → OK (~307 ms), và ssh -v KHÔNG có "administratively prohibited"
opencode:    prompt thật → trả lời đúng tiếng Việt; đã biết /global/health có cần auth không
API surface: bảng §17.2 điền đủ 8 dòng từ GET /doc, ghi ngày kiểm chứng;
             §33.3 ghi rõ chọn NHÁNH A / A+ / B (quyết định này đổi cả compose)
SSE mẫu:     docs/opencode-events-sample.jsonl chụp từ một prompt CÓ sửa file và CÓ xin quyền;
             đã ánh xạ các type quan sát được sang §18/§19/§26
permission:  khối permission dùng đúng tên khoá; bash["*"], webfetch, websearch,
             external_directory đều là "ask", lsp là "deny" (kiểm bằng node — vpn4 không có jq)
workspace:   touch/rm trong /workspace thành công (uid 1000)
telegram:    getMe → {"ok":true} từ chính vpn4
RAM dưới tải: đỉnh docker stats của 3 service đã ghi vào §37.1; khả dụng > 300 MB;
             derper RestartCount không đổi
```

**Không viết một dòng code Telegram nào trước khi 8 dòng trên xanh.** Hai dòng đắt nhất nếu bỏ
qua: `API surface` quyết định Gateway có phải mount gì không — tức quyết định nội dung
`docker-compose.yml`; `SSE mẫu` quyết định Event Processor viết được hay không — và bốn AC-09,
AC-10, AC-12, AC-16 đều đứng trên nó.

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
🔎 Searching references
🔧 Modifying code
        ↓
⚠️ Permission requested
git status

[Approve] [Reject]
        ↓
Approve
        ↓
✅ Completed

2 files changed
+31 / -14

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

Lưu ý về ví dụ trên: nó đã được sửa cho khớp ràng buộc thật. Bản gốc kết thúc bằng
`Tests 24/24 passed` và có bước `🧪 Running tests` — V1 **không** chạy test cục bộ (QĐ-8), và
lệnh ví dụ `docker restart mps` cũng không thực hiện được vì agent không có `docker.sock`
(§33.1). Chạy test là việc của GitHub Actions, không phải của agent trên vpn4.
