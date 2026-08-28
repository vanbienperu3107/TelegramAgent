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
 *   session/set_config_option nhan {sessionId, configId, value} -> {configOptions:[...]}
 *   (LUU Y: KHONG phai {} rong nhu ban dau doan — thieu configOptions trong
 *   phan hoi thi Zed khong ve lai dropdown, chon xong nhin nhu khong co gi xay
 *   ra. Bug that, tim thay 2026-08-28.)
 * ANH markdown `![]()` trong text: KHONG can xu ly rieng — Zed tu render Markdown
 * trong content block dang text, kem ca cu phap anh. Lan truoc thieu anh la do
 * MODEL tu sinh cu phap link thuong (thieu dau `!`), khong phai gioi han ky thuat.
 */

import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// Zed KHONG ghi lai stderr cua tien trinh con custom agent_servers vao log cua
// no (da xac nhan bang cach doc Zed.log that — chi co loi cap Zed nhu
// "acp_thread Error in run turn", khong co dong nao cua bridge). Ghi them ra
// file rieng thi moi co gi de doc khi loi. Mac dinh nam CUNG THU MUC voi
// bridge.mjs de nguoi dung de tim; doi duoc qua ACP_BRIDGE_LOG_PATH.
const LOG_PATH = process.env.ACP_BRIDGE_LOG_PATH
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'bridge.log');
let logStream;
try {
  logStream = fsSync.createWriteStream(LOG_PATH, { flags: 'a' });
} catch {
  logStream = null; // van con stderr, khong de mat het log chi vi khong mo duoc file
}

