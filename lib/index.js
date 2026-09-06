// huahua-dsh-chatroom kit plugin (loader row id: dsh-chatroom-kit).
//
// Responsibilities, all running in the host process when the row activates:
//   1. dsh-weave Fix1–Fix4 patch guard (see ./patch-guard.js, kept in sync with
//      patches/patch-weave.ps1): on start, detect missing fixes in the installed
//      dsh-weave lib/index.js and re-apply them (backup + node --check). The
//      running weave module was already loaded, so a write always warns "restart
//      to take effect".
//   2. Two agent tools: chatroom_patch_status / chatroom_patch_apply.
//   3. Host RPC /dsh-chatroom (status | patch), authority trusted-host.
// This bundle never registers chat_* tools nor inserts the dsh-chat/dsh-weave/
// dsh-bridge loader rows — the kit assumes those bundles are installed first.
//
// Cordis note: ctx.get(name) throws for services that are not in this plugin's
// `inject` list (that is exactly the rc.14 bug Fix1 wraps). The chat trio is
// deliberately NOT injected (a hard inject would make this kit pend forever on
// profiles without the trio); presence is probed at install level instead.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import Schema from "@deepseek-ai/schemastery";
import { applyPatch, detectPatchStatus } from "./patch-guard.js";
import { FileServer, DEFAULT_FILE_PORT } from "./file-server.js";
import { formatFileMsg, chatFileUrl } from "./file-msg.js";

export const name = "huahua-dsh-chatroom";
export const Config = Schema.object({
  weaveIndex: Schema.string().description("dsh-weave lib/index.js to guard. Default: <DSH_HOME|~/.dsh>/profiles/web/node_modules/dsh-weave/lib/index.js."),
  dataDir: Schema.string().description("Kit data directory (default ~/.dsh/chatroom); stores the last guard-run summary JSON."),
  // R1 file transfer L1 (route A) — see docs/FILE-TRANSFER-L1.md
  filePort: Schema.number().description("R1 attachment file server port (default 3090)."),
  fileBindHost: Schema.string().description("R1 file server bind host (default 0.0.0.0; use 127.0.0.1 for local-only tests)."),
  fileAttachmentsRoot: Schema.string().description("R1 attachments root (default <DSH_HOME>/.dsh/dsh-chat/attachments)."),
  fileMaxBytes: Schema.number().description("R1 max upload size in bytes (default 200MB)."),
  filePublicBase: Schema.string().description("R1 对外公开 URL 基址（默认 http://127.0.0.1:<port>；跨机请设如 http://192.168.1.3:3090，消息里 URL 才会被其它机器可达）.")
});
export const inject = ["connection", "tools"];

const PROFILE = "web";
const BACKUP_SUFFIX = ".bak-chatroom";
const SUMMARY_FILE = "patch-guard.json";
const CHAT_TRIO = [
  { package: "dsh-weave", file: "lib/index.js", service: "dshWeave" },
  { package: "dsh-bridge", file: "lib/index.js", service: "dshBridge" },
  { package: "dsh-chat", file: "lib/index.js", service: "dshChat" }
];

