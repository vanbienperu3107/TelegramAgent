/**
 * Uy quyen. Day la lop bao ve DUY NHAT giua Internet va mot agent duoc phep chay
 * `bash` tren may dang chay DERP relay cua ca fleet.
 *
 * Thu tu kiem BAT BUOC, khong duoc doi:
 *   1. la chat rieng?   -> V1 khong ho tro nhom (§8)
 *   2. co id nguoi gui? -> update he thong khong co `from`
 *   3. id trong whitelist?
 *
 * Whitelist doc tu bien moi truong chu KHONG tu DB: DB o cach 307 ms va co the
 * chet, ma "DB chet thi cho tat ca vao" la kieu fail-open toi te nhat.
 */
import type { Context, MiddlewareFn } from 'grammy';

export type KetQuaUyQuyen =
  | { ok: true; userId: bigint; laAdmin: boolean }
  | { ok: false; ly_do: 'khong-phai-chat-rieng' | 'khong-co-nguoi-gui' | 'khong-trong-whitelist' };

export function kiemUyQuyen(
  chatType: string | undefined,
  fromId: bigint | undefined,
  whitelist: readonly bigint[],
  admins: readonly bigint[],
): KetQuaUyQuyen {
  if (chatType !== 'private') return { ok: false, ly_do: 'khong-phai-chat-rieng' };
  if (fromId === undefined) return { ok: false, ly_do: 'khong-co-nguoi-gui' };
  if (!whitelist.some((id) => id === fromId)) return { ok: false, ly_do: 'khong-trong-whitelist' };
  return { ok: true, userId: fromId, laAdmin: admins.some((id) => id === fromId) };
}

export interface AuthFlavor {
  auth: { userId: bigint; laAdmin: boolean };
}

export function authMiddleware(
  whitelist: readonly bigint[],
  admins: readonly bigint[],
  log: { warn: (o: object, m: string) => void },
): MiddlewareFn<Context & AuthFlavor> {
  return async (ctx, next) => {
    const fromId = ctx.from?.id === undefined ? undefined : BigInt(ctx.from.id);
    const ketQua = kiemUyQuyen(ctx.chat?.type, fromId, whitelist, admins);

    if (!ketQua.ok) {
      log.warn(
        { ly_do: ketQua.ly_do, chat_type: ctx.chat?.type, telegram_user_id: fromId?.toString() },
        'tu choi update',
      );
      // Chat nhom: IM LANG bo qua. Tra loi la xac nhan bot ton tai trong nhom do,
      // va bot khong duoc phep hoat dong o nhom o V1.
      if (ketQua.ly_do === 'khong-phai-chat-rieng') return;
      await ctx.reply('⛔ Unauthorized');
      return;
    }

    (ctx as Context & AuthFlavor).auth = { userId: ketQua.userId, laAdmin: ketQua.laAdmin };
    await next();
  };
}
