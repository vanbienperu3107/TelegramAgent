/**
 * Rut van ban tu tep dinh kem.
 *
 * Bat bien quan trong nhat: KHONG BAO GIO gui di mot tep ma model se lang le bo
 * qua. Da xay ra that 2026-08-18 — mot tep .docx kem cau "Doc thong tin trong
 * file", bot tra loi sau MOT giay ve mot chu de hoan toan khac, va nguoi dung
 * tuong no da doc.
 */
import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { TOI_DA_KY_TU, docTep, ghepVaoPrompt } from '../../src/bot/doc-tep.js';

/** Dung mot tep ZIP toi thieu chua dung mot muc — du de kiem bo doc .docx. */
function zipMotMuc(ten: string, noiDung: Buffer): Buffer {
  const tenB = Buffer.from(ten, 'utf8');
  const nen = deflateRawSync(noiDung);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(nen.length, 18);
  local.writeUInt32LE(noiDung.length, 22);
  local.writeUInt16LE(tenB.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(nen.length, 20);
  central.writeUInt32LE(noiDung.length, 24);
  central.writeUInt16LE(tenB.length, 28);
  central.writeUInt32LE(0, 42); // offset local header

  const viTriCentral = local.length + tenB.length + nen.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + tenB.length, 12);
  eocd.writeUInt32LE(viTriCentral, 16);

  return Buffer.concat([local, tenB, nen, central, tenB, eocd]);
}

describe('anh va PDF gui nguyen tep', () => {
  it('anh de model tu nhin', () => {
    expect(docTep(Buffer.alloc(4), 'image/png', 'a.png').loai).toBe('gui-nguyen-tep');
  });

  it('PDF nhan ca theo mime lan theo duoi', () => {
    expect(docTep(Buffer.alloc(4), 'application/pdf').loai).toBe('gui-nguyen-tep');
    expect(docTep(Buffer.alloc(4), 'application/octet-stream', 'a.pdf').loai).toBe('gui-nguyen-tep');
  });
});

describe('van ban thuan', () => {
  it('nhan theo mime', () => {
    const r = docTep(Buffer.from('xin chao'), 'text/plain', 'a.txt');
    expect(r).toEqual({ loai: 'van-ban', van: 'xin chao', batBot: false });
  });

  it('nhan theo duoi khi Telegram bao mime chung chung', () => {
    // Telegram hay tra `application/octet-stream` cho tep ma nguon.
    const r = docTep(Buffer.from('SELECT 1;'), 'application/octet-stream', 'q.sql');
    expect(r.loai).toBe('van-ban');
  });

  it('giu duoc tieng Viet co dau', () => {
    const r = docTep(Buffer.from('Trái cây ngọt', 'utf8'), 'text/plain', 'a.txt');
    if (r.loai !== 'van-ban') throw new Error('phai la van-ban');
    expect(r.van).toBe('Trái cây ngọt');
  });

  it('cat bot khi qua dai VA noi ro la da cat', () => {
    const r = docTep(Buffer.from('x'.repeat(TOI_DA_KY_TU + 500)), 'text/plain', 'a.txt');
    if (r.loai !== 'van-ban') throw new Error('phai la van-ban');
    expect(r.van.length).toBe(TOI_DA_KY_TU);
    expect(r.batBot).toBe(true);
  });

  it('tu choi tep nhi phan doi lot duoi duoi van ban', () => {
    // Nhung mot dong ky tu rac vao prompt con te hon la noi that.
    const rac = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00, 0x01]);
    expect(docTep(rac, 'text/plain', 'a.txt').loai).toBe('khong-doc-duoc');
  });
});

describe('.docx', () => {
  it('rut duoc van ban tu tep Word that', () => {
    const xml =
      '<w:document><w:body><w:p><w:r><w:t>Dong mot</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Dong hai</w:t></w:r></w:p></w:body></w:document>';
    const docx = zipMotMuc('word/document.xml', Buffer.from(xml, 'utf8'));
    const r = docTep(docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx');
    if (r.loai !== 'van-ban') throw new Error(`phai la van-ban, nhan ${r.loai}`);
    expect(r.van).toContain('Dong mot');
    expect(r.van).toContain('Dong hai');
    // The XML khong duoc lot ra ngoai.
    expect(r.van).not.toContain('<w:');
  });

  it('giu ranh gioi doan van chu khong dinh het lam mot dong', () => {
    const xml = '<w:p><w:r><w:t>A</w:t></w:r></w:p><w:p><w:r><w:t>B</w:t></w:r></w:p>';
    const r = docTep(zipMotMuc('word/document.xml', Buffer.from(xml)), 'x', 'a.docx');
    if (r.loai !== 'van-ban') throw new Error('phai la van-ban');
    expect(r.van).toBe('A\nB');
  });

  it('tep .docx hong thi bao ro, khong nem', () => {
    const r = docTep(Buffer.from('khong phai zip'), 'x', 'a.docx');
    expect(r.loai).toBe('khong-doc-duoc');
  });

  it('.doc cu duoc phan biet voi .docx va chi ra cach xu ly', () => {
    // `.doc` la dinh dang OLE nhi phan, khong phai ZIP — thu doc bang cach cua
    // .docx se that bai kho hieu.
    const r = docTep(Buffer.alloc(10), 'application/msword', 'a.doc');
    if (r.loai !== 'khong-doc-duoc') throw new Error('phai la khong-doc-duoc');
    expect(r.lyDo).toContain('.docx');
  });
});

describe('dinh dang chua ho tro', () => {
  it('NOI RO thay vi gui di trong im lang', () => {
    // Day la ca da lam hong trai nghiem that: gui di thi model bo qua va tra loi
    // bang ngu canh cu, nguoi dung tuong no da doc tep.
    const r = docTep(Buffer.alloc(10), 'application/vnd.ms-excel', 'so-lieu.xlsx');
    if (r.loai !== 'khong-doc-duoc') throw new Error('phai la khong-doc-duoc');
    expect(r.lyDo).toContain('xlsx');
  });

  it('khong bao gio tra ve nhanh thu tu', () => {
    for (const [mime, ten] of [
      ['application/zip', 'a.zip'],
      ['application/octet-stream', 'a.bin'],
      ['', ''],
    ] as const) {
      const r = docTep(Buffer.alloc(4), mime, ten || undefined);
      expect(['van-ban', 'gui-nguyen-tep', 'khong-doc-duoc']).toContain(r.loai);
    }
  });
});

describe('ghep vao prompt', () => {
  it('co ranh gioi ro de model khong nham noi dung tep voi cau hoi', () => {
    const ra = ghepVaoPrompt('Tom tat giup toi', 'bao-cao.txt', 'noi dung', false);
    expect(ra).toContain('Tom tat giup toi');
    expect(ra).toContain('bao-cao.txt');
    expect(ra).toContain('noi dung');
    expect(ra.indexOf('Tom tat')).toBeLessThan(ra.indexOf('noi dung'));
  });

  it('noi ro khi da cat bot — model can biet no dang doc ban thieu', () => {
    expect(ghepVaoPrompt('c', 'a.txt', 'x', true)).toContain('cat bot');
  });
});