function ghiLog(msg) {
  const dong = `[${new Date().toISOString()}] ${msg}`;
  process.stderr.write(dong);
  logStream?.write(dong);
}

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
  ghiLog(
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
  ghiLog(`bridge.mjs: di qua proxy ${PROXY_URL}\n`);
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
  // Khong nam trong danh sach trang goc cua bot Telegram (mau 111 su kien khong
  // co luot nao dung tool "question"). Do duoc rieng qua opencode-openapi.json:
  // /question, /question/:id/reply, /question/:id/reject — kenh HOAN TOAN khac
  // /permission. Thieu 3 dong nay la nguyen nhan that cua "model hoi lai roi
  // treo vinh vien" (bao cao 2026-08-28): tool "question" ket qua ket vinh vien
  // o trang thai "running" vi khong ai tra loi qua dung kenh nay.
  'question.asked',
  'question.replied',
  'question.rejected',
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
    // Mot luong /event SONG SUOT ca phien, khong mo/dong theo tung luot — xem
    // chu thich cua LuongPhien ben duoi ve ly do doi kien truc nay.
    this.luong = new LuongPhien(ocSessionId);
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
 * Mot ket noi `/event` SONG SUOT ca phien opencode, khong mo-roi-dong theo tung
 * luot hoi-dap.
 *
 * TRUOC DAY moi `session/prompt` tu mo 1 ket noi SSE rieng roi huy (`cancel()`)
 * ngay khi `session.idle`. Do 2026-08-27 tren log that cua vpn4:
 *   - `caddy-edge`: "aborting with incomplete response ... broken pipe" — huy
 *     giua chung lam Caddy ghi loi khi con du lieu dang bay.
 *   - `opencode-server`: canh bao kieu MaxListeners tren mot EventEmitter noi
 *     bo (dem toi 11) — moi lan mo/huy `/event` de lai mot listener chua chac
 *     duoc don sach kip, tich luy qua nhieu luot lam server (mem_limit chi
 *     576m) nang dan len — dung la nguyen nhan "phan hoi cham dan" nguoi dung
 *     bao cao, khong phai do mang/proxy.
 * Sua bang cach giu DUY MOT ket noi cho ca doi phien: mo lan dau luc tao phien
 * (VongDoiPhien), dung chung cho moi `session/prompt` sau do — giam so lan
 * mo/huy tu "1 moi luot" xuong "1 moi phien Zed", dung mau `LuongSuKien` cua
 * bot Telegram (`src/services/event-stream.ts`) da chung minh on dinh.
 */
class LuongPhien {
  constructor(ocSessionId) {
    this.ocSessionId = ocSessionId;
    this.dung = false;
    this.lanThu = 0;
    /** { onEvent(ev): void|Promise<void>, resolve(): void } cua luot dang cho, hoac null. */
    this.currentHandler = null;
    void this.chay();
  }

  dong() {
    this.dung = true;
  }

  async chay() {
    while (!this.dung) {
      this.lanThu += 1;
      try {
        if (this.lanThu > 1) await this.doiChieuSauKhiNoiLai();
        await this.motVongKetNoi();
      } catch (e) {
        ghiLog(`bridge.mjs: luong /event (session ${this.ocSessionId}) loi (${e.message})\n`);
      }
      if (this.dung) break;
      // Lui dan co tran: 500ms, 1s, 2s... toi da 30s. Giong LuongSuKien ben bot.
      const cho = Math.min(30_000, 2 ** Math.min(this.lanThu, 5) * 500);
      await new Promise((r) => setTimeout(r, cho));
    }
  }

  /**
   * KHONG co replay (docs/opencode-api-do-duoc.md §4.1) — su kien mat trong
   * luc dut ket noi la mat vinh vien. Neu dang co mot luot `session/prompt`
   * treo cho, doi chieu bang `GET /session/:id/message`: tim thay cau tra loi
   * cuoi cung co noi dung thi coi nhu xong va gui not phan con thieu — con hon
   * de Zed treo vo thoi han.
   */
  async doiChieuSauKhiNoiLai() {
    if (!this.currentHandler) return;
    try {
      const list = await ocJson(`/session/${this.ocSessionId}/message`);
      const messages = Array.isArray(list) ? list : [];
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (m?.info?.role !== 'assistant') continue;
        const daiDien = (m.parts ?? [])
          .filter((p) => p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text)
          .join('')
          .trim();
        if (daiDien.length > 0) {
          await this.currentHandler.onEvent({
            type: 'message.part.delta',
            properties: { field: 'text', delta: `\n\n[noi lai sau mat ket noi]\n${daiDien}` },
          });
        }
        break;
      }
    } catch (e) {
      ghiLog(`bridge.mjs: doi chieu sau mat ket noi that bai (${e.message})\n`);
    } finally {
      this.currentHandler?.resolve?.();
      this.currentHandler = null;
    }
  }

  async motVongKetNoi() {
    const res = await fetch(`${OPENCODE_URL}/event`, { headers: headers({ accept: 'text/event-stream' }) });
    if (!res.ok || !res.body) {
      throw new Error(`GET /event -> HTTP ${res.status}`);
    }
    const doc = res.body.getReader();
    const giaiMa = new TextDecoder();
    let dem = '';
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
          if (props.sessionID && props.sessionID !== this.ocSessionId) continue;
          await this.currentHandler?.onEvent(ev);
          if (ev.type === 'session.idle' && this.currentHandler) {
            this.currentHandler.resolve();
            this.currentHandler = null;
          }
        }
        if (this.dung) break;
      }
    } finally {
      await doc.cancel().catch(() => undefined);
    }
  }
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
    ghiLog(
      `bridge.mjs: session/request_permission that bai (${e.message}), dung fallback "${AUTO_APPROVE_FALLBACK}"\n`,
    );
  }
  await ocPostJson(`/session/${ocSessionId}/permissions/${permissionId}`, { response: reply }).catch((e) => {
    ghiLog(`bridge.mjs: khong tra loi duoc permission ${permissionId}: ${e.message}\n`);
  });
}

/**
 * `question.asked` — tool "question" cua opencode hoi lai nguoi dung TRUOC khi
 * lam tiep (khac han co che `permission.asked`, dung API rieng: xem chu thich
 * cua LOAI_QUAN_TAM).
 *
 * Moi request co the co NHIEU cau hoi (`questions[]`), moi cau co nhieu lua
 * chon. ACP `session/request_permission` chi thiet ke cho MOT lua chon co san
 * (khong phai form nhieu cau hoi tu do) nen day la GHEP TAM: hoi tuan tu tung
 * cau qua chinh co che permission, lay 1 lua chon moi cau (chua ho tro
 * `multiple: true` chon nhieu — ghi log neu gap). Bat ky buoc nao loi/het gio
 * thi TU CHOI CA REQUEST — an toan hon la doan bua cau tra loi.
 */
