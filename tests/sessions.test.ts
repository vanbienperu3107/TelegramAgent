/**
 * Hop dong cua kho phien va ban phim.
 *
 * Hai lop loi duoc chan o day, ca hai deu am tham:
 *   - phien cua nguoi nay lot sang nguoi kia (AC-02)
 *   - callback_data vuot 64 byte -> Telegram tra 400 luc GUI ban phim, tuc loi
 *     hien ra o cho khong lien quan gi den chuoi qua dai
 */
import { describe, expect, it, vi } from 'vitest';

import { KhoPhien } from '../src/services/sessions.js';
import { TRAN_CALLBACK_BYTE, banPhimDuyet, dongGoi, giaiMa } from '../src/bot/keyboards.js';
import type { OpenCodeClient } from '../src/services/opencode-client.js';

/** Gia lap `postgres` dang tag template: ghi lai truy van, tra ve hang dat truoc. */
function sqlGia(ketQua: unknown[][] = []) {
  const goi: Array<{ van: string; thamSo: unknown[] }> = [];
  let i = 0;
  const f = (doan: TemplateStringsArray, ...thamSo: unknown[]) => {
    goi.push({ van: doan.join('?'), thamSo });
    return Promise.resolve(ketQua[i++] ?? []);
  };
  return Object.assign(f, { goi });
}

describe('cach ly nguoi dung', () => {
  it('dsPhien loc theo chu so huu ngay trong SQL', async () => {
    // Loc o tang tren (sau khi da SELECT het) van la ro ri: mot loi off-by-one o
    // do la lo het phien cua nguoi khac. Rang buoc phai nam trong cau truy van.
    const sql = sqlGia([[]]);
    const kho = new KhoPhien(sql as never, {} as OpenCodeClient);
    await kho.dsPhien(123n);
    expect(sql.goi[0]!.van).toContain('telegram_user_id =');
    expect(sql.goi[0]!.thamSo).toContain('123');
  });

  it('phienCuaNguoiDung buoc ca id phien va chu so huu trong cung truy van', async () => {
    const sql = sqlGia([[]]);
    const kho = new KhoPhien(sql as never, {} as OpenCodeClient);
    expect(await kho.phienCuaNguoiDung('ses_1', 123n)).toBeNull();
    expect(sql.goi[0]!.thamSo).toEqual(['ses_1', '123']);
  });

  it('khong phan biet "khong ton tai" voi "khong phai cua ban"', async () => {
    // Phan biet hai ca do xac nhan mot id co ton tai hay khong cho nguoi khong
    // so huu no — mot kenh ro ri du nho.
    const sql = sqlGia([[]]);
    const kho = new KhoPhien(sql as never, {} as OpenCodeClient);
    expect(await kho.phienCuaNguoiDung('ses_khong_co', 123n)).toBeNull();
    expect(await kho.phienCuaNguoiDung('ses_cua_nguoi_khac', 123n)).toBeNull();
  });
});

describe('taoPhien', () => {
  it('tao o OpenCode TRUOC roi moi ghi so', async () => {
    // Thu tu nay co y. Nguoc lai thi mot lan HTTP hong se de lai mot dong tro
    // toi phien khong ton tai, va bot goi lien tuc vao id chet.
    const thuTu: string[] = [];
    const client = {
      taoSession: vi.fn(async () => {
        thuTu.push('http');
        return { id: 'ses_moi' };
      }),
    } as unknown as OpenCodeClient;
    const sql = Object.assign(
      (doan: TemplateStringsArray, ...t: unknown[]) => {
        thuTu.push('sql');
        void doan;
        void t;
        return Promise.resolve([]);
      },
      {},
    );
    const kho = new KhoPhien(sql as never, client);
    const p = await kho.taoPhien({ telegramUserId: 7n, projectId: 1n });
    expect(thuTu).toEqual(['http', 'sql']);
    expect(p.opencodeSessionId).toBe('ses_moi');
  });
});

describe('callback_data', () => {
  it('di qua duoc voi id that cua OpenCode', () => {
    // Id that dai 31 ky tu; cong tien to viec la sat tran 64 byte.
    expect(() => dongGoi('phien', 'ses_feb658b0affedXguPQYQXFG0TJ')).not.toThrow();
    expect(() => dongGoi('quyen-always', 'per_014ea66580014YwBmv03RwAgZV')).not.toThrow();
  });

  it('nem loi CHI RA bien so thay vi de Telegram tra 400', () => {
    expect(() => dongGoi('viec', 'x'.repeat(TRAN_CALLBACK_BYTE))).toThrow(/vuot tran/);
  });

  it('dem BYTE chu khong dem ky tu', () => {
    // Ten project co dau tieng Viet: mot ky tu co the la 3 byte.
    const nhan = 'á'.repeat(30); // 60 byte
    expect(() => dongGoi('duan', nhan)).toThrow(/vuot tran/);
  });

  it('giai ma giu nguyen tham so co dau hai cham', () => {
    expect(giaiMa('viec:a:b')).toEqual({ viec: 'viec', thamSo: 'a:b' });
    expect(giaiMa('khong-co-dau-hai-cham')).toBeNull();
    expect(giaiMa(':thieu-viec')).toBeNull();
  });
});

describe('ban phim duyet quyen', () => {
  it('nhan cua always noi ro la ap dung cho MOI PHIEN', () => {
    // `always` ghi vao cau hinh quyen cua server va ben qua moi phien sau — da
    // do duoc. Mot nhan mo ho o day lam nguoi dung noi rong quyen cua agent
    // vinh vien ma tuong minh chi cho phep trong phien nay.
    const nhan = banPhimDuyet('per_1')
      .inline_keyboard.flat()
      .map((n) => n.text)
      .join(' | ');
    expect(nhan).toMatch(/moi phien|vinh vien/i);
    expect(nhan).toMatch(/lan nay/i);
    expect(nhan).toMatch(/Tu choi/i);
  });
});
