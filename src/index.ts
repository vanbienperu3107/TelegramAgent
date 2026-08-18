/**
 * Diem vao cua Gateway.
 *
 * Thu tu khoi dong la CO Y, khong phai tinh co:
 *   1. doc cau hinh   — sai thi chet ngay, truoc khi cham vao thu gi
 *   2. mo /healthz    — de container co the `healthy` ngay ca khi DB chua len
 *   3. nap cache      — can DB; that bai thi ghi nhan va chay tiep (AC-20)
 *   4. bat dau polling — sau cung, khi moi thu khac da san sang
 *
 * Migration KHONG chay o day: no la mot tien trinh rieng chay truoc (§37.2 buoc 4).
 */
import { Bot, type Context } from 'grammy';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createSql, pingDb } from './db/index.js';
import { UserStateCache } from './services/user-state.js';
import { authMiddleware, type AuthFlavor } from './bot/middleware/auth.js';
import { renderDashboard } from './bot/commands/start.js';
import {
  manHinhAgent,
  manHinhModel,
  manHinhPhien,
  manHinhProject,
  tachModel,
} from './bot/commands/chon.js';
import { giaiMa } from './bot/keyboards.js';
import { OpenCodeClient } from './services/opencode-client.js';
import { KhoPhien } from './services/sessions.js';
import { startHealthServer, type HealthState } from './health.js';

type Ctx = Context & AuthFlavor;

