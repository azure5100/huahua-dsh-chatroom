# upstream-patched · 三件套完整核心代码（含 dsh-weave Fix1–Fix4 已打补丁快照）

> 本目录收录 dsh-chat 会议室三件套（dsh-chat / dsh-weave / dsh-bridge）的**完整核心代码副本**，供审阅、对照与学习使用。方案 B：不止差量补丁，直接给你"能看全部代码"的整包。

## 1. 目的

- 完整展示三件套运行机制的真实代码（房间协议 / 跨机传输 / 会话桥接），配合 `docs/mechanism-study.md` 阅读；
- 其中 **dsh-weave 副本已打 Fix1–Fix4 补丁**（与当前部署一致）——这是本目录的核心价值：读者可直接看到"修好的代码长什么样"。

## 2. 收录内容与版本

```
upstream-patched/
├─ UPSTREAM-PATCHED.md                     ← 本说明
├─ dsh-weave-0.1.0-rc.14/                  ← 整包拷贝（Fix1–Fix4 已打补丁版）
│  ├─ package.json / LICENSE / README.md / README.zh.md / RELEASES.md
│  ├─ cordis.patch.yml
│  ├─ docs/（ADR-001 / ARCHITECTURE / PROTOCOL / SECURITY）
│  └─ lib/（client.js / index.d.ts / index.js）
├─ dsh-chat-0.1.0-rc.33/                   ← 官方原版整包拷贝（未改动）
│  ├─ package.json / LICENSE / README.md / README.zh.md / RELEASES.md
│  ├─ cordis.patch.yml
│  └─ lib/（client.js / index.d.ts / index.js / room-store.js）
└─ dsh-bridge-0.1.0-rc.15/                 ← 官方原版整包拷贝（未改动）
   ├─ package.json / README.md / README.zh.md / RELEASES.md
   ├─ cordis.patch.yml
   └─ lib/（index.js / types/index.d.ts）
```

## 3. 来源与版权

- **来源**：全部来自本机已安装的官方 npm 包（`~/.dsh/profiles/web/node_modules/` 内 `dsh-chat` / `dsh-weave` / `dsh-bridge`），版本如上标注。
- **版权**：作者 **Xiang Bai**（dsh-chat、dsh-weave 的 package.json 明示 author；dsh-bridge 未填 author 字段），三件套均为 **MIT 许可**。每个包含 `LICENSE` 的原样保留（dsh-weave、dsh-chat）；**dsh-bridge 官方包未附独立 LICENSE 文件**，其 MIT 声明在 `package.json`（`license: "MIT"`），正式许可文本以官方 npm 源为准。
- **改动状态**：
  - `dsh-weave-0.1.0-rc.14`：**含本项目适配**——Fix1–Fix4 四合一补丁已应用（见下 §4）。除此之外无其它改动，文件保持原样。
  - `dsh-chat-0.1.0-rc.33` / `dsh-bridge-0.1.0-rc.15`：**官方原版，未做任何改动**。
- 本目录仅作展示/学习用途的再分发快照（MIT 条款允许，已保留版权声明）；**不作为安装来源**——正式安装请走 npm 官方源 + 本仓库 `patches/patch-weave.ps1`。

## 4. dsh-weave Fix1–Fix4 补丁状态（已确认）

`dsh-weave-0.1.0-rc.14/lib/index.js` 四个补丁标记全部命中（2026-09-04 拷贝时点核对）：

| Fix | 检测标记 | 状态 |
|:--|:--|:--|
| Fix1 · dshBridge 访问 try/catch（`#dispatch`，L300–303） | `try { bridge = this.ctx?.dshBridge` | ✅ 已应用 |
| Fix2 · 固定 UDP 端口 64605（`DSH_WEAVE_PORT` 可覆盖，L71–77） | `DSH_WEAVE_PORT` | ✅ 已应用 |
| Fix3/Fix4 · `MAX_FRAME_BYTES` = 4MB（L32–35） | `const MAX_FRAME_BYTES = 4 * 1024 * 1024;` | ✅ 已应用 |
| Fix3b · ack 读满 `readToEnd(MAX_FRAME_BYTES)`（L239） | `stream.recv.readToEnd(MAX_FRAME_BYTES),` | ✅ 已应用 |

每项修复的「现象/根因/改动对照/部署版行号/验证方式」详见 [`docs/PATCH-NOTES.md`](../docs/PATCH-NOTES.md)（本目录行号与 PATCH-NOTES 的部署版基准一致）。

## 5. 与 patches/patch-weave.ps1 的关系

- `patches/patch-weave.ps1`：对**官方原版 rc.14** 打相同四合一补丁的**可执行脚本**——正式安装（`npm i dsh-weave@0.1.0-rc.14`）后跑它即可复现本目录的 weave 状态，幂等、自动备份、`node --check` 校验。
- 本目录：**已打补丁的结果快照**——给"想直接读最终代码"的人，无需自行打补丁。
- 两者同源：替换表完全一致；如未来分叉以 `patch-weave.ps1` 为权威并同步更新两处。

## 6. 同步与过期说明

- 上游发新版后，本快照即**过期**：以官方 npm 源为准（dsh-chat / dsh-weave / dsh-bridge 均可能更新）。
- 拿到新版 dsh-weave 后：先确认新版的原始代码与 rc.14 差异（升级可能顺带修掉 Fix1–Fix4 之一），再决定是否重跑 `patches/patch-weave.ps1`（脚本对已修复项会跳过；对查找串未命中的项会红字 WARN 提示人工核对，不视为失败）。
- 更新本目录：重新从官方包拷贝三件套 + 重跑补丁 + 核对 §4 标记表后提交。

## 7. 升级铁律

`dsh-weave` 升级会覆盖 node_modules 里的补丁 → **升级后必须重跑 `patch-weave.ps1`（或安装 plugin/ 的补丁守护自动处理），并重启 DSH 使新代码生效**。

## 8. 合规说明

- 全文已做去敏检查：本目录不含任何真实内网 IP / peerId / 房间 UUID / 个人标识 / 凭据（拷贝自官方公共 npm 包，天然干净）。
- 包内代码与 LICENSE **保持原样未修改**（dsh-weave 的 Fix1–Fix4 是其当前部署版的真实状态，属本项目唯一改动并已在 §4/§5 说明）。
