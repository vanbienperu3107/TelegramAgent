/**
 * So task va khoa mot-task-moi-nguoi.
 *
 * Khoa duoc thi hanh bang CHI SO RIENG PHAN cua Postgres
 * (`uniq_task_dang_chay`, migration 009) chu khong bang bien trong RAM. Bien RAM
 * khong du: luc deploy co hai ban sao Gateway chong lan nhau trong vai giay, moi
 * ban giu mot bien rieng va cung cho phep mot task — nguoi dung co hai task song
 * song, hai tien do ghi de len nhau, va khong ai hieu chuyen gi vua xay ra.
 */
import type { Sql } from 'postgres';

export type TrangThaiGhiSo = 'running' | 'waiting_permission' | 'done' | 'failed' | 'aborted';

/** Ma loi cua Postgres cho vi pham rang buoc duy nhat. */
const VI_PHAM_DUY_NHAT = '23505';

export interface Task {
  id: bigint;
  telegramUserId: bigint;
  telegramChatId: bigint;
  telegramStatusMessageId: bigint | null;
  opencodeSessionId: string;
  opencodeMessageId: string;
  trangThai: TrangThaiGhiSo;
  batDau: Date;
}

interface Row {
  id: string;
  telegram_user_id: string;
  telegram_chat_id: string;
  telegram_status_message_id: string | null;
  opencode_session_id: string;
  opencode_message_id: string;
  trang_thai: TrangThaiGhiSo;
  bat_dau: Date;
}

function tuRow(r: Row): Task {
  return {
    id: BigInt(r.id),
    telegramUserId: BigInt(r.telegram_user_id),
    telegramChatId: BigInt(r.telegram_chat_id),
    telegramStatusMessageId:
      r.telegram_status_message_id === null ? null : BigInt(r.telegram_status_message_id),
    opencodeSessionId: r.opencode_session_id,
    opencodeMessageId: r.opencode_message_id,
    trangThai: r.trang_thai,
    batDau: r.bat_dau,
  };
}

/** Nem khi nguoi dung da co mot task dang chay. Ben goi phan biet duoc voi loi khac. */
export class DaCoTaskDangChay extends Error {
  constructor() {
    super('nguoi dung da co mot task dang chay');
    this.name = 'DaCoTaskDangChay';
  }
}

export class KhoTask {
  constructor(private readonly sql: Sql) {}

  /**
   * Ghi so mot task moi. Nem `DaCoTaskDangChay` neu vi pham khoa.
   *
   * Bat theo MA LOI `23505` chu khong doc chuoi thong bao: chuoi doi theo phien
   * ban va theo ngon ngu cua server, ma loi thi khong.
   */
  async taoTask(doiSo: {
    telegramUserId: bigint;
    telegramChatId: bigint;
    opencodeSessionId: string;
    opencodeMessageId: string;
    prompt: string;
  }): Promise<Task> {
    try {
      const rows = await this.sql<Row[]>`
        INSERT INTO tasks (
          telegram_user_id, telegram_chat_id, opencode_session_id,
          opencode_message_id, prompt
        ) VALUES (
          ${String(doiSo.telegramUserId)}, ${String(doiSo.telegramChatId)},
          ${doiSo.opencodeSessionId}, ${doiSo.opencodeMessageId}, ${doiSo.prompt}
        )
        RETURNING id, telegram_user_id, telegram_chat_id, telegram_status_message_id,
                  opencode_session_id, opencode_message_id, trang_thai, bat_dau`;
      const r = rows[0];
      if (!r) throw new Error('INSERT task khong tra ve dong nao');
      return tuRow(r);
    } catch (e) {
      if ((e as { code?: string })?.code === VI_PHAM_DUY_NHAT) throw new DaCoTaskDangChay();
      throw e;
    }
  }

  async ganTinNhanTrangThai(taskId: bigint, messageId: bigint): Promise<void> {
    await this.sql`
      UPDATE tasks SET telegram_status_message_id = ${String(messageId)}
      WHERE id = ${String(taskId)}`;
  }

  async doiTrangThai(taskId: bigint, trangThai: TrangThaiGhiSo): Promise<void> {
    await this.sql`
      UPDATE tasks SET trang_thai = ${trangThai} WHERE id = ${String(taskId)}`;
  }

  async ketThuc(
    taskId: bigint,
    trangThai: Extract<TrangThaiGhiSo, 'done' | 'failed' | 'aborted'>,
    ketQua: string | null,
    loi: string | null,
  ): Promise<void> {
    await this.sql`
      UPDATE tasks
      SET trang_thai = ${trangThai}, ket_qua = ${ketQua}, loi = ${loi}, ket_thuc = NOW()
      WHERE id = ${String(taskId)}`;
  }

  async taskDangChay(telegramUserId: bigint): Promise<Task | null> {
    const rows = await this.sql<Row[]>`
      SELECT id, telegram_user_id, telegram_chat_id, telegram_status_message_id,
             opencode_session_id, opencode_message_id, trang_thai, bat_dau
      FROM tasks
      WHERE telegram_user_id = ${String(telegramUserId)}
        AND trang_thai IN ('running', 'waiting_permission')`;
    const r = rows[0];
    return r ? tuRow(r) : null;
  }

  /**
   * Task nao dang chay ma qua han thi danh dau that bai.
   *
   * Chay luc KHOI DONG. Ly do: Gateway co the bi giet giua luot chay (OOM, hoac
   * `--force-recreate` luc deploy), va luc do dong task van o `running` mai mai —
   * khoa mot-task khong bao gio nha, nguoi dung khong gui duoc gi nua va khong co
   * cach nao tu go. Doc "so task treo" o log khoi dong la tin hieu ro rang.
   */
  async donTaskMoCoi(quaBaoNhieuPhut: number): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE tasks
      SET trang_thai = 'failed',
          loi = 'gateway khoi dong lai giua luot chay',
          ket_thuc = NOW()
      WHERE trang_thai IN ('running', 'waiting_permission')
        AND bat_dau < NOW() - MAKE_INTERVAL(mins => ${quaBaoNhieuPhut})
      RETURNING id`;
    return rows.length;
  }

  /** Nha khoa cho MOI task con treo, khong xet thoi gian. Dung luc khoi dong. */
  async donMoiTaskTreo(): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE tasks
      SET trang_thai = 'failed',
          loi = 'gateway khoi dong lai giua luot chay',
          ket_thuc = NOW()
      WHERE trang_thai IN ('running', 'waiting_permission')
      RETURNING id`;
    return rows.length;
  }
}
