# DSH 插件打包安装机制研究报告

> 作者：architect-huahua（架构师/研究员）｜日期：2026-09-04｜团队：huahua-dsh-chatroom-release
> 目的：为「把 huahua-dsh-chatroom 做成可安装 cordis 插件」提供机制研究与实施依据。
> 证据来源：本机 web profile 已装插件（dsh-chat rc.33 / dsh-weave rc.14 / dsh-bridge rc.15 / dshmarket 1.26.0 / huahua-dsh-plugin-orchestra 本地包）、DSH 仓库源码（apps/cli/src/plugin.ts、packages/boot/app-boot/src/profile.ts、vendor/include/src/index.ts、apps/cli/tests）。
> 去敏声明：本文不含任何真实 peer id / IP / 房间实例号 / 个人标识。

---

## 0. 机制总览（一张图）

```
                      ┌────────────────────────────────────────────────┐
   发布方             │  ~/.dsh/profiles/<name>/  (一个 profile)        │
  npm registry /      │                                                │
  github: / file: /   │  package.json  ── dsh.profile.bundles: [有序]  │
  link: / 本地目录     │        │        （每项 = 一个 bundle 包名）       │
        │ dsh plugin   │        ▼                                       │
        │ add <spec>   │  resolveBundleDir → 包目录 → 读 dsh.bundle.patch│
        ▼              │        │  (cordis.patch.yml = patch 层)         │
  pnpm add（写 deps）  │        ▼                                       │
        │              │  applyEntryPatches：bundles 顺序逐层叠加        │
        ▼              │  空 root 行列表 ──每层 insert 行──▶ 行列表        │
  reconcilePlugins    │        │                                        │
  （按 dsh.bundle 对账 │        ▼                                        │
   追加/移除 bundles） │  用户层 ~/.dsh/profiles/<name>/cordis.patch.yml  │
                      │  （最后叠加；insert/disabled/config/!!js）        │
                      └───────────────┬────────────────────────────────┘
                                      ▼
                        cordis Loader 挂载行 → 每行执行插件模块
                        apply(ctx, config) → 提供服务/注册工具/RPC
```

**核心结论先行**
1. DSH 插件 = 一个 npm 包，靠 `package.json` 的 `dsh` 清单字段声明自己是"bundle"，把 `cordis.patch.yml`（loader patch 层）挂进 profile 的行组合里。
2. 安装 = 一条命令 `dsh plugin --profile <name> add <spec>`（本质 pnpm add + 自动对账 `dsh.profile.bundles`）；可视化市场（dshmarket）是这条命令的 UI 包装 + 安装后校验。
3. 挂载 = 插件模块 `apply(ctx, config)` 在行激活时执行——注册工具、提供服务、跑任意启动逻辑（补丁守护就在这里做）。
4. chat 三件套（dsh-bridge/dsh-weave/dsh-chat）以 peerDependency + profile 显式依赖 + bundles 列表三种方式共同声明；`chat_*` agent 工具由 dsh-chat 在 `apply` 里 `ctx.tools.register(...)` 注册，随服务激活全会话可见。

---

## 1. 插件包最小结构

### 1.1 package.json 的 `dsh` 清单字段（本项目可用的两种）

| 字段 | 含义 | 证据（已装包） |
|:--|:--|:--|
| `dsh.bundle.patch` | 声明本包是一个 bundle 层，指向 patch 文件路径（相对包根）。**有它才会被 reconcile 进 `dsh.profile.bundles`** | dsh-chat、dsh-weave、dsh-bridge rc.15、dshmarket、orchestra 全部是 `"./cordis.patch.yml"` |
| `dsh.client.inject` / `dsh.client.platform` | （可选）web UI 客户端模块清单：注入哪些 `@deepseek-ai/dsh-client-*` 服务、目标平台。客户端扫描器据此把 `lib/client.js` 送进浏览器 | dsh-chat client（inject runtime+conversation）、dshmarket（5 个 client 服务） |
| `dsh` 键存在本身 | dshmarket 判定"这是个插件"的最低标准（`hasDshManifest`） | dshmarket/lib/profile.js |

