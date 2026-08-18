/**
 * Log co cau truc, va QUAN TRONG NHAT la che bi mat.
 *
 * Log cua repo nay di ra stdout cua container tren mot may ha tang, va log cua
 * GitHub Actions thi CONG KHAI. Mot dong log lo `TELEGRAM_BOT_TOKEN` la mat quyen
 * dieu khien bot; lo `DATABASE_URL` la mat duong vao Postgres dung chung voi
 * headscale.
 */
import pino from 'pino';

/** Duong dan bi che trong moi ban ghi log. */
export const REDACT = [
  'TELEGRAM_BOT_TOKEN',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_PG_PASSWORD',
  'CLIPROXY_API_KEY',
  'DATABASE_URL',
  'token',
  'password',
  'apiKey',
  'authorization',
  '*.TELEGRAM_BOT_TOKEN',
  '*.DATABASE_URL',
  '*.password',
  '*.token',
  'req.headers.authorization',
];

/** Che mat khau trong mot chuoi ket noi truoc khi dua vao log. */
export function anMatKhauTrongUrl(url: string): string {
  return url.replace(/(:\/\/[^:/@]+:)[^@]*(@)/, '$1***$2');
}

export function createLogger(level: string, nodeEnv: string) {
  return pino({
    level,
    redact: { paths: REDACT, censor: '***' },
    base: { env: nodeEnv },
    // Log cua container duoc docker gan nhan thoi gian roi; ISO de doc hon epoch.
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof createLogger>;
