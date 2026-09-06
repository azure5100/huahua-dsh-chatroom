// huahua-dsh-chatroom · R1 file transfer L1 — host-side attachment file server (route A).
//
// Zero-dependency Node http server implementing docs/FILE-TRANSFER-L1.md §4:
//   POST /chat-file/upload?room=<roomId>   multipart field "file" -> store + manifest (atomic)
//   GET|HEAD /chat-file/<id>?room=<roomId>  stream file with Content-Length / X-SHA256 / Content-Disposition
// Storage: <attachmentsRoot>/<roomId>/manifest.json + <id> entities.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import http from 'node:http';

export const DEFAULT_FILE_PORT = 3090;
export const DEFAULT_MAX_FILE_BYTES = 200 * 1024 * 1024; // 200MB (spec §4)

const MIME = { '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.zip': 'application/zip', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function cleanIdPart(value, fallback) {
  const safe = String(value || '').replace(/[^A-Za-z0-9_-]/g, '');
  return safe || fallback;
}

function cleanFileName(value) {
  const raw = String(value || '').replace(/^.*[\\/]/, ''); // strip path parts
  const decoded = /%[0-9a-fA-F]{2}/.test(raw) ? (() => { try { return decodeURIComponent(raw); } catch { return raw; } })() : raw;
  const clean = decoded.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
  return clean && clean !== '.' && clean !== '..' ? clean : 'file';
}

function contentTypeFor(name) {
  return MIME[extname(name).toLowerCase()] || 'application/octet-stream';
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function formatSizeBytes(n) {
  return n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)}KB` : `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function manifestPath(root, roomId) {
  return join(root, roomId, 'manifest.json');
}

async function loadManifest(root, roomId) {
  try {
    const raw = await readFile(manifestPath(root, roomId), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // missing/corrupt -> empty index (spec §2); uploads will recreate it
  }
}

async function saveManifest(root, roomId, records) {
  const dir = join(root, roomId);
  await mkdir(dir, { recursive: true });
  const target = manifestPath(root, roomId);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  await rename(tmp, target); // atomic replace (spec §2)
}

/**
 * Minimal multipart/form-data reader (single part name="file" kept).
 * @returns {{ok:boolean, filename?:string, data?:Buffer, error?:string}}
 */
function parseMultipart(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) return { ok: false, error: 'missing multipart boundary' };
  const boundary = `--${(match[1] || match[2]).trim()}`;
  const parts = Buffer.from(boundary).length;
  let cursor = 0;
  let filename;
  let data;
  while (true) {
    const start = body.indexOf(boundary, cursor);
    if (start === -1) break;
    const head = start + parts;
    const headerEnd = body.indexOf('\r\n\r\n', head);
    if (headerEnd === -1) break;
    const headers = body.subarray(head, headerEnd).toString('latin1');
    const contentStart = headerEnd + 4;
    const next = body.indexOf(boundary, contentStart);
    if (next === -1) break;
    // trim trailing CRLF before boundary
    let end = next;
    if (end >= 2 && body[end - 2] === 13 && body[end - 1] === 10) end -= 2;
    const chunk = body.subarray(contentStart, end);
    if (/name="file"/.test(headers)) {
      const fm = /filename\*?=(?:UTF-8''|utf-8'')?"?([^";]+)"?/i.exec(headers);
      filename = fm ? fm[1] : undefined;
      data = chunk;
      break;
    }
    cursor = next;
  }
  if (data === undefined) return { ok: false, error: 'no part with name="file"' };
  return { ok: true, filename: filename ? cleanFileName(filename) : 'file', data };
}

