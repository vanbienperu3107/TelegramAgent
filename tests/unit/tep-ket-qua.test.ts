/**
 * Tim tep agent tao ra trong workspace.
 *
 * AN NINH la phan chinh cua bo test nay. Van ban dau vao do MODEL sinh ra, va
 * model co the bi dan dat boi noi dung no vua doc (mot tep nguoi dung gui len,
 * mot trang web). Neu tin thang duong dan trong do thi mot cau tra loi chua
 * `../../../.env` se lam bot tu gui mat khau DB va token bot ra ngoai.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TRAN_TEP_MB,
  timDuongDan,
  timTepKetQua,
  trongWorkspace,
} from '../../src/bot/tep-ket-qua.js';

describe('chan duong ra khoi workspace', () => {
  const goc = path.resolve('/workspace');

  it('chan `..` du no nam giua duong dan', () => {
    // So chuoi tho se cho qua: '/workspace/../etc/passwd' bat dau bang
    // '/workspace'. Giai ra tuyet doi thi no o '/etc'.
    expect(trongWorkspace('/workspace/../etc/passwd', goc)).toBeNull();
    expect(trongWorkspace('../../.env', goc)).toBeNull();
    expect(trongWorkspace('a/../../../.env', goc)).toBeNull();
  });

  it('chan thu muc chi KHOP TIEN TO', () => {
    // '/workspace-khac' bat dau bang '/workspace' nhung la thu muc khac han.
    expect(trongWorkspace('/workspace-khac/bi-mat', goc)).toBeNull();
    expect(trongWorkspace('/workspaces/x', goc)).toBeNull();
  });

  it('chan chinh thu muc goc — do khong phai mot tep', () => {
    expect(trongWorkspace('/workspace', goc)).toBeNull();
  });

  it('cho qua duong dan that su ben trong', () => {
    expect(trongWorkspace('so-do.png', goc)).toBe(path.resolve(goc, 'so-do.png'));
    expect(trongWorkspace('/workspace/a/b.png', goc)).toBe(path.resolve('/workspace/a/b.png'));
  });
});

describe('rut duong dan tu van ban', () => {
  it('CHI nhan duoi trong danh sach trang', () => {
    // Mot cau van bat ky co the chua dau gach cheo; doan bua se lam bot di doc
    // lung tung.
    const ra = timDuongDan('Toi da tao so-do.png va bao-cao.pdf, con /etc/shadow thi khong');
    expect(ra).toContain('so-do.png');
    expect(ra).toContain('bao-cao.pdf');
    expect(ra.join(' ')).not.toContain('shadow');
  });

  it('khong tra ve trung lap', () => {
    expect(timDuongDan('a.png va a.png nua')).toEqual(['a.png']);
  });

  it('nhan duong dan trong dau nhay nguoc cua Markdown', () => {
    expect(timDuongDan('Xem `ket-qua/bieu-do.svg` nhe')).toContain('ket-qua/bieu-do.svg');
  });
});

describe('tim tep that trong workspace', () => {
  let goc: string;

  beforeAll(async () => {
    goc = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-'));
    await fs.writeFile(path.join(goc, 'so-do.png'), 'x'.repeat(100));
    await fs.writeFile(path.join(goc, 'rong.png'), '');
    await fs.mkdir(path.join(goc, 'thu-muc.png'), { recursive: true });
    await fs.writeFile(path.join(goc, 'qua-to.png'), Buffer.alloc((TRAN_TEP_MB + 1) * 1024 * 1024));
  });

  afterAll(async () => {
    await fs.rm(goc, { recursive: true, force: true });
  });

  it('tim duoc tep co that', async () => {
    const ra = await timTepKetQua('Da tao so-do.png xong', goc);
    expect(ra).toHaveLength(1);
    expect(ra[0]!.ten).toBe('so-do.png');
    expect(ra[0]!.laAnh).toBe(true);
  });

  it('bo qua tep KHONG ton tai', async () => {
    // Agent hay nhac ten tep no DU DINH tao, hoac mot duong dan trong vi du.
    expect(await timTepKetQua('se tao bao-cao.pdf', goc)).toEqual([]);
  });

  it('bo qua thu muc mang ten giong tep', async () => {
    expect(await timTepKetQua('xem thu-muc.png', goc)).toEqual([]);
  });

  it('bo qua tep rong', async () => {
    // Tep 0 byte thuong la dau vet cua mot buoc that bai giua chung.
    expect(await timTepKetQua('xem rong.png', goc)).toEqual([]);
  });

  it('bo qua tep vuot tran cua Telegram', async () => {
    expect(await timTepKetQua('xem qua-to.png', goc)).toEqual([]);
  });

  it('KHONG doc duoc tep ngoai workspace du no ton tai', async () => {
    // Phep kiem quan trong nhat trong file nay.
    const ngoai = path.join(os.tmpdir(), `bi-mat-${Date.now()}.json`);
    await fs.writeFile(ngoai, '{"mat_khau":"x"}');
    try {
      expect(await timTepKetQua(`doc ${ngoai}`, goc)).toEqual([]);
      expect(await timTepKetQua('doc ../../../etc/passwd.json', goc)).toEqual([]);
    } finally {
      await fs.rm(ngoai, { force: true });
    }
  });

  it('gioi han so tep', async () => {
    for (let i = 0; i < 10; i += 1) {
      await fs.writeFile(path.join(goc, `t${i}.png`), 'xx');
    }
    const van = Array.from({ length: 10 }, (_, i) => `t${i}.png`).join(' ');
    expect((await timTepKetQua(van, goc)).length).toBeLessThanOrEqual(5);
  });

  it('phan biet anh voi tai lieu', async () => {
    await fs.writeFile(path.join(goc, 'bang.csv'), 'a,b');
    const ra = await timTepKetQua('xem bang.csv', goc);
    expect(ra[0]!.laAnh).toBe(false);
  });
});
