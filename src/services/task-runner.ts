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
import { rutAnh } from '../bot/dinh-dang.js';
import { BoGopTienDo, CongTacSua, veTienDo } from './progress.js';
import type { OpenCodeClient } from './opencode-client.js';
import { LoiOpenCode } from './opencode-client.js';
import { DaCoTaskDangChay, KhoTask, type Task } from './tasks.js';

/** Phan Telegram ma bo chay can — thu hep lai de test khong phai dung bot that. */
export interface CuaSoTelegram {
  guiTinNhan: (chatId: bigint, van: string, banPhim?: unknown) => Promise<bigint>;
  suaTinNhan: (chatId: bigint, messageId: bigint, van: string, banPhim?: unknown) => Promise<void>;
  /**
   * Gui mot anh theo URL. Nem khi Telegram tu choi — ben goi tu quyet dinh.
   *
   * Tach khoi `guiTinNhan` vi that bai o day KHONG phai loi: URL do model dua ra
   * co the chet, qua to, hoac tro toi mot trang HTML chu khong phai anh. Nguoi
   * dung van con lien ket trong phan van ban.
   */
  guiAnh: (chatId: bigint, url: string, chuThich?: string) => Promise<void>;
}

function giay(dc: { batDau: number }): number {
  return Math.round((Date.now() - dc.batDau) / 1000);
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
    dinhKem?: Array<{ type: 'file'; mime: string; url: string; filename?: string }>;
  }): Promise<{ ok: true; task: Task } | { ok: false; lyDo: 'da-co-task' | 'phien-da-chet' }> {
    // Sinh truoc de ghi so va gui prompt dung mot id.
    const messageID = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;

    const gop = new BoGopTienDo(doiSo.sessionID, messageID);

    // GUI TIN NHAN TRUOC, ghi so sau.
    //
    // Truoc day thu tu la: INSERT task (307 ms) -> gui tin nhan -> UPDATE gan id
    // tin nhan (307 ms) -> moi gui prompt. Tuc nguoi dung khong thay gi trong
    // hon nua giay, va prompt chi bat dau chay sau HAI vong DB noi tiep. §7.10
    // dat ngan sach 2 luot truy van cho MOT thao tac; cho nay dung 2 luot chi de
    // ghi so, truoc khi lam bat ky viec gi co ich.
    //
    // Gui tin nhan truoc cho phan hoi ngay, va id tin nhan di thang vao INSERT —
    // con MOT luot truy van tren duong di. Thu tu con lai van giu nguyen y nghia
    // cu: task phai co trong so TRUOC khi prompt chay, neu khong su kien dau tien
    // den ma khong tim thay task nao de gan vao.
    const idTin = await this.tg.guiTinNhan(
      doiSo.telegramChatId,
      veTienDo(gop.trangThaiHienTai(), 0),
    );

    let task: Task;
    try {
      task = await this.khoTask.taoTask({
        telegramUserId: doiSo.telegramUserId,
        telegramChatId: doiSo.telegramChatId,
        telegramStatusMessageId: idTin,
        opencodeSessionId: doiSo.sessionID,
        opencodeMessageId: messageID,
        prompt: doiSo.van,
      });
    } catch (e) {
      if (e instanceof DaCoTaskDangChay) {
        // Da lo gui tin nhan roi thi sua no thay vi bo lai mot dong "dang chay"
        // chet tren man hinh.
        await this.tg
          .suaTinNhan(doiSo.telegramChatId, idTin, '⏳ Ban dang co mot task chay do. Doi no xong hoac dung /abort.')
          .catch(() => undefined);
        return { ok: false, lyDo: 'da-co-task' };
      }
      throw e;
    }

    const dangChay: TaskDangChay = {
      task,
      gop,
      congTac: new CongTacSua(3000),
      batDau: Date.now(),
      quyenDaHien: new Set(),
    };
    this.theoPhien.set(doiSo.sessionID, dangChay);

    try {
      // Chi dat truong khi THAT SU co gia tri: voi exactOptionalPropertyTypes,
      // truyen `undefined` tuong minh khac han voi bo trong truong do.
      await this.client.guiPrompt({
        sessionID: doiSo.sessionID,
        van: doiSo.van,
        messageID,
        ...(doiSo.providerID ? { providerID: doiSo.providerID } : {}),
        ...(doiSo.modelID ? { modelID: doiSo.modelID } : {}),
        ...(doiSo.agent ? { agent: doiSo.agent } : {}),
        ...(doiSo.dinhKem?.length ? { dinhKem: doiSo.dinhKem } : {}),
      });
    } catch (e) {
      // Gui prompt hong thi PHAI nha khoa ngay. Neu khong, nguoi dung bi chan
      // khoi moi cau hoi tiep theo boi mot task chua bao gio bat dau.
      this.theoPhien.delete(doiSo.sessionID);
      await this.khoTask.ketThuc(task.id, 'failed', null, (e as Error).message);

      // 404 = phien khong con ben OpenCode. Day KHONG phai loi bat thuong ma la
      // mot trang thai binh thuong: OpenCode co the da khoi dong lai, hoac phien
      // bi don. Nem mot chuoi JSON tho vao mat nguoi dung thi ho khong biet phai
      // lam gi — ben goi tu nhan dien va tao phien moi.
      if (e instanceof LoiOpenCode && e.status === 404) {
        await this.tg
          .suaTinNhan(doiSo.telegramChatId, idTin, '🔄 Phien cu khong con ton tai. Dang tao phien moi...')
          .catch(() => undefined);
        return { ok: false, lyDo: 'phien-da-chet' };
      }

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
    const idTin = dc.task.telegramStatusMessageId;

    // Quyet dinh KET THUC khong duoc phu thuoc vao cong tac chong sua qua day.
    // Neu de chung mot nhanh thi mot lan bi chan la task khong bao gio dong,
    // khoa khong bao gio nha.
    const nenSua = dc.congTac.nenSua(td) && idTin !== null;

    if (nenSua) {
      dc.gop.danhDauDaVe();

      // LUON gan lai ban phim khi con dang cho duyet.
      //
      // Telegram coi viec sua tin nhan MA KHONG KEM `reply_markup` la lenh XOA
      // ban phim. Truoc day cho nay chi gan nut o lan sua dau tien, nen su kien
      // ke tiep (message.part.updated, session.updated — den lien tuc) sua lai
      // tin nhan khong kem nut va NUT BIEN MAT trong chua day mot giay. Nguoi
      // dung nhin thay dong "Cho ban duyet" ma khong co gi de bam, va agent cho
      // vinh vien.
      let banPhim: unknown;
      const q = td.quyenDangCho;
      if (q) {
        banPhim = this.banPhimDuyet(q.id);
        if (!dc.quyenDaHien.has(q.id)) {
          // Rieng viec doi trang thai trong DB thi chi mot lan cho moi yeu cau.
          dc.quyenDaHien.add(q.id);
          await this.khoTask.doiTrangThai(dc.task.id, 'waiting_permission');
        }
      }

      await this.tg
        .suaTinNhan(dc.task.telegramChatId, idTin as bigint, veTienDo(td, giay(dc)), banPhim)
        .catch((e) => {
          // 429 hoac "message is not modified" khong duoc lam hong task.
          this.log.warn({ err: e }, 'sua tin nhan tien do that bai');
        });
    }

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
      await this.guiAnhKemTheo(dc.task.telegramChatId, ketQua);
    }
  }

  /**
   * Gui THAT nhung anh agent nhac toi bang cu phap `![alt](url)`.
   *
   * Truoc day chung chi thanh mot dong chu — te hon nua, dau `!` bi bo lai va
   * nguoi dung nhin thay "!Duong pho Ha Noi..." voi mot lien ket mau xanh.
   *
   * Moi anh gui rieng va that bai duoc NUOT: URL do model dua ra co the chet,
   * qua to, hoac tro toi mot trang HTML chu khong phai anh — do khong phai loi
   * cua task, va phan van ban van con lien ket de nguoi dung tu mo.
   */
  private async guiAnhKemTheo(chatId: bigint, van: string): Promise<void> {
    const ds = rutAnh(van);
    if (ds.length === 0) return;
    let hong = 0;
    for (const a of ds) {
      try {
        await this.tg.guiAnh(chatId, a.url, a.alt || undefined);
      } catch (e) {
        hong += 1;
        this.log.warn({ err: e, url: a.url }, 'Telegram tu choi anh');
      }
    }
    if (hong === ds.length) {
      // Hong HET thi noi mot cau: im lang o day lam nguoi dung tuong bot bo qua
      // yeu cau xem anh cua ho.
      await this.tg
        .guiTinNhan(chatId, '🖼 Khong tai duoc anh nao — bam vao lien ket trong cau tra loi de xem.')
        .catch(() => undefined);
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
