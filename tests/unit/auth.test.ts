/**
 * Uy quyen la lop bao ve DUY NHAT giua Internet va mot agent duoc phep chay bash
 * tren may chay DERP relay cua ca fleet. Moi test o day la mot duong tan cong.
 */
import { describe, expect, it } from 'vitest';
import { kiemUyQuyen } from '../../src/bot/middleware/auth.js';

const WHITELIST = [111n, 222n];
const ADMINS = [111n];

describe('kiemUyQuyen', () => {
  it('cho nguoi trong whitelist vao qua chat rieng', () => {
    const r = kiemUyQuyen('private', 222n, WHITELIST, ADMINS);
    expect(r).toEqual({ ok: true, userId: 222n, laAdmin: false });
  });

  it('nhan dien admin', () => {
    const r = kiemUyQuyen('private', 111n, WHITELIST, ADMINS);
    expect(r.ok && r.laAdmin).toBe(true);
  });

  it('tu choi nguoi ngoai whitelist', () => {
    const r = kiemUyQuyen('private', 333n, WHITELIST, ADMINS);
    expect(r).toEqual({ ok: false, ly_do: 'khong-trong-whitelist' });
  });

  it('tu choi chat nhom KE CA khi nguoi gui nam trong whitelist', () => {
    // V1 khong ho tro nhom. Neu chi kiem whitelist ma bo qua loai chat thi ai do
    // them bot vao mot nhom la moi thanh vien nhom deu dieu khien duoc agent.
    for (const loai of ['group', 'supergroup', 'channel']) {
      const r = kiemUyQuyen(loai, 111n, WHITELIST, ADMINS);
      expect(r).toEqual({ ok: false, ly_do: 'khong-phai-chat-rieng' });
    }
  });

  it('tu choi update khong co nguoi gui', () => {
    const r = kiemUyQuyen('private', undefined, WHITELIST, ADMINS);
    expect(r).toEqual({ ok: false, ly_do: 'khong-co-nguoi-gui' });
  });

  it('tu choi khi loai chat khong xac dinh', () => {
    const r = kiemUyQuyen(undefined, 111n, WHITELIST, ADMINS);
    expect(r).toEqual({ ok: false, ly_do: 'khong-phai-chat-rieng' });
  });

  it('whitelist rong thi tu choi tat ca (fail-closed)', () => {
    // Neu whitelist rong bi hieu thanh "cho tat ca" thi mot loi cau hinh nho
    // thanh cong khai quyen dieu khien agent.
    expect(kiemUyQuyen('private', 111n, [], []).ok).toBe(false);
  });

  it('so sanh id bang bigint, khong bi lech o so lon', () => {
    // Hai id nay bang nhau khi ep ve Number (mat do chinh xac), nhung khac nhau
    // that. So bang Number la uy quyen nham nguoi.
    const that = 9007199254740993n;
    const gia = 9007199254740992n;
    expect(kiemUyQuyen('private', that, [that], []).ok).toBe(true);
    expect(kiemUyQuyen('private', gia, [that], []).ok).toBe(false);
  });
});
