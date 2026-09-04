// Pure dsh-weave Fix1–Fix4 patch-guard logic.
//
// Markers and replacement strings are kept in sync with the repository's
// patches/patch-weave.ps1 (the source of truth for the four-in-one patch):
//   Fix1   #dispatch dshBridge access wrapped in try/catch
//   Fix2   Endpoint bound to a fixed UDP port (DSH_WEAVE_PORT env override)
//   Fix3/4 MAX_FRAME_BYTES raised 64KB→1MB→4MB
//   Fix3b  ack readToEnd(4096) → readToEnd(MAX_FRAME_BYTES)
// This module is dependency-free so it can be unit-tested with `node --test`
// without any @deepseek-ai peer packages installed.

/** Per-fix marker + replacement rule. `marker` proves the fix is present. */
export const FIXES = [
  {
    id: "fix1",
    label: "Fix1 dshBridge try/catch",
    marker: "try { bridge = this.ctx?.dshBridge",
    kind: "replace",
    old: '      const bridge = this.ctx?.dshBridge ?? this.ctx?.get?.("dshBridge");',
    new: "      let bridge;\n      try { bridge = this.ctx?.dshBridge ?? this.ctx?.get?.('dshBridge'); } catch { bridge = undefined; }"
  },
  {
    id: "fix2",
    label: "Fix2 fixed UDP port",
    marker: "DSH_WEAVE_PORT",
    kind: "insert-after",
    anchor: "    builder.secretKey(await this.#secretKey());",
    lines: [
      "    const weavePort = Number(process.env.DSH_WEAVE_PORT ?? 64605);",
      '    if (Number.isInteger(weavePort) && weavePort > 0 && weavePort < 65536) builder.bindAddr("0.0.0.0:" + weavePort);'
    ]
  },
  {
    id: "fix34",
    label: "Fix3/Fix4 MAX_FRAME_BYTES = 4MB",
    marker: "const MAX_FRAME_BYTES = 4 * 1024 * 1024;",
    kind: "replace-one-of",
    olds: ["const MAX_FRAME_BYTES = 64 * 1024;", "const MAX_FRAME_BYTES = 1024 * 1024;"],
    replacement: "const MAX_FRAME_BYTES = 4 * 1024 * 1024;"
  },
  {
    id: "fix3b",
    label: "Fix3b ack readToEnd(MAX_FRAME_BYTES)",
    marker: "stream.recv.readToEnd(MAX_FRAME_BYTES),",
    kind: "replace",
    old: "        stream.recv.readToEnd(4096),",
    new: "        stream.recv.readToEnd(MAX_FRAME_BYTES),"
  }
];

/** Return [{ id, label, applied }] for every fix against a source text. */
export function detectPatchStatus(source) {
  return FIXES.map(({ id, label, marker }) => ({ id, label, applied: source.includes(marker) }));
}

/**
 * Apply any missing fixes to a dsh-weave lib/index.js source text.
 * Idempotent: a second run on the returned source changes nothing.
 *
 * @param {string} source raw file text
 * @returns {{ source: string, changed: boolean, applied: string[], warnings: {id:string, reason:string}[] }}
 *   `applied` lists fix ids that were written this run; `warnings` lists fixes
 *   that are neither present nor applicable (upstream layout may have drifted —
 *   mirrors the ps1 red WARN, never treated as failure).
 */
export function applyPatch(source) {
  let next = source;
  const applied = [];
  const warnings = [];
  for (const fix of FIXES) {
    if (next.includes(fix.marker)) continue; // already patched
    if (fix.kind === "replace") {
      if (next.includes(fix.old)) {
        next = next.replace(fix.old, fix.new);
        applied.push(fix.id);
      } else {
        warnings.push({ id: fix.id, reason: "target code not found; check upstream version manually" });
      }
    } else if (fix.kind === "insert-after") {
      if (next.includes(fix.anchor)) {
        next = next.replace(fix.anchor, fix.anchor + "\n" + fix.lines.join("\n"));
        applied.push(fix.id);
      } else {
        warnings.push({ id: fix.id, reason: "insertion anchor not found; check upstream version manually" });
      }
    } else if (fix.kind === "replace-one-of") {
      const hit = fix.olds.find((old) => next.includes(old));
      if (hit) {
        next = next.replace(hit, fix.replacement);
        applied.push(fix.id);
      } else {
        warnings.push({ id: fix.id, reason: "MAX_FRAME_BYTES const not found (64K/1M); check upstream version manually" });
      }
    }
  }
  return { source: next, changed: applied.length > 0, applied, warnings };
}
