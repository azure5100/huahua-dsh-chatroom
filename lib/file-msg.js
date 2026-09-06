// huahua-dsh-chatroom · R1 file transfer L1 (route A) — pure message helpers.
// Spec docs/FILE-TRANSFER-L1.md §3/§5: message line format
//   [文件] 名称 (大小) <url>   (url 为裸 http(s)://…/chat-file/<id>…，可加 < > 包裹容错)

/** URL 集合：房间附件 url（http(s)://…/chat-file/…），容忍 < > 包裹与行内其它文本。 */
export function extractFileUrls(text) {
  if (typeof text !== 'string' || !text) return [];
  const urls = [];
  const re = /https?:\/\/[^\s<>"']+/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const u = m[0].replace(/[>"']+$/, '');
    if (u.includes('/chat-file/')) urls.push(u);
  }
  return urls;
}

const SIZE_RE = /\(\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)\s*\)/i;

/** 把 size 字节数格式化为展示文本（如 2.3MB / 512KB / 30B）。 */
export function formatBytes(n) {
  if (!Number.isFinite(Number(n)) || Number(n) < 0) return '';
  const v = Number(n);
  if (v < 1024) return `${v}B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v;
  let u = -1;
  while (x >= 1024 && u < units.length - 1) { x /= 1024; u += 1; }
  const s = x >= 100 ? Math.round(x) : Math.round(x * 10) / 10;
  return `${s}${units[u]}`;
}

function parseSize(label) {
  const units = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  const m = SIZE_RE.exec(label || '');
  if (!m) return null;
  return Math.round(Number(m[1]) * units[m[2].toUpperCase()]);
}

/**
 * 解析一行消息文本为文件引用。
 * @returns {{name:string,size:number|null,sizeLabel:string|null,url:string|null}|null} 行首非 [文件] 返回 null
 */
export function parseFileMsgLine(line) {
  const text = typeof line === 'string' ? line.trim() : '';
  if (!/^\[文件\]/.test(text)) return null;
  const urls = extractFileUrls(text);
  const sizeM = SIZE_RE.exec(text);
  let name = text.replace(/^\[文件\]\s*/, '');
  if (sizeM) {
    const at = name.lastIndexOf('(');
    if (at > 0) name = name.slice(0, at).trim();
  }
  if (urls.length) {
    const at = name.indexOf(urls[0]);
    if (at >= 0) name = name.slice(0, at).trim();
  }
  name = name.replace(/[<>\[\]]/g, '').trim();
  return {
    name: name || 'file',
    size: sizeM ? parseSize(sizeM[0]) : null,
    sizeLabel: sizeM ? sizeM[0].replace(/[\(\)]/g, '') : null,
    url: urls[0] ?? null,
  };
}

/**
 * 生成规范消息行。meta: { name, size, url }
 */
export function formatFileMsg(meta) {
  const name = String(meta?.name ?? 'file');
  const size = formatBytes(Number(meta?.size) || 0);
  const url = String(meta?.url ?? '');
  const parts = [`[文件] ${name}`];
  if (size) parts.push(`(${size})`);
  if (url) parts.push(url);
  return parts.join(' ');
}