async function xuLyQuestionAsked(acpSessionId, ev) {
  const p = ev.properties ?? {};
  const requestId = p.id;
  const cauHoi = p.questions ?? [];
  const traLoi = [];
  try {
    for (const q of cauHoi) {
      if (q.multiple) {
        ghiLog(`bridge.mjs: cau hoi "${q.header}" cho chon nhieu (multiple:true), bridge chi ho tro chon 1\n`);
      }
      const res = await callClient(
        'session/request_permission',
        {
          sessionId: acpSessionId,
          toolCall: {
            toolCallId: p.tool?.callID ?? requestId,
            title: q.header ?? q.question ?? 'question',
            kind: 'other',
          },
          options: (q.options ?? []).map((o) => ({ optionId: o.label, name: o.label, kind: 'allow_once' })),
        },
        PERMISSION_TIMEOUT_MS,
      );
      const chon = res?.outcome?.optionId;
      if (!chon) throw new Error(`khong nhan duoc lua chon cho cau hoi "${q.header}"`);
      traLoi.push([chon]);
    }
    await ocPostJson(`/question/${requestId}/reply`, { answers: traLoi });
  } catch (e) {
    ghiLog(`bridge.mjs: question.asked "${requestId}" tu choi vi ${e.message}\n`);
    await ocPostJson(`/question/${requestId}/reject`, {}).catch((e2) => {
      ghiLog(`bridge.mjs: khong tu choi duoc question ${requestId}: ${e2.message}\n`);
    });
  }
}

/**
 * Xay `configOptions` cho mot phien — dung chung cho `session/new` VA
 * `session/set_config_option`.
 *
 * BAT BUOC ca hai method deu tra ve field nay: do duoc tu binary `opencode acp`
 * that (2026-08-27) rang `session/set_config_option` KHONG tra `{}` nhu doan
 * ban dau, ma tra `{configOptions: [...toan bo danh sach, currentValue MOI...]}`
 * — thieu no thi Zed khong co gi de ve lai dropdown, chon xong nhin nhu khong
 * co gi xay ra (dung bug nguoi dung bao cao ngay 2026-08-28).
 * Loi goi API o day KHONG duoc lam hong ca luot goi: thieu dropdown van con
 * hon la mat ca phien/mat ca lan doi.
 */
async function xayConfigOptions(phien) {
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
    ghiLog(`bridge.mjs: khong lay duoc danh sach model (${e.message}), bo qua dropdown\n`);
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
    ghiLog(`bridge.mjs: khong lay duoc danh sach agent (${e.message}), bo qua dropdown\n`);
  }
  return configOptions;
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

  const configOptions = await xayConfigOptions(phien);
  return { sessionId: acpSessionId, ...(configOptions.length > 0 ? { configOptions } : {}) };
}

/**
 * `session/set_config_option` — method mo rong (khong trong dac ta ACP cong
 * khai), do duoc tu `opencode acp` that: {sessionId, configId, value} ->
 * {configOptions: [...]} (xem chu thich cua `xayConfigOptions`).
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
  const configOptions = await xayConfigOptions(phien);
  return { ...(configOptions.length > 0 ? { configOptions } : {}) };
}

function tenTepTuUri(uri) {
  if (typeof uri !== 'string' || uri.length === 0) return undefined;
  try {
    return decodeURIComponent(uri.split(/[/\\]/).pop() ?? '');
  } catch {
    return undefined;
  }
}

/**
 * Doan MIME tu duoi tep khi Zed khong cho san `mimeType`.
 *
 * BAT BUOC khong fallback ve `application/octet-stream` — do duoc that
 * (2026-08-28, xem doc chieu qua diag-session.yml): opencode-server tu choi
 * thang voi loi "'file part media type application/octet-stream' functionality
 * not supported.", assistant loi ngay lap tuc (~400ms), khong sinh duoc chu
 * nao. Mac dinh an toan hon la `text/plain` — dinh kem trong ngu canh coding
 * (script, config, log...) phan lon la van ban, chu khong phai nhi phan.
 */
function doanMime(ten) {
  const duoi = (ten ?? '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const bang = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv',
    ps1: 'text/plain', sh: 'text/plain', bash: 'text/plain', js: 'text/plain', mjs: 'text/plain', ts: 'text/plain',
    py: 'text/plain', yaml: 'text/plain', yml: 'text/plain', toml: 'text/plain', ini: 'text/plain', cfg: 'text/plain',
    xml: 'text/plain', html: 'text/plain', css: 'text/plain', sql: 'text/plain', log: 'text/plain', env: 'text/plain',
  };
  return (duoi && bang[duoi]) || 'text/plain';
}