async function main() {
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL, cfg.NODE_ENV);
  log.info(
    { project: cfg.DEFAULT_PROJECT_NAME, model: cfg.DEFAULT_MODEL },
    'gateway dang khoi dong',
  );

  const sql = createSql(cfg);
  const cache = new UserStateCache(sql);
  const opencode = new OpenCodeClient(cfg);
  const khoPhien = new KhoPhien(sql, opencode);

  const trangThai: HealthState = { db: 'down', botDangPolling: false, batDau: new Date() };
  const health = startHealthServer(cfg.HEALTH_PORT, () => trangThai);
  log.info({ port: cfg.HEALTH_PORT }, 'health server dang nghe tren loopback');

  // Nap cache. Mat DB KHONG phai ly do de chet: §41 va AC-20 doi Gateway song sot,
  // tra loi ro rang, va van cho Abort chay.
  trangThai.db = await pingDb(sql);
  if (trangThai.db === 'up') {
    const n = await cache.reload();
    log.info({ so_dong: n }, 'da nap user_state vao cache');
  } else {
    log.error({}, 'khong ket noi duoc DB luc khoi dong — chay o che do suy giam');
  }

  const bot = new Bot<Ctx>(cfg.TELEGRAM_BOT_TOKEN);
  bot.use(authMiddleware(cfg.TELEGRAM_ALLOWED_USER_IDS, cfg.TELEGRAM_ADMIN_USER_IDS, log));

  bot.command('start', async (ctx) => {
    const state = cache.get(ctx.auth.userId);
    let tenProject: string | null = null;
    if (state.currentProjectId !== null && trangThai.db === 'up') {
      const rows = await sql<{ name: string }[]>`
        SELECT name FROM projects WHERE id = ${String(state.currentProjectId)}`;
      tenProject = rows[0]?.name ?? null;
    }
    await ctx.reply(
      renderDashboard({ state, tenProject, dbUp: trangThai.db === 'up' }),
    );
  });

  bot.command('reload', async (ctx) => {
    if (!ctx.auth.laAdmin) {
      await ctx.reply('⛔ Chi admin dung duoc lenh nay');
      return;
    }
    const n = await cache.reload();
    await ctx.reply(`♻️ Da nap lai ${n} dong user_state`);
  });

  /**
   * Cac lenh chon deu doi DB. Khi DB sap thi noi thang thay vi nem stack trace:
   * §41 va AC-20 doi Gateway song sot va tra loi ro rang, khong phai im lang.
   */
  const doiDb = async (ctx: Ctx): Promise<boolean> => {
    if (trangThai.db === 'up') return true;
    await ctx.reply('🔴 Mat ket noi co so du lieu — lenh nay tam thoi khong dung duoc.');
    return false;
  };

  const guiManHinh = async (ctx: Ctx, mh: { van: string; banPhim?: unknown }) => {
    await ctx.reply(mh.van, mh.banPhim ? { reply_markup: mh.banPhim as never } : undefined);
  };

  bot.command('project', async (ctx) => {
    if (!(await doiDb(ctx))) return;
    const state = cache.get(ctx.auth.userId);
    await guiManHinh(ctx, manHinhProject(await khoPhien.dsProject(), state.currentProjectId));
  });

  bot.command('sessions', async (ctx) => {
    if (!(await doiDb(ctx))) return;
    const state = cache.get(ctx.auth.userId);
    await guiManHinh(
      ctx,
      manHinhPhien(await khoPhien.dsPhien(ctx.auth.userId, cfg.SESSION_PAGE_SIZE), state.currentSessionId),
    );
  });

  bot.command('new', async (ctx) => {
    if (!(await doiDb(ctx))) return;
    const state = cache.get(ctx.auth.userId);
    if (state.currentProjectId === null) {
      await ctx.reply('📁 Hay chon project truoc bang /project.');
      return;
    }
    const phien = await khoPhien.taoPhien({
      telegramUserId: ctx.auth.userId,
      projectId: state.currentProjectId,
      providerId: state.currentProviderId ?? cfg.DEFAULT_PROVIDER,
      modelId: state.currentModelId ?? cfg.DEFAULT_MODEL,
      agent: state.currentAgent ?? cfg.DEFAULT_AGENT,
    });
    await cache.set(ctx.auth.userId, { currentSessionId: phien.opencodeSessionId });
    await ctx.reply(`✅ Da tao phien moi: ${phien.opencodeSessionId}`);
  });

  bot.command('model', async (ctx) => {
    const state = cache.get(ctx.auth.userId);
    await guiManHinh(
      ctx,
      manHinhModel(await opencode.dsModel(), {
        providerId: state.currentProviderId,
        modelId: state.currentModelId,
      }, 0, cfg.MODEL_PAGE_SIZE),
    );
  });

  bot.command('agent', async (ctx) => {
    const state = cache.get(ctx.auth.userId);
    await guiManHinh(ctx, manHinhAgent(await opencode.dsAgent(), state.currentAgent));
  });

  bot.on('callback_query:data', async (ctx) => {
    const lenh = giaiMa(ctx.callbackQuery.data);
    if (!lenh) {
      await ctx.answerCallbackQuery('Nut khong hop le');
      return;
    }
    switch (lenh.viec) {
      case 'duan': {
        if (!(await doiDb(ctx))) return;
        const duAn = await khoPhien.project(BigInt(lenh.thamSo));
        if (!duAn) {
          await ctx.answerCallbackQuery('Project khong con ton tai');
          return;
        }
        // Doi project thi phien cu khong con y nghia: no gan voi thu muc khac.
        // Xoa luon con hon de nguoi dung go tiep vao phien cua project cu.
        await cache.set(ctx.auth.userId, { currentProjectId: duAn.id, currentSessionId: null });
        await ctx.answerCallbackQuery(`Da chon ${duAn.name}`);
        await ctx.reply(`📁 Project: ${duAn.name}
💬 Phien da dat lai — dung /new de bat dau.`);
        return;
      }
      case 'phien': {
        if (!(await doiDb(ctx))) return;
        const phien = await khoPhien.phienCuaNguoiDung(lenh.thamSo, ctx.auth.userId);
        if (!phien) {
          await ctx.answerCallbackQuery('Phien khong ton tai hoac khong phai cua ban');
          return;
        }
        await cache.set(ctx.auth.userId, { currentSessionId: phien.opencodeSessionId });
        await khoPhien.chamMoc(phien.opencodeSessionId);
        await ctx.answerCallbackQuery('Da chuyen phien');
        return;
      }
      case 'model': {
        const m = tachModel(lenh.thamSo);
        if (!m) {
          await ctx.answerCallbackQuery('Model khong hop le');
          return;
        }
        await cache.set(ctx.auth.userId, {
          currentProviderId: m.providerID,
          currentModelId: m.modelID,
        });
        await ctx.answerCallbackQuery(`Da chon ${m.modelID}`);
        return;
      }
      case 'trang-model': {
        const state = cache.get(ctx.auth.userId);
        const mh = manHinhModel(
          await opencode.dsModel(),
          { providerId: state.currentProviderId, modelId: state.currentModelId },
          Number(lenh.thamSo),
          cfg.MODEL_PAGE_SIZE,
        );
        await ctx.editMessageText(mh.van, { reply_markup: mh.banPhim as never });
        await ctx.answerCallbackQuery();
        return;
      }
      case 'agent': {
        await cache.set(ctx.auth.userId, { currentAgent: lenh.thamSo });
        await ctx.answerCallbackQuery(`Da chon ${lenh.thamSo}`);
        return;
      }
      default:
        // `khong-lam-gi` (nut so trang) roi vao day. Van phai tra loi callback,
        // neu khong Telegram hien vong xoay tren nut den khi het han.
        await ctx.answerCallbackQuery();
    }
  });

  bot.catch((err) => {
    // Loi chi tiet vao log, Telegram chi nhan mot cau ngan (§41).
    log.error({ err: err.error, update_id: err.ctx.update.update_id }, 'loi khi xu ly update');
  });

  // Theo doi DB nen: dung cho /healthz va cho quyet dinh che do suy giam.
  const nhipDb = setInterval(async () => {
    const truoc = trangThai.db;
    trangThai.db = await pingDb(sql);
    if (truoc !== trangThai.db) {
      log.warn({ truoc, sau: trangThai.db }, 'trang thai DB doi');
      if (trangThai.db === 'up') await cache.reload();
    }
  }, 30_000);

  const dungLai = async (tinHieu: string) => {
    log.info({ tinHieu }, 'dang dung');
    clearInterval(nhipDb);
    trangThai.botDangPolling = false;
    await bot.stop();
    health.close();
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.once('SIGTERM', () => void dungLai('SIGTERM'));
  process.once('SIGINT', () => void dungLai('SIGINT'));

  trangThai.botDangPolling = true;
  log.info({}, 'bat dau long polling');
  await bot.start();
}

main().catch((err) => {
  process.stderr.write(`gateway: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
