import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFileUrls, formatFileMsg, parseFileMsgLine, formatBytes, chatFileUrl } from '../lib/file-msg.js';

test('formatFileMsg canonical + roundtrip', () => {
  const meta = { name: '报告.pdf', size: 2411724, url: 'http://192.168.1.3:3090/chat-file/abc123?room=roomA' };
  const line = formatFileMsg(meta);
  assert.ok(line.startsWith('[文件] 报告.pdf (2.3MB)'), line);
  const parsed = parseFileMsgLine(line);
  assert.equal(parsed.name, '报告.pdf');
  assert.ok(Math.abs(parsed.size - 2411724) < 3, 'size approx 2.3MB, got ' + parsed.size);
  assert.equal(parsed.url, meta.url);
});

test('parseFileMsgLine KB/B & bare url (no angle brackets)', () => {
  const p1 = parseFileMsgLine('[文件] notes.txt (512KB) http://h:3090/chat-file/x1?room=r');
  assert.equal(p1.name, 'notes.txt');
  assert.equal(p1.size, 512 * 1024);
  const p2 = parseFileMsgLine('[文件] tiny (30B) http://h:3090/chat-file/x2?room=r');
  assert.equal(p2.size, 30);
  assert.ok(p1.url.includes('/chat-file/x1'));
});

test('parse tolerates angle-bracket wrapped url & extra text', () => {
  const p = parseFileMsgLine('[文件] 报告.pdf (2.3MB) <http://h:3090/chat-file/a1?room=r>');
  assert.equal(p.name, '报告.pdf');
  assert.equal(p.url, 'http://h:3090/chat-file/a1?room=r');
});

test('extractFileUrls multi-line returns all chat-file urls only', () => {
  const text = '我发了两个文件：\n[文件] a.bin (1MB) http://h:3090/chat-file/aa?room=r\n[文件] b.txt (2KB) http://h:3090/chat-file/bb?room=r\n外部链接 https://example.com/x 不算';
  const urls = extractFileUrls(text);
  assert.equal(urls.length, 2);
  assert.ok(urls[0].includes('/chat-file/aa'));
  assert.ok(urls[1].includes('/chat-file/bb'));
  assert.ok(!urls.some((u) => u.includes('example.com')));
});

test('malformed returns null / empty', () => {
  assert.equal(parseFileMsgLine('普通文本没有文件'), null);
  assert.equal(parseFileMsgLine(''), null);
  assert.deepEqual(extractFileUrls('no urls here'), []);
});

test('formatBytes labels', () => {
  assert.equal(formatBytes(30), '30B');
  assert.equal(formatBytes(512 * 1024), '512KB');
  assert.equal(formatBytes(2411724), '2.3MB');
  assert.equal(formatBytes(0), '0B');
});

test('chatFileUrl builds cross-machine url from public base', () => {
  const u = chatFileUrl('http://192.168.1.3:3090/', 'abc123', 'room A/1');
  assert.equal(u, 'http://192.168.1.3:3090/chat-file/abc123?room=room%20A%2F1');
  assert.equal(chatFileUrl('http://h:1', 'x', 'r'), 'http://h:1/chat-file/x?room=r');
});

test('name containing parentheses survives parse', () => {
  const line = formatFileMsg({ name: '年报(2026).pdf', size: 1024, url: 'http://h:3090/chat-file/z9?room=r' });
  const p = parseFileMsgLine(line);
  assert.equal(p.name, '年报(2026).pdf');
  assert.equal(p.size, 1024);
});