**最小可安装 bundle 的 package.json**（无 UI，纯 host 逻辑）：

```jsonc
{
  "name": "huahua-dsh-chatroom",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }
    // 无 UI 阶段可不写 client；未来加设置面板再补 dsh.client
  },
  "files": ["lib", "cordis.patch.yml", "README.md", "LICENSE"],
  "license": "MIT",
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": "^0.1.0-rc.7",
    "@deepseek-ai/dsh-typert-protocol": "^0.1.0-rc.7",
    "@deepseek-ai/schemastery": "^3.18.1"
    // 注意：不要在这里声明 dsh-chat/dsh-weave/dsh-bridge 为普通依赖
    //（见 §4：autoInstallPeers=false 且 @deepseek-ai/* 主机 peer 不上 npm）
  }
}
```

要点：`exports` 必须把 `./cordis.patch.yml` 与 `./package.json` 显式导出（loader 与对账逻辑按此读取）；`main` 指向实际存在的入口文件（dshmarket 会校验入口产物存在，github 源码未构建包会被判不可装）。

### 1.2 cordis.patch.yml（patch 层语法）

patch 文件 = 顶层 YAML 数组，两种条目（权威语义在 `vendor/include/src/index.ts` 的 `applyEntryPatches`）：

```yaml
# A. insert —— "确保这些行存在"：往 root 行列表追加自己带来的行
- insert:
    - id: dsh-chatroom-kit        # loader 行 id：全 profile 唯一，冲突则跳过+警告
      name: huahua-dsh-chatroom   # 包名：必须与 package.json name 一致（YAML 中 @ 开头要加引号）
      config:                     # 可选：该行挂载时传给 apply(ctx, config) 的配置
        dataDir: '~/.dsh/chatroom'
# B. id-targeted —— 改别人已存在的行（disabled/config/inject/group/isolate…）
- id: dsh-chat
  disabled: true                  # 例：web profile 用户层禁用 acp-plugin/acp-bridge 即此形态
```

规则（源码级确认）：
- **insert 追加行**：同 id 已在列表中 → 告警跳过、先到者胜（两个 bundle 想插同一共享行时可组合而非崩启动）；同列表内后 patch 可继续 target 前一个 patch 插入的行（插入即入索引）。
- **id-targeted 行**：`name` 与目标行不一致会告警跳过（防止误改同名）；`overrides`（含 `disabled`/`config`）整体覆盖到目标行。
- **`!!js` 表达式**：YAML 里 `!!js <expr>` 标量会在该行 fiber 上下文中惰性求值（cordis.yml 允许 `!!js`，禁止 `!js`）。
- patch 应用顺序：每个 bundle 层按 `dsh.profile.bundles` 顺序 → 用户层 `profile/cordis.patch.yml` 最后 → `--patch` 覆盖层。
- 诊断：`dsh --dump-config`（或 `--dump-default-config` 跳过用户层）走同一 `applyEntryPatches`，dump 永不偏离实际启动。

**行 id 唯一性是硬约束**：loader 对重复 entry id 直接拒绝整树启动（"duplicate loader entry id"），dshmarket 装新包前会做 `conflictingEntryIds` 预检。自己的行 id 取唯一命名（如 `dsh-chatroom-kit`），不要与 chat 三件套的行 id（`dsh-chat`/`dsh-weave`/`dsh-bridge`）撞名。

### 1.3 lib/index.js（函数插件入口形态）

仓库规范（packages/AGENTS.md + postmortem 0001）：**函数插件 = 具名导出 `name`/`inject`/`Config`/`apply`，禁止 default export**（default export 会让 Loader 丢弃 inject）。已装三件套全部是这个形态：

