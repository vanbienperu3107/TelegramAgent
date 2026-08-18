/**
 * Markdown cua agent -> HTML cua Telegram.
 *
 * Nguoi dung bao "loi hien thi rat xau": ```text va **dam** hien nguyen xi giua
 * cau tra loi, vi tin nhan duoc gui KHONG kem parse_mode. Bat parse_mode lai la
 * nhan rui ro Telegram tra 400 va ca tin nhan bien mat — nen bo chuyen nay phai
 * dung, va phai co duong lui.
 */
import { describe, expect, it } from 'vitest';

import {
  RONG_TOI_DA_DONG_MA,
  boDanhDau,
  markdownSangHtml,
  ngatDongMa,
  rutAnh,
  thoatHtml,
} from '../../src/bot/dinh-dang.js';

describe('anh Markdown', () => {
  it('KHONG bo lai dau cham than phia truoc', () => {
    // Loi that 2026-08-18: `![alt](url)` bi lien ket thuong khop phan trong, va
    // nguoi dung nhin thay "!Duong pho Ha Noi mua thu" voi mot lien ket mau xanh.
    const ra = markdownSangHtml('![Duong pho Ha Noi](https://a.vn/x.jpg)');
    expect(ra).not.toContain('!');
    expect(ra).toContain('href="https://a.vn/x.jpg"');
  });

  it('van tao lien ket bam duoc, de con duong lui khi Telegram tu choi anh', () => {
    expect(markdownSangHtml('![x](https://a.vn/x.jpg)')).toContain('<a href=');
  });

  it('rut duoc danh sach anh de gui that', () => {
    const van = '![Anh mot](https://a.vn/1.jpg)\n![Anh hai](https://a.vn/2.jpg)';
    expect(rutAnh(van)).toEqual([
      { alt: 'Anh mot', url: 'https://a.vn/1.jpg' },
      { alt: 'Anh hai', url: 'https://a.vn/2.jpg' },
    ]);
  });

  it('bo anh trung URL — nhac hai lan thi chi gui mot', () => {
    expect(rutAnh('![a](https://a.vn/1.jpg) ![b](https://a.vn/1.jpg)')).toHaveLength(1);
  });

  it('gioi han so anh de khong bien mot cau tra loi thanh 20 tin nhan', () => {
    const nhieu = Array.from({ length: 30 }, (_, i) => `![a${i}](https://a.vn/${i}.jpg)`).join('\n');
    expect(rutAnh(nhieu).length).toBeLessThanOrEqual(5);
  });

  it('bo qua URL khong phai http/https', () => {
    expect(rutAnh('![a](data:image/png;base64,xxx)')).toEqual([]);
  });
});

describe('ngat dong trong khoi ma cho vua man hinh', () => {
  it('ngat dong dai hon nguong', () => {
    const dai = 'SELECT ' + 'cot_rat_dai, '.repeat(12) + 'het';
    for (const d of ngatDongMa(dai).split('\n')) {
      expect(d.length).toBeLessThanOrEqual(RONG_TOI_DA_DONG_MA + 2);
    }
  });

  it('CHI ngat tai khoang trang — khong cat doi mot tu', () => {
    // Mot ten ham hay chuoi ket noi bi cat doi thi nguoi dung chep ra se sai ma
    // khong nhan ra.
    const dai = 'a '.repeat(40) + 'tu_cuoi_cung';
    expect(ngatDongMa(dai)).toContain('tu_cuoi_cung');
  });

  it('GIU NGUYEN dong khong co khoang trang nao', () => {
    // URL dai hay chuoi base64: cat chung la lam hong du lieu.
    const url = 'https://vi-du.vn/' + 'x'.repeat(200);
    expect(ngatDongMa(url)).toBe(url);
  });

  it('giu nguyen dong ngan', () => {
    expect(ngatDongMa('SELECT 1;')).toBe('SELECT 1;');
  });

  it('KHONG ngat khoi ma cua ngon ngu nhay cam thut le', () => {
    // Them mot dong moi giua khoi Python lam hong chinh cu phap.
    const py = '```python\n' + 'def f():\n    return ' + 'x + '.repeat(30) + '1\n```';
    const ra = markdownSangHtml(py);
    expect(ra).toContain('x + '.repeat(30) + '1');
  });

  it('CO ngat khoi ma cua SQL', () => {
    const sql = '```sql\nSELECT ' + 'cot_dai, '.repeat(15) + '1;\n```';
    const than = markdownSangHtml(sql);
    expect(than.split('\n').length).toBeGreaterThan(3);
  });
});

