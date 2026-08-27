/**
 * Kiem tra khung ACP cua zed-acp-bridge/bridge.mjs, khong dung toi opencode-server
 * that (chi test "initialize" — buoc duy nhat khong goi HTTP ra ngoai).
 *
 * Cac buoc con lai (session/new, session/prompt) can goi that toi opencode-server
 * nen KHONG test o day — xem huong dan "Chay thu doc lap" trong
 * zed-acp-bridge/README.md.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, '..', 'zed-acp-bridge', 'bridge.mjs');

function chayBridge(dong: string, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('node', [BRIDGE], {
      env: {
        ...process.env,
        OPENCODE_URL: 'https://khong-dung-toi.invalid',
        OPENCODE_SERVER_PASSWORD: 'test',
      },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error(`timeout, stderr: ${err}`));
    }, timeoutMs);
    p.stdout.on('data', (d) => {
      out += d.toString('utf8');
      if (out.includes('\n')) {
        clearTimeout(timer);
        p.kill();
        resolve(out);
      }
    });
    p.stderr.on('data', (d) => {
      err += d.toString('utf8');
    });
    p.on('error', reject);
    p.stdin.write(`${dong}\n`);
  });
}

describe('zed-acp-bridge initialize', () => {
  it('tra loi initialize ma khong goi HTTP', async () => {
    const raw = await chayBridge(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }),
    );
    const msg = JSON.parse(raw.trim().split('\n')[0]!);
    expect(msg.id).toBe(1);
    expect(msg.result?.agentCapabilities).toBeDefined();
  });

  it('bao loi -32601 cho method khong ho tro', async () => {
    const raw = await chayBridge(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'khong-ton-tai', params: {} }),
    );
    const msg = JSON.parse(raw.trim().split('\n')[0]!);
    expect(msg.error?.code).toBe(-32601);
  });
});
