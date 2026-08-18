/**
 * `.env.example` va `config.ts` phai phu nhau — theo CA HAI CHIEU.
 *
 * Hai lop loi, ca hai deu im lang:
 *
 *   - bien co trong khuon ma schema khong doc  -> CAU HINH CHET. Nguoi van hanh
 *     doi gia tri, khoi dong lai, va khong co gi xay ra. Da xay ra that:
 *     MODEL_PAGE_SIZE / SESSION_PAGE_SIZE / PROJECT_PAGE_SIZE nam trong
 *     `.env.example` tu dau nhung `config.ts` chua bao gio doc toi.
 *   - bien schema doi ma khuon khong co        -> Gateway chet luc khoi dong voi
 *     "cau hinh khong hop le", va khong ai biet phai them gi vao dau.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { schema } from '../../src/config.js';

const GOC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Bien nam trong `.env` nhung KHONG phai cua Gateway.
 *
 * Moi dong phai co ly do, va ly do phai la "co tien trinh khac doc no" — khong
 * duoc dung danh sach nay de lam im mot bien bi bo quen.
 */
const KHONG_PHAI_CUA_GATEWAY: Record<string, string> = {
  // `scripts/sync-models.cjs` doc luc deploy de tham do model; `opencode-server`
  // doc qua `.env.opencode` de giai `{env:...}` trong opencode.json.
  CLIPROXY_BASE_URL: 'sync-models.cjs va opencode-server doc, Gateway thi khong',
  CLIPROXY_API_KEY: 'sync-models.cjs va opencode-server doc, Gateway thi khong',
  // Gateway khong doc bien nay TRUC TIEP — no di vao DATABASE_URL qua giu cho
  // `__OPENCODE_PG_PASSWORD__` ma gen-env.py thay. Buoc verify cua deploy cung
  // doc no de goi psql. Doi schema doc them mot ban sao roi la moi cho lech.
  OPENCODE_PG_PASSWORD: 'di vao DATABASE_URL qua giu cho, gen-env.py thay',
};

function bienTrongKhuon(ten: string): string[] {
  return fs
    .readFileSync(path.join(GOC, ten), 'utf8')
    .split('\n')
    .map((d) => d.trim())
    .filter((d) => d.length > 0 && !d.startsWith('#') && d.includes('='))
    .map((d) => d.split('=', 1)[0]!.trim());
}

describe('.env.example va config.ts phu nhau', () => {
  const khuon = new Set(bienTrongKhuon('.env.example'));
  const cuaSchema = new Set(Object.keys(schema.shape));

  it('moi bien schema doi deu co trong khuon', () => {
    const thieu = [...cuaSchema].filter((k) => !khuon.has(k));
    expect(thieu, `schema doi nhung .env.example khong co: ${thieu.join(', ')}`).toEqual([]);
  });

  it('moi bien trong khuon deu duoc doc, tru nhung bien co chu so huu khac', () => {
    const boQuen = [...khuon].filter((k) => !cuaSchema.has(k) && !(k in KHONG_PHAI_CUA_GATEWAY));
    expect(
      boQuen,
      `co trong .env.example nhung khong ai doc — cau hinh chet: ${boQuen.join(', ')}`,
    ).toEqual([]);
  });

  it('danh sach ngoai le khong chua bien ma schema van doc', () => {
    // Chan viec ai do them mot bien vao ca hai cho roi quen go ngoai le — luc do
    // phep kiem tren mat tac dung ma khong ai hay.
    for (const k of Object.keys(KHONG_PHAI_CUA_GATEWAY)) {
      expect(cuaSchema.has(k), `${k} nam trong danh sach ngoai le nhung schema van doc`).toBe(
        false,
      );
    }
  });
});
