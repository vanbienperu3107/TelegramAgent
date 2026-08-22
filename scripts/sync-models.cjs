#!/usr/bin/env node
/**
 * Sinh khoi provider.cliproxy.models cua opencode.json tu /v1/models cua CLIProxy,
 * chi giu model GOI THAT DUOC.
 *
 *   CLIPROXY_BASE_URL=... CLIPROXY_API_KEY=... node scripts/sync-models.js
 *
 * HAI dau vao:
 *   opencode.json.template  — khuon (bat buoc)
 *   opencode.json           — ban hien co, NEU CO: de biet model nao da kiem
 *
 * Hop dong:
 *  1. `/v1/models` tra 200 kem 25 model KHONG chung minh goi duoc model nao —
 *     bai hoc tra gia o deploy-cliproxy.yml. Phai goi that mot completion cuc
 *     ngan cho tung model.
 *  2. Chi probe model MOI (chua co trong opencode.json hien co). Probe lai ca 25
 *     model moi lan deploy la dot quota that cua 2 credential OAuth, va co the
 *     lam cliproxy restart -> tu kich tieu chi huy deploy.
 *  3. Dong thoi toi da 3. cliproxy co mem_limit 1 GB va tung bi OOM-kill.
 *  4. KHONG sinh khoi `agent` — no khong co nguon du lieu nao (/v1/models chi tra
 *     model). Khoi do nam tinh trong template, script chi chep qua.
 *  5. LUON ghi docs/models-unverified.md, rong cung ghi: buoc 5d cua deploy
 *     `scp` file nay ve, thieu file thi step do tren duong happy-path.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TEMPLATE = 'opencode.json.template';
const OUTPUT = 'opencode.json';
const REPORT = path.join('docs', 'models-unverified.md');
const CONCURRENCY = 3;
const PROBE_TIMEOUT_MS = 20000;

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`thieu bien moi truong ${name}`);
  return value;
}

async function listModels(baseURL, apiKey) {
  const res = await fetch(`${baseURL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`GET /models tra ${res.status}`);
  const body = await res.json();
  const ids = (body.data || []).map((m) => m.id).filter(Boolean);
  if (!ids.length) throw new Error('/v1/models tra danh sach rong');
  return ids;
}

/** Goi that mot completion cuc ngan. Tra null neu dat, hoac ly do truot. */
async function probe(baseURL, apiKey, id) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: id,
        max_tokens: 4,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    if (!res.ok) return `HTTP ${res.status}`;
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.trim() === '') return 'phan hoi rong';
    return null;
  } catch (err) {
    return err.name === 'AbortError' ? `timeout ${PROBE_TIMEOUT_MS}ms` : err.message;
  } finally {
    clearTimeout(timer);
  }
}

/** Chay cac tac vu voi tran dong thoi. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Model da kiem tu lan deploy truoc. File hong hoac `{}` = coi nhu chua co. */
function readVerified(file) {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.keys(cfg?.provider?.cliproxy?.models || {});
  } catch {
    return [];
  }
}

function writeReport(failed) {
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  const lines = ['# Model truot phep thu', ''];
  if (!failed.length) {
    lines.push('Khong co model nao truot o lan sinh gan nhat.');
  } else {
    lines.push('| model | ly do |', '|---|---|');
    for (const { id, reason } of failed) lines.push(`| \`${id}\` | ${reason} |`);
  }
  lines.push('', '> File nay LUON duoc ghi, rong cung ghi. Buoc 5d cua deploy `scp` no ve');
  lines.push('> luu thanh artifact; thieu file thi step do tren duong happy-path.');
  fs.writeFileSync(REPORT, lines.join('\n') + '\n', 'utf8');
}

/**
 * Kha nang mac dinh cho mot model chua duoc khai trong khuon.
 *
 * Vi sao can doan thay vi hoi CLIProxy: `/v1/models` cua CLIProxy chi tra ve `id`,
 * khong co truong nao noi model co nhan anh hay khong. Khong khai gi ca thi
 * OpenCode mac dinh coi la CHI VAN BAN va tu choi anh dau vao — do la hong AM
 * THAM, va nguoi dung chi thay "phien nay khong ho tro doc anh".
 *
 * Doan theo HO MODEL, khong theo tung ten: danh sach ten doi moi thang, con
 * "moi model Claude 3 tro len va moi model GPT-4 tro len deu nhan anh" thi on
 * dinh. Model sinh anh (`gpt-image-*`) va model chuyen review (`codex-*`) thi
 * khong nhan anh dau vao — chung khong phai model hoi-dap.
 */
function khaNangMacDinh(id) {
  const s = String(id).toLowerCase();
  const khongPhaiHoiDap = s.startsWith('gpt-image') || s.startsWith('codex-');
  if (khongPhaiHoiDap) return {};
  const nhanAnh = s.startsWith('claude-') || s.startsWith('gpt-');
  if (!nhanAnh) return {};
  return { modalities: { input: ['text', 'image'], output: ['text'] } };
}

async function main() {
  const baseURL = env('CLIPROXY_BASE_URL').replace(/\/+$/, '');
  const apiKey = env('CLIPROXY_API_KEY');

  const template = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
  const verified = readVerified(OUTPUT);

  const all = await listModels(baseURL, apiKey);
  const fresh = all.filter((id) => !verified.includes(id));
  process.stderr.write(
    `sync-models: ${all.length} model tu cliproxy, ${verified.length} da kiem, probe ${fresh.length}\n`
  );

  const results = await mapLimit(fresh, CONCURRENCY, async (id) => ({
    id,
    reason: await probe(baseURL, apiKey, id),
  }));

  const passed = results.filter((r) => r.reason === null).map((r) => r.id);
  const failed = results.filter((r) => r.reason !== null);

  // Giu lai model da kiem MA VAN CON trong danh sach cua cliproxy.
  const keep = verified.filter((id) => all.includes(id));
  const models = {};
  // GIU LAI khai bao kha nang cua model, khong chi ghi moi ten.
  //
  // Truoc day dong nay ghi `{ name: id }` va lam MAT `modalities`. Hau qua: OpenCode
  // coi moi model la chi-van-ban, va khi nguoi dung gui anh thi agent tra loi
  // "phien nay khong ho tro doc anh dau vao" — du anh da toi noi va model that su
  // doc duoc anh. Loi nay khong the doan tu trieu chung: no chi ra o TANG CAU HINH,
  // khong phai o tang gui/nhan.
  //
  // Khuon la nguon: neu template khai san modalities cho mot model thi giu nguyen.
  // Con lai dung mac dinh cua `khaNangMacDinh` — xem chu thich cua no.
  const khuonCu = template.provider.cliproxy.models || {};
  for (const id of [...keep, ...passed].sort()) {
    models[id] = khuonCu[id] ? { ...khuonCu[id], name: id } : { name: id, ...khaNangMacDinh(id) };
  }

  if (Object.keys(models).length === 0) {
    writeReport(failed);
    throw new Error('khong model nao goi duoc — khong ghi opencode.json de giu ban cu');
  }

  template.provider.cliproxy.models = models;
  fs.writeFileSync(OUTPUT, JSON.stringify(template, null, 2) + '\n', 'utf8');
  writeReport(failed);

  process.stderr.write(
    `sync-models: ghi ${Object.keys(models).length} model, ${failed.length} truot\n`
  );
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`sync-models: ${err.message}\n`);
    process.exit(1);
  });
}
module.exports = { mapLimit, readVerified, khaNangMacDinh, CONCURRENCY };
