/**
 * Dashboard `/start` — deliverable cua Milestone 1.
 *
 * Dashboard LUON hien trang thai hien tai, ke ca khi con trong: nguoi dung phai
 * biet minh dang thieu gi, chu khong doan.
 */
import type { UserState } from '../../services/user-state.js';

export interface DashboardInput {
  state: UserState;
  tenProject: string | null;
  dbUp: boolean;
}

const CHUA_CHON = '—';

/** Dung chuoi dashboard. Tach khoi grammy de test duoc ma khong can bot that. */
export function renderDashboard(input: DashboardInput): string {
  const { state, tenProject, dbUp } = input;

  const model =
    state.currentProviderId && state.currentModelId
      ? `${state.currentProviderId}/${state.currentModelId}`
      : CHUA_CHON;

  const trangThai = !dbUp
    ? '🔴 Mat ket noi co so du lieu'
    : state.currentSessionId
      ? '🟢 San sang'
      : '🟡 Chua co phien lam viec';

  return [
    '🤖 OpenCode Remote',
    '',
    '📁 Project',
    tenProject ?? CHUA_CHON,
    '',
    '💬 Session',
    state.currentSessionId ?? CHUA_CHON,
    '',
    '🧠 Model',
    model,
    '',
    '🤖 Agent',
    state.currentAgent ?? CHUA_CHON,
    '',
    trangThai,
  ].join('\n');
}
