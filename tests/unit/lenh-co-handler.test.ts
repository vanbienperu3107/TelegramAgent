/**
 * Moi lenh trong DANH_SACH_LENH phai co `bot.command` dang ky trong index.ts.
 *
 * Lop loi nay am tham va rat kho hieu khi gap: lenh nam trong danh sach (nen
 * `doanLenh` tim thay no) nhung khong co handler (nen no roi vao nhanh "lenh
 * la"), va bot tra ve:
 *
 *     Khong co lenh /dondep. Y ban la /dondep phai khong?
 *
 * Nguoi dung go lai y het roi lai nhan y het. Da xay ra that voi /dondep ngay
 * 2026-08-18: ham `donPhienDaChet` da viet xong trong service, ten lenh da them
 * vao danh sach, chi thieu dung mot dong `bot.command`.
 *
 * Doc VAN BAN cua index.ts thay vi khoi dong bot that: khoi dong bot doi token,
 * DB va OpenCode — ba thu khong co trong CI. Doc van ban la du, vi cai can kiem
 * la "co dong dang ky hay khong", khong phai "handler chay dung hay khong".
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DANH_SACH_LENH, TEN_KHAC } from '../../src/bot/commands/help.js';

const GOC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = fs.readFileSync(path.join(GOC, 'src', 'index.ts'), 'utf8');

/** Ten lenh duoc dang ky, doc tu `bot.command(moiTenCua('x')` va `bot.command('x'`. */
function lenhDaDangKy(): Set<string> {
  const ra = new Set<string>();
  for (const m of INDEX.matchAll(/bot\.command\(\s*moiTenCua\(\s*'([a-z0-9_]+)'\s*\)/g)) {
    ra.add(m[1]!);
  }
  for (const m of INDEX.matchAll(/bot\.command\(\s*'([a-z0-9_]+)'/g)) {
    ra.add(m[1]!);
  }
  return ra;
}

describe('danh sach lenh khop voi handler that', () => {
  const daDangKy = lenhDaDangKy();

  it('bo doc duoc it nhat cac lenh co ban — neu khong, phep kiem duoi vo nghia', () => {
    // Canh giu chinh bo doc: neu ai doi cach dang ky lenh (vi du dung mot ham
    // boc khac) thi regex tren im lang khong khop gi ca, va MOI phep kiem duoi
    // deu xanh gia.
    expect(daDangKy.size).toBeGreaterThanOrEqual(5);
    expect(daDangKy.has('start')).toBe(true);
  });

  it('moi lenh trong /help deu co bot.command trong index.ts', () => {
    const thieu = DANH_SACH_LENH.map((l) => l.lenh).filter((l) => !daDangKy.has(l));
    expect(
      thieu,
      `lenh co trong danh sach nhung khong ai dang ky: ${thieu.join(', ')}`,
    ).toEqual([]);
  });

  it('moi lenh chinh cua bi danh cung phai co handler', () => {
    // Bi danh chay qua `moiTenCua(chinh)`, nen bi danh tro toi mot lenh khong co
    // handler la mot bi danh chet — go vao khong ra gi.
    const thieu = [...new Set(Object.values(TEN_KHAC))].filter((c) => !daDangKy.has(c));
    expect(thieu, `bi danh tro toi lenh khong co handler: ${thieu.join(', ')}`).toEqual([]);
  });
});
