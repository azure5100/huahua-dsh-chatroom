# huahua-dsh-chatroom

> **English intro**: Cross-machine DSH group chat (dsh-chat × dsh-weave) — adapter fixes (Fix1–Fix4), mechanism research, field reports and a maintenance roadmap for the "multi-agent meeting room" setup, packed as a reproducible, publishable repo.

**中文定位**：dsh-chat / dsh-weave **跨机群聊的适配修复与运维文档集**。我们在双机协作排障（主机A host 机 & 主机B 成员机）联调"多 agent 会议室"的过程中，发现并修复了 dsh-weave `0.1.0-rc.14` 的四个底层缺陷（Fix1–Fix4），并把机制研究、排障与复盘报告、可视化全景图、升级规划整理成本仓库 —— 目标是让任何人能**一条命令复现修复**、读懂机制、接着往下演进。

---

## 1. 项目定位

DSH（DeepSeek Harness）跨机群聊由三件套协作构成：

| 组件 | 作用 | 版本（本项目验证基准） |
|:--|:--|:--|
| `dsh-chat` | 会议室/房间协议：成员、消息时间线、@ 投递、2000 条滚动窗口 | rc.33 |
| `dsh-weave` | 跨机消息传输（Endpoint/UDP 帧通道，底层基于 Iroh，含 relay 中继） | **0.1.0-rc.14**（补丁目标） |
| `dsh-bridge` | 本机 agent 会话桥：把投递消息 `followup` 进目标会话上下文 | rc.15 |

部署拓扑为 **host-hub 星型 + weave P2P mesh + Iroh relay**：所有消息发往 host，host 权威入列后按 mentions 投递各成员（本机走 bridge、跨机走 weave）。

> **上游版本事实**：dsh-weave `0.1.0-rc.14` 存在四个会导致会议室不可用的缺陷（见 §3），且修复未合入上游。本项目以三种形态交付：**自研补丁脚本/守护**（可执行）、**差量说明**（`docs/PATCH-NOTES.md`）、**完整核心代码快照**（`upstream-patched/`，含 weave Fix1–Fix4 已打补丁版），合规细节见 §8。

## 2. 功能特性

- **四合一幂等补丁** `patches/patch-weave.ps1`：一次运行修复 Fix1–Fix4；重复执行自动跳过已打项（"nothing to do"）；首次执行自动备份 `index.js.bak-portfix`；写盘后自动 `node --check` 语法校验；目标文件缺失时报红字并以退出码 1 结束；单个 Fix 目标串未命中仅红字 WARN 提示人工核对（新版上游可能已变动），不中断、不视为失败（幂等友好）。
- **DSH 插件（dsh.bundle）**：仓库根即插件包（name `huahua-dsh-chatroom`，loader 行 id `dsh-chatroom-kit`）——装好后启动即自动守护 weave 补丁（缺 Fix1–Fix4 则备份重打并提示重启生效），并新增 `chatroom_patch_status` / `chatroom_patch_apply` 两个 agent 工具与 `/dsh-chatroom` host RPC（见 §4 方式二）。
- **完整核心代码快照** `upstream-patched/`：dsh-chat / dsh-weave / dsh-bridge 整包副本（dsh-weave 为 Fix1–Fix4 已打补丁版），满足"看全部代码"需求，出处与版权见 `upstream-patched/UPSTREAM-PATCHED.md`。
- **机制研究文档**：6 组 Q&A 讲清"聊天记录如何进 agent 上下文 / 多机扩展 / 存储三层 / 唤醒机制 / 文件传输方案 / 使用指南"。
- **可视化全景图**（单文件 HTML，浏览器直接打开）：拓扑架构、核心消息流、数据存储地图、上下文生命周期、补丁时间线、排障速查、@ 规则速查 7 大章节。
- **完整排障证据链**：联调报告（过程）+ 复盘报告（根因归纳）+ Fix3 专项报告（证据链），编号成链可追溯。
- **升级路线图**：归档提醒、附件引用协议（文件传输 L1）、agent 主动读消息工具/notifyMode、多 agent 扩展、host 高可用 —— 见 `docs/ROADMAP.md`。

## 3. 四合一补丁速览（Fix1–Fix4）

| Fix | 缺陷（现象/根因一句话） | 修复形态 | 版本演进 |
|:--|:--|:--|:--|
| **Fix1** | `#dispatch` 内无条件访问未注入的 `dshBridge` 服务 → 任何入站帧抛 "cannot get property dshBridge without inject"，消息投递全挂 | 把 dshBridge 访问包进 `try/catch`，注入缺失时优雅降级 | — |
| **Fix2** | weave Endpoint 默认绑定**随机 UDP 端口**，重启即漂移 → peers.json 里的旧票全部失联 | schema/启动逻辑固定端口 **64605**（`DSH_WEAVE_PORT` 环境变量可覆盖），重启不再漂移 | — |
| **Fix3** | 批量拉取历史时响应超限：入站帧上限仅 64KB，且 ack 回执只读 `readToEnd(4096)`（4KB）→ `room.read` 批量响应抛 `TooLong`，UI 历史空白、HTTP 500 | **历史 ack 4KB→1MB 的根因修复**：ack 回执 `readToEnd(4096)` → `readToEnd(MAX_FRAME_BYTES)`，与帧上限对齐；帧上限同步 `64KB → 1MB` | 64KB·4KB → **1MB** |
| **Fix4** | 1MB 对增量历史拉取与更大消息仍偏紧，远期有复发风险 | **1MB→4MB 防远期复发**：帧上限提升至 4MB（脚本兼容 64KB/1MB 两种旧值，含"已打补丁则跳过"幂等检测） | 1MB → **4MB** |

