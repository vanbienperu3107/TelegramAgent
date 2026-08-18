/**
 * Bo gop tien do: nhan su kien, dung ra man hinh mot tin nhan Telegram.
 *
 * Thuan tuy va dong bo — khong goi mang, khong cham DB. Do la co y: toan bo phan
 * de sai cua tinh nang nay nam o "su kien nao doi cai gi", va phan do phai test
 * duoc bang cach cho an chinh file `docs/opencode-events-sample.jsonl`.
 *
 * Moi nhanh duoi day tuong ung mot loai su kien DA QUAN SAT DUOC trong phep do
 * 2026-08-18. Khong xu ly loai chua tung thay: doan mo o day chi tao ra ma chet
 * ma khong ai biet no chet.
 */
import type { SuKien } from './event-stream.js';

export type TrangThaiTask =
  | 'dang-chay'
  | 'cho-duyet'
  | 'xong'
  | 'loi';

export interface QuyenDangCho {
  id: string;
  permission: string;
  lenh: string | null;
}

export interface TienDo {
  trangThai: TrangThaiTask;
  /** Van ban tra loi dang duoc ghep dan tu `message.part.delta`. */
  van: string;
  /** Ten cac tool da duoc goi, theo thu tu, khong trung. */
  tool: string[];
  quyenDangCho: QuyenDangCho | null;
  /** Co thay doi gi ke tu lan `danhDauDaVe` gan nhat khong. */
  banThay: boolean;
}

/** Tin nhan tien do khong duoc vuot gioi han cua Telegram (4096 ky tu). */
export const TRAN_TIN_NHAN = 4096;

/**
 * Gop su kien cua MOT luot chay.
 *
 * Loc theo `messageID` khi co: mot phien co the co nhieu luot, va su kien cua
 * luot truoc van con den trong lucluot sau bat dau neu nguoi dung gui nhanh.
 */
export class BoGopTienDo {
  private td: TienDo = {
    trangThai: 'dang-chay',
    van: '',
    tool: [],
    quyenDangCho: null,
    banThay: true,
  };

  constructor(
    private readonly sessionID: string,
    private readonly messageID: string | null,
  ) {}

  trangThaiHienTai(): Readonly<TienDo> {
    return this.td;
  }

  danhDauDaVe(): void {
    this.td.banThay = false;
  }

  /** Tra ve `true` neu su kien nay thuoc luot chay dang theo doi. */
  private cuaTa(props: Record<string, unknown> | undefined): boolean {
    if (!props) return false;
    if (props.sessionID !== this.sessionID) return false;
    // messageID chi co o mot so loai. Khi vang mat thi tin vao sessionID: day la
    // danh doi co y — chat qua thi bo mat `session.idle` (khong co messageID) va
    // task treo vinh vien.
    if (this.messageID && typeof props.messageID === 'string') {
      return props.messageID === this.messageID;
    }
    return true;
  }

  nhan(ev: SuKien): void {
    const p = ev.properties ?? {};
    if (!this.cuaTa(p)) return;

    switch (ev.type) {
      case 'message.part.delta': {
        // Chi ghep truong `text`. `message.part.delta` cung den cho suy luan
        // (reasoning) va cho doi so cua tool — ghep chung vao thi nguoi dung
        // thay JSON do dang giua cau tra loi.
        if (p.field !== 'text' || typeof p.delta !== 'string') return;
        this.td.van += p.delta;
        this.td.banThay = true;
        return;
      }
      case 'message.part.updated': {
        const part = p.part as { type?: string; tool?: string; state?: unknown } | undefined;
        if (part?.type === 'tool' && typeof part.tool === 'string') {
          if (!this.td.tool.includes(part.tool)) {
            this.td.tool.push(part.tool);
            this.td.banThay = true;
          }
        }
        return;
      }
      case 'permission.asked': {
        this.td.trangThai = 'cho-duyet';
        this.td.quyenDangCho = {
          id: String(p.id ?? ''),
          permission: String(p.permission ?? '?'),
          lenh:
            typeof (p.metadata as { command?: unknown } | undefined)?.command === 'string'
              ? ((p.metadata as { command: string }).command)
              : null,
        };
        this.td.banThay = true;
        return;
      }
      case 'permission.replied': {
        this.td.trangThai = 'dang-chay';
        this.td.quyenDangCho = null;
        this.td.banThay = true;
        return;
      }
      case 'session.idle': {
        // Moc dung DUY NHAT. `session.status {type:"idle"}` phat nhieu lan giua
        // cac buoc (do duoc 6 lan trong mot luot) nen KHONG dung lam moc — dung
        // no thi tien do dung ngay sau buoc dau tien.
        this.td.trangThai = 'xong';
        this.td.quyenDangCho = null;
        this.td.banThay = true;
        return;
      }
      default:
        return;
    }
  }

