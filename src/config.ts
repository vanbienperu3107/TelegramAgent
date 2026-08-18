/**
 * Cau hinh doc tu bien moi truong, validate bang zod, FAIL FAST.
 *
 * Nguyen tac: khong co gia tri mac dinh ngam cho thu gi quan trong. §6 cua
 * Telegram.md ghi ro mot ca that: `HEALTH_PORT` thieu thi URL healthcheck thanh
 * `127.0.0.1:/healthz` — hong IM LANG, va trieu chung (container khong bao gio
 * `healthy`) chi ra sai o healthcheck chu khong chi ra sai o cau hinh.
 */
import { z } from 'zod';

/** Danh sach id Telegram, phan tach bang dau phay. Rong = loi, khong phai "cho tat ca". */
const userIdList = z
  .string()
  .min(1)
  .transform((raw, ctx) => {
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (ids.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'danh sach rong' });
      return z.NEVER;
    }
    const out: bigint[] = [];
    for (const id of ids) {
      if (!/^\d+$/.test(id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `id khong phai so: ${id}` });
        return z.NEVER;
      }
      out.push(BigInt(id));
    }
    return out;
  });

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().min(0);

export const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ALLOWED_USER_IDS: userIdList,
  TELEGRAM_ADMIN_USER_IDS: userIdList,
  TELEGRAM_MODE: z.literal('polling'),

  DATABASE_URL: z.string().url(),
  PG_POOL_MAX: positiveInt.pipe(z.number().min(1)),
  PG_CONNECT_TIMEOUT_S: positiveInt,
  PG_IDLE_TIMEOUT_S: positiveInt,
  PG_STATEMENT_TIMEOUT_MS: positiveInt,

  OPENCODE_URL: z.string().url(),
  OPENCODE_SERVER_PASSWORD: z.string().min(1),
  OPENCODE_EVENT_PATH: z.string().startsWith('/'),
  OPENCODE_HEALTH_PATH: z.string().startsWith('/'),

  DEFAULT_PROVIDER: z.string().min(1),
  DEFAULT_MODEL: z.string().min(1),
  DEFAULT_AGENT: z.string().min(1),

  WORKSPACE_ROOT: z.string().startsWith('/'),
  DEFAULT_PROJECT_NAME: z.string().min(1),
  DEFAULT_PROJECT_PATH: z.string().startsWith('/'),

  MAX_PROMPT_BODY_MB: positiveInt.pipe(z.number().min(1)),
  MAX_INPUT_ATTACHMENT_MB: positiveInt.pipe(z.number().min(1)),
  MAX_OUTPUT_ARTIFACT_MB: positiveInt.pipe(z.number().min(1)),
  APPROVAL_TIMEOUT_MIN: positiveInt.pipe(z.number().min(1)),
  TASK_MAX_DURATION_MIN: positiveInt.pipe(z.number().min(1)),

  // Kich thuoc trang cua cac ban phim inline. Telegram tu choi ban phim qua lon,
  // va phep do thay CLIProxy khai hon 20 model — nen day la gioi han that, khong
  // phai tham so trang tri.
  MODEL_PAGE_SIZE: positiveInt.pipe(z.number().min(1).max(20)),
  SESSION_PAGE_SIZE: positiveInt.pipe(z.number().min(1).max(20)),
  PROJECT_PAGE_SIZE: positiveInt.pipe(z.number().min(1).max(20)),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
  NODE_ENV: z.string().min(1),
  HEALTH_PORT: port,
});

export type Config = z.infer<typeof schema>;

/**
 * Bien doi phai thoa BAT DANG THUC nay, khong phai quy uoc.
 *
 * Telegram nhan tep nhi phan, con OpenCode nhan FilePart dang data: URI base64.
 * base64 phinh 4/3 (~33%). Neu tran dinh kem >= tran body thi moi tep gan tran
 * se bi CHINH ta tu choi sau khi da tai ve — nguoi dung thay "qua lon" cho mot
 * tep dung bang gioi han ma ta cong bo.
 */
export function kiemBatDangThuc(cfg: Config): string[] {
  const loi: string[] = [];
  const sauBase64 = Math.ceil(cfg.MAX_INPUT_ATTACHMENT_MB * 1.37);
  if (sauBase64 > cfg.MAX_PROMPT_BODY_MB) {
    loi.push(
      `MAX_INPUT_ATTACHMENT_MB=${cfg.MAX_INPUT_ATTACHMENT_MB} sau base64 thanh ~${sauBase64} MB, ` +
        `vuot MAX_PROMPT_BODY_MB=${cfg.MAX_PROMPT_BODY_MB}`,
    );
  }
  if (cfg.APPROVAL_TIMEOUT_MIN > cfg.TASK_MAX_DURATION_MIN) {
    loi.push(
      `APPROVAL_TIMEOUT_MIN=${cfg.APPROVAL_TIMEOUT_MIN} lon hon TASK_MAX_DURATION_MIN=` +
        `${cfg.TASK_MAX_DURATION_MIN}: task se bi huy truoc khi het han cho duyet`,
    );
  }
  const admins = new Set(cfg.TELEGRAM_ADMIN_USER_IDS.map(String));
  const allowed = new Set(cfg.TELEGRAM_ALLOWED_USER_IDS.map(String));
  for (const id of admins) {
    if (!allowed.has(id)) {
      loi.push(`admin ${id} khong nam trong TELEGRAM_ALLOWED_USER_IDS`);
    }
  }
  return loi;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const chiTiet = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(goc)'}: ${i.message}`)
      .join('\n');
    throw new Error(`cau hinh khong hop le:\n${chiTiet}`);
  }
  const loi = kiemBatDangThuc(parsed.data);
  if (loi.length > 0) {
    throw new Error(`cau hinh mau thuan:\n${loi.map((l) => `  ${l}`).join('\n')}`);
  }
  return parsed.data;
}
