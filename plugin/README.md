# huahua-dsh-chatroom · kit 插件（patch guard + chatroom_* 工具）

> 把 dsh-chat 会议室运维做成**可安装的 cordis 插件**（loader 行 id：`dsh-chatroom-kit`）。
> 安装后，只要 dsh-chat/dsh-weave/dsh-bridge 三件套已激活，本插件会自动：
> ① 守护 dsh-weave 的 Fix1–Fix4 补丁（启动时检测缺失并自动重打、备份 + `node --check`）；② 提供 `chatroom_patch_status` / `chatroom_patch_apply` 两个 agent 工具；③ 挂 host RPC `/dsh-chatroom`（`status` | `patch`）。

## 结构

```
plugin/
├─ package.json          dsh.bundle.patch 清单 + peerDeps + exports
├─ cordis.patch.yml      只 insert 自己一行（id dsh-chatroom-kit）
├─ lib/index.js          apply：补丁守护 + 工具 + RPC + effect disposer
├─ lib/patch-guard.js    Fix1–Fix4 marker 表 + applyPatch（纯逻辑，可单测）
├─ tests/                node --test 单测（markers / 幂等 / node --check）
├─ README.md
└─ LICENSE
```

替换表与 `patches/patch-weave.ps1` **同源**（四合一：Fix1 dshBridge try/catch、Fix2 固定 UDP 64605、Fix3/4 帧上限 4MB、Fix3b ack `readToEnd(MAX_FRAME_BYTES)`）；若两处未来分叉，以 `patch-weave.ps1` 为权威并同步本表。

## 安装（顺序重要）

```powershell
# 0) 前置：目标 profile 已装好三件套（重复 add 幂等，无副作用）
dsh plugin --profile web add dsh-chat dsh-weave dsh-bridge

# 1) 安装本 kit（发布后走 npm registry）
dsh plugin --profile web add huahua-dsh-chatroom
# 本地开发/自托管（二选一）：
dsh plugin --profile web add link:D:\huahua-dsh-chatroom\plugin   # 符号链接，改 lib 即热更
dsh plugin --profile web add file:D:\huahua-dsh-chatroom\plugin   # 拷贝语义
```

安装后重启 DSH / web profile。首次启动日志会显示守护结果；若 weave 缺补丁则自动写入并提示 **重启生效**（守护写入时 weave 模块已按旧文件加载，必须重启）。

## 行为

### 启动补丁守护
- 目标文件默认 `<DSH_HOME|~/.dsh>/profiles/web/node_modules/dsh-weave/lib/index.js`，可用行级 `config.weaveIndex` 覆盖（见下）。
- 四个 marker 全在 → `info: all fixes present`；有缺失 → 首次备份 `index.js.bak-chatroom` → 逐项替换 → `node --check` → `warn`（含重启提示）；替换串未命中（上游新版已变动）→ 仅 warn 提示人工核对，**不中断、不视为失败**（幂等友好，与 `patch-weave.ps1` 一致；仅目标文件缺失才告警）。
- 升级 dsh-weave 覆盖补丁后**重启一次本插件即自动重打**；逃生通道仍可用手动 `patches/patch-weave.ps1`。

### agent 工具（模型可见，随行激活全会话可用）
- `chatroom_patch_status`：逐 Fix 报告 `applied/missing`（含目标路径与"是否有缺"）。
- `chatroom_patch_apply`：立即执行一次守护（备份→补丁→`node --check`），返回是否 changed + 是否需要重启。

### host RPC（`trusted-host` authority）
- `/dsh-chatroom` `status` → 只读状态；`patch` → 执行守护。返回 `{ ok, value }`，value 与工具输出同构。

### 行级 config（profile 用户层 `cordis.patch.yml` 覆盖或 `--patch`）
```yaml
- id: dsh-chatroom-kit
  config:
    weaveIndex: 'D:\custom\dsh-weave\lib\index.js'   # 可选：非默认 profile 时指路
    dataDir: 'D:\data\chatroom'                      # 可选：守护摘要 JSON 落点（默认 ~/.dsh/chatroom）
```

## 运维铁律（与 README §8 / PATCH-NOTES 一致）

- **行 id 全 profile 唯一**：本包用 `dsh-chatroom-kit`，不撞三件套行 id（`dsh-chat`/`dsh-weave`/`dsh-bridge`）；本包**不 insert 三件套行**（重复行 id loader 拒绝启动；同包 apply 两次会重复 provide/注册 → 必崩）。
- 包名 = 行 `name` 必须与 `package.json` 的 `name` 一致；同一包在 profile deps 里只能有一个来源。
- 升级/重装 dsh-weave 会覆盖 node_modules 补丁 → 由本插件重启守护自动处理，或手动重跑 `patch-weave.ps1`。
- 三件套以 **profile 显式依赖 + bundles** 方式存在，本包 **peerDependencies 只声明 `@deepseek-ai/*` 主机包**（in-box，随 DSH 运行时提供），不把 chat 三件套声明为普通依赖。

## 测试

```powershell
cd plugin
node --test tests/        # markers 检测 / 一次打全 / 幂等 / 1MB 中间态 / 漂移容错 / node --check
```

## 许可

MIT（与仓库根 `LICENSE` 同款）。上游 dsh-chat/dsh-weave/dsh-bridge 为 MIT（author Xiang Bai），本插件不含上游源码，仅含自研守护逻辑与片段/行号引用。
