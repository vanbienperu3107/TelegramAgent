/**
 * Cache ghi-xuyen cho user_state.
 *
 * Ly do ton tai la con so 307 ms: mot luong doc ngay tho (doc user -> doc state ->
 * doc project -> doc session) ton ~1.2 giay TRUOC khi Telegram kip hien chu
 * "Working...". §7.10 dat ngan sach <= 2 luot truy van cho moi thao tac.
 *
 * Bang nay chi vai chuc dong (V1 co mot project, vai nguoi dung) va CHI Gateway
 * ghi vao no, nen cache khong bao gio lech — tru mot ngoai le da biet: admin them
 * project bang INSERT truc tiep. Vi vay co `/reload`, va lan nap lai phai HOAN DOI
 * NGUYEN TU chu khong duoc xoa-roi-dien: giua hai thao tac do, mot `/start` dong
 * thoi se thay cache rong va ghi de state bang gia tri thieu.
 */
import type { Sql } from 'postgres';

export interface UserState {
  telegramUserId: bigint;
  currentProjectId: bigint | null;
  currentSessionId: string | null;
  currentProviderId: string | null;
  currentModelId: string | null;
  currentAgent: string | null;
}

export function stateRong(telegramUserId: bigint): UserState {
  return {
    telegramUserId,
    currentProjectId: null,
    currentSessionId: null,
    currentProviderId: null,
    currentModelId: null,
    currentAgent: null,
  };
}

interface Row {
  telegram_user_id: string;
  current_project_id: string | null;
  current_session_id: string | null;
  current_provider_id: string | null;
  current_model_id: string | null;
  current_agent: string | null;
}

function tuRow(row: Row): UserState {
  return {
    telegramUserId: BigInt(row.telegram_user_id),
    currentProjectId: row.current_project_id === null ? null : BigInt(row.current_project_id),
    currentSessionId: row.current_session_id,
    currentProviderId: row.current_provider_id,
    currentModelId: row.current_model_id,
    currentAgent: row.current_agent,
  };
}

export class UserStateCache {
  private map = new Map<string, UserState>();

  constructor(private readonly sql: Sql) {}

  /** Nap lai toan bo. Dung map MOI roi hoan doi — khong xoa tai cho. */
  async reload(): Promise<number> {
    const rows = await this.sql<Row[]>`SELECT * FROM user_state`;
    const moi = new Map<string, UserState>();
    for (const row of rows) moi.set(row.telegram_user_id, tuRow(row));
    this.map = moi;
    return moi.size;
  }

  /** Doc: 0 luot truy van. Nguoi dung moi -> state rong, KHONG phai undefined. */
  get(telegramUserId: bigint): UserState {
    return this.map.get(String(telegramUserId)) ?? stateRong(telegramUserId);
  }

  /**
   * Ghi: cap nhat RAM truoc (giao dien phan hoi ngay), roi ben hoa xuong DB.
   *
   * KHONG dung `this.map.get(id)!` o day: nguoi dung MOI chua co dong nao trong
   * user_state, `get` tra undefined, va spread cua undefined cho ra object chi co
   * cac truong trong `patch` — mat currentProjectId/currentSessionId cho toi lan
   * nap sau.
   */
  async set(telegramUserId: bigint, patch: Partial<Omit<UserState, 'telegramUserId'>>): Promise<UserState> {
    const truoc = this.get(telegramUserId);
    const sau: UserState = { ...truoc, ...patch, telegramUserId };
    this.map.set(String(telegramUserId), sau);

    await this.sql`
      INSERT INTO user_state (
        telegram_user_id, current_project_id, current_session_id,
        current_provider_id, current_model_id, current_agent, updated_at
      ) VALUES (
        ${String(sau.telegramUserId)},
        ${sau.currentProjectId === null ? null : String(sau.currentProjectId)},
        ${sau.currentSessionId}, ${sau.currentProviderId},
        ${sau.currentModelId}, ${sau.currentAgent}, NOW()
      )
      ON CONFLICT (telegram_user_id) DO UPDATE SET
        current_project_id  = EXCLUDED.current_project_id,
        current_session_id  = EXCLUDED.current_session_id,
        current_provider_id = EXCLUDED.current_provider_id,
        current_model_id    = EXCLUDED.current_model_id,
        current_agent       = EXCLUDED.current_agent,
        updated_at          = NOW()`;

    return sau;
  }

  get soLuong(): number {
    return this.map.size;
  }
}
