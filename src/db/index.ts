/**
 * Ket noi PostgreSQL. DB nam tren vpn6, Gateway nam tren vpn4 — cach nhau 307 ms.
 *
 * Moi tham so duoi day la he qua truc tiep cua con so do, khong phai mac dinh
 * cua thu vien:
 *   max          it ket noi nhung GIU AM, vi moi lan bat tay moi ton them RTT
 *   idle_timeout 0 = khong dong ket noi roi; role opencode co idle_session_timeout
 *                    30 phut o phia server lam luoi an toan
 *   connect_timeout phai > 2xRTT + bat tay SCRAM, neu khong se timeout gia
 */
import postgres, { type Sql } from 'postgres';
import type { Config } from '../config.js';

export function createSql(cfg: Config): Sql {
  return postgres(cfg.DATABASE_URL, {
    max: cfg.PG_POOL_MAX,
    idle_timeout: cfg.PG_IDLE_TIMEOUT_S === 0 ? undefined : cfg.PG_IDLE_TIMEOUT_S,
    connect_timeout: cfg.PG_CONNECT_TIMEOUT_S,
    connection: { statement_timeout: cfg.PG_STATEMENT_TIMEOUT_MS },
    // Bot ca nhan: khong can prepare cache lon, va prepare lam phuc tap viec
    // hoa giai khi tunnel dut giua chung.
    prepare: false,
    onnotice: () => {},
  });
}

/** Trang thai DB de /healthz bao cao. */
export type TrangThaiDb = 'up' | 'down';

export async function pingDb(sql: Sql): Promise<TrangThaiDb> {
  try {
    await sql`SELECT 1`;
    return 'up';
  } catch {
    return 'down';
  }
}
