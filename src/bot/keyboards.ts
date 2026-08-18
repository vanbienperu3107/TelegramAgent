/**
 * Dung ban phim inline va giai ma callback data.
 *
 * Rang buoc cung cua Telegram: `callback_data` toi da **64 byte**. Vuot qua thi
 * API tra 400 khi GUI ban phim — tuc loi hien ra o cho khong lien quan gi toi
 * chuoi qua dai. Do la ly do moi thu o day di qua `dongGoi`/`giaiMa` va co phep
 * kiem do dai, thay vi noi chuoi tai cho.
 *
 * Id cua OpenCode dai that: `ses_feb658b0affedXguPQYQXFG0TJ` la 31 ky tu, con
 * `per_014ea66580014YwBmv03RwAgZV` la 31 — cong tien to viec lam la sat tran.
 */
import { InlineKeyboard } from 'grammy';

/** Gioi han cung cua Telegram, tinh bang BYTE chu khong phai ky tu. */
export const TRAN_CALLBACK_BYTE = 64;

export interface LenhNut {
  viec: string;
  thamSo: string;
}

export function dongGoi(viec: string, thamSo: string): string {
  const s = `${viec}:${thamSo}`;
  const soByte = Buffer.byteLength(s, 'utf8');
  if (soByte > TRAN_CALLBACK_BYTE) {
    // Nem o day chu khong de Telegram tu choi: thong bao nay chi ra dung bien so,
    // con loi 400 cua Telegram thi khong.
    throw new Error(`callback_data ${soByte} byte, vuot tran ${TRAN_CALLBACK_BYTE}: ${s}`);
  }
  return s;
}

export function giaiMa(du_lieu: string): LenhNut | null {
  const i = du_lieu.indexOf(':');
  if (i <= 0) return null;
  return { viec: du_lieu.slice(0, i), thamSo: du_lieu.slice(i + 1) };
}

/** Ban phim mot cot. Mot cot vi ten model va tua de phien deu dai. */
export function banPhimDoc(
  muc: ReadonlyArray<{ nhan: string; viec: string; thamSo: string }>,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const m of muc) {
    kb.text(m.nhan, dongGoi(m.viec, m.thamSo)).row();
  }
  return kb;
}

/**
 * Ban phim duyet quyen.
 *
 * Nhan cua `always` phai noi ro pham vi. Da do duoc: `always` GHI VAO CAU HINH
 * QUYEN CUA SERVER va ben qua moi phien sau — no khong phai "luon cho phep trong
 * phien nay". Mot nguoi dung bam nham vi hieu sai nhan se noi rong quyen cua
 * agent vinh vien.
 */
export function banPhimDuyet(permissionID: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Cho phep lan nay', dongGoi('quyen-once', permissionID))
    .row()
    .text('🔓 Cho phep vinh vien (moi phien)', dongGoi('quyen-always', permissionID))
    .row()
    .text('⛔ Tu choi', dongGoi('quyen-reject', permissionID));
}