function expandHome(value) {
  if (!value || value === "~") return homedir();
  return (value.startsWith("~/") || value.startsWith("~\\")) ? join(homedir(), value.slice(2)) : value;
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function profileDir() {
  return join(dshHome(), "profiles", PROFILE);
}

function resolveWeaveIndex(config) {
  if (config?.weaveIndex) return expandHome(config.weaveIndex);
  return join(profileDir(), "node_modules", "dsh-weave", "lib", "index.js");
}

function resolveDataDir(config) {
  return config?.dataDir ? expandHome(config.dataDir) : join(dshHome(), "chatroom");
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function syntaxCheckOk(file) {
  const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  return check.status === 0;
}

function makeLogger(ctx) {
  const logger = ctx?.logger;
  return {
    info: (...args) => logger?.info?.(...args),
    warn: (...args) => logger?.warn?.(...args),
    error: (...args) => logger?.error?.(...args)
  };
}

/**
 * Run one guard pass. write=false only inspects; write=true may back up and
 * rewrite the target (idempotent: no-op when every marker is present).
 */
async function guardOnce(ctx, config, write) {
  const logger = makeLogger(ctx);
  const target = resolveWeaveIndex(config);
  const result = {
    target,
    exists: false,
    fixes: [],
    changed: false,
    applied: [],
    warnings: [],
    backup: undefined,
    needsRestart: false,
    syntax: undefined
  };
  let source;
  try {
    source = await readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      result.exists = false;
      result.warnings.push({ id: "target", reason: `file not found: ${target} — dsh-weave not installed in profile '${PROFILE}'?` });
      return result;
    }
    throw error;
  }
  result.exists = true;
  result.fixes = detectPatchStatus(source);
  if (result.fixes.every((fix) => fix.applied)) {
    logger.info(`dsh-weave patch guard: all fixes present (${target})`);
    return result;
  }
  if (!write) return result;

  const backup = `${target}${BACKUP_SUFFIX}`;
  if (!(await exists(backup))) {
    await copyFile(target, backup);
    result.backup = backup;
  }
  const outcome = applyPatch(source);
  if (outcome.changed) {
    await writeFile(target, outcome.source, "utf8");
    result.syntax = syntaxCheckOk(target) ? "ok" : "failed";
    result.changed = true;
    result.applied = outcome.applied;
    result.warnings = outcome.warnings;
    result.needsRestart = true; // the running weave module was loaded from the pre-patch bytes
    result.fixes = detectPatchStatus(outcome.source);
    await persistSummary(config, result).catch(() => { /* summary is best-effort */ });
    logger.warn(`dsh-weave patch guard: applied [${outcome.applied.join(", ")}] to ${target} — restart DSH for the new weave code to take effect (backup: ${backup})`);
    if (result.syntax === "failed") logger.error(`dsh-weave patch guard: node --check FAILED after write; restore ${backup} if startup breaks`);
  } else {
    result.warnings = outcome.warnings;
    for (const warn of outcome.warnings) logger.warn(`dsh-weave patch guard: ${warn.id} — ${warn.reason}`);
  }
  return result;
}

async function persistSummary(config, result) {
  const dir = resolveDataDir(config);
  await mkdir(dir, { recursive: true });
  const summary = {
    ts: new Date().toISOString(),
    target: result.target,
    changed: result.changed,
    applied: result.applied,
    missing: result.fixes.filter((fix) => !fix.applied).map((fix) => fix.id),
    warnings: result.warnings,
    needsRestart: result.needsRestart,
    backup: result.backup ?? undefined
  };
  await writeFile(join(dir, SUMMARY_FILE), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

const fixesOutput = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      target: { type: "string", required: true },
      exists: { type: "boolean", required: true },
      fixes: {
        type: "array", required: true,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", required: true },
            label: { type: "string", required: true },
            applied: { type: "boolean", required: true }
          }
        }
      },
      changed: { type: "boolean", required: true },
      applied: { type: "array", items: { type: "string" } },
      warnings: {
        type: "array",
        items: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, reason: { type: "string" } } }
      },
      needsRestart: { type: "boolean", required: true }
    }
  },
  render: (_args, value) => {
    if (!value.exists) return [{ type: "text", text: `dsh-weave target not found: ${value.target}` }];
    const lines = value.fixes.map((fix) => `${fix.id}: ${fix.applied ? "applied" : "missing"}`);
    if (value.changed) lines.push(`patched [${value.applied.join(", ")}] — restart DSH to take effect`);
    else lines.push("nothing to patch (all fixes present)");
    return [{ type: "text", text: lines.join("\n") }];
  }
};


// ---------------------------------------------------------------------------
// R1 file transfer L1 (route A) — agent-side helpers (docs/FILE-TRANSFER-L1.md)
// ---------------------------------------------------------------------------

function fileServerBaseUrl(config) {
  const port = Number(config?.filePort ?? DEFAULT_FILE_PORT);
  return 'http://127.0.0.1:' + port;
}

/** 对外可达 URL 基址：config.filePublicBase 优先（跨机），否则回退本机 loopback。 */
function publicFileBaseUrl(config) {
  const custom = config?.filePublicBase ? String(config.filePublicBase).trim() : '';
  return custom ? custom.replace(/\/+$/, '') : fileServerBaseUrl(config);
}

