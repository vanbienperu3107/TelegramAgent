/**
 * Cache ghi-xuyen. Ba test dau la ba loi that da duoc chi ra trong vong review.
 */
import { describe, expect, it, vi } from 'vitest';
import { UserStateCache, stateRong } from '../../src/services/user-state.js';

/** Gia lap postgres.js: no la mot ham tag template, kem thuoc tinh khac. */
function sqlGia(rows: unknown[] = []) {
  const goi: string[] = [];
  const fn = vi.fn(async (strings: TemplateStringsArray) => {
    const cau = strings.join('?');
    goi.push(cau);
    return cau.includes('SELECT * FROM user_state') ? rows : [];
  });
  return { sql: fn as never, goi };
}

describe('UserStateCache', () => {
  it('nguoi dung moi tra ve state rong, khong phai undefined', () => {
    const { sql } = sqlGia();
    const cache = new UserStateCache(sql);
    expect(cache.get(42n)).toEqual(stateRong(42n));
  });

  it('set cho nguoi dung MOI khong lam mat truong nao', async () => {
    // Loi that da duoc chi ra: dung `this.map.get(id)!` thi voi nguoi dung moi,
    // get() tra undefined va spread cua undefined cho ra object CHI CO cac truong
    // trong patch — mat currentProjectId/currentSessionId cho toi lan nap sau.
    const { sql } = sqlGia();
    const cache = new UserStateCache(sql);
    const sau = await cache.set(42n, { currentAgent: 'build' });
    expect(sau.currentAgent).toBe('build');
    expect(sau).toHaveProperty('currentProjectId', null);
    expect(sau).toHaveProperty('currentSessionId', null);
    expect(sau.telegramUserId).toBe(42n);
  });

  it('doc sau khi ghi khong sinh them truy van (doc = 0 luot)', async () => {
    // Ngan sach 307 ms: doc phai lay tu RAM. Neu doc cham DB thi moi thao tac
    // Telegram cong them mot RTT.
    const { sql, goi } = sqlGia();
    const cache = new UserStateCache(sql);
    await cache.set(42n, { currentSessionId: 'ses_1' });
    const truocKhiDoc = goi.length;
    expect(cache.get(42n).currentSessionId).toBe('ses_1');
    expect(goi.length).toBe(truocKhiDoc);
  });

  it('ghi de tung phan, giu nguyen truong khong nam trong patch', async () => {
    const { sql } = sqlGia();
    const cache = new UserStateCache(sql);
    await cache.set(42n, { currentSessionId: 'ses_1', currentAgent: 'build' });
    const sau = await cache.set(42n, { currentAgent: 'plan' });
    expect(sau.currentAgent).toBe('plan');
    expect(sau.currentSessionId).toBe('ses_1');
  });

  it('reload dung map moi, khong xoa tai cho', async () => {
    // Neu reload xoa-roi-dien thi giua hai thao tac do, mot /start dong thoi se
    // thay cache rong va ghi de state bang gia tri thieu.
    const { sql } = sqlGia([
      {
        telegram_user_id: '42',
        current_project_id: '7',
        current_session_id: 'ses_db',
        current_provider_id: 'cliproxy',
        current_model_id: 'claude-opus-5',
        current_agent: 'build',
      },
    ]);
    const cache = new UserStateCache(sql);
    const n = await cache.reload();
    expect(n).toBe(1);
    const state = cache.get(42n);
    expect(state.currentSessionId).toBe('ses_db');
    expect(state.currentProjectId).toBe(7n);
  });

  it('giu id lon bang bigint, khong mat do chinh xac', async () => {
    const { sql } = sqlGia();
    const cache = new UserStateCache(sql);
    const to = 9007199254740993n;
    await cache.set(to, { currentAgent: 'build' });
    expect(cache.get(to).telegramUserId).toBe(to);
  });
});
