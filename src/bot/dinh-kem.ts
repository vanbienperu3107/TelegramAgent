/**
 * Dinh kem tu Telegram -> `FilePartInput` cua OpenCode.
 *
 * Hinh dang lay tu dac ta da tai ve (`FilePartInput`): ba truong bat buoc la
 * `type`, `mime`, `url`. `url` chap nhan data: URI, nen ta tai tep ve roi ma hoa
 * base64 — khong cho OpenCode tu tai, vi URL cua Telegram co token bot trong
 * duong dan va chi song vai gio.
 */

/** Gioi han cung cua Bot API: tep tai ve toi da 20 MB. */
export const TRAN_TAI_VE_MB = 20;

export interface DinhKem {
  /** `photo`, `document`, `voice`... — chi de bao loi cho de hieu. */
  loai: string;
  fileId: string;
  /** Telegram khong luon bao kich thuoc; `undefined` nghia la chua biet. */
  kichThuoc?: number;
  tenTep?: string;
  mime?: string;
}

export interface FilePartInput {
  type: 'file';
  mime: string;
  url: string;
  filename?: string;
}

/**
 * Doan MIME khi Telegram khong bao.
 *
 * Doan SAI con hon bo trong: OpenCode doi `mime` la truong bat buoc, va mot
 * chuoi rong lam ca yeu cau bi tu choi. `application/octet-stream` la gia tri
 * trung tinh moi ben deu hieu.
 */
export function doanMime(k: DinhKem): string {
  if (k.mime && k.mime.trim().length > 0) return k.mime;
  if (k.loai === 'photo') return 'image/jpeg';
  if (k.loai === 'voice') return 'audio/ogg';
  const duoi = (k.tenTep ?? '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const bang: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
  };
  return (duoi && bang[duoi]) || 'application/octet-stream';
}

export type KetQuaKiem =
  | { ok: true }
  | { ok: false; lyDo: string };

/**
 * Tep co nhan duoc khong — kiem TRUOC khi tai.
 *
 * Tra loi som re hon nhieu so voi tai 20 MB qua Thai Binh Duong roi moi tu choi,
 * va nguoi dung biet ngay thay vi doi.
 */
export function kiemKichThuoc(k: DinhKem, tranMb: number): KetQuaKiem {
  if (k.kichThuoc === undefined) return { ok: true };
  const mb = k.kichThuoc / (1024 * 1024);
  if (mb > tranMb) {
    return {
      ok: false,
      lyDo: `Tep ${mb.toFixed(1)} MB, vuot gioi han ${tranMb} MB cua bot.`,
    };
  }
  if (mb > TRAN_TAI_VE_MB) {
    return {
      ok: false,
      lyDo: `Tep ${mb.toFixed(1)} MB — Telegram Bot API khong cho bot tai tep qua ${TRAN_TAI_VE_MB} MB.`,
    };
  }
  return { ok: true };
}

/**
 * Dung `FilePartInput` tu byte da tai.
 *
 * base64 phinh ~33%, va §6 da co bat dang thuc buoc MAX_INPUT_ATTACHMENT_MB sau
 * base64 phai nho hon MAX_PROMPT_BODY_MB — nen cho nay khong can kiem lai, chi
 * can khong pha vo gia dinh do.
 */
export function dungFilePart(k: DinhKem, byte: Buffer): FilePartInput {
  const mime = doanMime(k);
  const ra: FilePartInput = {
    type: 'file',
    mime,
    url: `data:${mime};base64,${byte.toString('base64')}`,
  };
  if (k.tenTep) ra.filename = k.tenTep;
  return ra;
}

/**
 * Cau nhac khi nguoi dung gui dinh kem ma khong kem chu.
 *
 * KHONG de rong: `parts` phai co it nhat mot phan van ban de model biet phai lam
 * gi voi tep. Mot tep tran khong kem cau hoi thi model doan — va doan sai thi
 * nguoi dung tuong bot hong.
 */
export function vanMacDinh(k: DinhKem): string {
  if (k.loai === 'photo') return 'Xem anh nay va mo ta noi dung giup toi.';
  return `Xem tep dinh kem${k.tenTep ? ` (${k.tenTep})` : ''} va tom tat noi dung giup toi.`;
}