```js
import { defineTool } from "@deepseek-ai/dsh-tools";
import Schema from "@deepseek-ai/schemastery";

export const name = "huahua-dsh-chatroom";
export const Config = Schema.object({ dataDir: Schema.string().optional() });
export const inject = ["tools", "connection"];   // 声明式注入；可选服务用 ctx.get()，勿混用

export function apply(ctx, config) {
  // —— 注册 host RPC（chat 工具/UI 走同一网关）——
  ctx.connection.rpc.handle("/dsh-chatroom", async (endpoint, payload) => {
    /* ... */ return { ok: true, value: {} };
  }, { authority: "trusted-host" });

  // —— 注册 agent 工具（模型可见，随服务激活即全会话可用）——
  ctx.tools.register(defineTool({
    name: "chatroom_status",
    description: "...",
    parameters: { },
    output: { schema: { type: "object", additionalProperties: false, properties: {} }, render: () => [{ type: "text", text: "" }] },
    async execute(args, exec) { /* ... */ }
  }));

  // —— 启动自定义逻辑（补丁守护见 §5）——
  // —— 清理（HMR/dispose 需要）——
  ctx.effect(() => async () => { /* close/释放 */ });
}
```

`inject` 数组顺序无关（Cordis pending 直到服务齐备）：dsh-chat 就声明 `["connection","tools","dshBridge","dshWeave","sessions","workspaceRegistry","sessionTitle"]`，其中 dshBridge/dshWeave 是别的 bundle 提供的服务，未就绪前它 pending 等待。

---

## 2. 如何被安装进 profile（CLI 与市场两条路）

### 2.1 命令：`dsh plugin --profile <name> add <spec>`

`apps/cli/src/plugin.ts` 实现，是一个 **pnpm 薄转发 + bundles 对账**：

```
dsh plugin --profile web add huahua-dsh-chatroom     # npm registry 名
dsh plugin --profile web add ./local-plugin          # 本地目录（file: 拷贝语义）
dsh plugin --profile web add file:C:/path            # 显式 file:（拷贝）
dsh plugin --profile web add link:C:/path            # 显式 link:（符号链接，开发热更用）
dsh plugin --profile web add github:user/repo        # git 源（prepare 构建，pnpm≥10 需 allowBuilds）
dsh plugin --profile web remove huahua-dsh-chatroom  # 移除
dsh plugin --profile web why <pkg>                   # 依赖追溯（原样转发 pnpm why）
```

执行三步：
1. profile 不存在则按模板初始化（写 package.json + `dsh.profile.bundles`）；
2. 在 profile 目录跑 `pnpm add <spec>`（相对路径按调用目录锚定，防止 `add .` 把 profile 自己 link 进去；git 源 prepare 被 pnpm 拦时会提示去 `pnpm-workspace.yaml` 的 `allowBuilds` 放行）；
3. 成功后在 `reconcilePlugins` 里对账：deps 中解析到**声明了 `dsh.bundle.patch` 的包** → 追加进 `dsh.profile.bundles`；已移除或失去声明的包 → 从列表移除；无 bundle 声明的纯依赖只给一条警告。**按"已安装态"而非"依赖 diff"对账**，所以 `update` 能让新版本里新增 bundle 声明的包自动激活。

安装后 profile package.json 形如（本机 web profile 实证）：

```jsonc
{
  "dependencies": {
    "dsh-bridge": "0.1.0-rc.15",
    "dsh-weave": "0.1.0-rc.14",
    "dsh-chat": "0.1.0-rc.33",
    "huahua-dsh-chatroom": "file:C:/dev/huahua-dsh-chatroom"  // 或 link:/github:/npm semver
  },
  "dsh": { "profile": { "bundles": [ /* ...顺序列表..., "dsh-chat", "dsh-weave", "dsh-bridge", "huahua-dsh-chatroom" */ ] } }
}
```

### 2.2 可视化市场（dshmarket）：一条 UI 化的同一条路