describe('thoat ky tu HTML', () => {
  it('thoat & < > — ba ky tu duy nhat Telegram doi', () => {
    expect(thoatHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('thoat & TRUOC, khong thi thoat nham chinh the do minh chen', () => {
    // Neu doi thu tu: '<' -> '&lt;' roi '&' -> '&amp;' se bien '&lt;' thanh
    // '&amp;lt;' va nguoi dung nhin thay '&lt;' tren man hinh.
    expect(thoatHtml('<')).toBe('&lt;');
    expect(thoatHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('khoi ma', () => {
  it('```text ... ``` thanh <pre>, khong con hien dau backtick', () => {
    const ra = markdownSangHtml('Xem:\n```text\nBase URL: https://x.vn/v1\n```');
    expect(ra).toContain('<pre>');
    expect(ra).not.toContain('```');
  });

  it('giu ten ngon ngu de Telegram to mau cu phap', () => {
    expect(markdownSangHtml('```js\nlet a = 1;\n```')).toContain('class="language-js"');
  });

  it('KHONG dien giai dau sao BEN TRONG khoi ma', () => {
    // Trong ma nguon, `*` la ky tu that. Bien no thanh <i> lam hong doan ma ma
    // nguoi dung can chep ra dung.
    const ra = markdownSangHtml('```\nconst x = a * b * c;\n```');
    expect(ra).toContain('a * b * c');
    expect(ra).not.toContain('<i>');
  });

  it('thoat HTML ben trong khoi ma', () => {
    expect(markdownSangHtml('```\n<div>\n```')).toContain('&lt;div&gt;');
  });

  it('ma noi dong thanh <code>', () => {
    const ra = markdownSangHtml('dung `api-keys` nhe');
    expect(ra).toContain('<code>api-keys</code>');
    expect(ra).not.toContain('`');
  });
});

describe('chu dam va nghieng', () => {
  it('**x** thanh <b>', () => {
    expect(markdownSangHtml('**Cau hinh chinh**')).toBe('<b>Cau hinh chinh</b>');
  });

  it('xu ly dam TRUOC nghieng', () => {
    // Nguoc lai thi `*` dau cua `**` bi nuot thanh <i> va con lai mot dau sao le.
    const ra = markdownSangHtml('**dam**');
    expect(ra).not.toContain('*');
  });

  it('tieu de thanh chu dam — Telegram khong co the tieu de', () => {
    expect(markdownSangHtml('## Luu y bao mat')).toBe('<b>Luu y bao mat</b>');
  });

  it('khong nuot dau sao giua tu', () => {
    expect(markdownSangHtml('2*3*4')).toContain('2*3*4');
  });
});

describe('lien ket', () => {
  it('[chu](url) thanh the <a>', () => {
    expect(markdownSangHtml('[Myanmar Now](https://myanmar-now.org)')).toBe(
      '<a href="https://myanmar-now.org">Myanmar Now</a>',
    );
  });

  it('CHI cho phep http/https', () => {
    // Van ban nay den tu model, khong phai tu ta. `javascript:` trong the <a> la
    // mot duong tan cong.
    const ra = markdownSangHtml('[bam vao](javascript:alert(1))');
    expect(ra).not.toContain('javascript:');
    expect(ra).toContain('bam vao');
  });
});

describe('duong lui khi Telegram tu choi', () => {
  it('bo danh dau chu KHONG tra ve van ban goc', () => {
    // Nguoi dung da thay ```text hien nguyen xi mot lan roi — do chinh la thu can
    // sua. Tra lai y nguyen la lap lai dung loi do.
    const goc = '```text\nBase URL: https://x.vn\n```\n**Dam** va `ma`';
    const ra = boDanhDau(goc);
    expect(ra).not.toContain('```');
    expect(ra).not.toContain('**');
    expect(ra).not.toContain('`');
    expect(ra).toContain('Base URL: https://x.vn');
    expect(ra).toContain('Dam');
  });

  it('giu URL cua lien ket de nguoi dung con bam duoc', () => {
    expect(boDanhDau('[Trang](https://a.vn)')).toContain('https://a.vn');
  });
});

describe('khong lam vo van ban thuong', () => {
  it('van ban khong co danh dau di qua nguyen ven (tru escape)', () => {
    const v = 'Xin chao, day la mot cau binh thuong.';
    expect(markdownSangHtml(v)).toBe(v);
  });

  it('giu duoc tieng Viet co dau', () => {
    expect(markdownSangHtml('Trái cây ngọt ở Peru')).toContain('Trái cây ngọt ở Peru');
  });
});
