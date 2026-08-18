/**
 * Bo gop tien do, kiem bang CHINH file su kien that da chup.
 *
 * `docs/opencode-events-sample.jsonl` la 111 su kien cua mot luot hoi-dap co dung
 * tool va co duyet quyen tren server that. Cho no chay qua bo gop la phep thu sat
 * thuc te nhat co the lam ma khong can server — va no bat duoc dung nhung gia dinh
 * sai ma test tu bia khong bat duoc, vi test tu bia chi chua nhung gi ta DA NGHI toi.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BoGopTienDo, CongTacSua, TRAN_TIN_NHAN, veTienDo } from '../src/services/progress.js';
import type { SuKien } from '../src/services/event-stream.js';

const GOC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function suKienThat(): SuKien[] {
  const tho = fs.readFileSync(path.join(GOC, 'docs', 'opencode-events-sample.jsonl'), 'utf8');
  const ra: SuKien[] = [];
  for (const dong of tho.split('\n')) {
    const d = dong.trim();
    if (!d.startsWith('data: ')) continue;
    try {
      ra.push(JSON.parse(d.slice(6)) as SuKien);
    } catch {
      /* khung hong trong ban chup — bo qua, giong het luc chay that */
    }
  }
  return ra;
}

function phienTrongMau(ds: SuKien[]): string {
  for (const ev of ds) {
    const s = (ev.properties ?? {}).sessionID;
    if (typeof s === 'string') return s;
  }
  throw new Error('ban chup khong co sessionID nao — file mau hong');
}

describe('chay lai ban chup that', () => {
  const ds = suKienThat();

  it('ban chup co du du lieu de test co y nghia', () => {
    // Neu ai do thay file mau bang mot ban chup nhat nheo (vi du chup luc khong
    // co gi chay, nhu vong do dau tien), moi test duoi day van XANH ma khong kiem
    // gi ca. Phep kiem nay chan dieu do.
    const loai = new Set(ds.map((e) => e.type));
    expect(ds.length).toBeGreaterThan(50);
    for (const t of ['message.part.delta', 'permission.asked', 'permission.replied', 'session.idle']) {
      expect(loai.has(t), `ban chup thieu ${t}`).toBe(true);
    }
  });

  it('ket thuc o trang thai xong, khong treo', () => {
    const gop = new BoGopTienDo(phienTrongMau(ds), null);
    for (const ev of ds) gop.nhan(ev);
    expect(gop.trangThaiHienTai().trangThai).toBe('xong');
  });

  it('ghep duoc van ban tra loi tu cac manh delta', () => {
    const gop = new BoGopTienDo(phienTrongMau(ds), null);
    for (const ev of ds) gop.nhan(ev);
    expect(gop.trangThaiHienTai().van.length).toBeGreaterThan(0);
  });

  it('di qua trang thai cho-duyet giua chung', () => {
    // Luot chay that co dung `ls -la` nen cham cua duyet. Neu bo gop khong bao
    // gio vao trang thai nay thi nut duyet khong bao gio hien va agent cho mai.
    const gop = new BoGopTienDo(phienTrongMau(ds), null);
    let daThayChoDuyet = false;
    for (const ev of ds) {
      gop.nhan(ev);
      if (gop.trangThaiHienTai().trangThai === 'cho-duyet') daThayChoDuyet = true;
    }
    expect(daThayChoDuyet).toBe(true);
  });

  it('doc duoc lenh cu the trong yeu cau quyen, khong chi ten quyen', () => {
    const gop = new BoGopTienDo(phienTrongMau(ds), null);
    for (const ev of ds) {
      gop.nhan(ev);
      const q = gop.trangThaiHienTai().quyenDangCho;
      if (q) {
        // Nguoi dung phai thay agent dinh chay LENH GI, khong phai chi "bash".
        expect(q.permission).toBe('bash');
        expect(q.lenh).toBeTruthy();
        return;
      }
    }
    throw new Error('khong bat duoc yeu cau quyen nao');
  });

  it('bo qua nhieu — plugin.added khong lam doi gi', () => {
    const gop = new BoGopTienDo(phienTrongMau(ds), null);
    for (const ev of ds) gop.nhan(ev);
    const sau = { ...gop.trangThaiHienTai() };
    gop.nhan({ type: 'plugin.added', properties: { sessionID: phienTrongMau(ds) } });
    expect(gop.trangThaiHienTai().van).toBe(sau.van);
    expect(gop.trangThaiHienTai().trangThai).toBe(sau.trangThai);
  });
});