- dshmarket 本身也是一个 bundle 插件（行 id `dsh-market`），挂在 profile 后注入 `webServer`/`loader`/`shell` 提供市场 HTTP 路由与"桌面/CLI 两种宿主"的安装运行时。
- **市场条目来源**：社区目录（awesome-dsh-plugin.com）的 `plugins.json`/`readmes.json`；目录本体也发布成 npm 包（tar 里含 `plugins.json`），走中国镜像时 `dist.tarball` 跟随镜像（dshmarket/lib/catalog-npm.js）。条目 = 包名 + 元数据/readme。
- **安装动作** = 在 profile 目录跑 pnpm add/remove（同一语义），但带三件防护：
  - pnpm 已知坑自动恢复：modules 目录 pnpm 大版本漂移 → 先 `pnpm install` 重建重试一次；release-age 锁死 → 一次性 `--config.minimumReleaseAge=0`；大 tar 超时 → 一次性 `--config.fetchTimeout=600000`；
  - **auto-install-peers 关闭**（重试时）：DSH 运行时注入的 `@deepseek-ai/*` 主机包不上 npm，pnpm 8+ 默认 auto-install-peers 会去 registry 404；仅在重试时 `--config.auto-install-peers=false`（peerDependencyRules.ignoreMissing 无效）；
  - **安装后校验防下次启动被砖**：`hasDshManifest`（有 dsh 字段）、`entryArtifactExists`（入口产物在盘上，github 源未构建判坏）、`hasLoadableEntry`（自己或 carrier 目标可加载）、`conflictingEntryIds`（行 id 与已装 bundle 冲突预检）；失败回滚 manifest 幽灵依赖（pnpm 先写 package.json 后失败会留 ghost）。

### 2.3 包体解析锚点

`resolveBundleDir`：先查 dsh 安装自身（in-box 包如 `@deepseek-ai/dsh-base` 永远来自安装本体），再查 `profile/node_modules`。因此依赖管理的社区包装进 profile node_modules 即可被解析；`loadProfile` 对"列在 bundles 但没有 dsh.bundle 声明"的包**失败响亮**（是配置错误不是没补丁）。

---

## 3. chat 三件套如何声明依赖与组合（给我们的插件抄作业）

### 3.1 三种声明各管一段

| 声明位置 | 内容 | 作用 |
|:--|:--|:--|
| **上游包 peerDependencies** | dsh-chat 声明 `"dsh-bridge": ">=0.1.0-rc.14"`, `"dsh-weave": ">=0.1.0-rc.13"` + 一堆 `@deepseek-ai/*` 主机 peer | 表达"运行需要谁"；**不触发自动安装**（profile 的 pnpm-workspace.yaml `autoInstallPeers: false`），只是安装期的依赖图声明 |
| **profile dependencies** | web profile 显式列 `dsh-bridge/dsh-weave/dsh-chat`（npm / file: / link: / github: 均可） | 真正让 pnpm 把包装进 profile node_modules 的地方 |
| **profile `dsh.profile.bundles`** | 三件套各自的行由各自 bundle patch 插入（`dsh-chat` 行、`dsh-weave` 行、`dsh-bridge` 行），靠 bundles 顺序决定行组合 | 唯一决定启动组合的清单；`dsh plugin add` 自动维护 |

服务接线（Cordis 服务语义，行顺序无关）：dsh-bridge `apply` 提供 `dshBridge` 服务，dsh-weave 提供 `dshWeave`（`ctx.provide`），dsh-chat 声明 inject 这两个服务 → 挂载顺序任意，pending 直到服务齐备。

### 3.2 我们的插件怎么"依赖/组合"三件套——关键决策

**不要**在自己的 cordis.patch.yml 里再 insert dsh-chat/dsh-weave/dsh-bridge 的行：行 id 会重复（loader 拒绝启动），即便改 id 也会让同一模块 apply 两次 → 服务重复 provide / TypertRemote 重复注册，必崩。（实证：本机曾有 `@wenbin_wb/dsh-bridge` 与 rc 版 `dsh-bridge` 同名行 id 冲突导致启动失败，最终方案是 wenbin 版不进 bundles、以改名行 id 在用户层手动挂载——因为它全程不 provide 服务才安全。）