> 行号级改动对照（基于上游 rc.14 `lib/index.js`）、每个 Fix 的原始代码片段与部署版落点，见 `docs/PATCH-NOTES.md`。

## 4. 快速开始

### 4.1 方式一：手动打补丁（一次性 / 逃生通道）

前置：Node.js；目标环境装好上游 `dsh-weave@0.1.0-rc.14`（补丁只对该版本验证过）。

```powershell
# 1.（新装时）安装上游包
npm i dsh-weave@0.1.0-rc.14

# 2. 进入含 lib/index.js 的 dsh-weave 包根目录（node_modules/dsh-weave），然后执行补丁
powershell -ExecutionPolicy Bypass -File patches/patch-weave.ps1
```

补丁脚本行为：

- 首次执行：自动备份原文件为 `index.js.bak-portfix` → 依次应用 Fix1–Fix4 → `node --check` 语法校验；
- 再次执行：检测到已打补丁，输出 "nothing to do" 并正常退出（幂等）；
- 目标文件缺失：红字报错并以退出码 1 结束（不会破坏现场）；查找串未命中：红字 WARN 提示人工核对（新版上游可能已变动），不视为失败、脚本继续。

打完后重启 weave / DSH web profile，固定端口 64605 生效。

> ⚠️ **运维铁律**：`dsh-weave` 一旦升级（`npm update` 等）会覆盖 node_modules 里的补丁 —— **升级后必须重跑本脚本**（或安装方式二后重启一次即可自动重打）。

### 4.2 方式二：作为 DSH 插件安装（kit，推荐）

仓库根即一个 **dsh.bundle 插件**：`package.json` 声明 `dsh.bundle.patch = ./cordis.patch.yml`（loader 行 id `dsh-chatroom-kit`），发布物 = `lib/` + `cordis.patch.yml` + README/LICENSE。

```powershell
# 前置：目标 profile 已装好三件套（重复 add 幂等、无副作用）
dsh plugin --profile web add dsh-chat dsh-weave dsh-bridge

# 从本仓库安装 kit（GitHub 源；发布 npm 后可直接 add huahua-dsh-chatroom）
dsh plugin --profile web add github:azure5100/huahua-dsh-chatroom
# 本地开发/热更可用 link:（符号链接）
dsh plugin --profile web add link:D:\huahua-dsh-chatroom
```

装好并重启 profile 后：

- **启动即补丁守护**：weave 缺 Fix1–Fix4 时自动备份（`.bak-chatroom`）重打并 `node --check`，日志提示**重启生效**（升级 weave 后重启一次即自动恢复，无需手跑 ps1）；
- **agent 工具**：`chatroom_patch_status`（逐 Fix 查询 applied/missing）、`chatroom_patch_apply`（手动触发守护）；
- **host RPC**：`/dsh-chatroom`（`status` | `patch`，authority `trusted-host`）。

> ⚠️ **行 id 唯一铁律**：`dsh-chatroom-kit` 不撞三件套行 id（`dsh-chat`/`dsh-weave`/`dsh-bridge`）；本包**不 insert 三件套行**（重复行 id 会拒绝启动）。三件套以 profile 显式依赖存在，本包 peerDependencies 只声明 `@deepseek-ai/*` 主机包。

> 📘 **想从零搭起完整三件套会议室**（双机装 DSH 与 dsh-chat/dsh-weave/dsh-bridge、互 trust、host 建房间 + 邀请成员、验证链路、常见坑）？见 **[docs/SETUP.md](docs/SETUP.md)**（端到端部署手册）。

## 5. 仓库结构与文档导航

