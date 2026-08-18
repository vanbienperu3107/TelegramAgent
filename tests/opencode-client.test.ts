/**
 * Hop dong cua client OpenCode va bo tach khung SSE.
 *
 * Cac test nay khang dinh dung nhung dieu PHEP DO da chi ra, nen khi OpenCode
 * doi hanh vi thi cho nay do — thay vi bot im lang lam sai.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import type { Config } from '../src/config.js';
import { LoiOpenCode, OpenCodeClient, sinhMessageId } from '../src/services/opencode-client.js';
import { LOAI_QUAN_TAM, tachKhungSSE } from '../src/services/event-stream.js';

const cfg = {
  OPENCODE_URL: 'http://opencode-server:4096',
  OPENCODE_SERVER_PASSWORD: 'mat-khau-thu',
  OPENCODE_EVENT_PATH: '/event',
  OPENCODE_HEALTH_PATH: '/global/health',
  DEFAULT_PROVIDER: 'cliproxy',
  DEFAULT_MODEL: 'claude-opus-5',
  DEFAULT_AGENT: 'build',
} as unknown as Config;

function traLoi(du_lieu: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(du_lieu), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('xac thuc', () => {
  it('dung HTTP Basic chu khong phai Bearer', async () => {
    // Da do ca ba cach tren server that: Bearer -> 401, tieu de rieng -> 401,
    // Basic -> 200. Neu ai doi sang Bearer cho "gon" thi test nay do.
    const fetchGia = vi.fn().mockResolvedValue(traLoi([]));
    vi.stubGlobal('fetch', fetchGia);
    await new OpenCodeClient(cfg).dsAgent();
    const tieuDe = fetchGia.mock.calls[0]![1].headers as Record<string, string>;
    const mong = `Basic ${Buffer.from('opencode:mat-khau-thu').toString('base64')}`;
    expect(tieuDe.authorization).toBe(mong);
    vi.unstubAllGlobals();
  });
});

describe('guiPrompt', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(traLoi(null, 204))));
  afterEach(() => vi.unstubAllGlobals());

  it('tu sinh messageID va gui kem, vi phan hoi 204 khong co than', async () => {
    // Day la ly do ky thuat, khong phai so thich: khong tu sinh thi khong co
    // cach nao tuong quan lenh gui voi su kien nhan.
    const id = await new OpenCodeClient(cfg).guiPrompt({ sessionID: 'ses_1', van: 'chao' });
    expect(id).toMatch(/^msg/);
    const than = JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
    expect(than.messageID).toBe(id);
  });

  it('luon gui parts — truong bat buoc duy nhat theo dac ta', async () => {
    await new OpenCodeClient(cfg).guiPrompt({ sessionID: 'ses_1', van: 'chao' });
    const than = JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
    expect(than.parts).toEqual([{ type: 'text', text: 'chao' }]);
    expect(than.model).toEqual({ providerID: 'cliproxy', modelID: 'claude-opus-5' });
  });

  it('messageID sinh ra khong trung nhau', () => {
    const bo = new Set(Array.from({ length: 500 }, () => sinhMessageId()));
    expect(bo.size).toBe(500);
  });
});

describe('vanTraLoiCuoi', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lay message assistant CUOI CUNG chu khong phai dau tien', async () => {
    // Mot luot co dung tool sinh HAI message assistant. Lay nham cai dau thi
    // nguoi dung nhan doan van do dang truoc khi tool chay — da thay dieu do
    // trong phep do that.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        traLoi([
          { info: { role: 'user' }, parts: [{ type: 'text', text: 'cau hoi' }] },
          { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'de toi xem thu muc' }] },
          {
            info: { role: 'assistant' },
            parts: [
              { type: 'step-start' },
              { type: 'text', text: 'Co 7 file.' },
              { type: 'step-finish' },
            ],
          },
        ]),
      ),
    );
    expect(await new OpenCodeClient(cfg).vanTraLoiCuoi('ses_1')).toBe('Co 7 file.');
  });

  it('tra chuoi rong khi chua co cau tra loi, khong nem loi', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(traLoi([])));
    expect(await new OpenCodeClient(cfg).vanTraLoiCuoi('ses_1')).toBe('');
  });
});

describe('loi HTTP', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('giu lai ma trang thai de ben tren phan biet 401 voi 5xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('sai mat khau', { status: 401 })));
    await expect(new OpenCodeClient(cfg).dsAgent()).rejects.toBeInstanceOf(LoiOpenCode);
    await expect(new OpenCodeClient(cfg).dsAgent()).rejects.toMatchObject({ status: 401 });
  });

  it('khoe() tra false thay vi nem, de vong doi khoi dong khong chet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('mang hong')));
    expect(await new OpenCodeClient(cfg).khoe()).toBe(false);
  });
});

describe('tach khung SSE', () => {
  it('doc duoc khung day du', () => {
    const { suKien } = tachKhungSSE(
      'data: {"id":"e1","type":"session.idle","properties":{"sessionID":"ses_1"}}\n\n',
    );
    expect(suKien).toHaveLength(1);
    expect(suKien[0]!.type).toBe('session.idle');
  });

  it('GIU LAI khung bi cat giua chung thay vi vut di', () => {
    // message.part.delta den theo tung token nen la loai de bi cat nhat o ranh
    // gioi goi tin. Vut phan du = mat chu giua cau tra loi.
    const a = tachKhungSSE('data: {"type":"message.part.delta","prope');
    expect(a.suKien).toHaveLength(0);
    const b = tachKhungSSE(a.du + 'rties":{"delta":"xin"}}\n\n');
    expect(b.suKien[0]!.properties).toEqual({ delta: 'xin' });
  });

  it('mot khung hong khong lam chet ca luong', () => {
    const { suKien } = tachKhungSSE(
      'data: {khong-phai-json\n\ndata: {"type":"session.idle"}\n\n',
    );
    expect(suKien).toHaveLength(1);
    expect(suKien[0]!.type).toBe('session.idle');
  });

  it('chap nhan CRLF', () => {
    const { suKien } = tachKhungSSE('data: {"type":"server.heartbeat"}\r\n\r\n');
    expect(suKien).toHaveLength(1);
  });
});

describe('danh sach trang su kien', () => {
  it('phu du cac loai mang thong tin ma phep do quan sat duoc', () => {
    for (const t of [
      'session.created',
      'session.status',
      'session.idle',
      'session.diff',
      'message.updated',
      'message.part.updated',
      'message.part.delta',
      'permission.asked',
      'permission.replied',
    ]) {
      expect(LOAI_QUAN_TAM.has(t)).toBe(true);
    }
  });

  it('bo qua nhieu — plugin.added chiem 41% so su kien do duoc', () => {
    for (const t of ['plugin.added', 'catalog.updated', 'reference.updated', 'integration.updated']) {
      expect(LOAI_QUAN_TAM.has(t)).toBe(false);
    }
  });
});