正确做法（三选一，推荐 A）：
- **A（推荐）前置条件式**：自己的 bundle 只管自己的行；README 写明安装序列 `dsh plugin --profile web add dsh-chat dsh-weave dsh-bridge` 先行（幂等，重复 add 无副作用），再加本插件。组合关系沉淀在文档与 bundles 顺序里，零运行时风险。
- **B 依赖声明式（信息性）**：peerDependencies 里加 `dsh-chat/dsh-weave/dsh-bridge` + `peerDependenciesMeta.optional: true`，避免装不上（registry 有 rc 版但按 next tag 发）→ 但 autoInstallPeers=false 下不自动装，仅表达意图。
- **C 用户层补丁装配**：要求用户在 `profile/cordis.patch.yml` 加 insert（把三件套行与自己的行一起装配、可给行级 config）——把组合控制权交给 profile，插件只保证自己那行。适合做"kit"式插件的终态（见 §6）。

### 3.3 命名冲突总规则（写进 README 的运维铁律）

- 行 id 全 profile 唯一（与其它 bundle 的 `insertedIds` 不能重叠）；
- 包名 = 行 `name` 必须一致（YAML `@` 开头的包名要加引号）；
- 同一包在 deps 里只能有一个来源（ghost/同名错装是启动失败重灾区）；
- 升级/重装 dsh-weave 会覆盖 node_modules 补丁 → 需要补丁守护或重跑 patch（见 §5）。

---

## 4. 启动时运行自定义逻辑（补丁守护的落点）

插件模块 `apply(ctx, config)` 在行激活时于宿主进程内执行——这是唯一可靠的"开机自检"挂点。设计补丁守护如下：

### 4.1 定位补丁目标（无需硬编码 profile 名）

宿主运行时如何知道自己在哪个 profile：
- CLI 宿主：解析 `process.argv` 里 `--profile` 值（dshmarket 的 `argvProfile()` 即此模式），缺省 'web'；`DSH_HOME` 缺省 `~/.dsh`；
- 桌面宿主：`ctx.get('desktopProfiles')` 的 `current.dir`（dshmarket 双分支证据）；
- 通用兜底：`process.cwd()`（宿主通常以 profile 为 cwd 启动）或 `import.meta` 解析自身在 node_modules 的位置 → 上溯即 profile 根。

```
profileDir = ~/.dsh/profiles/<name>
target = <profileDir>/node_modules/dsh-weave/lib/index.js
```

### 4.2 检测 + 自动打补丁（建议：检测为主、自动修复 + 重启提示）

在 `apply` 里同步执行（宿主进程可直接读写磁盘，不受 agent 工具沙箱限制）：

```js
// 伪代码：四合一补丁守护（与 patch-weave.ps1 同源逻辑）
const markers = {
  fix1: 'try { bridge = this.ctx?.dshBridge',     // L300 附近
  fix2: 'DSH_WEAVE_PORT',                          // L72
  fix34: 'const MAX_FRAME_BYTES = 4 * 1024 * 1024', // L35
  fix3b: 'readToEnd(MAX_FRAME_BYTES)',             // L239
};
const src = await readFile(target, 'utf8');
const missing = Object.entries(markers).filter(([, m]) => !src.includes(m));
if (missing.length) {
  // 1) 备份 target.bak-chatroom → 2) 逐项字符串替换（复用 patch-weave.ps1 的替换表）
  // 3) 写回 → 4) spawnSync('node', ['--check', target]) 语法校验
  // 5) ctx.logger.warn: 补丁已写，当前 weave 实例仍是旧代码，需重启 DSH 生效
} else {
  ctx.logger.info('dsh-weave patch guard: all four fixes present');
}
```

**关键边界（必须写清楚）**：
- **生效时机**：dsh-weave 行在 bundles 顺序里若排在守护插件之前，weave 模块早已加载——文件补丁只对**下一次启动**生效。守护必须记日志并提示"重启生效"，或（更强）在检测到缺补丁时让 `ctx.get('dshWeave')` 的宿主抛启动期警告。
- **行序副作用**：把守护插件排在 dsh-weave **之前**可在 weave 加载前完成文件修复，但 `dsh plugin add` 的 reconcile 是追加到列表尾；要前置需手工编辑 bundles 或采用 kit 式用户层补丁（§6 的 C 方案），loader 会在下次组合时校验顺序合法性。
- **职责边界**：守护只修文件与告警，不替代用户对"升级后必须重启/重跑"的运维认知；README 同时保留手动 `patch-weave.ps1` 逃生通道。
- 替代/补充手段：把补丁逻辑抽成独立 npm 脚本，走插件 `scripts` + pnpm `allowBuilds` 在**安装期**执行（git/file 源 prepare 可跑）——但那受 pnpm≥10 build 白名单约束，且装完无法覆盖"运行中被升级覆盖"的场景，故守护放 `apply` 更稳。

