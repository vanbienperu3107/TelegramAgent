/**
 * So sach phien va project ve phia Gateway.
 *
 * OpenCode co `GET /session` cua rieng no, nhung ta van giu bang `opencode_sessions`
 * vi mot ly do khong the lay tu API: **OpenCode khong biet phien nao thuoc ve nguoi
 * dung Telegram nao**. `POST /session` tra `projectID:"global"` cho moi phien — no
 * khong co khai niem chu so huu. Neu chi dua vao API thi moi nguoi dung deu thay
 * phien cua nhau, va AC-02 (cach ly nguoi dung) hong ngay.
 *
 * Ngan sach truy van: §7.10 dat tran 2 luot cho moi thao tac vi DB o cach 307 ms.
 * Moi ham duoi day la MOT luot.
 */
import type { Sql } from 'postgres';

import type { OpenCodeClient } from './opencode-client.js';

export interface Project {
  id: bigint;
  name: string;
  projectPath: string;
  description: string | null;
}

export interface PhienGhiNho {
  opencodeSessionId: string;
  telegramUserId: bigint;
  projectId: bigint | null;
  title: string | null;
  providerId: string | null;
  modelId: string | null;
  agent: string | null;
  lastUsedAt: Date;
}

interface RowProject {
  id: string;
  name: string;
  project_path: string;
  description: string | null;
}

interface RowPhien {
  opencode_session_id: string;
  telegram_user_id: string;
  project_id: string | null;
  title: string | null;
  provider_id: string | null;
  model_id: string | null;
  agent: string | null;
  last_used_at: Date;
}

function tuRowProject(r: RowProject): Project {
  return {
    id: BigInt(r.id),
    name: r.name,
    projectPath: r.project_path,
    description: r.description,
  };
}

function tuRowPhien(r: RowPhien): PhienGhiNho {
  return {
    opencodeSessionId: r.opencode_session_id,
    telegramUserId: BigInt(r.telegram_user_id),
    projectId: r.project_id === null ? null : BigInt(r.project_id),
    title: r.title,
    providerId: r.provider_id,
    modelId: r.model_id,
    agent: r.agent,
    lastUsedAt: r.last_used_at,
  };
}

export class KhoPhien {
  constructor(
    private readonly sql: Sql,
    private readonly client: OpenCodeClient,
  ) {}

  async dsProject(): Promise<Project[]> {
    const rows = await this.sql<RowProject[]>`
      SELECT id, name, project_path, description
      FROM projects WHERE enabled = TRUE ORDER BY name`;
    return rows.map(tuRowProject);
  }

  async project(id: bigint): Promise<Project | null> {
    const rows = await this.sql<RowProject[]>`
      SELECT id, name, project_path, description FROM projects WHERE id = ${String(id)}`;
    const r = rows[0];
    return r ? tuRowProject(r) : null;
  }

  /**
   * Tao phien moi o OpenCode roi ghi so.
   *
   * KHONG dung giao dich bao trum ca hai: mot ben la HTTP, mot ben la SQL, va
   * `sql.begin` khong quay lui duoc lenh HTTP da gui. Thu tu la co y — tao o
   * OpenCode truoc, ghi so sau. Neu ghi so hong thi ta co mot phien mo coi ben
   * OpenCode (vo hai, no chi ton bo nho) chu khong phai mot dong tro toi phien
   * khong ton tai (bot se goi lien tuc vao id chet).
   */
  async taoPhien(doiSo: {
    telegramUserId: bigint;
    projectId: bigint | null;
    title?: string;
    providerId?: string | null;
    modelId?: string | null;
    agent?: string | null;
  }): Promise<PhienGhiNho> {
    const phien = await this.client.taoSession(doiSo.title);
    await this.sql`
      INSERT INTO opencode_sessions (
        opencode_session_id, telegram_user_id, project_id, title,
        provider_id, model_id, agent
      ) VALUES (
        ${phien.id}, ${String(doiSo.telegramUserId)},
        ${doiSo.projectId === null ? null : String(doiSo.projectId)},
        ${doiSo.title ?? phien.title ?? null},
        ${doiSo.providerId ?? null}, ${doiSo.modelId ?? null}, ${doiSo.agent ?? null}
      )
      ON CONFLICT (opencode_session_id) DO NOTHING`;
    return {
      opencodeSessionId: phien.id,
      telegramUserId: doiSo.telegramUserId,
      projectId: doiSo.projectId,
      title: doiSo.title ?? phien.title ?? null,
      providerId: doiSo.providerId ?? null,
      modelId: doiSo.modelId ?? null,
      agent: doiSo.agent ?? null,
      lastUsedAt: new Date(),
    };
  }

