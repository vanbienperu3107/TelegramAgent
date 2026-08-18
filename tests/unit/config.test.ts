/**
 * Cau hinh phai FAIL FAST. Moi test o day gan voi mot ca hong im lang cu the.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, kiemBatDangThuc, type Config } from '../../src/config.js';

const HOP_LE: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: '123:AA-token',
  TELEGRAM_ALLOWED_USER_IDS: '111,222',
  TELEGRAM_ADMIN_USER_IDS: '111',
  TELEGRAM_MODE: 'polling',
  DATABASE_URL: 'postgresql://opencode:pw@pg-tunnel:5433/opencode_remote',
  PG_POOL_MAX: '4',
  PG_CONNECT_TIMEOUT_S: '15',
  PG_IDLE_TIMEOUT_S: '0',
  PG_STATEMENT_TIMEOUT_MS: '8000',
  OPENCODE_URL: 'http://opencode-server:4096',
  OPENCODE_SERVER_PASSWORD: 'pw',
  OPENCODE_EVENT_PATH: '/global/event',
  OPENCODE_HEALTH_PATH: '/global/health',
  DEFAULT_PROVIDER: 'cliproxy',
  DEFAULT_MODEL: 'claude-opus-5',
  DEFAULT_AGENT: 'build',
  WORKSPACE_ROOT: '/workspace',
  DEFAULT_PROJECT_NAME: 'sandbox',
  DEFAULT_PROJECT_PATH: '/workspace/opencode-sandbox',
  MAX_PROMPT_BODY_MB: '8',
  MAX_INPUT_ATTACHMENT_MB: '5',
  MAX_OUTPUT_ARTIFACT_MB: '45',
  APPROVAL_TIMEOUT_MIN: '30',
  TASK_MAX_DURATION_MIN: '30',
  LOG_LEVEL: 'info',
  NODE_ENV: 'test',
  HEALTH_PORT: '8790',
};

describe('loadConfig', () => {
  it('nhan cau hinh hop le', () => {
    const cfg = loadConfig(HOP_LE);
    expect(cfg.HEALTH_PORT).toBe(8790);
    expect(cfg.TELEGRAM_ALLOWED_USER_IDS).toEqual([111n, 222n]);
  });

  it('bat HEALTH_PORT thieu', () => {
    // §6: thieu no thi URL thanh "127.0.0.1:/healthz" — hong IM LANG, va trieu
    // chung (container khong bao gio healthy) chi ra sai o healthcheck chu khong
    // chi ra sai o cau hinh.
    const { HEALTH_PORT: _bo, ...thieu } = HOP_LE;
    expect(() => loadConfig(thieu)).toThrow(/HEALTH_PORT/);
  });

  it('bat whitelist rong thay vi coi la "cho tat ca"', () => {
    expect(() => loadConfig({ ...HOP_LE, TELEGRAM_ALLOWED_USER_IDS: '' })).toThrow();
    expect(() => loadConfig({ ...HOP_LE, TELEGRAM_ALLOWED_USER_IDS: ' , ' })).toThrow();
  });

  it('bat id khong phai so', () => {
    expect(() => loadConfig({ ...HOP_LE, TELEGRAM_ALLOWED_USER_IDS: '111,abc' })).toThrow(/abc/);
  });

  it('bat cong ngoai dai', () => {
    expect(() => loadConfig({ ...HOP_LE, HEALTH_PORT: '70000' })).toThrow();
    expect(() => loadConfig({ ...HOP_LE, HEALTH_PORT: '0' })).toThrow();
  });

  it('giu duoc id lon hon so nguyen an toan cua JS', () => {
    // id Telegram co the vuot 2^53. Dung Number la mat do chinh xac AM THAM,
    // va hau qua la uy quyen so nham nguoi.
    const to = '9007199254740993';
    const cfg = loadConfig({
      ...HOP_LE,
      TELEGRAM_ALLOWED_USER_IDS: to,
      TELEGRAM_ADMIN_USER_IDS: to,
    });
    expect(cfg.TELEGRAM_ALLOWED_USER_IDS[0]?.toString()).toBe(to);
  });
});

describe('kiemBatDangThuc', () => {
  const cfg = loadConfig(HOP_LE);

  it('bat tran dinh kem vuot tran body sau khi base64 phinh', () => {
    // 8 MB dinh kem -> ~11 MB sau base64 -> vuot tran body 8 MB. Moi tep gan
    // tran se bi CHINH ta tu choi sau khi da tai ve.
    const xau: Config = { ...cfg, MAX_INPUT_ATTACHMENT_MB: 8 };
    expect(kiemBatDangThuc(xau).join(' ')).toMatch(/base64/);
  });

  it('bat han cho duyet dai hon han song cua task', () => {
    const xau: Config = { ...cfg, APPROVAL_TIMEOUT_MIN: 45, TASK_MAX_DURATION_MIN: 30 };
    expect(kiemBatDangThuc(xau).join(' ')).toMatch(/APPROVAL_TIMEOUT_MIN/);
  });

  it('bat admin khong nam trong whitelist', () => {
    const xau: Config = { ...cfg, TELEGRAM_ADMIN_USER_IDS: [999n] };
    expect(kiemBatDangThuc(xau).join(' ')).toMatch(/999/);
  });

  it('cau hinh that trong .env.example khong vi pham bat dang thuc nao', () => {
    expect(kiemBatDangThuc(cfg)).toEqual([]);
  });
});
