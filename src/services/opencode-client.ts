/**
 * Client HTTP cho opencode-server.
 *
 * Moi khang dinh trong file nay tra duoc ve `docs/opencode-api-do-duoc.md` —
 * ban ghi cua phep do tren server 1.18.18 dang chay tren vpn4 ngay 2026-08-18.
 * Khong doan endpoint, khong doan hinh dang phan hoi. Cho nao chua do thi ghi ro
 * la chua do.
 */
import { Buffer } from 'node:buffer';

import type { Config } from '../config.js';

/** Phien do `POST /session` tao ra. Chi khai nhung truong ta thuc su dung. */
export interface Session {
  id: string;
  title?: string;
  directory?: string;
  projectID?: string;
}

/** Mot model kha dung, phang hoa tu `GET /config/providers`. */
export interface Model {
  providerID: string;
  modelID: string;
  ten: string;
}

/** Mot agent tu `GET /agent`. */
export interface Agent {
  name: string;
  description?: string;
  mode?: string;
}

/** Yeu cau quyen con treo — hinh dang lay tu su kien `permission.asked` da do. */
export interface YeuCauQuyen {
  id: string;
  sessionID: string;
  permission: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  tool?: { messageID?: string; callID?: string };
}

export type TraLoiQuyen = 'once' | 'always' | 'reject';

/** Loi HTTP co ma trang thai, de tang tren phan biet 401 voi 5xx. */
export class LoiOpenCode extends Error {
  constructor(
    readonly status: number,
    readonly duongDan: string,
    readonly than: string,
  ) {
    super(`opencode ${duongDan} tra HTTP ${status}: ${than.slice(0, 300)}`);
    this.name = 'LoiOpenCode';
  }
}

/**
 * Sinh mot messageID hop le voi mau `^msg` ma dac ta doi.
 *
 * BAT BUOC, khong phai tien nghi: `POST /session/:id/prompt_async` tra **204
 * khong co than**, nen khong co cach nao lay id cua message tu phan hoi. Neu
 * khong tu sinh, viec tuong quan giua "lenh ta gui" va "su kien ta nhan" phai
 * doan bang thu tu thoi gian — sai ngay khi hai task cua hai nguoi chay xen ke.
 */
export function sinhMessageId(): string {
  const ngauNhien = Math.random().toString(36).slice(2, 12);
  return `msg_${Date.now().toString(36)}${ngauNhien}`;
}

export class OpenCodeClient {
  private readonly goc: string;
  private readonly xacThuc: string;

  constructor(private readonly cfg: Config) {
    this.goc = cfg.OPENCODE_URL.replace(/\/+$/, '');
    // HTTP Basic, KHONG phai Bearer. Da do ca ba cach: Bearer -> 401,
    // `x-opencode-password` -> 401, Basic -> 200. Ten nguoi dung khong duoc kiem,
    // dat 'opencode' cho de doc log.
    const cap = `opencode:${cfg.OPENCODE_SERVER_PASSWORD}`;
    this.xacThuc = `Basic ${Buffer.from(cap, 'utf8').toString('base64')}`;
  }

  /** Tieu de dung chung cho moi loi goi, ke ca luong SSE. */
  tieuDe(them?: Record<string, string>): Record<string, string> {
    return { authorization: this.xacThuc, ...(them ?? {}) };
  }

  private async goi(
    duongDan: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const { timeoutMs = 20_000, ...phanConLai } = init;
    const huy = AbortSignal.timeout(timeoutMs);
    const res = await fetch(`${this.goc}${duongDan}`, {
      ...phanConLai,
      signal: huy,
      headers: this.tieuDe(phanConLai.headers as Record<string, string> | undefined),
    });
    if (!res.ok) {
      throw new LoiOpenCode(res.status, duongDan, await res.text().catch(() => ''));
    }
    return res;
  }

  private async goiJson<T>(duongDan: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
    const res = await this.goi(duongDan, init);
    return (await res.json()) as T;
  }

  private thanJson(du_lieu: unknown): RequestInit {
    return {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(du_lieu),
    };
  }

