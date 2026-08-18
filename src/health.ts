/**
 * Endpoint /healthz. Bind 127.0.0.1 trong container, khong publish ra host.
 *
 * QUY UOC QUAN TRONG: LUON tra HTTP 200, ke ca khi mat DB. Trang thai that nam
 * trong THAN phan hoi (`"db":"up"|"down"`).
 *
 * Vi sao: healthcheck cua compose dung endpoint nay de quyet dinh container co
 * `healthy` khong. Neu mat DB ma tra 503 thi container thanh unhealthy -> restart
 * -> mat hang doi trong RAM -> task mo coi. Ma mat DB la trang thai Gateway PHAI
 * song sot duoc (AC-20): no van nhan lenh, van cho Abort chay, chi tu choi cac
 * thao tac can DB.
 *
 * He qua: KHONG duoc dung "healthz tra 200" lam bang chung deploy thanh cong —
 * §37.5.3 ghi ro phai kiem chuoi `"db":"up"`.
 */
import { createServer, type Server } from 'node:http';

export interface HealthState {
  db: 'up' | 'down';
  botDangPolling: boolean;
  batDau: Date;
}

export function bodyHealth(state: HealthState, now: Date = new Date()): string {
  return JSON.stringify({
    status: 'ok',
    db: state.db,
    bot: state.botDangPolling ? 'polling' : 'stopped',
    uptime_s: Math.floor((now.getTime() - state.batDau.getTime()) / 1000),
  });
}

export function startHealthServer(port: number, layTrangThai: () => HealthState): Server {
  const server = createServer((req, res) => {
    if (req.url !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(bodyHealth(layTrangThai()));
  });
  server.listen(port, '127.0.0.1');
  return server;
}
