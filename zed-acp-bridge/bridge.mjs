#!/usr/bin/env node
/**
 * Cau ACP <-> opencode-server remote.
 *
 * Zed noi ACP (JSON-RPC, moi dong stdin/stdout la 1 message) voi tien trinh CON
 * chay CUC BO. opencode-server tren vpn4 khong noi ACP — no chi co REST + SSE
 * (xem docs/opencode-api-do-duoc.md). File nay dich hai chieu:
 *
 *   Zed --ACP (stdio)--> bridge.mjs --REST/SSE (HTTPS)--> opencode-server
 *
 * KHONG PHAI ban dich day du dac ta ACP. Chi lam vua du de mot luot hoi-dap
 * van ban chay duoc qua Agent Panel cua Zed:
 *   - initialize, session/new, session/prompt, session/cancel
 *   - stream chu qua session/update (agent_message_chunk)
 *   - permission.asked: co goi nguoc session/request_permission ve Zed, neu
 *     Zed khong tra loi trong thoi han thi dung ACP_AUTO_APPROVE (mac dinh
 *     "reject" — an toan hon la tu y cho phep bash chay tren vpn4).
 *
 * Chua lam: tool_call chi tiet (dang gop vao agent_message_chunk dang van
 * ban danh dau [tool: ...]), session/load, mcpServers tu Zed truyen sang
 * opencode (opencode tu quan ly MCP rieng qua opencode.json cua no).
 *
 * `configOptions` (dropdown model/mode trong UI Zed) VA `session/set_config_option`
 * KHONG nam trong dac ta ACP cong khai — day la phan mo rong rieng cua binary
 * `opencode acp` that. Hinh dang o day duoc do truc tiep bang cach goi tay vao
 * `opencode acp` cuc bo (2026-08-27), khong doan:
 *   session/new tra them {configOptions: [{id,name,category,type,currentValue,options}]}
 *   session/set_config_option nhan {sessionId, configId, value} -> {} (200 rong)
 * ANH markdown `![]()` trong text: KHONG can xu ly rieng — Zed tu render Markdown
 * trong content block dang text, kem ca cu phap anh. Lan truoc thieu anh la do
 * MODEL tu sinh cu phap link thuong (thieu dau `!`), khong phai gioi han ky thuat.
 */

import { Buffer } from 'node:buffer';
import readline from 'node:readline';

const OPENCODE_URL = (process.env.OPENCODE_URL ?? '').replace(/\/+$/, '');
const OPENCODE_SERVER_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD ?? '';
const PROVIDER_ID = process.env.OPENCODE_PROVIDER_ID ?? 'cliproxy';
const MODEL_ID = process.env.OPENCODE_MODEL_ID ?? 'claude-opus-5';
const AGENT_NAME = process.env.OPENCODE_AGENT ?? 'build';
// "once" | "always" | "reject" — dung khi Zed khong tra loi session/request_permission
// trong PERMISSION_TIMEOUT_MS. Mac dinh reject: tha bo mot lenh con hon la tu
// dong cho bash chay tren may dang giu DERP relay cua ca tailnet.
const AUTO_APPROVE_FALLBACK = process.env.ACP_AUTO_APPROVE_FALLBACK ?? 'reject';
const PERMISSION_TIMEOUT_MS = Number(process.env.ACP_PERMISSION_TIMEOUT_MS ?? 60_000);

if (!OPENCODE_URL || !OPENCODE_SERVER_PASSWORD) {
  process.stderr.write(
    'bridge.mjs: thieu bien moi truong OPENCODE_URL hoac OPENCODE_SERVER_PASSWORD\n',
  );
  process.exit(1);
}

// Ra Internet phai qua proxy cuc bo (mang chi cho CONNECT :443, giong itop/gost
// da dung cho cac may khac trong ha tang nay). fetch/SSE built-in cua Node
// KHONG tu doc HTTPS_PROXY — phai gan dispatcher cua undici thu cong.
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (PROXY_URL) {
  const { ProxyAgent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new ProxyAgent(PROXY_URL));
  process.stderr.write(`bridge.mjs: di qua proxy ${PROXY_URL}\n`);
}

const BASIC_AUTH = `Basic ${Buffer.from(`opencode:${OPENCODE_SERVER_PASSWORD}`, 'utf8').toString('base64')}`;

function headers(extra) {
  return { authorization: BASIC_AUTH, ...(extra ?? {}) };
}

