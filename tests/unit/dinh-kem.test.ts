/**
 * Dinh kem tu Telegram -> FilePartInput cua OpenCode.
 *
 * Truoc day bot KHONG co handler nao cho anh/tep: gui anh vao thi roi vao hu
 * khong, khong mot cau tra loi.
 */
import { describe, expect, it } from 'vitest';

import {
  TRAN_TAI_VE_MB,
  doanMime,
  dungFilePart,
  kiemKichThuoc,
  vanMacDinh,
  type DinhKem,
} from '../../src/bot/dinh-kem.js';

const k = (t: Partial<DinhKem> = {}): DinhKem => ({ loai: 'document', fileId: 'f1', ...t });

describe('doan MIME', () => {
  it('uu tien gia tri Telegram bao', () => {
    expect(doanMime(k({ mime: 'application/pdf' }))).toBe('application/pdf');
  });

  it('anh khong co mime thi mac dinh image/jpeg', () => {
    // Telegram nen anh thanh JPEG cho `photo`.
    expect(doanMime(k({ loai: 'photo' }))).toBe('image/jpeg');
  });

  it('doan tu duoi ten tep khi Telegram khong bao', () => {
    expect(doanMime(k({ tenTep: 'ghi-chu.md' }))).toBe('text/markdown');
    expect(doanMime(k({ tenTep: 'anh.PNG' }))).toBe('image/png');
  });

  it('KHONG BAO GIO tra chuoi rong', () => {
    // `mime` la truong BAT BUOC cua FilePartInput; rong lam ca yeu cau bi tu choi.
    // Doan sai con hon bo trong.
    for (const t of [k(), k({ tenTep: 'la.xyz' }), k({ mime: '   ' })]) {
      expect(doanMime(t).length).toBeGreaterThan(0);
    }
  });
});

describe('kiem kich thuoc TRUOC khi tai', () => {
  it('tu choi tep vuot gioi han cua bot', () => {
    const r = kiemKichThuoc(k({ kichThuoc: 9 * 1024 * 1024 }), 5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.lyDo).toContain('5 MB');
  });

  it('tu choi tep vuot tran cung cua Telegram du cau hinh cho phep', () => {
    // Bot API khong cho bot tai tep qua 20 MB — dat MAX_INPUT_ATTACHMENT_MB=50
    // cung khong doi duoc dieu do.
    const r = kiemKichThuoc(k({ kichThuoc: 25 * 1024 * 1024 }), 50);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.lyDo).toContain(String(TRAN_TAI_VE_MB));
  });

  it('cho qua khi Telegram khong bao kich thuoc', () => {
    // Chan o day se chan nham nhung tep hop le; buoc tai ve se tu bao loi neu qua to.
    expect(kiemKichThuoc(k(), 5).ok).toBe(true);
  });
});

describe('dung FilePartInput', () => {
  it('dung data: URI, khong dua URL cua Telegram', () => {
    // URL tep cua Telegram chua TOKEN BOT trong duong dan — dua cho OpenCode la
    // lo token — va chi song vai gio.
    const p = dungFilePart(k({ loai: 'photo' }), Buffer.from('xin chao'));
    expect(p.url.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(p.url).not.toContain('api.telegram.org');
    expect(p.type).toBe('file');
  });

  it('ma hoa base64 dung noi dung', () => {
    const p = dungFilePart(k(), Buffer.from('abc'));
    const b64 = p.url.split(',')[1]!;
    expect(Buffer.from(b64, 'base64').toString()).toBe('abc');
  });

  it('chi dat filename khi that su co', () => {
    expect(dungFilePart(k(), Buffer.alloc(0)).filename).toBeUndefined();
    expect(dungFilePart(k({ tenTep: 'a.txt' }), Buffer.alloc(0)).filename).toBe('a.txt');
  });
});

describe('cau nhac mac dinh', () => {
  it('KHONG BAO GIO rong', () => {
    // `parts` phai co it nhat mot phan van ban de model biet lam gi voi tep. Mot
    // tep tran khong kem cau hoi thi model doan — doan sai thi nguoi dung tuong
    // bot hong.
    for (const t of [k({ loai: 'photo' }), k(), k({ tenTep: 'x.pdf' })]) {
      expect(vanMacDinh(t).trim().length).toBeGreaterThan(0);
    }
  });

  it('nhac ten tep de model biet dang xem gi', () => {
    expect(vanMacDinh(k({ tenTep: 'bao-cao.pdf' }))).toContain('bao-cao.pdf');
  });
});
