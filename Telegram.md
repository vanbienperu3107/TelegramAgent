# OpenCode Telegram Remote Gateway — Implementation Specification

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
          │                 │                  │ SSE
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

Khuyến nghị:

```text
Language       TypeScript
Runtime        Node.js 22+
Telegram       grammY
OpenCode       @opencode-ai/sdk
Database       PostgreSQL existing
ORM            Drizzle ORM
Validation     Zod
Logging        Pino
HTTP           native fetch / SDK
Deployment     Docker
Testing        Vitest
```

Không deploy PostgreSQL mới.

Sử dụng PostgreSQL có sẵn thông qua:

```env
DATABASE_URL=postgresql://user:password@host:5432/opencode_remote
```

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

```env
# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_IDS=123456789

# PostgreSQL existing
DATABASE_URL=postgresql://user:password@host:5432/opencode_remote

# OpenCode
OPENCODE_URL=http://127.0.0.1:4096
OPENCODE_USERNAME=opencode
OPENCODE_PASSWORD=

# Defaults
DEFAULT_PROVIDER=cliproxy
DEFAULT_MODEL=gpt-5.6-sol
DEFAULT_AGENT=build

# Upload limits
MAX_INPUT_ATTACHMENT_MB=10

# Telegram UI
MODEL_PAGE_SIZE=8
SESSION_PAGE_SIZE=8
PROJECT_PAGE_SIZE=8

# Runtime
LOG_LEVEL=info
NODE_ENV=production
```

All secrets must be loaded from environment variables.
Do not commit `.env`.

---

# 7. PostgreSQL Data Model

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

Example:

```text
📁 Select Project

[ MPS          ]
[ Provisioning ]
[ DCB          ]
[ Monitoring   ]
```

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

Preferred behavior:

```text
POST /session/{sessionId}/prompt_async
```

or equivalent SDK operation.

Prompt must include:

```text
providerID
modelID
agent
parts[]
```

Do not create a new OpenCode session for each prompt.

---

# 18. SSE Event Processing

Maintain a persistent OpenCode SSE event connection.

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
reply to OpenCode permission
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
OpenCode abort session/task
    ↓
task.status = aborted
    ↓
edit status message
```

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

---

# 34. OpenCode Connectivity

OpenCode should bind only to localhost/private Docker network.

Example:

```text
127.0.0.1:4096
```

Use authentication where supported/configured.

Never expose OpenCode server directly to the public Internet.

Telegram Gateway is the only remote-facing control plane.

---

# 35. Deployment Model

Existing:

```text
PostgreSQL
OpenCode
CLIProxy
workspace projects
```

New component:

```text
opencode-telegram-gateway
```

Target topology:

```text
Internet
   │
   ▼
Telegram
   │
   ▼
Telegram Gateway
   │
   ├──────── PostgreSQL existing
   │
   └──────── OpenCode localhost/private network
                 │
                 ▼
              CLIProxy
                 │
              AI models
```

---

# 36. Dockerfile Requirements

Use multi-stage build.

Expected:

```text
node:22-alpine
```

Runtime:

- non-root user
- production dependencies only
- health check
- no source secrets copied into image

Example conceptual command:

```text
node dist/index.js
```

---

# 37. docker-compose.yml Scope

Do not create PostgreSQL container.

Compose may contain only:

```text
telegram-gateway
```

Optionally OpenCode if desired later.

Required:

- restart unless-stopped
- env_file
- network connectivity to OpenCode/PostgreSQL
- controlled workspace mount only if Gateway needs project artifacts

Do not mount `/` or arbitrary host filesystem.

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

---

# 50. Implementation Order

Agent should implement in this order.

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