describe('cach ly giua cac luot', () => {
  it('bo qua su kien cua phien khac', () => {
    const gop = new BoGopTienDo('ses_cua_ta', null);
    gop.nhan({
      type: 'message.part.delta',
      properties: { sessionID: 'ses_nguoi_khac', field: 'text', delta: 'ro ri' },
    });
    expect(gop.trangThaiHienTai().van).toBe('');
  });

  it('bo qua su kien cua luot truoc trong CUNG phien', () => {
    // Nguoi dung gui hai cau hoi lien tiep: su kien cua cau truoc van con den.
    const gop = new BoGopTienDo('ses_1', 'msg_moi');
    gop.nhan({
      type: 'message.part.delta',
      properties: { sessionID: 'ses_1', messageID: 'msg_cu', field: 'text', delta: 'cu' },
    });
    gop.nhan({
      type: 'message.part.delta',
      properties: { sessionID: 'ses_1', messageID: 'msg_moi', field: 'text', delta: 'moi' },
    });
    expect(gop.trangThaiHienTai().van).toBe('moi');
  });

  it('van nhan session.idle du no khong co messageID', () => {
    // Danh doi co y: chat qua thi bo mat moc ket thuc va task treo vinh vien.
    const gop = new BoGopTienDo('ses_1', 'msg_1');
    gop.nhan({ type: 'session.idle', properties: { sessionID: 'ses_1' } });
    expect(gop.trangThaiHienTai().trangThai).toBe('xong');
  });
});

describe('loc truong cua delta', () => {
  it('chi ghep truong text, bo qua reasoning va doi so tool', () => {
    // Ghep ca vao thi nguoi dung thay JSON do dang giua cau tra loi.
    const gop = new BoGopTienDo('ses_1', null);
    for (const field of ['reasoning', 'input', 'text']) {
      gop.nhan({
        type: 'message.part.delta',
        properties: { sessionID: 'ses_1', field, delta: field },
      });
    }
    expect(gop.trangThaiHienTai().van).toBe('text');
  });
});

describe('ve tien do', () => {
  it('khong vuot tran tin nhan cua Telegram', () => {
    const gop = new BoGopTienDo('ses_1', null);
    for (let i = 0; i < 5000; i += 1) {
      gop.nhan({
        type: 'message.part.delta',
        properties: { sessionID: 'ses_1', field: 'text', delta: 'chu ' },
      });
    }
    expect(veTienDo(gop.trangThaiHienTai(), 10).length).toBeLessThan(TRAN_TIN_NHAN);
  });

  it('giu PHAN CUOI cua van ban chu khong phai phan dau', () => {
    // Phan moi nhat la phan nguoi dung dang doi. Cat duoi thi ho nhin mai mot
    // doan cu trong khi agent van chay.
    const gop = new BoGopTienDo('ses_1', null);
    gop.nhan({
      type: 'message.part.delta',
      properties: { sessionID: 'ses_1', field: 'text', delta: `${'a'.repeat(5000)}KETTHUC` },
    });
    expect(veTienDo(gop.trangThaiHienTai(), 1)).toContain('KETTHUC');
  });

  it('hien lenh cu the khi dang cho duyet', () => {
    const gop = new BoGopTienDo('ses_1', null);
    gop.nhan({
      type: 'permission.asked',
      properties: {
        sessionID: 'ses_1',
        id: 'per_1',
        permission: 'bash',
        metadata: { command: 'rm -rf /tmp/x' },
      },
    });
    const van = veTienDo(gop.trangThaiHienTai(), 5);
    expect(van).toContain('rm -rf /tmp/x');
  });
});

describe('cong tac chong sua qua day', () => {
  it('chan sua lien tuc khi chi co them chu', () => {
    // delta den theo TUNG TOKEN — hang chuc su kien moi giay. Sua theo tung su
    // kien la 429 chac chan.
    const ct = new CongTacSua(3000);
    const td = { trangThai: 'dang-chay', van: 'x', tool: [], quyenDangCho: null, banThay: true } as const;
    expect(ct.nenSua(td, 1000)).toBe(true);
    expect(ct.nenSua(td, 1500)).toBe(false);
    expect(ct.nenSua(td, 2999)).toBe(false);
    expect(ct.nenSua(td, 4100)).toBe(true);
  });

  it('KHONG chan trang thai cuoi va cua duyet', () => {
    // Nguoi dung dang cho de bam nut; 3 giay o day la 3 giay agent dung im.
    const ct = new CongTacSua(3000);
    const dangChay = { trangThai: 'dang-chay', van: 'x', tool: [], quyenDangCho: null, banThay: true } as const;
    ct.nenSua(dangChay, 1000);
    for (const tt of ['cho-duyet', 'xong', 'loi'] as const) {
      expect(ct.nenSua({ ...dangChay, trangThai: tt }, 1001)).toBe(true);
    }
  });

  it('khong sua khi khong co gi doi', () => {
    const ct = new CongTacSua(0);
    expect(
      ct.nenSua({ trangThai: 'dang-chay', van: '', tool: [], quyenDangCho: null, banThay: false }, 1),
    ).toBe(false);
  });
});
