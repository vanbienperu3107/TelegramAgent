/**
 * Doc luong su kien SSE cua opencode-server.
 *
 * Viet SAU khi da chup luong that (`docs/opencode-events-sample.jsonl`, 111 su
 * kien cua mot luot hoi-dap co dung tool va co duyet quyen). §17.2 cam viet file
 * nay truoc do, va cam co ly do: dac ta khai 135 lop su kien, con mot luot chay
 * that chi phat ra 16 loai — trong do 41% la mot loai khong mang thong tin gi.
 */
import type { Config } from '../config.js';
import type { OpenCodeClient } from './opencode-client.js';

/**
 * Chi nhung loai ta thuc su xu ly.
 *
 * DANH SACH TRANG, khong phai danh sach den. Danh sach den se hong ngay lan
 * OpenCode them loai moi — ma no co san 135 lop trong dac ta de them. Dung danh
 * sach trang thi loai la roi vao nhanh "bo qua" mot cach im lang va co chu dich.
 */
export const LOAI_QUAN_TAM = new Set([
  'server.connected',
  'server.heartbeat',
  'session.created',
  'session.updated',
  'session.status',
  'session.idle',
  'session.diff',
  'message.updated',
  'message.part.updated',
  'message.part.delta',
  'permission.asked',
  'permission.replied',
]);

export interface SuKien {
  id?: string;
  type: string;
  properties?: Record<string, unknown>;
}

/**
 * Tach cac khung SSE tu mot chuoi byte den dan.
 *
 * Tra ve [cac su kien doc duoc, phan con lai chua tron khung]. Phan du BAT BUOC
 * phai giu lai: mot khung JSON de dang bi cat giua chung o ranh gioi goi tin, va
 * `message.part.delta` — loai den theo tung token — la loai de bi cat nhat.
 */
export function tachKhungSSE(dem: string): { suKien: SuKien[]; du: string } {
  const suKien: SuKien[] = [];
  // Khung SSE ket thuc bang mot dong trong. Chap nhan ca CRLF.
  const khung = dem.split(/\r?\n\r?\n/);
  const du = khung.pop() ?? '';
  for (const k of khung) {
    for (const dong of k.split(/\r?\n/)) {
      if (!dong.startsWith('data:')) continue;
      const than = dong.slice(5).trim();
      if (than.length === 0) continue;
      try {
        const ev = JSON.parse(than) as SuKien;
        if (typeof ev?.type === 'string') suKien.push(ev);
      } catch {
        // Mot khung hong khong duoc lam chet ca luong. Bo qua co chu dich.
      }
    }
  }
  return { suKien, du };
}

export interface TuyChonLuong {
  /** Goi cho MOI su kien nam trong danh sach trang. */
  khiCoSuKien: (ev: SuKien) => void | Promise<void>;
  /** Goi moi lan noi lai — ben goi PHAI doi chieu bang tham do o day. */
  khiNoiLai?: (lanThu: number) => void | Promise<void>;
  khiLoi?: (e: unknown) => void;
}

/**
 * Giu ket noi toi luong su kien, tu noi lai khi dut.
 *
 * KHONG CO REPLAY — da do: noi lai lan hai chi nhan `server.connected`, moi su
 * kien phat ra trong luc dut la mat vinh vien, va khong co `Last-Event-ID`. Vi
 * the `khiNoiLai` khong phai mot moc tien nghi de ghi log: no la CHO DUY NHAT
 * de doi chieu lai trang thai bang `GET /session/:id/message` va
 * `GET /permission`. Ai bo qua callback do se co mot bot treo vinh vien o lan
 * dut ket noi dau tien.
 */
export class LuongSuKien {
  private dung = false;
  private lanThu = 0;
  private lanCuoiNhan = 0;

  constructor(
    private readonly cfg: Config,
    private readonly client: OpenCodeClient,
    private readonly tuyChon: TuyChonLuong,
  ) {}

  /** Bao lau roi khong nhan duoc gi. `server.heartbeat` ~10 giay mot lan. */
  imLangMs(): number {
    return this.lanCuoiNhan === 0 ? 0 : Date.now() - this.lanCuoiNhan;
  }

  dong(): void {
    this.dung = true;
  }

  async chay(): Promise<void> {
    while (!this.dung) {
      this.lanThu += 1;
      try {
        if (this.lanThu > 1) await this.tuyChon.khiNoiLai?.(this.lanThu);
        await this.motVongKetNoi();
      } catch (e) {
        this.tuyChon.khiLoi?.(e);
      }
      if (this.dung) break;
      // Lui dan nhung co tran: 1s, 2s, 4s… toi da 30s. Server co the dang khoi
      // dong lai sau OOM (mem_limit 512m, oom_score_adj 800) — dung nam chet.
      const cho = Math.min(30_000, 2 ** Math.min(this.lanThu, 5) * 500);
      await new Promise((r) => setTimeout(r, cho));
    }
  }

  private async motVongKetNoi(): Promise<void> {
    const url = `${this.cfg.OPENCODE_URL.replace(/\/+$/, '')}${this.cfg.OPENCODE_EVENT_PATH}`;
    const res = await fetch(url, {
      headers: this.client.tieuDe({ accept: 'text/event-stream' }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`luong su kien tra HTTP ${res.status}`);
    }
    this.lanCuoiNhan = Date.now();

    const doc = res.body.getReader();
    const giaiMa = new TextDecoder();
    let dem = '';
    for (;;) {
      const { done, value } = await doc.read();
      if (done) break;
      this.lanCuoiNhan = Date.now();
      dem += giaiMa.decode(value, { stream: true });
      const { suKien, du } = tachKhungSSE(dem);
      dem = du;
      for (const ev of suKien) {
        if (!LOAI_QUAN_TAM.has(ev.type)) continue;
        await this.tuyChon.khiCoSuKien(ev);
      }
      if (this.dung) {
        await doc.cancel().catch(() => undefined);
        break;
      }
    }
  }
}
