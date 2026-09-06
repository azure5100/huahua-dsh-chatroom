import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileServer } from '../lib/file-server.js';

let srv; let root; let base;
const h = (b) => createHash('sha256').update(b).digest('hex');

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'huahua-fs-'));
  srv = new FileServer({ port: 0, bindHost: '127.0.0.1', attachmentsRoot: root });
  await srv.start();
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
after(async () => { await srv.stop(); await rm(root, { recursive: true, force: true }); });

async function upload(buf, name, room) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), name);
  const r = await fetch(`${base}/chat-file/upload?room=${room}`, { method: 'POST', body: fd });
  return { status: r.status, json: await r.json() };
}

test('upload small -> 200 with meta', async () => {
  const buf = randomBytes(1500);
  const up = await upload(buf, '测试 报告.pdf', 'roomA');
  assert.equal(up.status, 200);
  assert.ok(up.json.id && up.json.size === buf.length && up.json.sha256 === h(buf) && up.json.roomId === 'roomA');
  assert.ok(typeof up.json.url === 'string' && up.json.url.includes('/chat-file/'));
  const dl = await fetch(up.json.url);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('x-sha256'), h(buf));
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(buf));
  assert.ok((dl.headers.get('content-disposition') || '').includes('filename*=UTF-8'));
});

test('HEAD returns headers without body', async () => {
  const buf = randomBytes(64);
  const up = await upload(buf, 'h.bin', 'roomA');
  const hd = await fetch(up.json.url, { method: 'HEAD' });
  assert.equal(hd.status, 200);
  assert.equal(Number(hd.headers.get('content-length')), 64);
  assert.equal(hd.headers.get('x-sha256'), h(buf));
});

test('>1MB roundtrip sha256', async () => {
  const big = randomBytes(1572864);
  const up = await upload(big, 'big.bin', 'roomA');
  assert.equal(up.status, 200);
  const dl = await fetch(up.json.url);
  assert.equal(h(Buffer.from(await dl.arrayBuffer())), h(big));
});

test('error branches: 404/400/405', async () => {
  const nf = await fetch(`${base}/chat-file/nope?room=roomA`);
  assert.equal(nf.status, 404);
  const nup = await fetch(`${base}/chat-file/upload`);
  assert.equal(nup.status, 400);
  const up = await upload(randomBytes(8), 'm.bin', 'roomA');
  const meth = await fetch(up.json.url, { method: 'PUT' });
  assert.equal(meth.status, 405);
});

test('manifest persisted atomically', async () => {
  const buf = randomBytes(8);
  await upload(buf, 'm2.bin', 'roomA');
  const mani = JSON.parse(await readFile(join(root, 'roomA', 'manifest.json'), 'utf8'));
  assert.ok(Array.isArray(mani) && mani.length >= 3);
  assert.ok(!existsSync(join(root, 'roomA', 'manifest.json.tmp')));
});