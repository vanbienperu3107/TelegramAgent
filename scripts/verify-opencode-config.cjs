#!/usr/bin/env node
/**
 * Kiem opencode.json sinh ra co dung 7 tinh chat. Chay HAI lan trong deploy:
 * truoc `up -d` (buoc 4) va o buoc verify (buoc 5).
 *
 *   node /opt/verify-opencode-config.js [duong-dan]
 *
 * Chay bang `docker run --rm` chu KHONG `docker exec`: node ton ~45 MB, ma cgroup
 * cua opencode-server chi 512m — dau do khong duoc tu kich OOM ngay trong buoc
 * chung minh deploy thanh cong.
 *
 * Vi sao ton tai: OpenCode BO QUA khoa permission khong hop le thay vi bao loi.
 * Mot ten khoa bia (`write`, `search`, `apply_patch`, `external` — bon ten tung
 * co trong dac ta) se lam agent chay theo mac dinh cua OpenCode ma khong ai biet.
 */
'use strict';

const fs = require('fs');

// Duong dan TUYET DOI. working_dir cua container la /workspace nen
// ./opencode.json se tro nham cho.
const DEFAULT_PATH = '/home/node/.config/opencode/opencode.json';

// 13 khoa permission hop le, doi chieu tai lieu OpenCode.
const VALID_KEYS = [
  'read', 'edit', 'glob', 'grep', 'bash', 'task', 'skill', 'lsp',
  'question', 'webfetch', 'websearch', 'external_directory', 'doom_loop',
];

// Map bash phai khop CHINH XAC bang nay (§27). Khong dung o "*" = ask: mot
// regression danh roi map deny se qua duoc phep kiem, va `docker compose down
// derper` tut tu "deny" xuong chi con mot nut bam luc 2 gio sang.
const BASH_REQUIRED = {
  '*': 'ask',
  'git status': 'allow',
  'git diff*': 'allow',
  'git log*': 'allow',
  'rm *': 'deny',
  'sudo *': 'deny',
  'systemctl *': 'deny',
  'docker *': 'deny',
  'kubectl *': 'deny',
  'git push*': 'deny',
  'git reset --hard*': 'deny',
};

function check(path) {
  const problems = [];

  // 0. Doc dung duong dan tuyet doi.
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (err) {
    return [`0. khong doc duoc ${path}: ${err.message}`];
  }

  // 1. File parse duoc.
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    return [`1. JSON khong hop le: ${err.message}`];
  }

  // 2. Provider cliproxy co it nhat mot model.
  const models = cfg?.provider?.cliproxy?.models;
  if (!models || typeof models !== 'object' || Object.keys(models).length === 0) {
    problems.push('2. provider.cliproxy.models rong — sync-models.js khong ghi duoc model nao');
  }

  const perm = cfg.permission;
  if (!perm || typeof perm !== 'object') {
    problems.push('3. thieu han khoi permission — agent se chay theo mac dinh cua OpenCode');
    return problems;
  }

  // 3. Moi ten khoa thuoc danh sach hop le.
  for (const key of Object.keys(perm)) {
    if (!VALID_KEYS.includes(key)) {
      problems.push(`3. khoa permission khong hop le: "${key}" (OpenCode se BO QUA im lang)`);
    }
  }

  // 4. lsp phai la deny — ngan sach RAM 512 MB dung tren khoa nay.
  if (perm.lsp !== 'deny') {
    problems.push(`4. permission.lsp = ${JSON.stringify(perm.lsp)}, phai la "deny" (§37.1 ngan sach RAM)`);
  }

  // 5. Du 13 khoa, khong thieu khong thua.
  const missing = VALID_KEYS.filter((k) => !(k in perm));
  if (missing.length) {
    problems.push(`5. thieu ${missing.length} khoa permission: ${missing.join(', ')}`);
  }

  // 6. Map bash khop chinh xac bang cua §27.
  if (typeof perm.bash !== 'object' || perm.bash === null) {
    problems.push('6. permission.bash phai la map mau lenh, khong phai mot gia tri don');
  } else {
    for (const [pattern, want] of Object.entries(BASH_REQUIRED)) {
      const got = perm.bash[pattern];
      if (got !== want) {
        problems.push(`6. bash["${pattern}"] = ${JSON.stringify(got)}, phai la "${want}"`);
      }
    }
    for (const pattern of Object.keys(perm.bash)) {
      if (!(pattern in BASH_REQUIRED)) {
        problems.push(`6. bash co mau lenh la: "${pattern}" — khong co trong bang §27`);
      }
    }
  }

  return problems;
}

function main(argv) {
  const path = argv[2] || DEFAULT_PATH;
  const problems = check(path);
  if (problems.length) {
    for (const p of problems) process.stderr.write(`verify-opencode-config: ${p}\n`);
    return 1;
  }
  process.stderr.write(`verify-opencode-config: OK (7 phep kiem, ${path})\n`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv));
module.exports = { check, VALID_KEYS, BASH_REQUIRED, DEFAULT_PATH };
