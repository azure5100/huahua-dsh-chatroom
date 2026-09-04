# dsh-weave Fix1–Fix4 补丁说明（PATCHES）

> 适用范围：**dsh-weave `0.1.0-rc.14`** 的 `lib/index.js`（本项目联调验证基准）。
> 配套脚本：`patches/patch-weave.ps1`（Fix1–Fix4 四合一，幂等）。
> 说明：本文件只含**少量代码片段与行号引用**，不携带上游完整源码（版权与合规见 §7）。
> 行号基准：**部署版 = 打补丁后**的 `lib/index.js`（348 行）；上游 rc.14 原始行号标注「原 ~Lnn」。

---

## 1. 快速使用

```powershell
# 目标环境需先装好上游包
npm i dsh-weave@0.1.0-rc.14

# 打补丁（默认目标 ~/.dsh/profiles/web/node_modules/dsh-weave/lib/index.js）
powershell -ExecutionPolicy Bypass -File patches\patch-weave.ps1

# 或显式指定目标文件
powershell -ExecutionPolicy Bypass -File patches\patch-weave.ps1 -WeaveIndex "D:\path\to\dsh-weave\lib\index.js"

# 验证：再跑一次应输出 "nothing to do"（幂等）
# 固定端口：默认 64605，可用环境变量覆盖
$env:DSH_WEAVE_PORT = "64605"
```

脚本行为：首次执行自动备份原文件为 `index.js.bak-portfix`；写盘后自动 `node --check` 语法校验；目标文件缺失 / 查找串未命中输出红字 WARN 并以退出码 1 结束（不破坏现场）。

## 2. Fix 总览

| Fix | 缺陷一句话 | 修复形态 | 部署版落点 |
|:--|:--|:--|:--|
| Fix1 | `#dispatch` 无条件访问未注入的 `dshBridge` → 任何入站帧抛错，消息投递全挂 | dshBridge 访问包 `try/catch`，缺失时优雅降级 | L300–303 |
| Fix2 | Endpoint 默认绑定随机 UDP 端口，重启漂移 → peers.json 旧票失联 | 固定端口 64605（`DSH_WEAVE_PORT` 可覆盖） | L71–77 |
| Fix3 | ack 回执只读 `readToEnd(4096)` + 帧上限 64KB → 批量历史响应超限，UI 历史空白 HTTP 500 | ack 读满 `readToEnd(MAX_FRAME_BYTES)`；帧上限 64KB→1MB | L239、L35 |
| Fix4 | 1MB 对 2000 条窗口的增量历史拉取仍偏紧 | 帧上限 1MB→4MB（兼容 64KB/1MB 旧值） | L32–35 |

## 3. 逐 Fix 详述

### Fix1 — dshBridge 访问未防护（入站帧全挂）

- **现象/根因**：`#dispatch` 内无条件执行
  ```js
  const bridge = this.ctx?.dshBridge ?? this.ctx?.get?.("dshBridge");   // 上游原 ~L289
  ```
  Cordis 的 `ctx.get("dshBridge")` 对**未注入**的服务会内部抛错；可选链 `?.` 挡不住 `get()` 内部的 throw。依赖注入表（rc.14 `inject` 表）没有 dshBridge → 每个入站帧一碰即抛，消息投递整体不可用。
- **修复**（脚本查找串 → 替换为 try/catch 包裹）：
  ```js
  let bridge;
  try { bridge = this.ctx?.dshBridge ?? this.ctx?.get?.("dshBridge"); } catch { bridge = undefined; }
  ```
- **效果**：dsh-bridge 存在时行为不变；缺失时 `bridge = undefined`，走 `no handler claimed ... and dsh-bridge is unavailable` 的显式报错路径（若已有 listener 认领则正常返回）。
- **部署版落点**：L300–303（`#dispatch` 内）。

### Fix2 — Endpoint 随机 UDP 端口漂移

- **现象/根因**：weave `Endpoint.builder()` 未显式 `bindAddr` 时每次重启绑定**随机 UDP 端口** → peers.json 里持久化的旧票携带过期地址 → 重启后对端失联（`remoteSessions` 空、投递失败）。修复须**双边**同打，票证地址才能跨重启稳定。
- **修复（脚本插入，锚点 = `builder.secretKey(...)` 之后）**：
  ```js
  const weavePort = Number(process.env.DSH_WEAVE_PORT ?? 64605);
  if (Number.isInteger(weavePort) && weavePort > 0 && weavePort < 65536) builder.bindAddr("0.0.0.0:" + weavePort);
  ```
- **部署版形变（等价语义演进，见 §6）**：部署环境已手工演进为「env 空串与缺失区分 + `config.bindAddr` 兜底」——空串/非法值回落到配置默认 `0.0.0.0:64605`（schema L21），比脚本的「空串 → 不 bind → 随机端口」更稳。**逻辑等价，建议后续合入脚本**。
- **部署版落点**：L71–77（`#start`）；schema `bindAddr` 默认值 L21。