### 4.3 其它启动逻辑挂点（同一 apply 内）

- `ctx.connection.rpc.handle('/dsh-chatroom', …, { authority: 'trusted-host' })`：host RPC（UI 与 agent 封装工具共用）；
- `ctx.tools.register(defineTool(...))`：agent 工具（见 §5）；
- `ctx.effect(() => async () => …)`：注册 disposer（HMR/卸载清理，registry 贡献必须证明可回收——仓库测试政策要求）；
- 定时器/事件订阅一律走 `ctx.setInterval` 等生命周期 API（防悬挂）。

---

## 5. chat_* 工具如何随 dsh-chat 生效（给"安装后自动可用"背书）

dsh-chat 的 `apply`（lib/index.js）做四件事，代理工具的可见性链路如下：

1. `new DshChatRemote(ctx, config)`（`TypertRemoteService`, namespace `dshChat`）封装 `DshChatService`（room-store.js），`attachWeave()` 让 weave 帧协议认领房间链路；
2. `ctx.connection.rpc.handle("/dsh-chat", handlers, { authority: "trusted-host" })`：宿主本地 RPC 端点（`listRooms/messages/remoteSessions/createRoom/addMember/removeMember/send`），UI（RoomTimeline poll）走这里；
3. **`ctx.tools.register(defineTool({...}))` 注册四个 agent 工具**：`chat_create`、`chat_join`、`chat_invite`、`chat_send`——每个带模型可读 description/parameters/output（含 render 意图），execute 里取 `exec.agent.session.id` 作为归属会话、经 remote 落房间；
4. 收件侧：房间 host 按 mentions 投递 → dsh-bridge `deliverExternal` → `target.followup(createUserMessage(...))` → 被 @ 的 agent 会话把消息当用户消息载入上下文。

**结论**：agent 工具是"服务注册制"而非"按会话授权制"——只要 dsh-chat 在 profile 组合里激活，`chat_*` 工具就在该宿主所有会话的 agent 工具目录里可见可调（本会话工具列表里 chat_create/chat_invite/chat_join/chat_send 的存在即为实证）。因此"huahua-dsh-chatroom 装好后希望房间套件可用"= "确保 dsh-chat/dsh-weave/dsh-bridge 三个 bundle 已激活"，我们的插件不需要也不能重复注册同名工具；它新增的是自己的 `chatroom_*` 面（如补丁状态查询、自动巡检、房间健康报告）。

---

## 6. 面向 huahua-dsh-chatroom 的实施建议（下一步任务输入）

### 6.1 推荐形态：kit 式 bundle

- **包名/行 id**：包 `huahua-dsh-chatroom`；行 id `dsh-chatroom-kit`（唯一，避开三件套行 id）。
- **cordis.patch.yml**：只 insert 自己一行，`config` 承载 dataDir 等；**不 insert chat 三件套**（§3.2 决策 A/C）。
- **lib/index.js**：
  - apply 内跑补丁守护（§4.2 逻辑，复用 patch-weave.ps1 的四个替换对）；
  - 提供 `chatroom_patch_status` / `chatroom_patch_apply` 两个 agent 工具（查询与手动触发，方便 agent 自查 weave 补丁态）；
  - host RPC `/dsh-chatroom` 挂 `status`/`patch` 端点（UI 后续可接）；
  - 可选用 `ctx.get('dshWeave')`/`ctx.get('dshBridge')` 探测三件套服务是否在线，缺失时 warn（仅诊断，不 try/catch 强依赖——用可选 `ctx.get` 读全局服务店，行未挂载返回 undefined）。