async function uploadFileToServer(config, filePath, roomId) {
  const base = fileServerBaseUrl(config);
  const buf = await readFile(filePath);
  const fd = new FormData();
  fd.append('file', new Blob([buf]), basename(filePath));
  const res = await fetch(base + '/chat-file/upload?room=' + encodeURIComponent(String(roomId)), { method: 'POST', body: fd });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('file server upload failed: ' + (payload.error || ('HTTP ' + res.status)));
  return payload;
}

async function fetchFileToDisk(config, url, saveDir) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('file fetch failed: HTTP ' + res.status);
  const expected = res.headers.get('x-sha256');
  const buf = Buffer.from(await res.arrayBuffer());
  const hash = createHash('sha256').update(buf).digest('hex');
  if (expected && hash !== expected) throw new Error('sha256 mismatch (expected ' + expected + ', got ' + hash + ')');
  const targetDir = saveDir || join(dshHome(), 'dsh-chat', 'downloads');
  await mkdir(targetDir, { recursive: true });
  const idFromUrl = String(url).split('/chat-file/')[1]?.split(/[?/]/)[0] || String(Date.now());
  const targetPath = join(targetDir, idFromUrl);
  await writeFile(targetPath, buf);
  return { path: targetPath, size: buf.length, sha256: hash || expected || undefined, url };
}

async function fileUploadAction(ctx, config, args) {
  try {
    const filePath = String(args?.filePath || '');
    const roomId = String(args?.roomId || '');
    if (!filePath) return { ok: false, message: 'filePath is required' };
    if (!roomId) return { ok: false, message: 'roomId is required (query of the room the file belongs to)' };
    const meta = await uploadFileToServer(config, filePath, roomId);
    // 跨机可达 URL：filePublicBase 覆盖服务器按请求 Host 回填的 loopback URL
    meta.url = chatFileUrl(publicFileBaseUrl(config), meta.id, roomId);
    const line = formatFileMsg({ name: meta.name, size: meta.size, url: meta.url });
    makeLogger(ctx).info('[huahua-dsh-chatroom] file uploaded: ' + meta.url);
    return { ok: true, message: line, url: meta.url, name: meta.name, size: meta.size, sha256: meta.sha256, roomId: meta.roomId };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) };
  }
}

async function fileFetchAction(ctx, config, args) {
  try {
    const url = String(args?.url || '');
    const saveDir = args?.saveDir ? String(args.saveDir) : undefined;
    if (!/^https?:\/\//.test(url)) return { ok: false, message: 'url is required (http/https chat-file url)' };
    const out = await fetchFileToDisk(config, url, saveDir);
    makeLogger(ctx).info('[huahua-dsh-chatroom] file fetched to ' + out.path);
    return { ok: true, message: 'downloaded to ' + out.path + ' (size=' + out.size + ', sha256=' + out.sha256 + ')', path: out.path, size: out.size, sha256: out.sha256, url };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) };
  }
}

const fileActionResultSchema = (extraFields) => ({
  type: 'object',
  additionalProperties: false,
  properties: Object.assign({
    ok: { type: 'boolean', required: true },
    message: { type: 'string', required: true },
  }, extraFields),
});

function textOutput() {
  return { schema: fileActionResultSchema({}), render: (_args, value) => [{ type: 'text', text: value.message || (value.ok ? 'ok' : 'failed') }] };
}

