# dsh-weave Fix1–Fix4 补丁说明（PATCH-NOTES）

> 适用范围：**dsh-weave `0.1.0-rc.14`** 的 `lib/index.js`（本项目联调验证基准）。
> 配套脚本：`patches/patch-weave.ps1`（Fix1–Fix4 四合一，幂等）。
> 行号基准：**部署版 = 打补丁后**的 `lib/index.js`（348 行）；上游 rc.14 原始行号标注「原 ~Lnn」。行号引用表与资产盘点清单 `ASSET-INVENTORY.md §2` 一致。
> 说明：本文件只含**少量代码片段与行号引用**，不携带上游完整源码（版权与合规见 §7）。

---

## 1. 快速使用

```powershell
# 目标环境需先装好上游包
npm i dsh-weave@0.1.0-rc.14

# 打补丁（默认目标 ~/.dsh/profiles/web/node_modules/dsh-weave/lib/index.js）
powershell -ExecutionPolicy Bypass -File patches\patch-weave.ps1

# 或显式指定目标文件
powershell -ExecutionPolicy Bypass -File patches\patch-weave.ps1 -WeaveIndex "D:\path\to\dsh-weave\lib\index.js"

# 固定端口：默认 64605，可用环境变量覆盖
$env:DSH_WEAVE_PORT = "64605"
```

脚本行为：首次执行自动备份原文件为 `index.js.bak-portfix`；写盘后自动 `node --check` 语法校验；目标文件缺失时红字报错并以退出码 1 结束（不破坏现场）；查找串未命中仅红字 WARN 提示人工核对（新版上游可能已变动），不视为失败、脚本继续（幂等友好）。

## 2. Fix 总览

| Fix | 缺陷一句话（问题） | 修复形态（改动位置） | 部署版落点 | 验证方式 |
|:--|:--|:--|:--|:--|
| Fix1 | `#dispatch` 无条件访问未注入的 `dshBridge` → 任何入站帧抛错，消息投递全挂 | dshBridge 访问包 `try/catch`，缺失时优雅降级（`#dispatch` 内） | L300–303 | 有 dsh-bridge 的正常栈：跨机 @ 消息送达且宿主侧不再报 "cannot get property dshBridge without inject" |
| Fix2 | Endpoint 默认绑定随机 UDP 端口，重启漂移 → peers.json 旧票失联 | 固定端口 64605（`DSH_WEAVE_PORT` 可覆盖）（`#start` + schema 默认） | L71–77、L21 | 重启 weave 前后监听端口不变（`netstat -an` 查 64605 UDP）；重启后无需换票，对端仍可达 |
| Fix3 | ack 回执只读 `readToEnd(4096)`（4KB）+ 入站帧上限 64KB → 批量历史响应抛 `TooLong`，UI 历史空白 HTTP 500 | ack 读满 `readToEnd(MAX_FRAME_BYTES)`；帧上限 64KB→1MB（`send` 读 ack + 常量） | L239、L35 | 历史消息 ≥ 30 条时 UI 时间线完整显示、不再 HTTP 500；`/dsh-chat/messages` 拉取大响应不再 `TooLong` |
| Fix4 | 1MB 对 2000 条窗口的增量历史拉取仍偏紧，远期有复发风险 | 帧上限 1MB→4MB（兼容 64KB/1MB 旧值；常量处） | L32–35 | `index.js` 常量 = `4 * 1024 * 1024`；脚本二跑输出 "nothing to do"；大响应读取验证同 Fix3 |

## 3. 逐 Fix 详述

### Fix1 — dshBridge 访问未防护（入站帧全挂）

- **问题**：`#dispatch` 内无条件执行
  ```js
  const bridge = this.ctx?.dshBridge ?? this.ctx?.get?.("dshBridge");   // 上游原 ~L289
  ```
  Cordis 的 `ctx.get("dshBridge")` 对**未注入**的服务会内部抛错；可选链 `?.` 挡不住 `get()` 内部的 throw。rc.14 的 `inject` 表没有 dshBridge → 每个入站帧一碰即抛，消息投递整体不可用。
- **改动位置**：`#dispatch` 内（部署版 L300–303）。
- **修复形态**（脚本查找串 → try/catch 包裹）：
  ```js
  let bridge;
  try { bridge = this.ctx?.dshBridge ?? this.ctx?.get?.("dshBridge"); } catch { bridge = undefined; }
  ```
- **效果**：dsh-bridge 存在时行为不变；缺失时 `bridge = undefined`，走 `no handler claimed ... and dsh-bridge is unavailable` 的显式报错路径（若已有 listener 认领则正常返回）。
- **验证**：正常栈（含 dsh-bridge）重启 weave 后，跨机 @ 消息双向送达，宿主日志/UI 不再出现 inject 报错。

### Fix2 — Endpoint 随机 UDP 端口漂移

