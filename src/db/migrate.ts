/**
 * Migration. Chay bang `docker compose run --entrypoint node ... dist/migrate.js`
 * TRUOC khi bot bat dau polling.
 *
 * Vi sao la mot tien trinh rieng chu khong goi trong index.ts: CMD cua image la
 * `node dist/index.js`, nen neu migration nam trong do thi giua luc `up -d` va
 * luc schema san sang co mot cua so vai chuc giay ma `/start` dap vao bang chua
 * ton tai.
 *
 * Backoff la bat buoc: DB o cach 307 ms qua mot tunnel co the vua duoc dung lai,
 * va `depends_on` cua pg-tunnel co y dung `service_started` chu khong phai
 * `service_healthy` (de Gateway con song sot ma tra loi khi mat DB — AC-20).
 */
import type { Sql } from 'postgres';
import { createSql } from './index.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';

/** Moi buoc chi chay mot lan; ten la khoa. Khong bao gio sua buoc da chay. */
export const MIGRATIONS: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: '001_telegram_users',
    sql: `
      CREATE TABLE IF NOT EXISTS telegram_users (
        id BIGSERIAL PRIMARY KEY,
        telegram_user_id BIGINT NOT NULL UNIQUE,
        telegram_username VARCHAR(255),
        display_name VARCHAR(255),
        role VARCHAR(30) NOT NULL DEFAULT 'user',
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
  },
  {
    name: '002_projects',
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        project_path TEXT NOT NULL UNIQUE,
        description TEXT,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
  },
  {
    name: '003_user_state',
    sql: `
      CREATE TABLE IF NOT EXISTS user_state (
        telegram_user_id BIGINT PRIMARY KEY,
        current_project_id BIGINT REFERENCES projects(id),
        current_session_id VARCHAR(255),
        current_provider_id VARCHAR(255),
        current_model_id VARCHAR(255),
        current_agent VARCHAR(255),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
  },
  {
    name: '004_audit_logs',
    sql: `
      CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGSERIAL PRIMARY KEY,
        telegram_user_id BIGINT,
        session_id VARCHAR(255),
        action VARCHAR(100) NOT NULL,
        payload JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
  },
  {
    name: '005_audit_indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(telegram_user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at)`,
  },
];

export async function chayMigration(sql: Sql, log: { info: (o: object, m: string) => void }) {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

  const daChay = new Set(
    (await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name),
  );

  let soBuoc = 0;
  for (const m of MIGRATIONS) {
    if (daChay.has(m.name)) continue;
    // Mot buoc = mot giao dich: nua chung that bai thi khong de lai schema lung chung.
    await sql.begin(async (tx) => {
      await tx.unsafe(m.sql);
      await tx`INSERT INTO schema_migrations (name) VALUES (${m.name})`;
    });
    log.info({ migration: m.name }, 'da ap dung migration');
    soBuoc += 1;
  }
  return soBuoc;
}

async function main() {
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL, cfg.NODE_ENV);
  const sql = createSql(cfg);

  const TOI_DA = 20;
  for (let lan = 1; lan <= TOI_DA; lan += 1) {
    try {
      const soBuoc = await chayMigration(sql, log);
      log.info({ soBuoc }, 'migration xong');
      await sql.end();
      return;
    } catch (err) {
      if (lan === TOI_DA) throw err;
      const cho = Math.min(1000 * 2 ** (lan - 1), 15000);
      log.info({ lan, cho }, 'chua ket noi duoc DB, thu lai');
      await new Promise((r) => setTimeout(r, cho));
    }
  }
}

if (process.argv[1]?.endsWith('migrate.js')) {
  main().catch((err) => {
    process.stderr.write(`migrate: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
