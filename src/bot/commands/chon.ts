/**
 * Cac lenh chon: project, phien, model, agent.
 *
 * Phan DUNG danh sach tach khoi phan GUI di, de test duoc ma khong can bot that
 * lan server that. Moi ham o day thuan tuy: vao du lieu, ra van ban + ban phim.
 */
import type { InlineKeyboard } from 'grammy';

import type { Agent, Model } from '../../services/opencode-client.js';
import type { PhienGhiNho, Project } from '../../services/sessions.js';
import { banPhimDoc } from '../keyboards.js';

export interface ManHinh {
  van: string;
  banPhim?: InlineKeyboard;
}

/**
 * Cat nhan nut cho vua ban phim Telegram.
 *
 * Khong phai cho dep: nhan qua dai bi Telegram cat giua chung tren man hinh hep
 * va hai lua chon khac nhau co the trong y het nhau. Cat o day thi it nhat phan
 * dau — phan phan biet duoc — luon hien.
 */
export function catNhan(s: string, toiDa = 40): string {
  return s.length <= toiDa ? s : `${s.slice(0, toiDa - 1)}…`;
}

export function manHinhProject(ds: Project[], dangChon: bigint | null): ManHinh {
  if (ds.length === 0) {
    // Khong bao gio de nguoi dung doi mot danh sach rong ma khong biet lam gi.
    return { van: '📁 Chua co project nao duoc bat. Admin can them vao bang `projects`.' };
  }
  return {
    van: '📁 Chon project:',
    banPhim: banPhimDoc(
      ds.map((p) => ({
        nhan: `${p.id === dangChon ? '✅ ' : ''}${catNhan(p.name)}`,
        viec: 'duan',
        thamSo: String(p.id),
      })),
    ),
  };
}

export function manHinhPhien(ds: PhienGhiNho[], dangChon: string | null): ManHinh {
  if (ds.length === 0) {
    return { van: '💬 Ban chua co phien nao. Dung /new de tao phien moi.' };
  }
  return {
    van: '💬 Chon phien lam viec:',
    banPhim: banPhimDoc(
      ds.map((p) => ({
        nhan: `${p.opencodeSessionId === dangChon ? '✅ ' : ''}${catNhan(
          p.title ?? p.opencodeSessionId,
        )}`,
        viec: 'phien',
        thamSo: p.opencodeSessionId,
      })),
    ),
  };
}

/**
 * Man hinh chon model, co phan trang.
 *
 * Phan trang la bat buoc chu khong phai tuy chon: phep do ngay 2026-08-18 thay
 * CLIProxy khai hon 20 model, va Telegram tu choi ban phim qua lon. Trang duoc
 * ma hoa vao chinh callback_data cua nut "trang sau".
 */
export function manHinhModel(
  ds: Model[],
  dangChon: { providerId: string | null; modelId: string | null },
  trang = 0,
  moiTrang = 8,
): ManHinh {
  if (ds.length === 0) {
    return { van: '🧠 OpenCode khong bao model nao. Kiem `GET /config/providers` truoc.' };
  }
  const soTrang = Math.max(1, Math.ceil(ds.length / moiTrang));
  const t = Math.min(Math.max(trang, 0), soTrang - 1);
  const lat = ds.slice(t * moiTrang, (t + 1) * moiTrang);

  const muc = lat.map((m) => ({
    nhan: `${
      m.providerID === dangChon.providerId && m.modelID === dangChon.modelId ? '✅ ' : ''
    }${catNhan(m.ten)}`,
    viec: 'model',
    // providerID/modelID deu can de goi prompt, nen phai mang ca hai qua
    // callback. Dau `/` la ky tu phan cach vi id cua model khong chua no.
    thamSo: `${m.providerID}/${m.modelID}`,
  }));
  const kb = banPhimDoc(muc);
  if (soTrang > 1) {
    if (t > 0) kb.text('◀️ Truoc', `trang-model:${t - 1}`);
    kb.text(`${t + 1}/${soTrang}`, 'khong-lam-gi:x');
    if (t < soTrang - 1) kb.text('Sau ▶️', `trang-model:${t + 1}`);
  }
  return { van: `🧠 Chon model (${ds.length} model):`, banPhim: kb };
}

export function manHinhAgent(ds: Agent[], dangChon: string | null): ManHinh {
  if (ds.length === 0) {
    return { van: '🤖 OpenCode khong bao agent nao. Kiem `GET /agent` truoc.' };
  }
  return {
    van: '🤖 Chon agent:',
    banPhim: banPhimDoc(
      ds.map((a) => ({
        nhan: `${a.name === dangChon ? '✅ ' : ''}${catNhan(a.name)}`,
        viec: 'agent',
        thamSo: a.name,
      })),
    ),
  };
}

/** Tach `provider/model` tu callback. Model id co the chua `-` va `.` nhung khong chua `/`. */
export function tachModel(thamSo: string): { providerID: string; modelID: string } | null {
  const i = thamSo.indexOf('/');
  if (i <= 0 || i === thamSo.length - 1) return null;
  return { providerID: thamSo.slice(0, i), modelID: thamSo.slice(i + 1) };
}