  /**
   * Server co dang lang nghe khong.
   *
   * Xac thuc PHU LUON `/global/health` (da do), nen khong the dung endpoint nay
   * de kiem "server song" ma khong co mat khau. Ta co mat khau nen goi binh
   * thuong; healthcheck cua compose lai co canh khac va co ly do rieng — xem
   * chu thich trong docker-compose.yml.
   */
  async khoe(): Promise<boolean> {
    try {
      await this.goi(this.cfg.OPENCODE_HEALTH_PATH, { timeoutMs: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Danh sach model, phang hoa tu `GET /config/providers`.
   *
   * Nguon la API chu khong phai `opencode.json` da mount: file do la DAU VAO cua
   * server, con cai ta can la thu server THUC SU nap duoc. Hai thu tung lech
   * nhau that — `baseURL` rong ngay 2026-08-18 la mot vi du.
   */
  async dsModel(): Promise<Model[]> {
    const d = await this.goiJson<{
      providers?: Array<{
        id: string;
        name?: string;
        models?: Record<string, { id?: string; name?: string }>;
      }>;
    }>('/config/providers');
    const ra: Model[] = [];
    for (const p of d.providers ?? []) {
      for (const [khoa, m] of Object.entries(p.models ?? {})) {
        const modelID = m.id ?? khoa;
        ra.push({ providerID: p.id, modelID, ten: m.name ?? modelID });
      }
    }
    return ra;
  }

  /** Danh sach agent tu `GET /agent` — endpoint co that, da do tra 200. */
  async dsAgent(): Promise<Agent[]> {
    const d = await this.goiJson<Agent[]>('/agent');
    return Array.isArray(d) ? d : [];
  }

  async taoSession(tuaDe?: string): Promise<Session> {
    return this.goiJson<Session>('/session', this.thanJson(tuaDe ? { title: tuaDe } : {}));
  }

  async dsSession(): Promise<Session[]> {
    const d = await this.goiJson<Session[]>('/session');
    return Array.isArray(d) ? d : [];
  }

  /**
   * Gui prompt, khong cho ket qua.
   *
   * Tra ve `messageID` DO TA SINH chu khong phai do server tra: phan hoi la 204
   * khong co than. Ben goi dung id nay de loc su kien cua dung luot chay nay.
   */
  async guiPrompt(doiSo: {
    sessionID: string;
    van: string;
    providerID?: string;
    modelID?: string;
    agent?: string;
    messageID?: string;
  }): Promise<string> {
    const messageID = doiSo.messageID ?? sinhMessageId();
    await this.goi(`/session/${doiSo.sessionID}/prompt_async`, {
      ...this.thanJson({
        messageID,
        model: {
          providerID: doiSo.providerID ?? this.cfg.DEFAULT_PROVIDER,
          modelID: doiSo.modelID ?? this.cfg.DEFAULT_MODEL,
        },
        agent: doiSo.agent ?? this.cfg.DEFAULT_AGENT,
        // `parts` la truong bat buoc DUY NHAT theo dac ta da tai ve.
        parts: [{ type: 'text', text: doiSo.van }],
      }),
      timeoutMs: 30_000,
    });
    return messageID;
  }

  async huy(sessionID: string): Promise<void> {
    await this.goi(`/session/${sessionID}/abort`, this.thanJson({}));
  }

  /**
   * Toan bo message cua mot phien.
   *
   * Day la nua kia cua viec khong co replay: sau moi lan noi lai luong su kien,
   * doi chieu bang ham nay chu khong hy vong luong tu bu.
   */
  async dsMessage(sessionID: string): Promise<Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>> {
    const d = await this.goiJson<Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>>(
      `/session/${sessionID}/message`,
    );
    return Array.isArray(d) ? d : [];
  }

  /** Diff cua phien. Endpoint co that — khong can `git diff` nhu ban plan cu du lieu. */
  async diff(sessionID: string): Promise<unknown[]> {
    const d = await this.goiJson<unknown[]>(`/session/${sessionID}/diff`);
    return Array.isArray(d) ? d : [];
  }

  /** Yeu cau quyen con treo. Nua kia cua viec khong co replay, cho luong duyet. */
  async dsQuyenChoDuyet(sessionID?: string): Promise<YeuCauQuyen[]> {
    const d = await this.goiJson<YeuCauQuyen[]>('/permission');
    const tatCa = Array.isArray(d) ? d : [];
    return sessionID ? tatCa.filter((p) => p.sessionID === sessionID) : tatCa;
  }

  /**
   * Tra loi mot yeu cau quyen.
   *
   * CANH BAO ngu nghia: `always` ghi vao cau hinh quyen CUA SERVER va ben qua
   * cac phien — no khong phai "luon cho phep trong phien nay". Nhan nut o
   * Telegram phai noi dung dieu do.
   */
  async traLoiQuyen(sessionID: string, permissionID: string, traLoi: TraLoiQuyen): Promise<void> {
    await this.goi(
      `/session/${sessionID}/permissions/${permissionID}`,
      this.thanJson({ response: traLoi }),
    );
  }

  /**
   * Van ban tra loi cuoi cung cua mot phien.
   *
   * Lay message assistant CUOI CUNG, khong phai dau tien: mot luot co dung tool
   * sinh HAI message assistant (mot cho buoc goi tool, mot cho buoc tra loi).
   * Lay nham cai dau thi nguoi dung nhan doan van do dang truoc khi tool chay.
   */
  async vanTraLoiCuoi(sessionID: string): Promise<string> {
    const ds = await this.dsMessage(sessionID);
    for (let i = ds.length - 1; i >= 0; i -= 1) {
      const m = ds[i];
      if ((m.info as { role?: string })?.role !== 'assistant') continue;
      const van = (m.parts ?? [])
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('')
        .trim();
      if (van.length > 0) return van;
    }
    return '';
  }
}