```
huahua-dsh-chatroom/
├─ README.md                       ← 本文件：定位/补丁速览/快速开始（手动补丁 + 插件安装）/文档导航/合规
├─ package.json                    ← dsh.bundle 清单：本仓库 = 可安装 DSH 插件 huahua-dsh-chatroom（v0.1.0）
├─ cordis.patch.yml                ← 插件 loader patch：只 insert 一行 dsh-chatroom-kit
├─ lib/                            ← 插件实现：index.js（补丁守护 + chatroom_* 工具 + RPC）+ patch-guard.js（纯逻辑）
├─ tests/                          ← node --test 单测（patch-guard：markers / 幂等 / node --check）
├─ patches/
│  └─ patch-weave.ps1              ← 四合一幂等补丁（Fix1–Fix4，手动/逃生通道，与 lib 守护同源）
├─ upstream-patched/               ← 三件套完整核心代码快照（weave 为 Fix1–Fix4 已打补丁版，见 UPSTREAM-PATCHED.md）
├─ docs/
│  ├─ PATCH-NOTES.md            ← Fix1–Fix4 补丁说明（问题/改动对照 + 行号表 + 验证方式 + MIT 归属）
│  ├─ SETUP.md                  ← 端到端部署手册（从零搭双机会议室：三件套安装/互 trust/建房间/验证/避坑）
│  ├─ mechanism-study.md        ← 运行机制研究与方案（6 组 Q&A + 落地清单）
│  ├─ usage-guide.md            ← 会议室使用指南（@ 规则/成员管理/跨机配置/FAQ/Agent 操作速查）
│  ├─ EXTERNAL-BRIDGE.md        ← 外部 agent/桥接入指南（HTTP RPC 伪成员模式/@捕获/轮询，免 weave）
│  ├─ architecture-overview.html   ← 全景图看板（单文件自包含，浏览器直接打开）
│  ├─ weave-integration-report.md  ← 跨机联调报告（Fix1 定位与打通过程；历史快照）
│  ├─ weave-postmortem.md          ← Fix1/Fix2 复盘报告（根因 A/B 归纳 + 修复 6 步；历史快照）
│  ├─ fix3-frame-limit-postmortem.md ← Fix3 专项排障报告（完整证据链；历史快照，由 Fix4 接续）
│  └─ ROADMAP.md                ← 升级路线图（本仓库后续演进规划）
└─ LICENSE / .gitignore / .gitattributes
```

> 排障报告链（编号成链可追溯）：`docs/weave-integration-report.md`（联调过程）→ `docs/weave-postmortem.md`（Fix1/Fix2 复盘）→ `docs/fix3-frame-limit-postmortem.md`（Fix3 专项，由 Fix4 接续）。

**阅读顺序建议**：先 README（本文）→ `docs/SETUP.md`（端到端部署）→ `docs/mechanism-study.md`（机制）→ `docs/usage-guide.md`（怎么用）→ `docs/EXTERNAL-BRIDGE.md`（外部 agent/桥接入）→ `docs/PATCH-NOTES.md`（改了什么）→ 排障报告链 `weave-integration-report → weave-postmortem → fix3-frame-limit-postmortem`（怎么踩出来的）→ 打开 `docs/architecture-overview.html` 看图。

## 6. 升级路线图

本仓库不止于"修好即止"。基于机制研究落地清单，后续规划了 **归档提醒机制 → 文件传输 L1 附件引用协议 → agent 主动读消息工具 / notifyMode → 多 agent 扩展工具化 → host 高可用** 等里程碑（每项含动机、方案要点与工作量估计），详见：

👉 **[docs/ROADMAP.md](docs/ROADMAP.md)**

## 7. 致谢与关联项目

- **上游项目**（MIT © Xiang Bai）：
  - [`github.com/baixianger/dsh-chat`](https://github.com/baixianger/dsh-chat) —— 会议室/房间协议
  - [`github.com/baixianger/dsh-weave`](https://github.com/baixianger/dsh-weave) —— 跨机消息传输（补丁目标）
  - dsh-bridge —— 本机 agent 会话桥
- **双机协作排障**：主机A & 主机B（跨机联调、Fix1–Fix4 定位与验证；公开叙述以主机占位代称）
- **整理发布**：huahua-dsh-chatroom-release 团队（架构 / 工程 / 文档 / 评审）

## 8. 许可与合规说明

- 上游 `dsh-chat` / `dsh-weave` / `dsh-bridge` 均为 **MIT 许可**（author Xiang Bai）。
- **上游源码处理**：正式安装走官方 npm + 自研补丁（`patches/patch-weave.ps1`，或装插件后由 `lib/` 守护自动执行）；另在 `upstream-patched/` 收录三件套**完整核心代码快照**（MIT 允许再分发，已逐包保留 LICENSE 与归属；weave 副本为 Fix1–Fix4 已打补丁状态，详见 `upstream-patched/UPSTREAM-PATCHED.md`）。对上游的改动始终以"补丁差量 + 已打补丁快照"双形态呈现并附行号引用（`docs/PATCH-NOTES.md`）。
- 仓库自研部分（补丁脚本、文档、图表、报告）遵循宽松许可发布，使用/分发时建议保留出处声明。
- **公开去敏红线**：本仓库公开发布内容不含真实内网 IP、weave peerId 全文、ticket、房间 UUID 与真实主机名；双机实况统一以"主机A / 主机B"占位叙述（保留排障叙事本身）。资产清单与逐项去敏记录属团队内部文件，不入库。

---

*维护：huahua-dsh-chatroom-release 团队 · 基于 dsh-weave 0.1.0-rc.14 联调实证（2026-09-04）*
