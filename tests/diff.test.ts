/**
 * `/diff` va `/patch`.
 *
 * Trong tam: cac TRUONG KHONG BAT BUOC cua `SnapshotFileDiff`. Theo dac ta chi
 * `additions`/`deletions` la bat buoc — `file`, `patch`, `status` deu co the
 * vang. Tin rang chung luon co la cach chac chan de sinh ra dong "undefined"
 * tren man hinh nguoi dung.
 */
import { describe, expect, it } from 'vitest';

import { vePatch, veTomTatDiff, type FileDiff } from '../src/bot/commands/diff.js';

/**
 * Dung mot FileDiff, co the BO HAN mot so truong.
 *
 * Phai bo han chu khong dat `undefined`: voi exactOptionalPropertyTypes, "truong
 * co gia tri undefined" va "khong co truong" la hai kieu khac nhau — va cai ta
 * can mo phong la cai thu hai, vi do moi la thu server that gui ve.
 */
type TruongTuyChon = 'file' | 'patch' | 'status';

function f(ghiDe: Partial<FileDiff> = {}, bo: TruongTuyChon[] = []): FileDiff {
  const ra: FileDiff = {
    file: 'src/a.ts',
    patch: '@@ -1 +1 @@\n-cu\n+moi',
    additions: 1,
    deletions: 1,
    status: 'modified',
    ...ghiDe,
  };
  for (const k of bo) delete ra[k];
  return ra;
}

describe('tom tat diff', () => {
  it('noi ro khi chua sua gi, khong tra danh sach rong', () => {
    expect(veTomTatDiff([])).toMatch(/chua sua file nao/i);
  });

  it('cong don so dong them va bot', () => {
    const van = veTomTatDiff([
      f({ additions: 10, deletions: 2 }),
      f({ file: 'b.ts', additions: 5, deletions: 3 }),
    ]);
    expect(van).toContain('+15');
    expect(van).toContain('−5');
    expect(van).toContain('2 file');
  });

  it('KHONG in "undefined" khi thieu ten file', () => {
    // `file` khong bat buoc theo dac ta. Day la cach de nhat de sinh ra mot dong
    // vo nghia tren man hinh nguoi dung.
    const van = veTomTatDiff([f({}, ['file'])]);
    expect(van).not.toContain('undefined');
    expect(van).toMatch(/khong ro ten file/i);
  });

  it('thieu status thi coi la sua, khong de bieu tuong trong', () => {
    const van = veTomTatDiff([f({}, ['status'])]);
    expect(van).not.toContain('undefined');
    expect(van).toContain('src/a.ts');
  });

  it('phan biet them, sua, xoa bang bieu tuong khac nhau', () => {
    const van = veTomTatDiff([
      f({ file: 'them.ts', status: 'added' }),
      f({ file: 'sua.ts', status: 'modified' }),
      f({ file: 'xoa.ts', status: 'deleted' }),
    ]);
    const bt = ['🆕', '✏️', '🗑'];
    for (const x of bt) expect(van).toContain(x);
  });
});

describe('patch', () => {
  it('noi ro khi khong co noi dung patch nao', () => {
    expect(vePatch([f({}, ['patch'])])[0]).toMatch(/khong co noi dung patch/i);
    expect(vePatch([f({ patch: '   ' })])[0]).toMatch(/khong co noi dung patch/i);
  });

  it('cat theo TUNG FILE chu khong theo ky tu', () => {
    // Mot patch bi xen giua dong `@@ -12,7 +12,9 @@` la vo nghia. Thieu han mot
    // file thi it nhat nhung file hien ra van doc duoc tron ven.
    const manh = vePatch([f({ file: 'a.ts' }), f({ file: 'b.ts' })]);
    expect(manh).toHaveLength(2);
    expect(manh[0]).toContain('a.ts');
    expect(manh[1]).toContain('b.ts');
    expect(manh[0]).not.toContain('b.ts');
  });

  it('NOI RA khi phai cat mot file qua dai', () => {
    // Im lang thi nguoi dung tuong day la toan bo thay doi — sai lam nguy hiem
    // khi ho dang duyet xem co nen giu thay doi hay khong.
    const manh = vePatch([f({ patch: 'x'.repeat(9000) })], 100);
    expect(manh[0]).toMatch(/da cat bot/i);
  });

  it('khong noi gi them khi khong phai cat', () => {
    expect(vePatch([f()])[0]).not.toMatch(/da cat bot/i);
  });

  it('bo qua file khong co patch nhung van hien file co patch', () => {
    const manh = vePatch([f({ file: 'khong.ts' }, ['patch']), f({ file: 'co.ts' })]);
    expect(manh).toHaveLength(1);
    expect(manh[0]).toContain('co.ts');
  });
});