/**
 * `resource` (embedded, co san noi dung) -> `FilePartInput` cua opencode-server.
 * Hinh dang chuan ACP: `{type:'resource', resource:{uri, mimeType, text|blob}}`
 * (do tu https://agentclientprotocol.com/protocol/content, khong doan).
 */
function resourceThanhFilePart(block) {
  const r = block?.resource;
  if (!r) return null;
  const mime = r.mimeType || doanMime(tenTepTuUri(r.uri));
  if (typeof r.blob === 'string') {
    return { type: 'file', mime, url: `data:${mime};base64,${r.blob}`, filename: tenTepTuUri(r.uri) };
  }
  if (typeof r.text === 'string') {
    const b64 = Buffer.from(r.text, 'utf8').toString('base64');
    return { type: 'file', mime, url: `data:${mime};base64,${b64}`, filename: tenTepTuUri(r.uri) };
  }
  return null;
}

/**
 * Gioi han cung, DONG BO voi `TRAN_TAI_VE_MB` cua bot Telegram (`dinh-kem.ts`).
 * Khong co gioi han nay, doc+ma hoa base64+gui mot tep vai chuc MB co the treo
 * rat lau (proxy cham/chan upload lon) MA KHONG log gi ca — vi loi chi duoc ghi
 * o buoc SAU (fetch that bai), khong phai o buoc doc/ma hoa file. Bao cao that
 * 2026-08-28: dinh kem 1 tep lon, Zed im lang hoan toan, bridge.log rong.
 */
const TRAN_TEP_DINH_KEM_MB = 20;

/**
 * `resource_link` (chi co duong dan, KHONG co noi dung san) -> phai tu doc tep.
 * Doc duoc vi bridge chay CUNG MAY voi Zed (tien trinh con do Zed spawn) — `uri`
 * dang `file://` tro toi tep tren chinh may do.
 *
 * Tra ve `{loiKichThuoc}` (khong phai file part) khi vuot gioi han, de ben goi
 * bao lai cho nguoi dung THAY VI im lang bo qua hoac treo.
 */
async function resourceLinkThanhFilePart(block) {
  if (typeof block?.uri !== 'string') return null;
  let duongDan = block.uri;
  if (duongDan.startsWith('file://')) {
    try {
      duongDan = fileURLToPath(duongDan);
    } catch {
      // giu nguyen chuoi goc, thu doc thang — mot so client gui duong dan tran
    }
  }
  try {
    const tt = await fs.stat(duongDan);
    const mb = tt.size / (1024 * 1024);
    if (mb > TRAN_TEP_DINH_KEM_MB) {
      const ten = block.name || tenTepTuUri(block.uri) || duongDan;
      ghiLog(`bridge.mjs: tep dinh kem "${duongDan}" ${mb.toFixed(1)}MB vuot tran ${TRAN_TEP_DINH_KEM_MB}MB, bo qua\n`);
      return { loiKichThuoc: `Tệp "${ten}" nặng ${mb.toFixed(1)} MB, vượt giới hạn ${TRAN_TEP_DINH_KEM_MB} MB của bridge — KHÔNG gửi lên model.` };
    }
    const byte = await fs.readFile(duongDan);
    const mime = block.mimeType || doanMime(block.name || tenTepTuUri(block.uri));
    return {
      type: 'file',
      mime,
      url: `data:${mime};base64,${byte.toString('base64')}`,
      filename: block.name || tenTepTuUri(block.uri),
    };
  } catch (e) {
    ghiLog(`bridge.mjs: khong doc duoc tep dinh kem "${duongDan}": ${e.message}\n`);
    return null;
  }
}

/**
 * Dich toan bo `prompt` (mang content block ACP) sang `parts` cua opencode-server.
 * Van ban gop thanh MOT part `text` dat DAU TIEN (opencode-client.ts cua bot
 * Telegram da ghi ro thu tu nay co chu dich: cau hoi phai den truoc tep de model
 * biet phai lam gi voi no). File dinh kem (`resource`/`resource_link`/`image`)
 * theo sau — TRUOC DAY bi vut het, chi lay `text`, dung nguyen nhan bao cao
 * 2026-08-28 (dinh kem @mention trong Zed khong toi duoc opencode-server).
 */
