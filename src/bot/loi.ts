/**
 * Bien mot loi thanh cau tra loi cho nguoi dung.
 *
 * Nguyen tac: KHONG BAO GIO IM LANG. Mot handler nem loi ma nguoi dung khong
 * nhan duoc gi la truong hop te nhat — ho khong phan biet duoc voi "bot chet",
 * khong biet nen doi, nen go lai, hay bao loi. Da xay ra hai lan trong mot ngay:
 * lenh la (`/session`) va lenh nem loi (`/agent` khi OpenCode chua san sang).
 *
 * Nguyen tac hai: noi DU de nguoi dung biet phai lam gi, va KHONG hon. Chuoi
 * JSON tho cua server, stack trace, hay chuoi ket noi DB deu khong giup ho —
 * chi tiet thuoc ve log.
 */
import { LoiOpenCode } from '../services/opencode-client.js';

export function moTaLoi(loi: unknown): string {
  if (loi instanceof LoiOpenCode) {
    // Ma trang thai la thu DUY NHAT tu server dang cho nguoi dung xem: no phan
    // biet duoc "phien khong con" voi "server dang hong" — hai viec can hai hanh
    // dong khac han.
    if (loi.status === 404) {
      return '🔄 Phien khong con ton tai. Dung /new de tao phien moi.';
    }
    if (loi.status === 401 || loi.status === 403) {
      return '🔒 Gateway khong xac thuc duoc voi OpenCode. Day la loi cau hinh, khong phai loi cua ban.';
    }
    if (loi.status >= 500) {
      return '⚠️ OpenCode dang gap su co. Thu lai sau it phut.';
    }
    return `⚠️ OpenCode tu choi yeu cau (HTTP ${loi.status}).`;
  }

  const van = loi instanceof Error ? loi.message : String(loi);

  // Loi mang khi OpenCode chua len — hay gap ngay sau deploy, va nguoi dung chi
  // can biet la doi mot chut.
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|timeout|aborted/i.test(van)) {
    return '⏳ Chua goi duoc OpenCode (co the dang khoi dong lai). Thu lai sau it giay.';
  }

  return '❌ Co loi khi xu ly lenh. Da ghi log; thu lai hoac dung /help.';
}
