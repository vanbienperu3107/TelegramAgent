/**
 * Tim va gui ve Telegram nhung tep agent VUA TAO RA trong workspace.
 *
 * Ly do ton tai: agent sinh duoc so do, anh, bao cao — nhung Gateway khong doc
 * duoc workspace nen khong ai gui chung di. Nguoi dung chi thay mot cau "da tao
 * xong" va khong nhan duoc gi.
 *
 * AN NINH la phan chinh cua file nay, khong phai phan phu. Van ban dau vao do
 * MODEL sinh ra, va model co the bi dan dat boi noi dung no vua doc (mot tep
 * nguoi dung gui len, mot trang web). Neu tin thang duong dan trong do thi mot
 * cau tra loi chua `../../../.env` se lam bot tu gui mat khau DB va token bot ra
 * ngoai. Vi vay moi duong dan deu phai giai ra tuyet doi roi doi chieu lai voi
 * goc workspace — khong bao gio kiem bang cach so chuoi tho.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** Duoi tep duoc phep gui. Danh sach TRANG, khong phai danh sach den. */
const DUOI_ANH = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const DUOI_TAI_LIEU = new Set([
  'pdf', 'svg', 'drawio', 'xml', 'csv', 'json', 'md', 'txt', 'html', 'sql',
  'py', 'ts', 'js', 'sh', 'yaml', 'yml', 'log', 'zip', 'docx', 'xlsx', 'pptx',
]);

/** Toi da bao nhieu tep gui kem mot cau tra loi. */
export const TOI_DA_TEP = 5;

/** Telegram: anh gui bang URL/tep toi da 10 MB, tai lieu 50 MB. Lay muc chat hon. */
export const TRAN_TEP_MB = 10;

export interface TepKetQua {
  /** Duong dan tuyet doi, DA duoc xac minh nam trong workspace. */
  duongDan: string;
  /** Ten hien cho nguoi dung — tuong doi so voi workspace. */
  ten: string;
  laAnh: boolean;
}

/**
 * Rut cac duong dan tep co ve la ket qua tu van ban cua agent.
 *
 * Chi nhan duong dan co DUOI trong danh sach trang: mot cau van bat ky co the
 * chua dau `/`, va doan bua se lam bot di doc lung tung.
 */
export function timDuongDan(van: string): string[] {
  const duoi = [...DUOI_ANH, ...DUOI_TAI_LIEU].join('|');
  // Bat ca duong dan tran lan duong dan trong dau nhay nguoc / ngoac markdown.
  const mau = new RegExp(`[\\w./~-]*[\\w-]+\\.(?:${duoi})\\b`, 'gi');
  const ra: string[] = [];
  const daThay = new Set<string>();
  for (const m of van.matchAll(mau)) {
    const d = m[0];
    if (daThay.has(d)) continue;
    daThay.add(d);
    ra.push(d);
  }
  return ra;
}

/**
 * Giai mot duong dan ve tuyet doi VA xac minh no nam trong workspace.
 *
 * Tra `null` khi ra ngoai. Dung `path.resolve` roi so voi goc DA chuan hoa —
 * khong so chuoi tho: `/workspace/../etc/passwd` bat dau bang `/workspace` neu
 * chi so chuoi, nhung giai ra thi no o `/etc`.
 *
 * Cung chan ca cho khop tien to gia: `/workspace-khac/bi-mat` bat dau bang
 * `/workspace` nhung la mot thu muc khac han. Vi vay phai so voi goc KEM DAU
 * PHAN CACH o cuoi.
 */
export function trongWorkspace(duongDan: string, goc: string): string | null {
  const gocChuan = path.resolve(goc);
  const tuyetDoi = path.isAbsolute(duongDan)
    ? path.resolve(duongDan)
    : path.resolve(gocChuan, duongDan);
  if (tuyetDoi === gocChuan) return null; // chinh thu muc goc, khong phai tep
  if (!tuyetDoi.startsWith(gocChuan + path.sep)) return null;
  return tuyetDoi;
}

function laAnh(duongDan: string): boolean {
  const d = duongDan.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return DUOI_ANH.has(d);
}

/**
 * Tim nhung tep THAT SU TON TAI trong workspace ma agent vua nhac toi.
 *
 * Bon tang loc, moi tang mot ly do:
 *   1. co duoi trong danh sach trang  — khong di doc lung tung
 *   2. giai ra van nam trong workspace — chan `../../.env`
 *   3. ton tai va la tep thuong        — chan thu muc, symlink toi noi khac
 *   4. duoi tran kich thuoc            — Telegram tu choi tep qua to
 */
export async function timTepKetQua(
  van: string,
  goc: string,
  toiDa = TOI_DA_TEP,
): Promise<TepKetQua[]> {
  const ra: TepKetQua[] = [];
  for (const tho of timDuongDan(van)) {
    if (ra.length >= toiDa) break;
    const tuyetDoi = trongWorkspace(tho, goc);
    if (!tuyetDoi) continue;

    try {
      // `lstat` chu khong `stat`: `stat` di theo symlink, va mot symlink tro ra
      // ngoai workspace se lot qua phep kiem duong dan o tren.
      const st = await fs.lstat(tuyetDoi);
      if (!st.isFile()) continue;
      if (st.size === 0) continue;
      if (st.size > TRAN_TEP_MB * 1024 * 1024) continue;
      ra.push({
        duongDan: tuyetDoi,
        ten: path.relative(path.resolve(goc), tuyetDoi),
        laAnh: laAnh(tuyetDoi),
      });
    } catch {
      // Khong ton tai — chuyen binh thuong: agent nhac ten tep du dinh tao, hoac
      // mot duong dan trong vi du.
    }
  }
  return ra;
}