  danhDauLoi(): void {
    this.td.trangThai = 'loi';
    this.td.banThay = true;
  }
}

function catDuoi(s: string, toiDa: number): string {
  return s.length <= toiDa ? s : `…${s.slice(s.length - toiDa + 1)}`;
}

/**
 * Dung van ban tien do.
 *
 * Cat tu DUOI len chu khong tu tren xuong: phan moi nhat la phan nguoi dung dang
 * doi. Cat dau thi ho nhin mai mot doan van cu trong khi agent van chay.
 */
export function veTienDo(td: Readonly<TienDo>, giay: number): string {
  const dong: string[] = [];
  const bieuTuong = {
    'dang-chay': '⏳',
    'cho-duyet': '🔐',
    xong: '✅',
    loi: '❌',
  }[td.trangThai];

  const nhan = {
    'dang-chay': 'Dang chay',
    'cho-duyet': 'Cho ban duyet',
    xong: 'Xong',
    loi: 'Loi',
  }[td.trangThai];

  dong.push(`${bieuTuong} ${nhan} · ${giay}s`);

  if (td.tool.length > 0) {
    dong.push(`🔧 ${td.tool.join(', ')}`);
  }

  if (td.quyenDangCho) {
    dong.push('');
    dong.push(`Agent xin quyen \`${td.quyenDangCho.permission}\``);
    if (td.quyenDangCho.lenh) dong.push(`\`${catDuoi(td.quyenDangCho.lenh, 200)}\``);
  }

  if (td.van.trim().length > 0) {
    dong.push('');
    // Chua cho phan dau (~200 ky tu) va vai dong ky tu dinh dang.
    dong.push(catDuoi(td.van, TRAN_TIN_NHAN - 400));
  }

  return dong.join('\n');
}

/**
 * Cong tac chong sua tin nhan qua day.
 *
 * Telegram gioi han khoang 1 lan sua moi giay cho cung mot tin nhan, va vuot qua
 * thi tra 429 kem `retry_after` — luc do ta mat luon cac ban cap nhat sau do.
 * `message.part.delta` den theo TUNG TOKEN (do duoc), tuc hang chuc su kien moi
 * giay, nen khong the sua theo tung su kien.
 */
export class CongTacSua {
  private lanCuoi = 0;

  constructor(private readonly cachNhauMs = 3000) {}

  nenSua(td: Readonly<TienDo>, bayGio = Date.now()): boolean {
    // Trang thai cuoi va cua duyet PHAI hien ngay: nguoi dung dang cho de bam
    // nut, va mot do tre 3 giay o day la 3 giay agent dung im.
    if (td.trangThai === 'xong' || td.trangThai === 'loi' || td.trangThai === 'cho-duyet') {
      this.lanCuoi = bayGio;
      return true;
    }
    if (!td.banThay) return false;
    if (bayGio - this.lanCuoi < this.cachNhauMs) return false;
    this.lanCuoi = bayGio;
    return true;
  }
}