async function partsTuPrompt(promptBlocks) {
  const blocks = promptBlocks ?? [];
  const text = blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
  const parts = [{ type: 'text', text }];

  for (const b of blocks) {
    if (b?.type === 'text') continue;
    let filePart = null;
    if (b?.type === 'resource') {
      filePart = resourceThanhFilePart(b);
    } else if (b?.type === 'resource_link') {
      filePart = await resourceLinkThanhFilePart(b);
    } else if (b?.type === 'image' && typeof b.data === 'string') {
      const mime = b.mimeType || 'image/png';
      filePart = { type: 'file', mime, url: `data:${mime};base64,${b.data}` };
    }
    if (filePart?.loiKichThuoc) {
      // Bao NGAY TRONG VAN BAN thay vi im lang bo qua — model (va nguoi dung
      // doc lai qua agent_message_chunk sau nay) can biet vi sao khong thay tep.
      parts[0].text += `\n\n[bridge: ${filePart.loiKichThuoc}]`;
    } else if (filePart) {
      parts.push(filePart);
    } else {
      ghiLog(`bridge.mjs: bo qua content block khong dich duoc (type=${b?.type})\n`);
    }
  }
  return parts;
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

  const parts = await partsTuPrompt(params.prompt);
  const messageID = sinhMessageId();
  const toolCallDaGui = new Set();

  // Dang ky handler TRUOC khi POST — tranh lo hong: mot su kien (vd
  // permission.asked) toi ngay sau khi opencode nhan prompt nhung truoc khi ta
  // kip gan currentHandler thi se roi vao khoang trong, khong ai xu ly.
  let resolveXongLuot;
  const xongLuot = new Promise((resolve) => { resolveXongLuot = resolve; });
  phien.luong.currentHandler = {
    resolve: resolveXongLuot,
    onEvent: async (ev) => {
      if (ev.type === 'permission.asked') {
        await xuLyPermissionAsked(params.sessionId, ev);
        return;
      }
      if (ev.type === 'question.asked') {
        await xuLyQuestionAsked(params.sessionId, ev);
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
  };

  try {
    await ocPostJson(
      `/session/${phien.ocSessionId}/prompt_async`,
      {
        messageID,
        model: { providerID: phien.providerID, modelID: phien.modelID },
        agent: phien.agentName,
        parts,
      },
      // Dinh kem base64 phinh ~33%; 30s khong du cho mot tep vai MB di qua
      // duong proxy — giong het bat dang thuc da ghi trong opencode-client.ts
      // cua bot Telegram (timeoutMs 90_000 khi co dinh kem). Thieu dong nay la
      // nguyen nhan "khong phan hoi gi" khi dinh kem tep lon, bao cao 2026-08-28.
      parts.some((p) => p.type === 'file') ? 90_000 : 30_000,
    );

    // Chan treo vinh vien: neu opencode-server khong bao gio phat session.idle
    // (loi phia no ma khong thay tren SSE), Zed van phai nhan duoc phan hoi.
    const hetHan = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('timeout doi session.idle')), 10 * 60_000);
    });
    await Promise.race([xongLuot, hetHan]);
  } catch (e) {
    // KHONG de Zed "im lang hoan toan" (bao cao 2026-08-28: gui dinh kem lon,
    // prompt_async vuot timeout, nguoi dung khong thay gi ca — sendError qua
    // JSON-RPC co ve khong luon hien ra UI). Gui hien mot dong chu bao loi truoc
    // khi tra ve, de nguoi dung it nhat biet co chuyen gi xay ra thay vi treo.
    sendNotification('session/update', {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `\n\n[bridge loi: ${e.message}]\n` },
      },
    });
  } finally {
    phien.luong.currentHandler = null;
  }

  return { stopReason: 'end_turn' };
}

/**
 * `session/load` — nap lai lich su phien cu. `sessionId` la id ACP do chinh
 * bridge sinh o `handleSessionNew` (dang `zed-<n>-<ocSessionId>`) nen tach lai
 * duoc `ocSessionId` MA KHONG CAN nho gi giua cac lan tien trinh bridge khoi
 * dong lai — Zed spawn bridge moi moi lan mo Agent Panel, `sessions` Map luon
 * rong luc bat dau.
 */
