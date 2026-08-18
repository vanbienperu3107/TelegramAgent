/**
 * Bo chay task.
 *
 * Trong tam la cac duong HONG, vi duong tot thi da co test cua bo gop tien do.
 * Moi test o day gan voi mot cach cu the ma nguoi dung bi KHOA VINH VIEN — do la
 * hong nang nhat cua tinh nang nay: bot khong bao gio tra loi lai va nguoi dung
 * khong co cach nao tu go.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Config } from '../src/config.js';
import type { OpenCodeClient } from '../src/services/opencode-client.js';
import { BoChayTask, chiaTinNhan } from '../src/services/task-runner.js';
import { DaCoTaskDangChay, type KhoTask, type Task } from '../src/services/tasks.js';

const cfg = { DEFAULT_PROVIDER: 'cliproxy', DEFAULT_MODEL: 'm', DEFAULT_AGENT: 'build' } as Config;
const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;

const taskGia = (): Task => ({
  id: 1n,
  telegramUserId: 7n,
  telegramChatId: 9n,
  telegramStatusMessageId: null,
  opencodeSessionId: 'ses_1',
  opencodeMessageId: 'msg_1',
  trangThai: 'running',
  batDau: new Date(),
});

function dungBo(ghiDe: {
  client?: Partial<OpenCodeClient>;
  kho?: Partial<KhoTask>;
} = {}) {
  const tg = {
    guiTinNhan: vi.fn(async () => 100n),
    suaTinNhan: vi.fn(
      async (_chat: bigint, _msg: bigint, _van: string, _banPhim?: unknown) => undefined,
    ),
  };
  const kho = {
    taoTask: vi.fn(async () => taskGia()),
    ganTinNhanTrangThai: vi.fn(async () => undefined),
    doiTrangThai: vi.fn(async () => undefined),
    ketThuc: vi.fn(async () => undefined),
    taskDangChay: vi.fn(async () => null),
    ...ghiDe.kho,
  } as unknown as KhoTask;
  const client = {
    guiPrompt: vi.fn(async () => 'msg_1'),
    vanTraLoiCuoi: vi.fn(async () => 'xong roi'),
    huy: vi.fn(async () => undefined),
    dsQuyenChoDuyet: vi.fn(async () => []),
    ...ghiDe.client,
  } as unknown as OpenCodeClient;
  const bo = new BoChayTask(cfg, client, kho, tg, log, (id) => ({ nut: id }));
  return { bo, tg, kho, client };
}

const batDau = (bo: BoChayTask) =>
  bo.batDau({
    telegramUserId: 7n,
    telegramChatId: 9n,
    sessionID: 'ses_1',
    van: 'chao',
  });

describe('khoa mot task moi nguoi', () => {
  it('tu choi task thu hai thay vi de hai tien do ghi de len nhau', async () => {
    const { bo } = dungBo({
      kho: {
        taoTask: vi.fn(async () => {
          throw new DaCoTaskDangChay();
        }),
      },
    });
    expect(await batDau(bo)).toEqual({ ok: false, lyDo: 'da-co-task' });
  });

  it('NHA KHOA khi gui prompt that bai', async () => {
    // Neu khong nha, nguoi dung bi chan khoi moi cau hoi tiep theo boi mot task
    // CHUA BAO GIO bat dau — va khong co cach nao tu go tru khi admin sua DB.
    const { bo, kho, tg } = dungBo({
      client: {
        guiPrompt: vi.fn(async () => {
          throw new Error('opencode 500');
        }),
      },
    });
    await expect(batDau(bo)).rejects.toThrow('opencode 500');
    expect(kho.ketThuc).toHaveBeenCalledWith(1n, 'failed', null, 'opencode 500');
    expect(bo.soTaskDangChay()).toBe(0);
    // Va nguoi dung phai duoc bao, khong phai nhin mot tin nhan "dang chay" chet.
    expect(tg.suaTinNhan).toHaveBeenCalled();
  });
});

describe('ghi so truoc, gui prompt sau', () => {
  it('task duoc ghi so TRUOC khi prompt chay', async () => {
    // Nguoc lai thi su kien dau tien den truoc khi co task de gan vao, va tien
    // do dau bi mat. Voi mot vong 307 ms, cua so do du rong de xay ra that.
    const thuTu: string[] = [];
    const { bo } = dungBo({
      kho: {
        taoTask: vi.fn(async () => {
          thuTu.push('ghi-so');
          return taskGia();
        }),
      },
      client: {
        guiPrompt: vi.fn(async () => {
          thuTu.push('prompt');
          return 'msg_1';
        }),
      },
    });
    await batDau(bo);
    expect(thuTu).toEqual(['ghi-so', 'prompt']);
  });
});

describe('vong doi qua su kien', () => {
  it('session.idle ket thuc task va gui cau tra loi', async () => {
    const { bo, tg, kho } = dungBo();
    await batDau(bo);
    await bo.nhanSuKien({ type: 'session.idle', properties: { sessionID: 'ses_1' } });
    expect(kho.ketThuc).toHaveBeenCalledWith(1n, 'done', 'xong roi', null);
    expect(bo.soTaskDangChay()).toBe(0);
    expect(tg.guiTinNhan).toHaveBeenCalledWith(9n, 'xong roi');
  });

  it('doc lai cau tra loi tu API chu khong dung ban ghep tu delta', async () => {
    // Khong co replay: neu ta noi vao luong muon thi ban ghep thieu manh dau.
    // API la nguon dung.
    const { bo, tg } = dungBo({ client: { vanTraLoiCuoi: vi.fn(async () => 'ban day du') } });
    await batDau(bo);
    await bo.nhanSuKien({
      type: 'message.part.delta',
      properties: { sessionID: 'ses_1', messageID: 'msg_1', field: 'text', delta: 'thieu' },
    });
    await bo.nhanSuKien({ type: 'session.idle', properties: { sessionID: 'ses_1' } });
    expect(tg.guiTinNhan).toHaveBeenCalledWith(9n, 'ban day du');
  });

  it('API hong thi lui ve ban ghep chu khong mat cau tra loi', async () => {
    const { bo, tg } = dungBo({
      client: {
        vanTraLoiCuoi: vi.fn(async () => {
          throw new Error('mang hong');
        }),
      },
    });
    await batDau(bo);
    await bo.nhanSuKien({
      type: 'message.part.delta',
      properties: { sessionID: 'ses_1', messageID: 'msg_1', field: 'text', delta: 'cuu duoc' },
    });
    await bo.nhanSuKien({ type: 'session.idle', properties: { sessionID: 'ses_1' } });
    expect(tg.guiTinNhan).toHaveBeenCalledWith(9n, 'cuu duoc');
  });

  it('su kien cua phien khac khong dung toi task cua ta', async () => {
    const { bo, kho } = dungBo();
    await batDau(bo);
    await bo.nhanSuKien({ type: 'session.idle', properties: { sessionID: 'ses_khac' } });
    expect(kho.ketThuc).not.toHaveBeenCalled();
    expect(bo.soTaskDangChay()).toBe(1);
  });

  it('mot su kien hong khong lam chet bo chay', async () => {
    const { bo } = dungBo();
    await batDau(bo);
    await expect(
      bo.nhanSuKien({ type: 'permission.asked', properties: { sessionID: 'ses_1' } }),
    ).resolves.toBeUndefined();
  });
});

describe('nut duyet quyen', () => {
  it('chi gui nut MOT lan cho moi yeu cau', async () => {
    // Sua lai ban phim moi vai giay lam nut nhay duoi ngon tay nguoi dung.
    const { bo, tg } = dungBo();
    await batDau(bo);
    const ev = {
      type: 'permission.asked',
      properties: { sessionID: 'ses_1', id: 'per_1', permission: 'bash' },
    };
    await bo.nhanSuKien(ev);
    await bo.nhanSuKien(ev);
    const coNut = tg.suaTinNhan.mock.calls.filter((c) => c[3] !== undefined);
    expect(coNut).toHaveLength(1);
  });

  it('ghi trang thai waiting_permission de khoa khong bi coi la treo', async () => {
    const { bo, kho } = dungBo();
    await batDau(bo);
    await bo.nhanSuKien({
      type: 'permission.asked',
      properties: { sessionID: 'ses_1', id: 'per_1', permission: 'bash' },
    });
    expect(kho.doiTrangThai).toHaveBeenCalledWith(1n, 'waiting_permission');
  });
});

describe('doi chieu sau khi noi lai', () => {
  it('phat hien luot chay da xong trong luc mat ket noi', async () => {
    // Khong co replay: session.idle phat ra trong luc dut la mat vinh vien. Khong
    // co buoc nay thi task treo mai va nguoi dung bi khoa.
    const { bo, kho } = dungBo();
    await batDau(bo);
    await bo.doiChieuSauKhiNoiLai();
    expect(kho.ketThuc).toHaveBeenCalledWith(1n, 'done', 'xong roi', null);
  });

  it('phat hien yeu cau quyen bi bo lo', async () => {
    const { bo, tg } = dungBo({
      client: {
        dsQuyenChoDuyet: vi.fn(async () => [
          { id: 'per_1', sessionID: 'ses_1', permission: 'bash' },
        ]),
      },
    });
    await batDau(bo);
    await bo.doiChieuSauKhiNoiLai();
    const coNut = tg.suaTinNhan.mock.calls.filter((c) => c[3] !== undefined);
    expect(coNut).toHaveLength(1);
  });

  it('khong ket thuc nham khi luot chay van dang cho duyet', async () => {
    const { bo, kho } = dungBo({
      client: {
        dsQuyenChoDuyet: vi.fn(async () => [
          { id: 'per_1', sessionID: 'ses_1', permission: 'bash' },
        ]),
      },
    });
    await batDau(bo);
    await bo.doiChieuSauKhiNoiLai();
    expect(kho.ketThuc).not.toHaveBeenCalled();
  });
});

describe('huy', () => {
  it('nha khoa ngay ca khi goi abort that bai', async () => {
    // OpenCode co the dang chet. Khong nha khoa o day thi nguoi dung ket luon.
    const { bo, kho } = dungBo({
      kho: { taskDangChay: vi.fn(async () => ({ ...taskGia(), telegramStatusMessageId: 100n })) },
      client: {
        huy: vi.fn(async () => {
          throw new Error('opencode chet');
        }),
      },
    });
    expect(await bo.huy(7n)).toBe(true);
    expect(kho.ketThuc).toHaveBeenCalledWith(1n, 'aborted', null, null);
  });

  it('tra false khi khong co task nao', async () => {
    const { bo } = dungBo();
    expect(await bo.huy(7n)).toBe(false);
  });
});

describe('chia tin nhan dai', () => {
  it('giu nguyen tin nhan ngan', () => {
    expect(chiaTinNhan('ngan')).toEqual(['ngan']);
  });

  it('cat o ranh gioi DONG de khong xe giua khoi ma', () => {
    const van = Array.from({ length: 200 }, (_, i) => `dong ${i}`).join('\n');
    const manh = chiaTinNhan(van, 100);
    expect(manh.length).toBeGreaterThan(1);
    for (const m of manh) expect(m.length).toBeLessThanOrEqual(100);
    expect(manh.join('\n')).toBe(van);
  });

  it('van cat duoc mot dong dai hon ca tran', () => {
    const manh = chiaTinNhan('x'.repeat(250), 100);
    expect(manh).toHaveLength(3);
    for (const m of manh) expect(m.length).toBeLessThanOrEqual(100);
  });
});
