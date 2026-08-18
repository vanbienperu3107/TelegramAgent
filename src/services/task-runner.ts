/**
 * Bo chay task: noi luong su kien, bo gop tien do, so task va Telegram lai.
 *
 * Mot ket noi SSE duy nhat cho ca Gateway (khong phai mot ket noi moi task): moi
 * ket noi la mot dong TCP di 307 ms qua Thai Binh Duong, va OpenCode phat su kien
 * cua MOI phien tren cung mot luong. Vi the o day co mot bo dieu phoi: sessionID
 * -> task dang chay.
 */
import type { Logger } from 'pino';

import type { Config } from '../config.js';
import type { SuKien } from './event-stream.js';
import { BoGopTienDo, CongTacSua, veTienDo } from './progress.js';
import type { OpenCodeClient } from './opencode-client.js';
import { DaCoTaskDangChay, KhoTask, type Task } from './tasks.js';

/** Phan Telegram ma bo chay can — thu hep lai de test khong phai dung bot that. */
export interface CuaSoTelegram {
  guiTinNhan: (chatId: bigint, van: string, banPhim?: unknown) => Promise<bigint>;
  suaTinNhan: (chatId: bigint, messageId: bigint, van: string, banPhim?: unknown) => Promise<void>;
}

interface TaskDangChay {
  task: Task;
  gop: BoGopTienDo;
  congTac: CongTacSua;
  batDau: number;
  /** Id quyen da hien nut, de khong gui nut hai lan cho cung mot yeu cau. */
  quyenDaHien: Set<string>;
}

export class BoChayTask {
  /** sessionID -> task dang chay. Mot phien chi co mot task tai mot thoi diem. */
  private theoPhien = new Map<string, TaskDangChay>();

  constructor(
    private readonly cfg: Config,
    private readonly client: OpenCodeClient,
    private readonly khoTask: KhoTask,
    private readonly tg: CuaSoTelegram,
    private readonly log: Logger,
    private readonly banPhimDuyet: (permissionID: string) => unknown,
  ) {}

  soTaskDangChay(): number {
    return this.theoPhien.size;
  }

  /**
   * Bat dau mot task.
   *
   * Thu tu la co y: ghi so TRUOC khi gui prompt. Nguoc lai thi giua luc prompt da
   * chay ma so chua co, mot su kien den se khong tim thay task nao de gan vao —
   * va tien do dau tien bi mat. Voi mot luot chay 307 ms mot vong, cua so do du
   * rong de xay ra that.
   */
  async batDau(doiSo: {
    telegramUserId: bigint;
    telegramChatId: bigint;
    sessionID: string;
    van: string;
    providerID?: string | null;
    modelID?: string | null;
    agent?: string | null;
  }): Promise<{ ok: true; task: Task } | { ok: false; lyDo: 'da-co-task' }> {
    // Sinh truoc de ghi so va gui prompt dung mot id.
    const messageID = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;

    let task: Task;
    try {
      task = await this.khoTask.taoTask({
        telegramUserId: doiSo.telegramUserId,
        telegramChatId: doiSo.telegramChatId,
        opencodeSessionId: doiSo.sessionID,
        opencodeMessageId: messageID,
        prompt: doiSo.van,
      });
    } catch (e) {
      if (e instanceof DaCoTaskDangChay) return { ok: false, lyDo: 'da-co-task' };
      throw e;
    }

    const gop = new BoGopTienDo(doiSo.sessionID, messageID);
    const dangChay: TaskDangChay = {
      task,
      gop,
      congTac: new CongTacSua(3000),
      batDau: Date.now(),
      quyenDaHien: new Set(),
    };
    this.theoPhien.set(doiSo.sessionID, dangChay);

    const idTin = await this.tg.guiTinNhan(
      doiSo.telegramChatId,
      veTienDo(gop.trangThaiHienTai(), 0),
    );
    dangChay.task = { ...task, telegramStatusMessageId: idTin };
    await this.khoTask.ganTinNhanTrangThai(task.id, idTin);

    try {
      await this.client.guiPrompt({
        sessionID: doiSo.sessionID,
        van: doiSo.van,
        providerID: doiSo.providerID ?? undefined,
        modelID: doiSo.modelID ?? undefined,
        agent: doiSo.agent ?? undefined,
        messageID,
      });
    } catch (e) {
      // Gui prompt hong thi PHAI nha khoa ngay. Neu khong, nguoi dung bi chan
      // khoi moi cau hoi tiep theo boi mot task chua bao gio bat dau.
      this.theoPhien.delete(doiSo.sessionID);
      await this.khoTask.ketThuc(task.id, 'failed', null, (e as Error).message);
      await this.tg.suaTinNhan(
        doiSo.telegramChatId,
        idTin,
        `❌ Khong gui duoc yeu cau toi OpenCode: ${(e as Error).message}`,
      );
      throw e;
    }

    return { ok: true, task: dangChay.task };
  }

  /** Nhan mot su kien tu luong. Khong nem — mot su kien hong khong duoc giet luong. */
  async nhanSuKien(ev: SuKien): Promise<void> {
    const sessionID = (ev.properties ?? {}).sessionID;
    if (typeof sessionID !== 'string') return;
    const dc = this.theoPhien.get(sessionID);
    if (!dc) return;

    try {
      dc.gop.nhan(ev);
      await this.veLai(dc);
    } catch (e) {
      this.log.error({ err: e, type: ev.type }, 'loi khi xu ly su kien');
    }
  }