async function handleSessionLoad(params) {
  const m = /^zed-\d+-(.+)$/.exec(params.sessionId ?? '');
  if (!m) throw new Error(`sessionId khong dung dinh dang cua bridge nay: ${params.sessionId}`);
  const ocSessionId = m[1];

  const phien = new VongDoiPhien(ocSessionId, PROVIDER_ID, MODEL_ID, AGENT_NAME);
  sessions.set(params.sessionId, phien);

  const toolCallDaGui = new Set();
  const list = await ocJson(`/session/${ocSessionId}/message`);
  for (const msg of Array.isArray(list) ? list : []) {
    const role = msg?.info?.role;
    for (const part of msg?.parts ?? []) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        sendNotification('session/update', {
          sessionId: params.sessionId,
          update: {
            // "user_message_chunk" chua kiem chung truc tiep tu traffic that (chi
            // do duoc "agent_message_chunk" qua tool_call probe) — dung theo quy
            // uoc dac ta ACP cong khai cho vai tro user.
            sessionUpdate: role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
            content: { type: 'text', text: part.text },
          },
        });
      } else if (part.type === 'tool' && part.callID) {
        guiToolCallUpdate(params.sessionId, part, toolCallDaGui);
      }
    }
  }
  return {};
}

async function handleSessionCancel(params) {
  const phien = sessions.get(params.sessionId);
  if (!phien) return {};
  await ocPostJson(`/session/${phien.ocSessionId}/abort`, {}).catch(() => undefined);
  return {};
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  // ghiLog TRUOC DAY chi ghi khi co loi — mot luot dang chay binh thuong (dai,
  // hoac cho session.idle lau) thi bridge.log rong trong suot qua trinh, khong
  // phan biet duoc "dang chay" voi "treo that". Ghi ca luc bat dau/ket thuc MOI
  // request de doc log biet ngay dang cho o buoc nao — bao cao 2026-08-28.
  const batDau = Date.now();
  ghiLog(`bridge.mjs: >>> ${method} (id=${id}) sessionId=${params?.sessionId ?? '-'}\n`);
  try {
    let result;
    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: params?.protocolVersion ?? 1,
          // image: true vi Zed tu render Markdown (ke ca cu phap anh) trong content
          // block text — khong can bridge tu tach thanh block anh rieng. audio/embeddedContext
          // van false: chua lam.
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false } },
          // authMethods CO Y BO TRONG: xac thuc that (HTTP Basic toi opencode-server)
          // da xong tu luc doc OPENCODE_SERVER_PASSWORD trong env, khong can Zed
          // hoi lai gi them. Ke ca vay, Zed van co the tu goi 'authenticate' cho
          // MOI custom agent (thay vi chi khi co authMethods) — xu ly ben duoi de
          // khong chan nguoi dung o man hinh "Authenticate to ...".
        };
        break;
      case 'authenticate':
        result = {};
        break;
      case 'session/new':
        result = await handleSessionNew(params);
        break;
      case 'session/load':
        result = await handleSessionLoad(params);
        break;
      case 'session/prompt':
        result = await handleSessionPrompt(params);
        break;
      case 'session/cancel':
        result = await handleSessionCancel(params);
        break;
      case 'session/set_config_option':
        result = await handleSetConfigOption(params);
        break;
      default:
        sendError(id, -32601, `method khong duoc ho tro: ${method}`);
        ghiLog(`bridge.mjs: <<< ${method} (id=${id}) method khong ho tro, ${Date.now() - batDau}ms\n`);
        return;
    }
    sendResult(id, result);
    ghiLog(`bridge.mjs: <<< ${method} (id=${id}) OK, ${Date.now() - batDau}ms\n`);
  } catch (e) {
    sendError(id, -32000, e?.message ?? String(e));
    ghiLog(`bridge.mjs: <<< ${method} (id=${id}) LOI: ${e?.message ?? e}, ${Date.now() - batDau}ms\n`);
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
    ghiLog(`bridge.mjs: bo qua dong khong phai JSON: ${trimmed.slice(0, 200)}\n`);
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
