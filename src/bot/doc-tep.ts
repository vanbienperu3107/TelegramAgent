/**
 * Rut van ban tu tep dinh kem.
 *
 * Ly do ton tai: nguoi dung gui mot tep .docx kem cau "Doc thong tin trong file",
 * bot gui no di duoi dang FilePart base64, va model AM THAM BO QUA — no khong doc
 * duoc dinh dang nhi phan cua Word. Ket qua: bot tra loi sau MOT giay, bang noi
 * dung lay tu ngu canh truoc do, va nguoi dung tuong no da doc tep.
 *
 * Do la kieu hong te nhat trong nhom nay: khong co loi, khong co canh bao, cau
 * tra loi nghe van hop ly. Nen nguyen tac o day la: hoac rut duoc van ban that,
 * hoac NOI RO la khong doc duoc — khong bao gio gui mot tep ma model se lang le
 * bo qua.
 */
import { inflateRawSync } from 'node:zlib';

/** Toi da bao nhieu ky tu van ban nhung vao prompt. */
export const TOI_DA_KY_TU = 60_000;

export type KetQuaDoc =
  | { loai: 'van-ban'; van: string; batBot: boolean }
  | { loai: 'gui-nguyen-tep' }
  | { loai: 'khong-doc-duoc'; lyDo: string };

/** Duoi tep chac chan la van ban thuan. */
const DUOI_VAN_BAN = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'yml', 'yaml', 'xml',
  'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb',
  'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash',
  'sql', 'ini', 'toml', 'conf', 'env', 'diff', 'patch', 'srt', 'vtt',
]);

function duoiCua(tenTep?: string): string {
  return (tenTep ?? '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
}

/**
 * Tim mot muc trong tep ZIP va giai nen no.
 *
 * Tu doc ZIP thay vi them thu vien: them phu thuoc doi cap nhat package-lock,
 * ma buoc do khong chay duoc o day. Doc central directory (o cuoi tep) chu khong
 * quet local header: local header co the thieu kich thuoc khi ZIP dung data
 * descriptor, con central directory thi luon day du.
 */
function docTuZip(buf: Buffer, tenCanTim: string): Buffer | null {
  // End of Central Directory: chu ky PK\x05\x06, nam trong 64 KB cuoi.
  const CHU_KY_EOCD = 0x06054b50;
  let eocd = -1;
  const batDauTim = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= batDauTim; i -= 1) {
    if (buf.readUInt32LE(i) === CHU_KY_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const soMuc = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // offset cua central directory

  for (let i = 0; i < soMuc; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const nen = buf.readUInt16LE(p + 10);
    const coNen = buf.readUInt32LE(p + 20);
    const daiTen = buf.readUInt16LE(p + 28);
    const daiPhu = buf.readUInt16LE(p + 30);
    const daiChuThich = buf.readUInt16LE(p + 32);
    const viTriLocal = buf.readUInt32LE(p + 42);
    const ten = buf.toString('utf8', p + 46, p + 46 + daiTen);

    if (ten === tenCanTim) {
      // Local header co do dai truong rieng, phai doc lai chu khong dung cua
      // central directory.
      if (buf.readUInt32LE(viTriLocal) !== 0x04034b50) return null;
      const daiTenL = buf.readUInt16LE(viTriLocal + 26);
      const daiPhuL = buf.readUInt16LE(viTriLocal + 28);
      const batDau = viTriLocal + 30 + daiTenL + daiPhuL;
      const dl = buf.subarray(batDau, batDau + coNen);
      if (nen === 0) return Buffer.from(dl); // khong nen
      if (nen === 8) return inflateRawSync(dl);
      return null; // phuong phap nen khac — hiem, khong doan
    }
    p += 46 + daiTen + daiPhu + daiChuThich;
  }
  return null;
}

/** Bo the XML, giu ranh gioi doan van cua Word. */
function xmlSangVanBan(xml: string): string {
  return xml
    // Word danh dau ket doan bang </w:p> va xuong dong bang <w:br/>.
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br\s*\/?>/g, '\n')
    .replace(/<w:tab\s*\/?>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Quyet dinh xu ly mot tep dinh kem the nao.
 *
 * Ba nhanh, va KHONG co nhanh thu tu: mot tep khong roi vao nhanh nao thi phai
 * duoc bao la khong doc duoc, chu khong duoc gui di trong im lang.
 */
export function docTep(byte: Buffer, mime: string, tenTep?: string): KetQuaDoc {
  const duoi = duoiCua(tenTep);

  // 1. Anh: model da doc duoc truc tiep, gui nguyen tep.
  if (mime.startsWith('image/')) return { loai: 'gui-nguyen-tep' };

  // 2. PDF: cac model Claude doc duoc qua FilePart.
  if (mime === 'application/pdf' || duoi === 'pdf') return { loai: 'gui-nguyen-tep' };

  // 3. Van ban thuan.
  if (mime.startsWith('text/') || DUOI_VAN_BAN.has(duoi) || mime === 'application/json') {
    const van = byte.toString('utf8');
    // Tep nhi phan doc bang utf8 sinh day ky tu thay the — dau hieu chac chan la
    // doan sai loai, va nhung mot dong rac vao prompt con te hon la noi that.
    const soRac = (van.match(/�/g) ?? []).length;
    if (soRac > van.length / 20) {
      return { loai: 'khong-doc-duoc', lyDo: 'tep co ve la nhi phan chu khong phai van ban' };
    }
    return catBot(van);
  }

  // 4. Word .docx (la mot tep ZIP chua word/document.xml).
  if (
    duoi === 'docx' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    try {
      const xml = docTuZip(byte, 'word/document.xml');
      if (!xml) return { loai: 'khong-doc-duoc', lyDo: 'khong tim thay noi dung trong tep .docx' };
      const van = xmlSangVanBan(xml.toString('utf8'));
      if (van.length === 0) return { loai: 'khong-doc-duoc', lyDo: 'tep .docx khong co van ban' };
      return catBot(van);
    } catch {
      return { loai: 'khong-doc-duoc', lyDo: 'tep .docx hong hoac dung dinh dang la' };
    }
  }

  // 5. `.doc` cu (nhi phan OLE) KHAC HAN `.docx` — khong phai ZIP, khong doc duoc
  //    bang cach nay. Noi ro thay vi thu roi that bai kho hieu.
  if (duoi === 'doc') {
    return { loai: 'khong-doc-duoc', lyDo: 'dinh dang .doc cu chua ho tro — hay luu lai thanh .docx' };
  }

  return {
    loai: 'khong-doc-duoc',
    lyDo: `chua ho tro dinh dang nay${duoi ? ` (.${duoi})` : ''}`,
  };
}

function catBot(van: string): KetQuaDoc {
  if (van.length <= TOI_DA_KY_TU) return { loai: 'van-ban', van, batBot: false };
  return { loai: 'van-ban', van: van.slice(0, TOI_DA_KY_TU), batBot: true };
}

/** Ghep noi dung tep vao cau hoi, co ranh gioi ro de model khong nham voi cau hoi. */
export function ghepVaoPrompt(cauHoi: string, tenTep: string | undefined, noiDung: string, batBot: boolean): string {
  const nhan = tenTep ?? 'tep dinh kem';
  return [
    cauHoi,
    '',
    `--- noi dung ${nhan}${batBot ? ' (da cat bot phan cuoi)' : ''} ---`,
    noiDung,
    `--- het ${nhan} ---`,
  ].join('\n');
}