async function ocFetch(path, init = {}) {
  const { timeoutMs = 30_000, ...rest } = init;
  const signal = AbortSignal.timeout(timeoutMs);
  const res = await fetch(`${OPENCODE_URL}${path}`, {
    ...rest,
    signal,
    headers: headers(rest.headers),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`opencode ${path} -> HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return res;
}

async function ocJson(path, init) {
  const res = await ocFetch(path, init);
  return res.json();
}

function ocPostJson(path, data, timeoutMs) {
  return ocFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
    timeoutMs,
  });
}

function sinhMessageId() {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** Chi nhung loai su kien ta xu ly — danh sach TRANG, xem event-stream.ts goc. */
const LOAI_QUAN_TAM = new Set([
  'server.connected',
  'server.heartbeat',
  'session.created',
  'session.updated',
  'session.status',
  'session.idle',
  'session.diff',
  'message.updated',
  'message.part.updated',
  'message.part.delta',
  'permission.asked',
  'permission.replied',
]);

function tachKhungSSE(dem) {
  const suKien = [];
  const khung = dem.split(/\r?\n\r?\n/);
  const du = khung.pop() ?? '';
  for (const k of khung) {
    for (const dong of k.split(/\r?\n/)) {
      if (!dong.startsWith('data:')) continue;
      const than = dong.slice(5).trim();
      if (than.length === 0) continue;
      try {
        const ev = JSON.parse(than);
        if (typeof ev?.type === 'string') suKien.push(ev);
      } catch {
        // khung hong khong duoc lam chet ca luong
      }
    }
  }
  return { suKien, du };
}

// ---------------------------------------------------------------------------
// JSON-RPC / ACP framing: moi dong stdin/stdout la DUY MOT message JSON.
// ---------------------------------------------------------------------------

let nextOutboundId = 1;
const pendingOutbound = new Map(); // id -> {resolve, reject}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendNotification(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

/** Goi nguoc mot method tren Zed (client), cho phan hoi hoac het han. */
function callClient(method, params, timeoutMs) {
  const id = nextOutboundId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingOutbound.delete(id);
      reject(new Error('timeout cho client tra loi'));
    }, timeoutMs);
    pendingOutbound.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

// ---------------------------------------------------------------------------
// Trang thai phien: mot bridge process phuc vu nhieu session/new tuan tu.
// ---------------------------------------------------------------------------

/** sessionId (ACP, ta tu sinh) -> { ocSessionId, streaming controller } */
const sessions = new Map();

let sessionCounter = 0;

class VongDoiPhien {
  constructor(ocSessionId, providerID, modelID, agentName) {
    this.ocSessionId = ocSessionId;
    this.providerID = providerID;
    this.modelID = modelID;
    this.agentName = agentName;
    this.dungLuong = false;
  }
}

/**
 * Danh sach model, phang hoa tu `GET /config/providers` — dung dinh dang
 * "providerID/modelID" lam `value`, giong het cach `opencode acp` that dang lam
 * (do duoc: "cliproxy/claude-opus-5", "opencode/big-pickle"...).
 */
async function dsModelConfigOptions() {
  const d = await ocJson('/config/providers');
  const options = [];
  for (const p of d.providers ?? []) {
    for (const [khoa, m] of Object.entries(p.models ?? {})) {
      const modelID = m.id ?? khoa;
      options.push({ value: `${p.id}/${modelID}`, name: `${p.name ?? p.id}/${m.name ?? modelID}` });
    }
  }
  return options;
}

/** Danh sach agent (mode), tu `GET /agent`. */
async function dsAgentConfigOptions() {
  const d = await ocJson('/agent');
  const list = Array.isArray(d) ? d : [];
  return list.map((a) => ({
    value: a.name,
    name: a.name,
    description: a.description,
  }));
}

/**
 * Mo mot vong ket noi SSE, loc theo sessionID + messageID cua luot hien tai,
 * goi `onEvent` cho tung su kien quan tam, tra ve khi gap session.idle hoac loi.
 *
 * KHONG replay (da do trong docs/opencode-api-do-duoc.md): neu mat ket noi giua
 * chung, ta doi chieu bang GET /session/:id/message roi coi nhu ket thuc — tot
 * hon la treo vinh vien.
 */
async function theoDoiMotLuot({ ocSessionId, messageID, onEvent }) {
  const url = `${OPENCODE_URL}/event`;
  const res = await fetch(url, { headers: headers({ accept: 'text/event-stream' }) });
  if (!res.ok || !res.body) {
    throw new Error(`GET /event -> HTTP ${res.status}`);
  }
  const doc = res.body.getReader();
  const giaiMa = new TextDecoder();
  let dem = '';
  let daXongSaySessionIdle = false;
  try {
    for (;;) {
      const { done, value } = await doc.read();
      if (done) break;
      dem += giaiMa.decode(value, { stream: true });
      const { suKien, du } = tachKhungSSE(dem);
      dem = du;
      for (const ev of suKien) {
        if (!LOAI_QUAN_TAM.has(ev.type)) continue;
        const props = ev.properties ?? {};
        if (props.sessionID && props.sessionID !== ocSessionId) continue;
        await onEvent(ev);
        if (ev.type === 'session.idle') {
          daXongSaySessionIdle = true;
        }
      }
      if (daXongSaySessionIdle) break;
    }
  } finally {
    await doc.cancel().catch(() => undefined);
  }
  return daXongSaySessionIdle;
}

async function xuLyPermissionAsked(acpSessionId, ev) {
  const p = ev.properties ?? {};
  const permissionId = p.id;
  const ocSessionId = p.sessionID;
  let reply = AUTO_APPROVE_FALLBACK;
  try {
    const res = await callClient(
      'session/request_permission',
      {
        sessionId: acpSessionId,
        toolCall: {
          toolCallId: p.tool?.callID ?? permissionId,
          title: p.permission ?? 'permission',
          kind: 'execute',
        },
        options: [
          { optionId: 'once', name: 'Cho phep 1 lan', kind: 'allow_once' },
          { optionId: 'always', name: 'Luon cho phep (ghi vao config server)', kind: 'allow_always' },
          { optionId: 'reject', name: 'Tu choi', kind: 'reject_once' },
        ],
      },
      PERMISSION_TIMEOUT_MS,
    );
    reply = res?.outcome?.optionId ?? AUTO_APPROVE_FALLBACK;
  } catch (e) {
    process.stderr.write(
      `bridge.mjs: session/request_permission that bai (${e.message}), dung fallback "${AUTO_APPROVE_FALLBACK}"\n`,
    );
  }
  await ocPostJson(`/session/${ocSessionId}/permissions/${permissionId}`, { response: reply }).catch((e) => {
    process.stderr.write(`bridge.mjs: khong tra loi duoc permission ${permissionId}: ${e.message}\n`);
  });
}

async function handleSessionNew(params) {
  const ocSession = await ocJson('/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: params?.cwd ? `zed:${params.cwd}` : 'zed-acp-bridge' }),
  });
  sessionCounter += 1;
  const acpSessionId = `zed-${sessionCounter}-${ocSession.id}`;
  const phien = new VongDoiPhien(ocSession.id, PROVIDER_ID, MODEL_ID, AGENT_NAME);
  sessions.set(acpSessionId, phien);

  // configOptions la phan mo rong rieng cua opencode acp, khong nam trong dac ta
  // ACP cong khai — hinh dang do truc tiep tu binary that (xem chu thich dau file).
  // Loi goi API o day KHONG duoc lam hong ca session/new: thieu dropdown van con
  // hon la khong tao duoc phien.
  const configOptions = [];
  try {
    const modelOptions = await dsModelConfigOptions();
    configOptions.push({
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: `${phien.providerID}/${phien.modelID}`,
      options: modelOptions,
    });
  } catch (e) {
    process.stderr.write(`bridge.mjs: khong lay duoc danh sach model (${e.message}), bo qua dropdown\n`);
  }
  try {
    const agentOptions = await dsAgentConfigOptions();
    if (agentOptions.length > 0) {
      configOptions.push({
        id: 'mode',
        name: 'Agent',
        category: 'mode',
        type: 'select',
        currentValue: phien.agentName,
        options: agentOptions,
      });
    }
  } catch (e) {
    process.stderr.write(`bridge.mjs: khong lay duoc danh sach agent (${e.message}), bo qua dropdown\n`);
  }

  return { sessionId: acpSessionId, ...(configOptions.length > 0 ? { configOptions } : {}) };
}

/**
 * `session/set_config_option` — method mo rong (khong trong dac ta ACP cong
 * khai), do duoc tu `opencode acp` that: {sessionId, configId, value} -> {}.
 */
async function handleSetConfigOption(params) {
  const phien = sessions.get(params.sessionId);
  if (!phien) throw new Error(`session khong ton tai: ${params.sessionId}`);
  if (params.configId === 'model') {
    const slash = String(params.value).indexOf('/');
    if (slash < 0) throw new Error(`gia tri model khong dung dang providerID/modelID: ${params.value}`);
    phien.providerID = params.value.slice(0, slash);
    phien.modelID = params.value.slice(slash + 1);
  } else if (params.configId === 'mode') {
    phien.agentName = params.value;
  } else {
    throw new Error(`configId khong duoc ho tro: ${params.configId}`);
  }
  return {};
}

function vanBanTuPrompt(promptBlocks) {
  return (promptBlocks ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/** Kind ACP gan cho tung loai tool cua opencode — do tu tool_call that: bash -> execute. Con lai chua do, dung 'other' cho an toan. */
const TOOL_ACP_KIND = { bash: 'execute', read: 'read', write: 'edit', edit: 'edit', patch: 'edit', webfetch: 'fetch', grep: 'search', glob: 'search' };

/**
 * `message.part.updated` voi `part.type === 'tool'` -> `tool_call`/`tool_call_update`.
 *
 * Hinh dang `part.state` (pending/running/completed) do truc tiep tu
 * `docs/opencode-events-sample.jsonl`. Hinh dang ACP tool_call/tool_call_update
 * do truc tiep tu binary `opencode acp` that (2026-08-27) — xem chu thich dau file.
 */
function guiToolCallUpdate(acpSessionId, part, daGuiLanDau) {
  const toolCallId = part.callID;
  const trangThai = part.state?.status;
  const status = trangThai === 'completed' ? 'completed'
    : trangThai === 'error' ? 'failed'
    : trangThai === 'running' ? 'in_progress'
    : 'pending';
  const update = {
    sessionUpdate: daGuiLanDau.has(toolCallId) ? 'tool_call_update' : 'tool_call',
    toolCallId,
    status,
    kind: TOOL_ACP_KIND[part.tool] ?? 'other',
    title: part.state?.title || part.state?.input?.description || part.state?.input?.command || part.tool,
    rawInput: part.state?.input,
  };
  if (status === 'completed' || status === 'failed') {
    const output = part.state?.output ?? part.state?.metadata?.output;
    if (typeof output === 'string' && output.length > 0) {
      update.content = [{ type: 'content', content: { type: 'text', text: output } }];
    }
    if (part.state?.metadata) update.rawOutput = part.state.metadata;
  }
  daGuiLanDau.add(toolCallId);
  sendNotification('session/update', { sessionId: acpSessionId, update });
}

async function handleSessionPrompt(params) {
  const phien = sessions.get(params.sessionId);
  if (!phien) throw new Error(`session khong ton tai: ${params.sessionId}`);

  const text = vanBanTuPrompt(params.prompt);
  const messageID = sinhMessageId();
  const toolCallDaGui = new Set();

  await ocPostJson(
    `/session/${phien.ocSessionId}/prompt_async`,
    {
      messageID,
      model: { providerID: phien.providerID, modelID: phien.modelID },
      agent: phien.agentName,
      parts: [{ type: 'text', text }],
    },
    30_000,
  );

  await theoDoiMotLuot({
    ocSessionId: phien.ocSessionId,
    messageID,
    onEvent: async (ev) => {
      if (ev.type === 'permission.asked') {
        await xuLyPermissionAsked(params.sessionId, ev);
        return;
      }
      if (ev.type === 'message.part.delta') {
        const props = ev.properties ?? {};
        if (props.field === 'text' && typeof props.delta === 'string') {
          sendNotification('session/update', {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: props.delta },
            },
          });
        }
        return;
      }
      if (ev.type === 'message.part.updated') {
        const part = ev.properties?.part;
        if (part?.type === 'tool' && part?.callID) {
          guiToolCallUpdate(params.sessionId, part, toolCallDaGui);
        }
      }
    },
  });

  return { stopReason: 'end_turn' };
}

async function handleSessionCancel(params) {
  const phien = sessions.get(params.sessionId);
  if (!phien) return {};
  await ocPostJson(`/session/${phien.ocSessionId}/abort`, {}).catch(() => undefined);
  return {};
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  try {
    switch (method) {
      case 'initialize':
        sendResult(id, {
          protocolVersion: params?.protocolVersion ?? 1,
          // image: true vi Zed tu render Markdown (ke ca cu phap anh) trong content
          // block text — khong can bridge tu tach thanh block anh rieng. audio/embeddedContext
          // van false: chua lam.
          agentCapabilities: { loadSession: false, promptCapabilities: { image: true, audio: false } },
        });
        return;
      case 'session/new':
        sendResult(id, await handleSessionNew(params));
        return;
      case 'session/prompt':
        sendResult(id, await handleSessionPrompt(params));
        return;
      case 'session/cancel':
        sendResult(id, await handleSessionCancel(params));
        return;
      case 'session/set_config_option':
        sendResult(id, await handleSetConfigOption(params));
        return;
      default:
        sendError(id, -32601, `method khong duoc ho tro: ${method}`);
    }
  } catch (e) {
    sendError(id, -32000, e?.message ?? String(e));
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    process.stderr.write(`bridge.mjs: bo qua dong khong phai JSON: ${trimmed.slice(0, 200)}\n`);
    return;
  }
  if (msg.method && msg.id !== undefined) {
    void handleRequest(msg);
  } else if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pendingOutbound.get(msg.id);
    if (p) {
      pendingOutbound.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'loi tu client'));
      else p.resolve(msg.result);
    }
  } else if (msg.method) {
    // notification tu client, hien tai khong xu ly gi (vd session/cancel dang
    // gui nhu request; neu Zed gui nhu notification thi roi vao day)
  }
});

process.stdin.on('end', () => process.exit(0));
