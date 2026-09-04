// node --test unit tests for the dsh-weave four-fix patch guard.
// Pure-logic coverage: marker detection, one-pass application, idempotency,
// drifted-upstream tolerance, and a node --check parse gate on the output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { FIXES, detectPatchStatus, applyPatch } from "../lib/patch-guard.js";

/** Syntactically valid upstream-rc.14-like fragment embedding all four old tokens. */
function buildFake({ maxLine = "const MAX_FRAME_BYTES = 64 * 1024;", withAnchor = true } = {}) {
  const lines = [
    "// fake upstream dsh-weave rc.14 fragment (for patch-guard tests)",
    "class FakeWeave {",
    "  async start() {",
    withAnchor ? "    builder.secretKey(await this.#secretKey());" : "    builder.applyN0();",
    "  }",
    "  async #secretKey() { return []; }",
    "  async #dispatch() {",
    "    {",
    '      const bridge = this.ctx?.dshBridge ?? this.ctx?.get?.("dshBridge");',
    "    }",
    "  }",
    "  async send() {",
    "    const ack = await Promise.race([",
    "        stream.recv.readToEnd(4096),",
    "        new Promise(() => {})",
    "    ]);",
    "  }",
    "}",
    maxLine,
    "export { FakeWeave };"
  ];
  return lines.join("\n");
}

test("FIXES table covers exactly the four fixes with distinct markers", () => {
  assert.deepEqual(FIXES.map((fix) => fix.id), ["fix1", "fix2", "fix34", "fix3b"]);
  const markers = FIXES.map((fix) => fix.marker);
  assert.equal(new Set(markers).size, 4, "markers must be pairwise distinct");
});

test("detectPatchStatus reports all four missing on a pristine upstream fragment", () => {
  const status = detectPatchStatus(buildFake());
  assert.equal(status.length, 4);
  for (const fix of status) assert.equal(fix.applied, false, `${fix.id} should be missing`);
});

test("applyPatch applies all four fixes in one pass", () => {
  const pristine = buildFake();
  const out = applyPatch(pristine);
  assert.equal(out.changed, true);
  assert.deepEqual(out.applied.sort(), ["fix1", "fix2", "fix34", "fix3b"]);
  assert.deepEqual(out.warnings, []);
  for (const fix of FIXES) assert.ok(out.source.includes(fix.marker), `${fix.id} marker must be present after apply`);
});

test("applyPatch is idempotent: a second run changes nothing", () => {
  const once = applyPatch(buildFake());
  const twice = applyPatch(once.source);
  assert.equal(twice.changed, false);
  assert.deepEqual(twice.applied, []);
  assert.equal(twice.source, once.source);
  const status = detectPatchStatus(twice.source);
  for (const fix of status) assert.equal(fix.applied, true);
});

test("applyPatch handles the 1MB intermediate MAX_FRAME_BYTES value (Fix3 -> Fix4 path)", () => {
  const mid = buildFake({ maxLine: "const MAX_FRAME_BYTES = 1024 * 1024;" });
  const out = applyPatch(mid);
  assert.ok(out.applied.includes("fix34"));
  assert.ok(out.source.includes("const MAX_FRAME_BYTES = 4 * 1024 * 1024;"));
});

test("applyPatch warns instead of failing when a target string drifted upstream", () => {
  const drifted = buildFake({ withAnchor: false }); // Fix2 anchor removed
  const out = applyPatch(drifted);
  assert.equal(out.changed, true);
  assert.ok(!out.applied.includes("fix2"));
  assert.ok(out.warnings.some((warn) => warn.id === "fix2"));
  assert.equal(out.warnings.some((warn) => warn.id === "fix1"), false);
});

test("patched output passes node --check (parse gate)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-chatroom-guard-"));
  try {
    const file = join(dir, "patched.mjs");
    const out = applyPatch(buildFake());
    await writeFile(file, out.source, "utf8");
    const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(check.status, 0, `node --check failed: ${check.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
