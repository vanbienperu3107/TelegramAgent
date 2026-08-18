/**
 * `/help` — danh sach lenh.
 *
 * Giu la MOT nguon: dung danh sach nay de dung ca van ban tra loi lan menu lenh
 * dang ky voi BotFather. Hai ban chep tay se lech nhau ngay lan them lenh sau.
 */
export interface MoTaLenh {
  lenh: string;
  moTa: string;
}

export const DANH_SACH_LENH: ReadonlyArray<MoTaLenh> = [
  { lenh: 'start', moTa: 'Xem trang thai hien tai' },
  { lenh: 'project', moTa: 'Chon project lam viec' },
  { lenh: 'new', moTa: 'Tao phien lam viec moi' },
  { lenh: 'sessions', moTa: 'Chuyen sang phien khac' },
  { lenh: 'model', moTa: 'Chon model' },
  { lenh: 'agent', moTa: 'Chon agent' },
  { lenh: 'abort', moTa: 'Huy task dang chay' },
  { lenh: 'help', moTa: 'Xem huong dan nay' },
];

export function renderHelp(): string {
  return [
    '📖 Huong dan',
    '',
    'Go mot cau hoi binh thuong de giao viec cho agent.',
    'Moi nguoi chi chay MOT task tai mot thoi diem.',
    '',
    ...DANH_SACH_LENH.map((l) => `/${l.lenh} — ${l.moTa}`),
    '',
    'Khi agent xin quyen, ban se thay nut bam. "Cho phep vinh vien" ghi vao cau',
    'hinh cua server va con hieu luc o MOI phien sau, khong chi phien nay.',
  ].join('\n');
}

/**
 * Ten goi khac cho cung mot lenh.
 *
 * `/session` (so it) va `/sessions` (so nhieu) la cho truot chan chan xay ra —
 * da xay ra ngay lan test dau tien. Nhan ca hai re hon nhieu so voi bat nguoi
 * dung nho dung so nhieu.
 */
export const TEN_KHAC: Readonly<Record<string, string>> = {
  session: 'sessions',
  du_an: 'project',
  projects: 'project',
  models: 'model',
  agents: 'agent',
  huy: 'abort',
  cancel: 'abort',
  stop: 'abort',
  moi: 'new',
  tro_giup: 'help',
};

/**
 * Doan nguoi dung dinh go lenh nao.
 *
 * Tra `null` khi khong doan duoc. Chi doan khi CHAC: goi y sai con kho chiu hon
 * la khong goi y, vi nguoi dung se bam theo roi lai khong duoc gi.
 */
export function doanLenh(go: string): string | null {
  const s = go.toLowerCase().replace(/^\//, '');
  if (DANH_SACH_LENH.some((l) => l.lenh === s)) return s;
  if (s in TEN_KHAC) return TEN_KHAC[s]!;
  // Tien to: `/ses` -> `/sessions`. Chi nhan khi CHI CO MOT lenh khop.
  const khop = DANH_SACH_LENH.filter((l) => l.lenh.startsWith(s) || s.startsWith(l.lenh));
  return khop.length === 1 ? khop[0]!.lenh : null;
}

/** Cau tra loi cho mot lenh khong ton tai. Khong bao gio im lang. */
export function renderLenhLa(go: string): string {
  const doan = doanLenh(go);
  if (doan) return `Khong co lenh ${go}. Y ban la /${doan} phai khong?`;
  return `Khong co lenh ${go}. Go /help de xem danh sach lenh.`;
}

/**
 * Moi ten goi cua mot lenh, ke ca ten chinh.
 *
 * grammy nhan mot MANG ten cho cung mot handler, nen bi danh chay dung code voi
 * ten chinh — khong phai mot nhanh rieng se lech dan theo thoi gian.
 */
export function moiTenCua(chinh: string): string[] {
  const khac = Object.entries(TEN_KHAC)
    .filter(([, c]) => c === chinh)
    .map(([k]) => k);
  return [chinh, ...khac];
}
