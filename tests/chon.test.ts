/**
 * Man hinh chon: project, phien, model, agent.
 *
 * Trong tam la cac ca RONG va ca PHAN TRANG — hai cho de bo sot nhat, va ca hai
 * deu bieu hien thanh "bot khong phan hoi" chu khong thanh loi.
 */
import { describe, expect, it } from 'vitest';

import {
  catNhan,
  manHinhAgent,
  manHinhModel,
  manHinhPhien,
  manHinhProject,
  tachModel,
} from '../src/bot/commands/chon.js';
import type { Model } from '../src/services/opencode-client.js';
import type { PhienGhiNho, Project } from '../src/services/sessions.js';

const duAn = (id: bigint, name: string): Project => ({
  id,
  name,
  projectPath: `/workspace/${name}`,
  description: null,
});

const phien = (id: string, title: string | null): PhienGhiNho => ({
  opencodeSessionId: id,
  telegramUserId: 1n,
  projectId: 1n,
  title,
  providerId: null,
  modelId: null,
  agent: null,
  lastUsedAt: new Date(),
});

const model = (p: string, m: string): Model => ({ providerID: p, modelID: m, ten: m });

describe('danh sach rong', () => {
  it('project rong: noi ro phai lam gi, khong de man hinh trong', () => {
    const mh = manHinhProject([], null);
    expect(mh.banPhim).toBeUndefined();
    expect(mh.van).toMatch(/projects/);
  });

  it('phien rong: chi sang /new', () => {
    expect(manHinhPhien([], null).van).toMatch(/\/new/);
  });

  it('model rong: chi ra cho de kiem, khong noi chung chung', () => {
    expect(manHinhModel([], { providerId: null, modelId: null }).van).toMatch(
      /config\/providers/,
    );
  });

  it('agent rong: chi ra endpoint de kiem', () => {
    expect(manHinhAgent([], null).van).toMatch(/\/agent/);
  });
});

describe('danh dau lua chon hien tai', () => {
  it('project dang chon co dau tich', () => {
    const nhan = manHinhProject([duAn(1n, 'a'), duAn(2n, 'b')], 2n)!
      .banPhim!.inline_keyboard.flat()
      .map((n) => n.text);
    expect(nhan[0]).not.toMatch(/✅/);
    expect(nhan[1]).toMatch(/✅/);
  });

  it('model dang chon so khop CA provider LAN model', () => {
    // Hai provider co the cung khai mot ten model. So mot ve thi tich sai dong.
    const ds = [model('a', 'opus'), model('b', 'opus')];
    const nhan = manHinhModel(ds, { providerId: 'b', modelId: 'opus' })
      .banPhim!.inline_keyboard.flat()
      .map((n) => n.text);
    expect(nhan[0]).not.toMatch(/✅/);
    expect(nhan[1]).toMatch(/✅/);
  });
});

describe('phan trang model', () => {
  const nhieu = Array.from({ length: 23 }, (_, i) => model('cliproxy', `model-${i}`));

  it('chia dung so trang', () => {
    // CLIProxy khai hon 20 model (do duoc 2026-08-18) va Telegram tu choi ban
    // phim qua lon — phan trang la bat buoc, khong phai tuy chon.
    const mh = manHinhModel(nhieu, { providerId: null, modelId: null }, 0, 8);
    const soDong = mh.banPhim!.inline_keyboard.length;
    expect(soDong).toBe(9); // 8 model + 1 dong dieu huong
    expect(JSON.stringify(mh.banPhim)).toContain('3'); // 23/8 -> 3 trang
  });

  it('trang dau khong co nut Truoc, trang cuoi khong co nut Sau', () => {
    const dau = JSON.stringify(manHinhModel(nhieu, { providerId: null, modelId: null }, 0, 8));
    const cuoi = JSON.stringify(manHinhModel(nhieu, { providerId: null, modelId: null }, 2, 8));
    expect(dau).not.toContain('Truoc');
    expect(dau).toContain('Sau');
    expect(cuoi).toContain('Truoc');
    expect(cuoi).not.toContain('Sau');
  });

  it('so trang ngoai khoang bi keo ve bien thay vi tra ban phim rong', () => {
    // Nguoi dung co the bam nut cu trong mot tin nhan cu sau khi danh sach model
    // da ngan lai. Ban phim rong o do trong nhu bot chet.
    for (const t of [-5, 99]) {
      const mh = manHinhModel(nhieu, { providerId: null, modelId: null }, t, 8);
      expect(mh.banPhim!.inline_keyboard.length).toBeGreaterThan(1);
    }
  });
});

describe('tachModel', () => {
  it('giu nguyen id model co dau gach va dau cham', () => {
    expect(tachModel('cliproxy/claude-opus-4-5-20251101')).toEqual({
      providerID: 'cliproxy',
      modelID: 'claude-opus-4-5-20251101',
    });
    expect(tachModel('cliproxy/gpt-5.3-codex-spark')).toEqual({
      providerID: 'cliproxy',
      modelID: 'gpt-5.3-codex-spark',
    });
  });

  it('tu choi dang thieu ve', () => {
    expect(tachModel('khong-co-gach')).toBeNull();
    expect(tachModel('/thieu-provider')).toBeNull();
    expect(tachModel('thieu-model/')).toBeNull();
  });
});

describe('catNhan', () => {
  it('giu nguyen nhan ngan', () => {
    expect(catNhan('ngan')).toBe('ngan');
  });

  it('cat nhan dai nhung giu phan dau — phan phan biet duoc', () => {
    const ra = catNhan('x'.repeat(80), 10);
    expect(ra).toHaveLength(10);
    expect(ra.endsWith('…')).toBe(true);
  });

  it('phien khong co tua de thi hien id thay vi o trong', () => {
    const nhan = manHinhPhien([phien('ses_abc', null)], null)
      .banPhim!.inline_keyboard.flat()
      .map((n) => n.text);
    expect(nhan[0]).toContain('ses_abc');
  });
});