  /** Phien gan day cua MOT nguoi dung. Loc theo chu so huu la cot loi cua AC-02. */
  async dsPhien(telegramUserId: bigint, gioiHan = 8): Promise<PhienGhiNho[]> {
    const rows = await this.sql<RowPhien[]>`
      SELECT opencode_session_id, telegram_user_id, project_id, title,
             provider_id, model_id, agent, last_used_at
      FROM opencode_sessions
      WHERE telegram_user_id = ${String(telegramUserId)} AND archived = FALSE
      ORDER BY last_used_at DESC
      LIMIT ${gioiHan}`;
    return rows.map(tuRowPhien);
  }

  /**
   * Doc mot phien VA kiem chu so huu trong cung mot luot truy van.
   *
   * Tra `null` cho ca "khong ton tai" lan "khong phai cua ban" — co y khong phan
   * biet: phan biet hai ca do la mot kenh ro ri, no xac nhan mot id co ton tai
   * hay khong cho nguoi khong so huu no.
   */
  async phienCuaNguoiDung(
    opencodeSessionId: string,
    telegramUserId: bigint,
  ): Promise<PhienGhiNho | null> {
    const rows = await this.sql<RowPhien[]>`
      SELECT opencode_session_id, telegram_user_id, project_id, title,
             provider_id, model_id, agent, last_used_at
      FROM opencode_sessions
      WHERE opencode_session_id = ${opencodeSessionId}
        AND telegram_user_id = ${String(telegramUserId)}
        AND archived = FALSE`;
    const r = rows[0];
    return r ? tuRowPhien(r) : null;
  }

  /**
   * Dat tua de tu cau hoi DAU TIEN cua phien.
   *
   * OpenCode dat tua de mac dinh la "New session - <dau thoi gian ISO>", nen sau
   * vai phien thi danh sach chi con nhung dong giong het nhau khac moi vai giay
   * — khong the chon dung phien minh muon. Chi ghi khi tua de con la mac dinh
   * hoac con trong: nguoi dung doi ten roi thi khong duoc de len.
   */
  async datTuaDeTuPrompt(opencodeSessionId: string, prompt: string): Promise<void> {
    const tuaDe = prompt.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (tuaDe.length === 0) return;
    await this.sql`
      UPDATE opencode_sessions SET title = ${tuaDe}
      WHERE opencode_session_id = ${opencodeSessionId}
        AND (title IS NULL OR title = '' OR title LIKE 'New session -%')`;
  }

  /**
   * Luu tru moi phien cua nguoi dung ma OpenCode KHONG con biet toi.
   *
   * Doi chieu voi `GET /session` thay vi xoa theo tuoi: mot phien cu ma van song
   * thi van dung duoc, con mot phien vua tao 10 giay truoc ma OpenCode da quen
   * thi vo dung. Tuoi khong noi len dieu gi; su ton tai thi co.
   *
   * Tra ve so phien da don. Loi goi OpenCode duoc de NEM LEN: don nham het phien
   * vi mot lan mang chap chon thi te hon nhieu so voi bao loi va khong lam gi.
   */
  async donPhienDaChet(telegramUserId: bigint): Promise<number> {
    const conSong = new Set((await this.client.dsSession()).map((s) => s.id));
    const cuaTa = await this.dsPhien(telegramUserId, 200);
    const chet = cuaTa.filter((p) => !conSong.has(p.opencodeSessionId));
    if (chet.length === 0) return 0;

    const rows = await this.sql<{ opencode_session_id: string }[]>`
      UPDATE opencode_sessions SET archived = TRUE
      WHERE telegram_user_id = ${String(telegramUserId)}
        AND opencode_session_id IN ${this.sql(chet.map((p) => p.opencodeSessionId))}
      RETURNING opencode_session_id`;
    return rows.length;
  }

  async chamMoc(opencodeSessionId: string): Promise<void> {
    await this.sql`
      UPDATE opencode_sessions SET last_used_at = NOW()
      WHERE opencode_session_id = ${opencodeSessionId}`;
  }

  async luuTru(opencodeSessionId: string, telegramUserId: bigint): Promise<boolean> {
    const rows = await this.sql<{ opencode_session_id: string }[]>`
      UPDATE opencode_sessions SET archived = TRUE
      WHERE opencode_session_id = ${opencodeSessionId}
        AND telegram_user_id = ${String(telegramUserId)}
      RETURNING opencode_session_id`;
    return rows.length > 0;
  }
}
