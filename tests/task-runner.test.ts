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
import { LoiOpenCode } from '../src/services/opencode-client.js';
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
    guiAnh: vi.fn(async (_chat: bigint, _url: string, _chuThich?: string) => undefined),
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
  it('gui tin nhan TRUOC khi ghi so — phan hoi ngay, bot mot vong DB', async () => {
    // Truoc day: INSERT (307 ms) -> gui tin nhan -> UPDATE gan id (307 ms) -> moi
    // gui prompt. Nguoi dung khong thay gi trong hon nua giay, va do la HAI vong
    // DB noi tiep chi de ghi so, truoc khi lam bat ky viec gi co ich.
    const thuTu: string[] = [];
    const { bo } = dungBo({
      kho: {
        taoTask: vi.fn(async () => {
          thuTu.push('ghi-so');
          return taskGia();
        }),
      },
    });
    const goc = dungBo();
    void goc;
    await bo.batDau({
      telegramUserId: 7n,
      telegramChatId: 9n,
      sessionID: 'ses_1',
      van: 'chao',
    });
    expect(thuTu[0]).toBe('ghi-so');
  });

  it('khong con luot UPDATE rieng de gan id tin nhan', async () => {
    // Id tin nhan di thang vao INSERT. Con mot luot truy van tren duong di.
    const { bo, kho } = dungBo();
    await batDau(bo);
    expect((kho.ganTinNhanTrangThai as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    const doiSo = (kho.taoTask as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(doiSo.telegramStatusMessageId).toBe(100n);
  });

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
  it('LUON gan lai ban phim khi con dang cho duyet', async () => {
    // Test nay truoc day khang dinh dieu NGUOC LAI ("chi gui nut mot lan") va
    // do chinh la bug: Telegram coi viec sua tin nhan KHONG kem reply_markup la
    // lenh XOA ban phim. Su kien tiep theo — message.part.updated, session.updated,
    // den lien tuc — sua lai tin nhan khong kem nut, va nut bien mat trong chua
    // day mot giay. Nguoi dung nhin thay dong "Cho ban duyet" ma khong co gi de
    // bam, agent cho vinh vien.
    //
    // Da xay ra that tren may nguoi dung ngay 2026-08-18.
    const { bo, tg } = dungBo();
    await batDau(bo);
    await bo.nhanSuKien({
      type: 'permission.asked',
      properties: { sessionID: 'ses_1', id: 'per_1', permission: 'bash' },
    });
    // Mot su kien BAT KY den sau do, khong lien quan gi toi quyen.
    await bo.nhanSuKien({
      type: 'message.part.delta',
      properties: { sessionID: 'ses_1', messageID: 'msg_1', field: 'text', delta: 'x' },
    });

    const lanSua = tg.suaTinNhan.mock.calls;
    expect(lanSua.length).toBeGreaterThan(1);
    for (const [, , , banPhim] of lanSua) {
      expect(banPhim, 'moi lan sua khi dang cho duyet deu phai kem ban phim').toBeDefined();
    }
  });

  it('doi trang thai DB chi mot lan cho moi yeu cau quyen', async () => {
    // Ban phim thi gan lai moi lan, nhung mot vong ghi DB 307 ms moi su kien la
    // lang phi thuan tuy.
    const { bo, kho } = dungBo();
    await batDau(bo);
    const ev = {
      type: 'permission.asked',
      properties: { sessionID: 'ses_1', id: 'per_1', permission: 'bash' },
    };
    await bo.nhanSuKien(ev);
    await bo.nhanSuKien(ev);
    expect((kho.doiTrangThai as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
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

describe('phien chet ben OpenCode', () => {
  it('404 tra ve ly do rieng, khong nem chuoi JSON tho vao mat nguoi dung', async () => {
    // Xay ra that ngay 2026-08-18: deploy `--force-recreate opencode-server` xoa
    // sach moi phien (luc do chua co volume), nhung bang cua bot van tro toi
    // chung. Nguoi dung nhan nguyen van:
    //   {"name":"NotFoundError","data":{"message":"Session not found: ses_..."}}
    // — khong biet minh lam sai gi va cung khong the doan duoc phai lam gi.
    const { bo, tg } = dungBo({
      client: {
        guiPrompt: vi.fn(async () => {
          throw new LoiOpenCode(404, '/session/ses_1/prompt_async', 'Session not found');
        }),
      },
    });
    const kq = await batDau(bo);
    expect(kq).toEqual({ ok: false, lyDo: 'phien-da-chet' });

    const van = tg.suaTinNhan.mock.calls.at(-1)?.[2] ?? '';
    expect(van).not.toContain('NotFoundError');
    expect(van).toMatch(/phien moi/i);
  });

  it('van NHA KHOA khi phien chet', async () => {
    const { bo, kho } = dungBo({
      client: {
        guiPrompt: vi.fn(async () => {
          throw new LoiOpenCode(404, '/x', 'Session not found');
        }),
      },
    });
    await batDau(bo);
    expect(bo.soTaskDangChay()).toBe(0);
    expect(kho.ketThuc).toHaveBeenCalled();
  });

  it('loi KHAC 404 van bao nguyen van va nem len tren', async () => {
    // 404 la trang thai binh thuong co duong xu ly; 500 thi khong — nuot no di la
    // giau mot su co that.
    const { bo, tg } = dungBo({
      client: {
        guiPrompt: vi.fn(async () => {
          throw new LoiOpenCode(500, '/x', 'noi bo hong');
        }),
      },
    });
    await expect(batDau(bo)).rejects.toBeInstanceOf(LoiOpenCode);
    expect(tg.suaTinNhan.mock.calls.at(-1)?.[2] ?? '').toContain('500');
  });
});

describe('gui anh kem cau tra loi', () => {
  it('gui THAT nhung anh agent nhac toi', async () => {
    // Truoc day chung chi thanh mot dong chu — te hon nua, dau `!` bi bo lai va
    // nguoi dung nhin thay "!Duong pho Ha Noi..." voi mot lien ket mau xanh.
    const { bo, tg } = dungBo({
      client: {
        vanTraLoiCuoi: vi.fn(async () => 'Xem anh:\n![Ho Guom](https://a.vn/1.jpg)'),
      },
    });
    await batDau(bo);
    await bo.nhanSuKien({ type: 'session.idle', properties: { sessionID: 'ses_1' } });
    expect(tg.guiAnh).toHaveBeenCalledWith(9n, 'https://a.vn/1.jpg', 'Ho Guom');
  });

  it('mot anh hong KHONG lam hong task', async () => {
    // URL do model dua ra co the chet, qua to, hoac tro toi trang HTML. Do khong
    // phai loi cua task, va phan van ban van con lien ket de nguoi dung tu mo.
    const { bo, kho, tg } = dungBo({
      client: {
        vanTraLoiCuoi: vi.fn(async () => '![a](https://a.vn/1.jpg) ![b](https://a.vn/2.jpg)'),
      },
    });
    (tg.guiAnh as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('anh chet'));
    await batDau(bo);
    await bo.nhanSuKien({ type: 'session.idle', properties: { sessionID: 'ses_1' } });
    expect(kho.ketThuc).toHaveBeenCalledWith(1n, 'done', expect.any(String), null);
  });

  it('hong HET thi noi mot cau, khong im lang', async () => {
    // Im lang o day lam nguoi dung tuong bot bo qua yeu cau xem anh cua ho.
    const { bo, tg } = dungBo({
      client: { vanTraLoiCuoi: vi.fn(async () => '![a](https://a.vn/1.jpg)') },
    });
    (tg.guiAnh as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('chet'));
    await batDau(bo);
    await bo.nhanSuKien({ type: 'session.idle', properties: { sessionID: 'ses_1' } });
    const cauCuoi = tg.guiTinNhan.mock.calls.at(-1)?.[1] ?? '';
    expect(cauCuoi).toMatch(/khong tai duoc anh/i);
  });

  it('khong goi sendPhoto khi cau tra loi khong co anh nao', async () => {
    const { bo, tg } = dungBo();
    await batDau(bo);
    await bo.nhanSuKien({ type: 'session.idle', properties: { sessionID: 'ses_1' } });
    expect(tg.guiAnh).not.toHaveBeenCalled();
  });
});
