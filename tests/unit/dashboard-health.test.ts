import { describe, expect, it } from 'vitest';
import { renderDashboard } from '../../src/bot/commands/start.js';
import { bodyHealth } from '../../src/health.js';
import { stateRong } from '../../src/services/user-state.js';

describe('renderDashboard', () => {
  it('hien day du bon muc khi da chon het', () => {
    const out = renderDashboard({
      state: {
        telegramUserId: 1n,
        currentProjectId: 7n,
        currentSessionId: 'ses_abc',
        currentProviderId: 'cliproxy',
        currentModelId: 'claude-opus-5',
        currentAgent: 'build',
      },
      tenProject: 'sandbox',
      dbUp: true,
    });
    expect(out).toContain('sandbox');
    expect(out).toContain('ses_abc');
    expect(out).toContain('cliproxy/claude-opus-5');
    expect(out).toContain('build');
    expect(out).toContain('San sang');
  });

  it('nguoi dung moi thay dau gach thay vi undefined', () => {
    // "undefined" hien tren giao dien la lo chi tiet cai dat va lam nguoi dung
    // tuong bot hong.
    const out = renderDashboard({ state: stateRong(1n), tenProject: null, dbUp: true });
    expect(out).not.toMatch(/undefined|null/);
    expect(out).toContain('—');
  });

  it('bao mat DB thay vi gia vo san sang', () => {
    const out = renderDashboard({ state: stateRong(1n), tenProject: null, dbUp: false });
    expect(out).toContain('Mat ket noi');
  });
});

describe('bodyHealth', () => {
  const batDau = new Date('2026-01-01T00:00:00Z');

  it('bao db=up khi DB song', () => {
    const body = JSON.parse(
      bodyHealth({ db: 'up', botDangPolling: true, batDau }, new Date('2026-01-01T00:01:00Z')),
    );
    expect(body).toMatchObject({ status: 'ok', db: 'up', bot: 'polling', uptime_s: 60 });
  });

  it('van bao status=ok khi mat DB, nhung db=down', () => {
    // Quy uoc co y: /healthz LUON tra 200, trang thai that nam trong than phan
    // hoi. Tra 503 khi mat DB se lam container unhealthy -> restart -> mat hang
    // doi trong RAM -> task mo coi. Ma mat DB la trang thai Gateway PHAI song
    // sot duoc (AC-20).
    const body = JSON.parse(bodyHealth({ db: 'down', botDangPolling: true, batDau }));
    expect(body.status).toBe('ok');
    expect(body.db).toBe('down');
  });

  it('phan biet duoc bot dang polling hay da dung', () => {
    const body = JSON.parse(bodyHealth({ db: 'up', botDangPolling: false, batDau }));
    expect(body.bot).toBe('stopped');
  });
});