/** Host entrypoint. */
/** Host entrypoint. */
export function apply(ctx, config = {}) {
  const disposers = [];
  ctx.effect(() => async () => {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* registry disposers are best-effort on teardown */ }
    }
  });
  const logger = makeLogger(ctx);

  // ① start-time patch guard (fire-and-forget; failures surface via logger)
  void guardOnce(ctx, config, true).catch((error) => logger.error(`dsh-weave patch guard failed: ${String(error?.message ?? error)}`));

  // ② agent tools
  const statusDisposer = ctx.tools.register(defineTool({
    name: "chatroom_patch_status",
    description: "Report whether the installed dsh-weave carries the Fix1-Fix4 adapter patches (marker-level status per fix). Use to diagnose weave room history/delivery issues or before reporting a weave bug.",
    parameters: {},
    output: fixesOutput,
    async execute() { return guardOnce(ctx, config, false); }
  }));
  if (typeof statusDisposer === "function") disposers.push(statusDisposer);

  const applyDisposer = ctx.tools.register(defineTool({
    name: "chatroom_patch_apply",
    description: "Run the dsh-weave Fix1-Fix4 patch guard now: backs up lib/index.js (once), applies any missing fixes and runs node --check. A changed result requires a DSH restart to take effect. Idempotent.",
    parameters: {},
    output: fixesOutput,
    async execute() { return guardOnce(ctx, config, true); }
  }));
  if (typeof applyDisposer === "function") disposers.push(applyDisposer);

  const uploadDisposer = ctx.tools.register(defineTool({
    name: "chatroom_file_upload",
    description: "R1: 上传本地文件到聊天室附件服务并生成规范消息文本 [文件] name (size) url。filePath 本地绝对路径；roomId 房间标识（必填）。返回可直接发进房间的消息行。",
    parameters: {
      filePath: { type: "string", required: true, description: "本地文件绝对路径" },
      roomId: { type: "string", required: true, description: "房间标识（必填）" }
    },
    output: textOutput(),
    async execute(args) { const r = await fileUploadAction(ctx, config, args); return { ok: r.ok, message: r.message }; }
  }));
  if (typeof uploadDisposer === "function") disposers.push(uploadDisposer);

  const fetchDisposer = ctx.tools.register(defineTool({
    name: "chatroom_file_fetch",
    description: "R1: 从房间附件 url 下载文件到本地并校验 sha256（对照 X-SHA256 响应头）。url 为 http(s)://…/chat-file/<id>?room=…；saveDir 可选。",
    parameters: {
      url: { type: "string", required: true, description: "附件 url（http/https）" },
      saveDir: { type: "string", description: "可选保存目录（默认 ~/.dsh/dsh-chat/downloads）" }
    },
    output: textOutput(),
    async execute(args) { const r = await fileFetchAction(ctx, config, args); return { ok: r.ok, message: r.message }; }
  }));
  if (typeof fetchDisposer === "function") disposers.push(fetchDisposer);

  // ③ host RPC (UI can reuse the same operations + R1 file upload/fetch)
  const handlers = {
    status: () => guardOnce(ctx, config, false),
    patch: () => guardOnce(ctx, config, true),
    "file-upload": (payload) => fileUploadAction(ctx, config, payload),
    "file-fetch": (payload) => fileFetchAction(ctx, config, payload)
  };
  const rpcDisposer = ctx.connection.rpc.handle("/dsh-chatroom", async (endpoint, payload) => {
    if (!(endpoint in handlers)) throw new Error(`unknown dsh-chatroom endpoint: ${endpoint}`);
    return { ok: true, value: await handlers[endpoint](payload) };
  }, { authority: "trusted-host" });
  if (typeof rpcDisposer === "function") disposers.push(rpcDisposer);

  // ⑤ R1 file transfer L1 (route A): host-side attachment file server (docs/FILE-TRANSFER-L1.md)
  const fileServer = new FileServer({
    port: config.filePort ?? DEFAULT_FILE_PORT,
    bindHost: config.fileBindHost ?? "0.0.0.0",
    attachmentsRoot: config.fileAttachmentsRoot ? expandHome(config.fileAttachmentsRoot) : join(dshHome(), "dsh-chat", "attachments"),
    maxFileBytes: config.fileMaxBytes
  });
  void fileServer.start()
    .then(() => logger.info(`[huahua-dsh-chatroom] R1 file server listening on http://${fileServer.bindHost}:${fileServer.port} (attachments root: ${fileServer.root}) — remember to allow TCP ${fileServer.port} in the host firewall (spec §4.5)`))
    .catch((error) => logger.error(`[huahua-dsh-chatroom] R1 file server failed to start: ${String(error?.message ?? error)}`));
  disposers.push(() => void fileServer.stop().catch(() => {}));

  // ④ install-level probe of the chat trio (see Cordis note at the top)
  const modulesDir = join(profileDir(), "node_modules");
  for (const item of CHAT_TRIO) {
    void exists(join(modulesDir, item.package, item.file)).then((present) => {
      if (!present) logger.warn(`huahua-dsh-chatroom: ${item.package} not installed in profile '${PROFILE}' — install the chat trio first so ${item.service} is active (see README install sequence).`);
    });
  }
}