/** R1 host-side file server (route A). Start/stop lifecycle owned by the kit plugin. */
export class FileServer {
  constructor(options = {}) {
    this.port = Number(options.port ?? DEFAULT_FILE_PORT);
    this.bindHost = options.bindHost ?? '0.0.0.0';
    this.root = options.attachmentsRoot ?? join(process.env.DSH_HOME || `${process.env.HOME || process.env.USERPROFILE || ''}\.dsh`, 'dsh-chat', 'attachments');
    this.maxFileBytes = Number(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
    this.server = null;
    this.startedAt = null;
  }

  get listening() { return this.server?.listening ?? false; }

  async start() {
    if (this.listening) return this;
    await mkdir(this.root, { recursive: true });
    this.server = http.createServer((req, res) => this.#handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.bindHost, resolve);
    });
    this.startedAt = new Date().toISOString();
    return this;
  }

  async stop() {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    await new Promise((resolve) => s.close(() => resolve()));
  }

  async #handle(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const method = String(req.method || '').toUpperCase();
      if (method === 'POST' && url.pathname === '/chat-file/upload') return await this.#upload(req, res, url);
      if ((method === 'GET' || method === 'HEAD') && url.pathname.startsWith('/chat-file/')) return await this.#download(req, res, url, method === 'HEAD');
      if (!['GET', 'HEAD', 'POST'].includes(method)) return json(res, 405, { error: 'method not allowed' });
      return json(res, 404, { error: 'not found' });
    } catch (error) {
      json(res, 500, { error: String(error?.message ?? error) });
    }
  }

  async #upload(req, res, url) {
    const roomId = cleanIdPart(url.searchParams.get('room'), '');
    if (!roomId) return json(res, 400, { error: 'room query parameter required' });
    const contentType = req.headers['content-type'] || '';
    const chunks = [];
    let received = 0;
    for await (const chunk of req) {
      received += chunk.length;
      if (received > Math.ceil(this.maxFileBytes * 1.6) + (64 * 1024)) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `payload exceeds ${this.maxFileBytes} byte limit` }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    const parsed = parseMultipart(body, contentType);
    if (!parsed.ok) return json(res, 400, { error: parsed.error });
    if (parsed.data.length > this.maxFileBytes) return json(res, 413, { error: `file exceeds ${this.maxFileBytes} byte limit` });
    const id = randomUUID().replace(/-/g, '');
    const dir = join(this.root, roomId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, id), parsed.data);
    const record = {
      id,
      name: parsed.filename || 'file',
      size: parsed.data.length,
      sha256: sha256Hex(parsed.data),
      roomId,
      uploadedAt: new Date().toISOString(),
    };
    const records = await loadManifest(this.root, roomId);
    records.push(record);
    await saveManifest(this.root, roomId, records);
    const host = req.headers.host || `localhost:${this.port}`;
    record.url = `http://${host}/chat-file/${id}?room=${encodeURIComponent(roomId)}`;
    return json(res, 200, record);
  }

  async #download(req, res, url, headOnly) {
    const roomId = cleanIdPart(url.searchParams.get('room'), '');
    const idPart = url.pathname.slice('/chat-file/'.length).split('/')[0];
    const id = cleanIdPart(idPart, '');
    if (!roomId || !id) return json(res, 400, { error: 'id and room query required' });
    const records = await loadManifest(this.root, roomId);
    const record = records.find((r) => r.id === id && r.roomId === roomId);
    if (!record) return json(res, 404, { error: 'attachment not found' });
    const filePath = join(this.root, roomId, record.id);
    let size;
    try { size = (await stat(filePath)).size; } catch { return json(res, 404, { error: 'attachment file missing on disk' }); }
    const headers = {
      'content-length': String(size),
      'x-sha256': record.sha256,
      'content-type': contentTypeFor(record.name),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(record.name)}`,
    };
    res.writeHead(200, headers);
    if (headOnly) return res.end();
    await new Promise((resolve, reject) => {
      const stream = createReadStream(filePath);
      stream.on('error', reject);
      res.on('close', () => stream.destroy());
      stream.pipe(res).on('finish', resolve);
    });
  }
}

export const _internal = { parseMultipart, cleanFileName, formatSizeBytes, sha256Hex, loadManifest, saveManifest, manifestPath };