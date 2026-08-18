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
import { DANH_SACH_LENH, moiTenCua, renderHelp, renderLenhLa } from './bot/commands/help.js';
import { vePatch, veTomTatDiff } from './bot/commands/diff.js';
import {
  manHinhAgent,
  manHinhModel,
  manHinhPhien,
  manHinhProject,
  tachModel,
} from './bot/commands/chon.js';
import { banPhimDuyet, giaiMa } from './bot/keyboards.js';
import { OpenCodeClient } from './services/opencode-client.js';
import { KhoPhien } from './services/sessions.js';
import { KhoTask } from './services/tasks.js';
import { BoChayTask } from './services/task-runner.js';
import { LuongSuKien } from './services/event-stream.js';
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
  const khoTask = new KhoTask(sql);

  const trangThai: HealthState = { db: 'down', botDangPolling: false, batDau: new Date() };
  const health = startHealthServer(cfg.HEALTH_PORT, () => trangThai);
  log.info({ port: cfg.HEALTH_PORT }, 'health server dang nghe tren loopback');

  // Nap cache. Mat DB KHONG phai ly do de chet: §41 va AC-20 doi Gateway song sot,
  // tra loi ro rang, va van cho Abort chay.
  trangThai.db = await pingDb(sql);
  if (trangThai.db === 'up') {
    const n = await cache.reload();
    log.info({ so_dong: n }, 'da nap user_state vao cache');
    // Gateway co the bi giet giua luot chay (OOM, hoac --force-recreate luc
    // deploy). Dong task khi do ket o 'running' MAI MAI: khoa mot-task khong bao
    // gio nha, nguoi dung khong gui duoc gi nua va khong co cach tu go. Don ngay
    // luc khoi dong, va so luong don duoc la mot tin hieu dang doc trong log.
    const soTreo = await khoTask.donMoiTaskTreo();
    if (soTreo > 0) log.warn({ so_task: soTreo }, 'da nha khoa cho task treo tu lan chay truoc');
  } else {
    log.error({}, 'khong ket noi duoc DB luc khoi dong — chay o che do suy giam');
  }

  const bot = new Bot<Ctx>(cfg.TELEGRAM_BOT_TOKEN);
  bot.use(authMiddleware(cfg.TELEGRAM_ALLOWED_USER_IDS, cfg.TELEGRAM_ADMIN_USER_IDS, log));

  bot.command(moiTenCua('help'), async (ctx) => {
    await ctx.reply(renderHelp());
  });

  bot.command('start', async (ctx) => {
    let state = cache.get(ctx.auth.userId);
    let tenProject: string | null = null;

    if (trangThai.db === 'up') {
      // V1 co DUNG MOT project. Bat nguoi dung bam /project de chon cai duy nhat
      // co the chon la mot buoc khong mang thong tin gi. Tu chon, nhung NOI RA —
      // im lang lam thay doi trang thai la kieu "thong minh" gay kho hieu khi so
      // project tang len sau nay.
      if (state.currentProjectId === null) {
        const ds = await khoPhien.dsProject();
        const duyNhat = ds.length === 1 ? ds[0] : undefined;
        if (duyNhat) {
          state = await cache.set(ctx.auth.userId, { currentProjectId: duyNhat.id });
          tenProject = duyNhat.name;
          await ctx.reply(`📁 Chi co mot project nen da tu chon: ${duyNhat.name}`);
        }
      }
      if (tenProject === null && state.currentProjectId !== null) {
        const duAn = await khoPhien.project(state.currentProjectId);
        tenProject = duAn?.name ?? null;
      }
    }

    await ctx.reply(
      renderDashboard({ state, tenProject, dbUp: trangThai.db === 'up' }),
    );
    if (state.currentSessionId === null) {
      await ctx.reply('Buoc tiep theo: /new de tao phien, roi go cau hoi.');
    }
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

  bot.command(moiTenCua('project'), async (ctx) => {
    if (!(await doiDb(ctx))) return;
    const state = cache.get(ctx.auth.userId);
    await guiManHinh(ctx, manHinhProject(await khoPhien.dsProject(), state.currentProjectId));
  });

  bot.command(moiTenCua('sessions'), async (ctx) => {
    if (!(await doiDb(ctx))) return;
    const state = cache.get(ctx.auth.userId);
    await guiManHinh(
      ctx,
      manHinhPhien(await khoPhien.dsPhien(ctx.auth.userId, cfg.SESSION_PAGE_SIZE), state.currentSessionId),
    );
  });

  bot.command(moiTenCua('new'), async (ctx) => {
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

  bot.command(moiTenCua('model'), async (ctx) => {
    const state = cache.get(ctx.auth.userId);
    await guiManHinh(
      ctx,
      manHinhModel(await opencode.dsModel(), {
        providerId: state.currentProviderId,
        modelId: state.currentModelId,
      }, 0, cfg.MODEL_PAGE_SIZE),
    );
  });

  bot.command(moiTenCua('agent'), async (ctx) => {
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
      case 'quyen-once':
      case 'quyen-always':
      case 'quyen-reject': {
        if (!(await doiDb(ctx))) return;
        const task = await khoTask.taskDangChay(ctx.auth.userId);
        if (!task) {
          // Nguoi dung co the bam nut cu trong mot tin nhan cu. Noi ro thay vi
          // gui mot cau tra loi quyen vao mot phien da ket thuc.
          await ctx.answerCallbackQuery('Task da ket thuc, nut nay khong con tac dung');
          return;
        }
        const traLoi = ({ 'quyen-once': 'once', 'quyen-always': 'always', 'quyen-reject': 'reject' } as const)[
          lenh.viec
        ];
        try {
          await opencode.traLoiQuyen(task.opencodeSessionId, lenh.thamSo, traLoi);
          await khoTask.doiTrangThai(task.id, 'running');
          await ctx.answerCallbackQuery(
            traLoi === 'reject' ? 'Da tu choi' : traLoi === 'always' ? 'Da cho phep vinh vien' : 'Da cho phep',
          );
        } catch (e) {
          log.error({ err: e }, 'tra loi quyen that bai');
          await ctx.answerCallbackQuery('Khong gui duoc cau tra loi toi OpenCode');
        }
        return;
      }
      default:
        // `khong-lam-gi` (nut so trang) roi vao day. Van phai tra loi callback,
        // neu khong Telegram hien vong xoay tren nut den khi het han.
        await ctx.answerCallbackQuery();
    }
  });

  const chay = new BoChayTask(
    cfg,
    opencode,
    khoTask,
    {
      guiTinNhan: async (chatId, van, kb) => {
        const m = await bot.api.sendMessage(Number(chatId), van, kb ? { reply_markup: kb as never } : undefined);
        return BigInt(m.message_id);
      },
      suaTinNhan: async (chatId, messageId, van, kb) => {
        await bot.api.editMessageText(Number(chatId), Number(messageId), van, kb ? { reply_markup: kb as never } : undefined);
      },
    },
    log,
    banPhimDuyet,
  );

  /** Doc phien hien tai, hoac tra loi ro rang neu chua co. Dung chung cho /diff va /patch. */
  const phienHienTai = async (ctx: Ctx): Promise<string | null> => {
    const state = cache.get(ctx.auth.userId);
    if (state.currentSessionId === null) {
      await ctx.reply('💬 Chua co phien lam viec. Dung /new de bat dau.');
      return null;
    }
    return state.currentSessionId;
  };

  bot.command(moiTenCua('dong'), async (ctx) => {
    if (!(await doiDb(ctx))) return;
    const state = cache.get(ctx.auth.userId);
    if (state.currentSessionId === null) {
      await ctx.reply('💬 Ban khong co phien nao dang mo.');
      return;
    }
    const co = await khoPhien.luuTru(state.currentSessionId, ctx.auth.userId);
    await cache.set(ctx.auth.userId, { currentSessionId: null });
    await ctx.reply(
      co
        ? '📕 Da dong phien. Dung /new de tao phien moi.'
        : '📕 Phien khong con trong danh sach. Da bo chon.',
    );
  });

  bot.command(moiTenCua('diff'), async (ctx) => {
    const phien = await phienHienTai(ctx);
    if (phien === null) return;
    await ctx.reply(veTomTatDiff(await opencode.diff(phien)));
  });

  bot.command(moiTenCua('patch'), async (ctx) => {
    const phien = await phienHienTai(ctx);
    if (phien === null) return;
    for (const manh of vePatch(await opencode.diff(phien))) {
      await ctx.reply(manh, { parse_mode: 'Markdown' });
    }
  });

  bot.command(moiTenCua('abort'), async (ctx) => {
    if (!(await doiDb(ctx))) return;
    const co = await chay.huy(ctx.auth.userId);
    await ctx.reply(co ? '🛑 Da huy task dang chay.' : 'Ban khong co task nao dang chay.');
  });

  /**
   * Van ban thuong = mot cau hoi cho agent.
   *
   * Dat SAU tat ca cac `bot.command` de khong nuot lenh. grammy phan phoi theo
   * thu tu dang ky, va `bot.on('message:text')` khop CA tin nhan bat dau bang `/`.
   */
  bot.on('message:text', async (ctx) => {
    // Lenh khong ton tai PHAI duoc tra loi. Truoc day cho nay `return` im lang,
    // va lan test dau tien go `/session` (so it) roi thang vao do: bot khong noi
    // gi ca, khong phan biet duoc voi "bot chet". Im lang la phan hoi te nhat co
    // the co — nguoi dung khong biet nen doi, nen go lai, hay bao loi.
    if (ctx.message.text.startsWith('/')) {
      const go = ctx.message.text.split(/\s+/)[0] ?? '';
      await ctx.reply(renderLenhLa(go));
      return;
    }
    if (!(await doiDb(ctx))) return;

    let state = cache.get(ctx.auth.userId);
    if (state.currentSessionId === null) {
      await ctx.reply('💬 Chua co phien lam viec. Dung /project roi /new de bat dau.');
      return;
    }

    const giaoViec = async (sessionID: string) =>
      chay.batDau({
        telegramUserId: ctx.auth.userId,
        telegramChatId: BigInt(ctx.chat.id),
        sessionID,
        van: ctx.message.text,
        providerID: state.currentProviderId,
        modelID: state.currentModelId,
        agent: state.currentAgent,
      });

    let phien = state.currentSessionId;
    let kq = await giaoViec(phien);

    /**
     * Phien chet ben OpenCode: tao phien moi va thu LAI, dung mot lan.
     *
     * Xay ra that khi opencode-server khoi dong lai. Bat nguoi dung tu go /new
     * roi go lai cau hoi la day viec cua may sang cho ho — ho khong lam gi sai va
     * cung khong the doan duoc chuyen gi vua xay ra.
     *
     * Chi thu lai MOT lan: neu phien vua tao cung 404 thi van de nam o cho khac,
     * va thu vong lai chi doi mot loi ro thanh mot vong lap.
     */
    if (!kq.ok && kq.lyDo === 'phien-da-chet') {
      await khoPhien.luuTru(phien, ctx.auth.userId).catch(() => undefined);
      const moi = await khoPhien.taoPhien({
        telegramUserId: ctx.auth.userId,
        projectId: state.currentProjectId,
        providerId: state.currentProviderId,
        modelId: state.currentModelId,
        agent: state.currentAgent,
      });
      state = await cache.set(ctx.auth.userId, { currentSessionId: moi.opencodeSessionId });
      phien = moi.opencodeSessionId;
      kq = await giaoViec(phien);
    }

    if (!kq.ok) return; // bo chay task da sua chinh tin nhan trang thai de bao

    // Dat tua de phien theo cau hoi dau tien. KHONG `await` tren duong di: day la
    // viec lam dep danh sach, khong duoc lam cham cau tra loi them mot vong 307 ms.
    void khoPhien
      .datTuaDeTuPrompt(phien, ctx.message.text)
      .catch((e) => log.warn({ err: e }, 'khong dat duoc tua de phien'));
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
    luong.dong();
    trangThai.botDangPolling = false;
    await bot.stop();
    health.close();
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.once('SIGTERM', () => void dungLai('SIGTERM'));
  process.once('SIGINT', () => void dungLai('SIGINT'));

  /**
   * Mot luong su kien duy nhat cho ca Gateway.
   *
   * `khiNoiLai` KHONG phai cho de ghi log: luong khong co replay (da do), nen moi
   * su kien phat ra trong luc dut la mat vinh vien — ke ca `session.idle`. Day la
   * cho DUY NHAT de doi chieu lai, va bo qua no la mot task treo mai o lan dut
   * ket noi dau tien.
   */
  const luong = new LuongSuKien(cfg, opencode, {
    khiCoSuKien: (ev) => chay.nhanSuKien(ev),
    khiNoiLai: async (lanThu) => {
      log.warn({ lanThu }, 'noi lai luong su kien — dang doi chieu trang thai');
      await chay.doiChieuSauKhiNoiLai();
    },
    khiLoi: (e) => log.warn({ err: e }, 'luong su kien loi'),
  });
  void luong.chay();

  // Menu lenh lay tu CUNG danh sach voi /help — hai ban chep tay se lech nhau
  // ngay lan them lenh sau. Khong chan khoi dong neu that bai: day la trang tri,
  // khong phai chuc nang.
  await bot.api
    .setMyCommands(DANH_SACH_LENH.map((l) => ({ command: l.lenh, description: l.moTa })))
    .catch((e) => log.warn({ err: e }, 'khong dang ky duoc menu lenh'));

  trangThai.botDangPolling = true;
  log.info({}, 'bat dau long polling');
  await bot.start();
}

main().catch((err) => {
  process.stderr.write(`gateway: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
