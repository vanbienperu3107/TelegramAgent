/**
 * `/help` va menu lenh phai la MOT nguon.
 *
 * Hai ban chep tay lech nhau la chuyen chac chan xay ra sau vai lan them lenh,
 * va trieu chung rat kho chiu: menu goi y mot lenh khong ton tai, hoac mot lenh
 * co that thi khong ai biet.
 */
import { describe, expect, it } from 'vitest';

import {
  DANH_SACH_LENH,
  TEN_KHAC,
  doanLenh,
  moiTenCua,
  renderHelp,
  renderLenhLa,
} from '../../src/bot/commands/help.js';

describe('danh sach lenh', () => {
  it('moi lenh trong danh sach deu xuat hien trong /help', () => {
    const van = renderHelp();
    for (const l of DANH_SACH_LENH) {
      expect(van, `thieu /${l.lenh}`).toContain(`/${l.lenh}`);
    }
  });

  it('phu du cac lenh da noi vao bot', () => {
    // Danh sach nay cung dung de dang ky menu voi Telegram. Thieu mot lenh o day
    // nghia la nguoi dung khong bao gio thay no goi y.
    const ten = new Set(DANH_SACH_LENH.map((l) => l.lenh));
    for (const can of ['start', 'help', 'project', 'new', 'sessions', 'model', 'agent', 'abort']) {
      expect(ten.has(can), `thieu lenh ${can}`).toBe(true);
    }
  });

  it('ten lenh hop le voi Telegram: chu thuong, so, gach duoi, toi da 32 ky tu', () => {
    for (const l of DANH_SACH_LENH) {
      expect(l.lenh).toMatch(/^[a-z0-9_]{1,32}$/);
    }
  });

  it('mo ta khong vuot 256 ky tu — Telegram tu choi ca danh sach neu vuot', () => {
    for (const l of DANH_SACH_LENH) {
      expect(l.moTa.length).toBeGreaterThan(0);
      expect(l.moTa.length).toBeLessThanOrEqual(256);
    }
  });

  it('canh bao ro ve pham vi cua "cho phep vinh vien"', () => {
    // Da do duoc: `always` ghi vao cau hinh quyen cua server va con hieu luc o
    // moi phien sau. Mot nguoi dung hieu nham se noi rong quyen agent vinh vien
    // ma tuong minh chi cho phep mot lan.
    expect(renderHelp()).toMatch(/MOI phien|moi phien sau/i);
  });
});

describe('lenh la khong bao gio bi im lang', () => {
  it('/session (so it) duoc doan dung thanh /sessions', () => {
    // Cho truot that o lan test dau tien. Truoc do bot khong noi gi ca, khong
    // phan biet duoc voi 'bot chet'.
    expect(doanLenh('/session')).toBe('sessions');
    expect(renderLenhLa('/session')).toContain('/sessions');
  });

  it('tien to ngan van doan duoc khi chi khop mot lenh', () => {
    expect(doanLenh('/ses')).toBe('sessions');
    expect(doanLenh('/ab')).toBe('abort');
  });

  it('KHONG doan khi mo ho — goi y sai con kho chiu hon khong goi y', () => {
    // Nguoi dung se bam theo goi y roi lai khong duoc gi.
    expect(doanLenh('/xyz')).toBeNull();
    expect(renderLenhLa('/xyz')).toContain('/help');
  });

  it('luon tra ve mot cau tra loi, khong bao gio chuoi rong', () => {
    for (const go of ['/', '/x', '/session', '/khong-he-co', '/a'.repeat(50)]) {
      expect(renderLenhLa(go).length).toBeGreaterThan(10);
    }
  });
});

describe('ten goi khac', () => {
  it('moi bi danh tro toi mot lenh CO THAT', () => {
    // Mot bi danh tro toi lenh khong ton tai se dang ky mot handler chet.
    const ten = new Set(DANH_SACH_LENH.map((l) => l.lenh));
    for (const [bi, chinh] of Object.entries(TEN_KHAC)) {
      expect(ten.has(chinh), `bi danh /${bi} tro toi /${chinh} khong ton tai`).toBe(true);
    }
  });

  it('bi danh khong trung voi ten lenh chinh nao', () => {
    // Trung thi grammy dang ky hai handler cho cung mot ten va cai sau bi bo qua.
    const ten = new Set(DANH_SACH_LENH.map((l) => l.lenh));
    for (const bi of Object.keys(TEN_KHAC)) {
      expect(ten.has(bi), `/${bi} vua la ten chinh vua la bi danh`).toBe(false);
    }
  });

  it('moiTenCua luon co ten chinh o dau', () => {
    expect(moiTenCua('sessions')[0]).toBe('sessions');
    expect(moiTenCua('sessions')).toContain('session');
  });

  it('bi danh hop le voi Telegram', () => {
    for (const bi of Object.keys(TEN_KHAC)) expect(bi).toMatch(/^[a-z0-9_]{1,32}$/);
  });
});