- **README**：安装序列（三件套先行 → 本包）、升级 weave 后重跑/重启提醒、行 id 冲突说明、`dsh plugin` 命令速查。
- **dev 循环**：本地开发用 `link:` 装（符号链接，改 lib 后重启宿主即新）；发布用 npm `next` tag（三件套即 `publishConfig.tag: "next"`）或 `file:`/`github:` 分发。

### 6.2 若想"一键包含三件套"（kit 理想态，改动更大）

方案 C 的延伸：本包作为**用户层装配说明 + 校验器**——文档给出 profile 用户层 `cordis.patch.yml` 的 insert 片段（含三件套行 + 自己的行 + 可选行级 config），并提供一个 `dsh plugin --profile <name> add huahua-dsh-chatroom-suite` 式 meta 包？——**不可行**：meta 包无法替用户在 bundles 列表里安插多个带服务的行（每行 name 指向一个包、一行一包；让一个包把自己 apply 多次行不通）。正确形态是**安装脚本/文档化装配**：或由 dshmarket 类安装器按清单批量 add（市场未来可支持"suite 条目 = 多个包的组合"），或 profile 模板（PROFILE_TEMPLATES 在 DSH 仓库侧维护，本插件无法染指）。本期建议止步于方案 A + 文档化装配。

### 6.3 发布物（承接 t1 资产清单）

在 `D:\huahua-dsh-chatroom` 下新增 `plugin/` 子工程：
```
plugin/
├─ package.json          # dsh.bundle.patch 清单 + peerDeps + exports（§1.1 骨架）
├─ cordis.patch.yml      # 只 insert 自己（§1.2 骨架）
├─ lib/index.js          # apply：补丁守护 + chatroom_* 工具 + RPC（§1.3/§4/§5）
├─ lib/patch-guard.js    # 四合一替换表（与 patches/patch-weave.ps1 同源、单测覆盖）
├─ tests/                # node --test：markers 检测、替换幂等、node --check
├─ README.md             # 安装序列/升级提醒/冲突规则
└─ LICENSE               # MIT
```
验收路径（仓库 testing 政策要求真实组合）：boot 一个测试 cordis.yml（Loader + 三件套 stub + 本插件），断言补丁守护写入 marker、`chatroom_patch_status` 工具可见可调。

---

## 7. 参考代码位置索引（可核查证据）

| 主题 | 位置 |
|:--|:--|
| `dsh plugin` 实现（pnpm 转发 + reconcilePlugins + 路径锚定） | `D:\Deepseek-harness\apps\cli\src\plugin.ts` |
| CLI 参数/退出码测试（`plugin --profile <p> add/remove/why`） | `D:\Deepseek-harness\apps\cli\tests\args.spec.ts`、`built-bin.e2e.ts` |
| Profile 装载与 patch 层组合（loadProfile/resolveBundleDir/compose） | `D:\Deepseek-harness\packages\boot\app-boot\src\profile.ts`（L332-403） |
| Patch 语义权威实现（insert/id-targeted/!!js/dup-skip/索引） | `D:\Deepseek-harness\vendor\include\src\index.ts` `applyEntryPatches`（L61-153） |
| 插件模块规范（具名导出、禁 default） | `D:\Deepseek-harness\packages\AGENTS.md`、`docs/postmortem/0001-*` |
| 已装包样板 | `C:\Users\cosmo\.dsh\profiles\web\node_modules\{dsh-chat,dsh-weave,dsh-bridge,dshmarket,huahua-dsh-plugin-orchestra}\`（package.json dsh 字段 + cordis.patch.yml + lib/index.js apply） |
| profile 清单样板（deps 来源形态 file:/link:/github:/npm + bundles 序 + 用户层 patch 注释） | `C:\Users\cosmo\.dsh\profiles\web\package.json`、`cordis.patch.yml` |
| 市场侧判定与安装校验 | `C:\Users\cosmo\.dsh\profiles\web\node_modules\dshmarket\lib\{profile.js,install.js,catalog-npm.js,index.js}` |

---

*研究完成。本文件为机制事实来源；§6 的实施拆分建议由船长分配后续任务。*