### Fix3 — ack 回执 4KB 截断（UI 历史空白 / HTTP 500）

- **现象/根因**：`send()` 等 ack 时
  ```js
  stream.recv.readToEnd(4096),                       // 上游原 ~L236
  ```
  ack 通道只读 4KB → `room.read` 的批量历史响应（随消息累积远超 4KB）抛 `TooLong` → 上层表现为 HTTP 500 / UI 历史空白。**真凶是 ack 通道 4KB**，而不是入站帧上限本身。
- **修复**：
  - Fix3b：`readToEnd(4096)` → `readToEnd(MAX_FRAME_BYTES)`（部署版 L239，随常量取值）；
  - Fix3a：帧上限常量 64KB → 1MB（入站读取 L263 用的是同一常量，无需改行，升常量即生效）。
- **部署版落点**：L239（`send` 读 ack）；L263（`#accept` 入站读，代码行未变）。

### Fix4 — 帧上限 1MB → 4MB

- **根因/动机**：1MB 对「2000 条滚动窗口的增量历史拉取」与更大单条消息仍偏紧，远期有复发风险（实测 58 条约 70KB，2000 条窗口最坏增量约 2MB，需留裕量）。
- **修复**：`MAX_FRAME_BYTES` 目标值 4MB（脚本兼容 64KB 与 1MB 两种旧值，命中即替换；已是 4MB 则跳过）。
- **演进链**：`64KB → 1MB（Fix3）→ 4MB（Fix4）`。
- **部署版落点**：L32–35（注释 + `const MAX_FRAME_BYTES = 4 * 1024 * 1024;`）。

## 4. 上游行号引用表（rc.14 → 部署版）

> 引用基准：`dsh-weave@0.1.0-rc.14` 的 `lib/index.js`。补丁脚本内查找串见 `patches/patch-weave.ps1`（`$fix1Old` / `$fix2Anchor` / `$fixFrameOlds` / `$fix3bOld`）。

| Fix | 上游原始（rc.14 未打补丁） | 部署版（打补丁后） | 改动形态 |
|:--|:--|:--|:--|
| Fix1 | 原 ~L289：`const bridge = this.ctx?.dshBridge ?? this.ctx?.get?.("dshBridge");` | L300–303 | 包 try/catch |
| Fix2 | 无固定端口绑定（随机端口） | L71–77（+ schema 默认 L21） | 插入固定端口逻辑 |
| Fix3/Fix4 | 原 ~L32：`const MAX_FRAME_BYTES = 64 * 1024;` | L35：`4 * 1024 * 1024` | 常量值提升 |
| Fix3b | 原 ~L236：`stream.recv.readToEnd(4096),` | L239：`stream.recv.readToEnd(MAX_FRAME_BYTES),` | ack 读满 |
| Fix3(入站侧) | 同形 `readToEnd(MAX_FRAME_BYTES)` | L263 | 随常量提升，行未变 |

## 5. 复现路径（读者可自行验证）

```powershell
npm i dsh-weave@0.1.0-rc.14
powershell -ExecutionPolicy Bypass -File patches\patch-weave.ps1
# 期望：Fix1–Fix4 全部 applied / skip（二次执行 nothing to do），SYNTAX OK
```

对应排障证据链：`docs/fix3-frame-limit-postmortem.md`（Fix3 完整诊断与验证，Fix4 为其接续）。

## 6. 脚本逻辑 vs 部署版形变说明

`patch-weave.ps1` 是**通用发布形态**（对新装的 rc.14 干净文件一键打全）；部署环境的 `lib/index.js` 是**演进形态**，两处与脚本不同但语义等价：

1. **Fix2**：脚本「env 缺失 → 64605、env 空串 → 不 bind（随机端口）」；部署版「env 缺失 → 64605、env 空串/非法 → config.bindAddr 兜底（默认 0.0.0.0:64605）」——部署版对空串更稳，见 §3 Fix2。
2. **注释**：部署版在 Fix3/4a 常量与 Fix3b 处补了中文说明注释；脚本基于查找串替换，不增删注释，结果一致。

## 7. 版权与合规

- 上游 `dsh-weave` 为 **MIT 许可**（author Xiang Bai，repo：`github.com/baixianger/dsh-weave`）。`dsh-chat` / `dsh-bridge` 同为 MIT（详见仓库 README 致谢段）。
- 本项目对上游的修改**未合入上游**；发布物只含**自研补丁脚本**与**少量片段/行号引用**（MIT 条款下合规，并已附完整归属）。读者自行 `npm i dsh-weave@0.1.0-rc.14` + 执行脚本即可完整复现，无需本仓库携带上游源码。
- 仓库自研部分（脚本、本说明、文档、图表）遵循仓库根 `LICENSE`（MIT）发布。

## 8. 运维铁律

`dsh-weave` 升级（`npm update` / 重装 node_modules）会**覆盖补丁**——升级后**必须重跑** `patch-weave.ps1`，并重启 weave / DSH web profile 使固定端口 64605 生效。