- **问题**：weave `Endpoint.builder()` 未显式 `bindAddr` 时每次重启绑定**随机 UDP 端口** → peers.json 里持久化的旧票携带过期地址 → 重启后对端失联（`remoteSessions` 空、投递失败）。修复须**双边**同打，票证地址才能跨重启稳定。
- **改动位置**：`#start`（部署版 L71–77）；schema `bindAddr` 默认 `0.0.0.0:64605`（L21）。
- **修复形态**（脚本插入，锚点 = `builder.secretKey(...)` 之后）：
  ```js
  const weavePort = Number(process.env.DSH_WEAVE_PORT ?? 64605);
  if (Number.isInteger(weavePort) && weavePort > 0 && weavePort < 65536) builder.bindAddr("0.0.0.0:" + weavePort);
  ```
- **部署版形变（等价语义演进，见 §6）**：部署环境已手工演进为「env 空串与缺失区分 + `config.bindAddr` 兜底」——空串/非法值回落到配置默认 `0.0.0.0:64605`，比脚本的「空串 → 不 bind → 随机端口」更稳。**逻辑等价，建议后续合入脚本**。
- **验证**：重启 weave / DSH web profile 前后 `netstat -an | findstr 64605` 可见稳定 UDP 监听；重启后不换票，对端消息仍可达（双向）。

### Fix3 — ack 回执 4KB 截断（UI 历史空白 / HTTP 500）

- **问题**：`send()` 等 ack 时
  ```js
  stream.recv.readToEnd(4096),                       // 上游原 ~L236
  ```
  ack 通道只读 4KB → `room.read` 的批量历史响应（随消息累积远超 4KB）抛 `TooLong` → 上层表现为 HTTP 500 / UI 历史空白。**真凶是 ack 通道 4KB**，而不是入站帧上限本身。
- **改动位置**：
  - Fix3b：`send` 读 ack 处（部署版 L239），`readToEnd(4096)` → `readToEnd(MAX_FRAME_BYTES)`；
  - Fix3a：帧上限常量（部署版 L35），64KB → 1MB。入站读取（L263）用的是同一常量，无需改行，升常量即生效。
- **验证**：历史消息累积超过 4KB（≥ 30 条）时，UI 时间线完整显示、无 HTTP 500；RPC 重放 `room.read`/`messages` 大响应不再 `TooLong`（证据链见 `docs/fix3-frame-limit-postmortem.md`，双端 27→54 条验证）。

### Fix4 — 帧上限 1MB → 4MB

- **问题**：1MB 对「2000 条滚动窗口的增量历史拉取」与更大单条消息仍偏紧，远期有复发风险（实测 58 条约 70KB，2000 条窗口最坏增量约 2MB，需留裕量）。
- **改动位置**：帧上限常量（部署版 L32–35，注释 + `const MAX_FRAME_BYTES = 4 * 1024 * 1024;`）。
- **修复形态**：目标值 4MB；脚本兼容 64KB 与 1MB 两种旧值（命中即替换），已是 4MB 则跳过（幂等）。
- **演进链**：`64KB → 1MB（Fix3）→ 4MB（Fix4）`。
- **验证**：`index.js` 中常量为 4MB；脚本二跑输出 "nothing to do"；构造接近 1–4MB 的大响应读取成功（Fix3 的验证口径在 Fix4 下继续成立）。

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

`patch-weave.ps1` 是**通用发布形态**（对新装的 rc.14 干净文件一键打全）；部署环境的 `lib/index.js` 是**演进形态**，与脚本的差异为等价语义演进：

1. **Fix2**：脚本「env 缺失 → 64605、env 空串 → 不 bind（随机端口）」；部署版「env 缺失 → 64605、env 空串/非法 → `config.bindAddr` 兜底（默认 `0.0.0.0:64605`）」——部署版对空串更稳，见 §3 Fix2。
2. **注释**：部署版在 Fix3/4a 常量与 Fix3b 处补了中文说明注释；脚本基于查找串替换、不增删注释，结果一致。

## 7. 版权与合规

- 上游 `dsh-weave` 为 **MIT 许可**（author Xiang Bai，repo：`github.com/baixianger/dsh-weave`）。`dsh-chat` / `dsh-bridge` 同为 MIT（详见仓库 README 致谢段）。
- 本项目对上游的修改**未合入上游**；发布物只含**自研补丁脚本**与**少量片段/行号引用**（MIT 条款下合规，并已附完整归属）。读者自行 `npm i dsh-weave@0.1.0-rc.14` + 执行脚本即可完整复现，无需本仓库携带上游源码。
- 仓库自研部分（脚本、本说明、文档、图表）遵循仓库根 `LICENSE`（MIT）发布。

## 8. 运维铁律

`dsh-weave` 升级（`npm update` / 重装 node_modules）会**覆盖补丁**——升级后**必须重跑** `patch-weave.ps1`，并重启 weave / DSH web profile 使固定端口 64605 生效。
