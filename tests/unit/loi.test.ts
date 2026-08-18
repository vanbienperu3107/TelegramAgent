/**
 * Bien loi thanh cau tra loi.
 *
 * Bat bien duy nhat va quan trong nhat: KHONG BAO GIO IM LANG, va khong bao gio
 * tra ve chuoi rong. Da hong hai lan trong mot ngay theo hai duong khac nhau —
 * lenh la (`/session`) va handler nem loi (`/agent` luc OpenCode chua san sang).
 */
import { describe, expect, it } from 'vitest';

import { moTaLoi } from '../../src/bot/loi.js';
import { LoiOpenCode } from '../../src/services/opencode-client.js';

describe('luon co cau tra loi', () => {
  it('moi dang dau vao deu ra mot cau co nghia', () => {
    const dauVao: unknown[] = [
      new Error('bat ky'),
      new LoiOpenCode(404, '/x', ''),
      new LoiOpenCode(500, '/x', ''),
      'chuoi tran',
      null,
      undefined,
      { khong: 'phai loi' },
      123,
    ];
    for (const d of dauVao) {
      const van = moTaLoi(d);
      expect(van.length, `dau vao ${String(d)} cho ra cau qua ngan`).toBeGreaterThan(10);
    }
  });
});

describe('phan biet theo ma trang thai', () => {
  it('404 chi ra hanh dong cu the: tao phien moi', () => {
    // Ma trang thai la thu duy nhat tu server dang cho nguoi dung xem: no phan
    // biet 'phien khong con' voi 'server dang hong' — hai viec can hai hanh dong.
    expect(moTaLoi(new LoiOpenCode(404, '/x', ''))).toContain('/new');
  });

  it('401/403 noi ro day la loi cau hinh, khong phai loi cua nguoi dung', () => {
    for (const ma of [401, 403]) {
      expect(moTaLoi(new LoiOpenCode(ma, '/x', ''))).toMatch(/khong phai loi cua ban/i);
    }
  });

  it('5xx bao la su co cua server, khuyen thu lai', () => {
    for (const ma of [500, 502, 503]) {
      expect(moTaLoi(new LoiOpenCode(ma, '/x', ''))).toMatch(/thu lai/i);
    }
  });

  it('loi mang khi OpenCode chua len duoc nhan ra rieng', () => {
    // Hay gap ngay sau deploy. Nguoi dung chi can biet la doi mot chut.
    for (const van of ['fetch failed', 'connect ECONNREFUSED', 'The operation was aborted']) {
      expect(moTaLoi(new Error(van))).toMatch(/thu lai sau it giay|khoi dong lai/i);
    }
  });
});

describe('khong ro ri chi tiet noi bo', () => {
  it('khong tra nguyen van chuoi JSON cua server', () => {
    // Nguoi dung tung nhan nguyen van:
    //   {"name":"NotFoundError","data":{"message":"Session not found: ses_..."}}
    const loi = new LoiOpenCode(404, '/session/ses_abc/prompt_async', '{"name":"NotFoundError"}');
    const van = moTaLoi(loi);
    expect(van).not.toContain('NotFoundError');
    expect(van).not.toContain('ses_abc');
  });

  it('khong lo chuoi ket noi hay mat khau trong thong bao chung', () => {
    const van = moTaLoi(new Error('connect to postgresql://opencode:matkhau@pg-tunnel:5433 failed'));
    expect(van).not.toContain('matkhau');
    expect(van).not.toContain('postgresql://');
  });

  it('khong lo stack trace', () => {
    const e = new Error('vo');
    e.stack = 'Error: vo\n    at rat/nhieu/duong/dan.ts:1:1';
    expect(moTaLoi(e)).not.toContain('duong/dan.ts');
  });
});