  private async veLai(dc: TaskDangChay): Promise<void> {
    const td = dc.gop.trangThaiHienTai();
    if (!dc.congTac.nenSua(td)) return;
    dc.gop.danhDauDaVe();

    const giay = Math.round((Date.now() - dc.batDau) / 1000);
    const idTin = dc.task.telegramStatusMessageId;
    if (idTin === null) return;

    // Nut duyet chi gui MOT lan cho moi yeu cau: sua lai ban phim moi vai giay
    // lam nut nhay duoi ngon tay nguoi dung.
    let banPhim: unknown;
    const q = td.quyenDangCho;
    if (q && !dc.quyenDaHien.has(q.id)) {
      dc.quyenDaHien.add(q.id);
      banPhim = this.banPhimDuyet(q.id);
      await this.khoTask.doiTrangThai(dc.task.id, 'waiting_permission');
    }

    await this.tg
      .suaTinNhan(dc.task.telegramChatId, idTin, veTienDo(td, giay), banPhim)
      .catch((e) => {
        // 429 hoac "message is not modified" khong duoc lam hong task.
        this.log.warn({ err: e }, 'sua tin nhan tien do that bai');
      });

    if (td.trangThai === 'xong') await this.ketThuc(dc);
  }

  private async ketThuc(dc: TaskDangChay): Promise<void> {
    this.theoPhien.delete(dc.task.opencodeSessionId);

    // Doc lai cau tra loi tu API thay vi dung van ban da ghep tu delta.
    // Hai nguon phai trung nhau, nhung khi lech thi API dung: ban ghep co the
    // thieu manh dau neu ta noi vao luong muon (khong co replay — da do).
    let ketQua = '';
    try {
      ketQua = await this.client.vanTraLoiCuoi(dc.task.opencodeSessionId);
    } catch (e) {
      this.log.warn({ err: e }, 'khong doc lai duoc cau tra loi, dung ban ghep tu delta');
    }
    if (ketQua.trim().length === 0) ketQua = dc.gop.trangThaiHienTai().van;

    await this.khoTask.ketThuc(dc.task.id, 'done', ketQua, null);

    if (ketQua.trim().length > 0) {
      for (const manh of chiaTinNhan(ketQua)) {
        await this.tg.guiTinNhan(dc.task.telegramChatId, manh);
      }
    }
  }

  /** Huy task cua mot nguoi dung. Tra `false` neu ho khong co task nao dang chay. */
  async huy(telegramUserId: bigint): Promise<boolean> {
    const task = await this.khoTask.taskDangChay(telegramUserId);
    if (!task) return false;
    this.theoPhien.delete(task.opencodeSessionId);
    await this.client.huy(task.opencodeSessionId).catch((e) => {
      this.log.warn({ err: e }, 'goi abort that bai, van danh dau da huy');
    });
    await this.khoTask.ketThuc(task.id, 'aborted', null, null);
    if (task.telegramStatusMessageId !== null) {
      await this.tg
        .suaTinNhan(task.telegramChatId, task.telegramStatusMessageId, '🛑 Da huy task.')
        .catch(() => undefined);
    }
    return true;
  }

  /**
   * Doi chieu sau khi noi lai luong.
   *
   * BAT BUOC, khong phai toi uu: luong su kien KHONG co replay (da do — noi lai
   * chi nhan `server.connected`, khong co `Last-Event-ID`). Moi su kien phat ra
   * trong luc dut la mat vinh vien, ke ca `session.idle`. Khong co ham nay thi
   * mot lan dut ngan la mot task treo mai va mot nguoi dung bi khoa.
   */
  async doiChieuSauKhiNoiLai(): Promise<void> {
    for (const [sessionID, dc] of [...this.theoPhien]) {
      try {
        const quyen = await this.client.dsQuyenChoDuyet(sessionID);
        for (const q of quyen) {
          if (dc.quyenDaHien.has(q.id)) continue;
          dc.gop.nhan({
            type: 'permission.asked',
            properties: q as unknown as Record<string, unknown>,
          });
        }
        // Neu khong con quyen cho duyet VA da co cau tra loi thi luot chay da
        // xong trong luc ta mat ket noi.
        if (quyen.length === 0) {
          const van = await this.client.vanTraLoiCuoi(sessionID);
          if (van.trim().length > 0) {
            dc.gop.nhan({ type: 'session.idle', properties: { sessionID } });
          }
        }
        await this.veLai(dc);
      } catch (e) {
        this.log.warn({ err: e, sessionID }, 'doi chieu sau khi noi lai that bai');
      }
    }
  }
}

/** Gioi han tin nhan cua Telegram. Cat theo dong de khong xe giua mot dong ma. */
export const TRAN_TIN_NHAN_TELEGRAM = 4096;

export function chiaTinNhan(van: string, tran = TRAN_TIN_NHAN_TELEGRAM): string[] {
  if (van.length <= tran) return [van];
  const ra: string[] = [];
  let hienTai = '';
  for (const dong of van.split('\n')) {
    // Mot dong dai hon ca tran thi buoc phai cat cung — nhung do la truong hop
    // hiem (ma nguon rat dai khong xuong dong), con truong hop thuong thi cat o
    // ranh gioi dong giu duoc khoi ma nguyen ven.
    if (dong.length > tran) {
      if (hienTai) ra.push(hienTai), (hienTai = '');
      for (let i = 0; i < dong.length; i += tran) ra.push(dong.slice(i, i + tran));
      continue;
    }
    if (hienTai.length + dong.length + 1 > tran) {
      ra.push(hienTai);
      hienTai = dong;
    } else {
      hienTai = hienTai ? `${hienTai}\n${dong}` : dong;
    }
  }
  if (hienTai) ra.push(hienTai);
  return ra;
}
