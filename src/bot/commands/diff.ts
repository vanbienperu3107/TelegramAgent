/**
 * `/diff` — agent da sua nhung gi.
 *
 * Hinh dang du lieu lay tu dac ta da tai ve (`SnapshotFileDiff`), khong doan:
 *   { file?, patch?, additions, deletions, status? }
 * CHI `additions` va `deletions` la bat buoc — `file`, `patch`, `status` deu co
 * the vang. Do la ly do moi cho doc chung o day deu co duong lui, thay vi tin
 * rang chung luon co.
 */
export interface FileDiff {
  file?: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: 'added' | 'deleted' | 'modified';
}

const BIEU_TUONG: Record<string, string> = {
  added: '🆕',
  deleted: '🗑',
  modified: '✏️',
};

/**
 * Tom tat: moi file mot dong.
 *
 * Khong gui ca patch o day. Mot lan sua vai file de vuot 4096 ky tu cua Telegram,
 * va luc do tin nhan bi cat giua chung — nguoi dung thay mot patch cut ma khong
 * biet la con thieu. Tom tat truoc, patch theo yeu cau.
 */
export function veTomTatDiff(ds: FileDiff[]): string {
  if (ds.length === 0) return '📋 Agent chua sua file nao trong phien nay.';

  const dong = ds.map((d) => {
    const bt = BIEU_TUONG[d.status ?? 'modified'] ?? '✏️';
    // `file` khong bat buoc theo dac ta. Khong co ten thi noi ro la khong co,
    // dung de dong trong — dong trong trong nhu loi hien thi.
    const ten = d.file ?? '(khong ro ten file)';
    return `${bt} ${ten}  +${d.additions} −${d.deletions}`;
  });

  const tongThem = ds.reduce((s, d) => s + d.additions, 0);
  const tongBot = ds.reduce((s, d) => s + d.deletions, 0);

  return [
    `📋 ${ds.length} file thay doi  (+${tongThem} −${tongBot})`,
    '',
    ...dong,
    '',
    'Go /patch de xem noi dung thay doi.',
  ].join('\n');
}

/**
 * Noi dung thay doi, dang khoi ma.
 *
 * Cat theo TUNG FILE chu khong cat theo ky tu: mot patch bi xen giua dong
 * `@@ -12,7 +12,9 @@` la vo nghia, con thieu han mot file thi it nhat nhung file
 * hien ra van doc duoc tron ven.
 */
export function vePatch(ds: FileDiff[], tran = 3500): string[] {
  const coPatch = ds.filter((d) => (d.patch ?? '').trim().length > 0);
  if (coPatch.length === 0) {
    return ['📋 Khong co noi dung patch nao (agent chua sua file, hoac server khong tra patch).'];
  }

  const ra: string[] = [];
  for (const d of coPatch) {
    const ten = d.file ?? '(khong ro ten file)';
    const than = (d.patch ?? '').trim();
    // Mot file don le van co the vuot tran. Luc do buoc phai cat, nhung noi ro
    // la da cat — im lang thi nguoi dung tuong day la toan bo thay doi.
    if (than.length > tran) {
      ra.push(`\`\`\`\n--- ${ten}\n${than.slice(0, tran)}\n\`\`\`\n⚠️ Da cat bot: patch cua file nay dai hon gioi han tin nhan.`);
    } else {
      ra.push(`\`\`\`\n--- ${ten}\n${than}\n\`\`\``);
    }
  }
  return ra;
}
