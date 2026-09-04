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
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import Schema from "@deepseek-ai/schemastery";
import { applyPatch, detectPatchStatus } from "./patch-guard.js";

export const name = "huahua-dsh-chatroom";
export const Config = Schema.object({
  weaveIndex: Schema.string().description("dsh-weave lib/index.js to guard. Default: <DSH_HOME|~/.dsh>/profiles/web/node_modules/dsh-weave/lib/index.js."),
  dataDir: Schema.string().description("Kit data directory (default ~/.dsh/chatroom); stores the last guard-run summary JSON.")
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

  // ③ host RPC (UI can reuse the same two operations)
  const handlers = {
    status: () => guardOnce(ctx, config, false),
    patch: () => guardOnce(ctx, config, true)
  };
  const rpcDisposer = ctx.connection.rpc.handle("/dsh-chatroom", async (endpoint) => {
    if (!(endpoint in handlers)) throw new Error(`unknown dsh-chatroom endpoint: ${endpoint}`);
    return { ok: true, value: await handlers[endpoint]() };
  }, { authority: "trusted-host" });
  if (typeof rpcDisposer === "function") disposers.push(rpcDisposer);

  // ④ install-level probe of the chat trio (see Cordis note at the top)
  const modulesDir = join(profileDir(), "node_modules");
  for (const item of CHAT_TRIO) {
    void exists(join(modulesDir, item.package, item.file)).then((present) => {
      if (!present) logger.warn(`huahua-dsh-chatroom: ${item.package} not installed in profile '${PROFILE}' — install the chat trio first so ${item.service} is active (see README install sequence).`);
    });
  }
}
