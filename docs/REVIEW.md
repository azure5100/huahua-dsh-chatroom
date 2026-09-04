# 发布包评审报告（reviewer-huahua · t4）

> 评审对象：`D:\huahua-dsh-chatroom`（发布根）
> 评审时间：2026-09-04（快照时刻；评审期间工作区有并行编辑，详见 §6）
> 评审人：reviewer-huahua（评审/QA）｜团队：huahua-dsh-chatroom-release
> 结论：**需修订后再发布（NOT PASS）** —— 补丁本体正确性已实证通过；完整性有 2 项缺口、合规去敏有 4 个文件未过红线。

---

## 0. 结论速览

| 检查项 | 结果 |
|:--|:--|
| 1. 完整性核对（vs ASSET-INVENTORY） | ⚠️ 2 项必发资产缺失（D2 联调报告、D3 复盘报告）；PATCH-NOTES 位置与 README 引用不一致 |
| 2. 补丁正确性（干净副本实证） | ✅ 上游 rc.14 官方包上 Fix1–Fix4 全部正确应用、幂等、语法 OK；⚠️ WARN 路径退出码与文档不符 |
| 3. 版权/合规 | ✅ 不含上游源码、无密钥/ticket；❌ 4 个文档仍含真实 IP / 房间 UUID / peerId / 会话 ID / 主机名，违反 README §8 自述红线 |
| 4. 文档质量 | ⚠️ Fix4 过期引用未修订（mechanism/usage-guide）；1 处文件名断链；ASSET-INVENTORY 引用矛盾 |
| 5. 发布前动作 | ⚠️ 工作区有未提交改动（README/ROADMAP/改名） |

---

## 1. 资产完整性核对（基准：docs/ASSET-INVENTORY.md）

| 资产 | 清单目标位置 | 实际状态 | 判定 |
|:--|:--|:--|:--|
| A1 patch-weave.ps1 | patches/patch-weave.ps1 | 存在；与源文件 SHA256 一致（BF74C8…） | ✅ |
| A2 补丁说明 | patches/PATCH-NOTES.md | 存在但位于 **docs/PATCH-NOTES.md**（刚由 docs/PATCHES.md 改名），README L40/L82/L84/L104 仍引用 `patches/PATCH-NOTES.md` | ⚠️ 位置未统一 |
| A3 上游 lib/index.js | 不入库 | 未携带 | ✅ |
| B1 机制研究 | docs/mechanism-study-20260904.md | 存在（docs/mechanism-study.md）；去敏未完成、Fix4 引用过期 | ⚠️ |
| B2 使用指南 | docs/usage-guide-20260904.md | 存在（docs/usage-guide.md）；去敏未完成、Fix 三合一字样过期 | ⚠️ |
| C1 全景图 HTML | docs/dsh-chatroom-overview.html | 存在（docs/architecture-overview.html）；去敏未完成 | ⚠️ |
| D1 Fix3 专项报告 | reports/03-fix3-frame-limit-20260904.md | 存在（docs/fix3-frame-limit-postmortem.md）；缺"被 Fix4 接续"头部注记 | ⚠️ |
| D2 联调报告 | reports/01-integration-20260904.md | **缺失**（README §2/§5、ROADMAP M0 均宣称在册） | ❌ |
| D3 复盘报告 | reports/02-fix1fix2-retro-20260904.md | **缺失**（同上） | ❌ |
| D5 web-boot-repair | reports/archive/…（可选） | 缺失（新 README 已不再列出，视为主动舍弃） | ✅ |
| E1 README | README.md | 存在（仍在演进中，未提交） | ⚠️ |

> 说明：.gitignore 排除了 docs/ASSET-INVENTORY.md（携带去敏前引用），但 README §5 目录树与 §8 仍将其列为仓库组成部分、并作为"去敏点逐项标注"的唯一指引 —— 公开发布（git 提交）后读者将看不到该文件；若整目录打包发布，该文件自身内容又违反红线。两者只能取其一，需决策。

---

## 2. 补丁正确性（干净副本实证）

方法：从 npm 官方源下载 `dsh-weave@0.1.0-rc.14`（shasum 05c6e608…，含 lib/index.js 19.8KB），在临时目录解包后对**原始未打补丁文件**执行 `patch-weave.ps1 -WeaveIndex <副本>`。

**PASS 项（全部实证）：**

1. **锚点匹配**：Fix1（6 空格缩进 dshBridge 行）、Fix2（`builder.secretKey(...)` 4 空格）、Fix3/4a（`const MAX_FRAME_BYTES = 64 * 1024;`）、Fix3b（8 空格 `readToEnd(4096),`）4 个查找串在原始 rc.14 中全部精确命中（含缩进）。
2. **一次应用**：Fix1 try/catch、Fix2 `DSH_WEAVE_PORT ?? 64605` + `bindAddr("0.0.0.0:"+weavePort)`、Fix3/4a 常量→`4 * 1024 * 1024`、Fix3b `readToEnd(MAX_FRAME_BYTES)` 全部落位；旧值（64KB 常量、4096）清除。
3. **备份**：首次执行生成 `index.js.bak-portfix`。
4. **幂等**：二次执行输出 nothing to do，exit 0，内容不再变化。
5. **语法**：打补丁后 `node --check` 通过。
6. **文件缺失**：目标不存在时红字 FAIL 并 exit 1（脚本 L18–21，实证代码路径）。

**FAIL 项（文档与实现不符）：**

- **查找串未命中路径不 exit 1**：对不含任何锚点的文件执行，脚本打印 4 条红字 WARN 后输出绿字 `[OK] nothing to do (all patches active)` 并 **exit 0**。README L25/L58、PATCH-NOTES §1 声称"查找串未命中：红字 WARN，退出码 1"——与实际不符（且"nothing to do / all patches active"文案具有误导性：什么都没打上）。
- **建议**：脚本增加 `$warned` 标志，任一 Fix WARN 后最终 `exit 1`（与文件缺失路径对齐），否则修订 README/PATCH-NOTES 措辞。二者择一，需在发布前定稿。

---

## 3. 版权与合规检查

**通过项：**
- ✅ 仓库不含上游 dsh-chat / dsh-weave / dsh-bridge npm 源码（无 node_modules、无 *.js 副本、无 *.tgz、无 *.bak 残留，已全树核查）。
- ✅ 无密钥/API Key/ticket 全文/私钥（grep `sk-…`/`api_key`/`AKIA`/`BEGIN PRIVATE KEY`/`Bearer` 零命中）。
- ✅ LICENSE（MIT © 2026 azure5100）+ README §7/§8 + PATCH-NOTES §7 的上游归属声明（Xiang Bai / MIT / repo 链接）齐备。
- ✅ 对上游的修改以"补丁脚本 + 片段/行号引用"呈现，符合差量发布口径。
- ✅ .gitignore 覆盖 node_modules / *.bak-portfix；.gitattributes 统一 LF。

**未过红线（违反 README §8「公开去敏红线」，发布前必须清洗）：**

| 文件 | 行 | 内容 |
|:--|:--|:--|
| docs/mechanism-study.md | L1 | 房间 UUID `ea4228fb`（标题内） |
| docs/mechanism-study.md | L3 | **真实内网 IP** `192.168.1.3` / `192.168.1.168` + 主机名 |
| docs/usage-guide.md | L3 | 房间 UUID `ea4228fb` + 主机名 |
| docs/usage-guide.md | L41 | peerId 前缀 `a5f92c23…` / `f7bd62da…` + 主机名 |
| docs/usage-guide.md | L52 | 废弃房间 UUID `e8a3f26b` |
| docs/architecture-overview.html | L135/L144 | peerId 前缀 `a5f92c23…` / `f7bd62da…` |
| docs/architecture-overview.html | L137/L145 | **真实内网 IP** `192.168.1.3` / `192.168.1.168` + 主机名 |
| docs/fix3-frame-limit-postmortem.md | L14 | 房间 UUID `ea4228fb` + peerId 前缀 + 会话 ID `session-3950c88a` + 主机名 |

次要合规/口径项：
- 主机名「大力/丽丽」在多处文档用作 host/成员代称，而 README §8 红线声明"双机实况统一以 主机A/主机B 占位" —— 若昵称算公开口径需在红线里明示豁免，否则全量替换。
- fix3 报告 frontmatter/正文含 gbrain 双链 `[[nango-dsh-weave-复盘-20260904]]` 与本地绝对路径 `D:\Deepseek-harness\restart-dsh-fix3.ps1`；mechanism-study.md L173 亦含 gbrain slug —— 公开发布建议清洗/泛化（非红线级）。
- fix3 报告正文为 Fix3 时点"三合一"快照（L48/L69），发布口径上保留历史原貌可接受，但缺 ASSET-INVENTORY D1 项要求的"被 Fix4 接续"头部注记。

---

## 4. 文档质量

**通过项：**
- README 结构完整（定位/特性/补丁速览/快速开始/结构导航/路线图/致谢/合规），中文正文 + 英文 intro 齐备；§3 补丁速览表已按 Fix3=ack 根因、Fix4=4MB 的最新口径修订。
- PATCH-NOTES.md 逐 Fix 现象/根因/对照/行号表/复现路径/MIT 归属/升级铁律齐备，质量高。
- ROADMAP 里程碑（M0–F1）动机/方案/工作量分级/依赖链清晰；"4MB 之后不再加帧、改走 R1 附件协议"的边界原则明确，可行性合理。

**待修订项：**
1. **Fix4 过期引用未同步**（ASSET-INVENTORY §5 明确要求的修订未落实）：
   - docs/mechanism-study.md L128「Fix3 后上限 1MB」、L146「注意 1MB 帧上限」→ 应为 4MB；L169 落地清单 #4「Fix4：帧上限 1MB→4MB（远期…）」仍列为建议项，ROADMAP 已将其归入 M0 ✅ 完成 —— 两文档自相矛盾。
   - docs/usage-guide.md L50/L69「Fix1+2+3 三合一」→ 应为 Fix1–Fix4（README/PATCH-NOTES/ROADMAP 均已是四合一口径）。
2. **文件名断链**：docs/mechanism-study.md Q6（L158）引用《dsh会议室-使用指南-20260904.md》——实际文件为 docs/usage-guide.md。
3. **README 内部引用**：`patches/PATCH-NOTES.md`（L40/L82/L84/L104）与实际 docs/PATCH-NOTES.md 位置不符（见 §1 A2）；README §5 目录树含 ASSET-INVENTORY.md 但该文件被 .gitignore 排除（见 §1 说明）。
4. **术语一致性**：Fix1–Fix4 名称、64605 端口、64KB→1MB→4MB 演进链在 README/PATCH-NOTES/ROADMAP 中一致 ✅；差异仅集中在 mechanism-study.md 与 usage-guide.md 两篇未完成 Fix4 修订的文档。
5. **HTML 实况残留**：architecture-overview.html L240（会话体积）、L288（「大力已生效/丽丽待重启」状态）、L329（署名）为时点快照叙述，公开口径需决策保留/泛化。

---

## 5. 发布前修订清单（建议 captain 分派）

**Blocker（发布前必须解决）：**
- [ ] B1 合规去敏：清洗上述 4 个文件中的真实 IP / 房间 UUID / peerId 前缀 / 会话 ID（机制研究、使用指南、全景图 HTML、Fix3 报告）；同步决定「大力/丽丽」昵称口径（替换为 主机A/主机B 或明示红线豁免）。
- [ ] B2 完整性：补齐 D2 联调报告、D3 复盘报告（gbrain 导出 + 去敏后入库，命名对齐 README §5），或将 README §2 特性、§5 说明与 ROADMAP M0 范围中关于这两份报告的宣称同步删除/标注待补。
- [ ] B3 PATCH-NOTES 位置统一：移入 patches/PATCH-NOTES.md（贴合 README 引用与 ASSET-INVENTORY 规划），或批量改 README 引用为 docs/PATCH-NOTES.md。
- [ ] B4 ASSET-INVENTORY 定位：从公开仓库中移除其引用并补一段去敏映射说明（或另立公开版），避免"§8 指引指向 gitignore 文件"的悬空引用。
- [ ] B5 补丁 WARN 路径：脚本加 `$warned` 标志使"查找串未命中"最终 exit 1（或改文档措辞），保证 README/说明与实现一致。

**Should（随修订一并处理）：**
- [ ] M1 修 mechanism-study.md / usage-guide.md 的 Fix4 过期引用（1MB→4MB、三合一→四合一、落地清单 #4 勾完成）。
- [ ] M2 fix3 报告头部加"被 Fix4 接续"注记；清洗 gbrain 双链与本地绝对路径。
- [ ] M3 修 mechanism-study.md Q6 断链文件名。
- [ ] M4 提交工作区改动（README.md / docs/ROADMAP.md / docs/PATCHES.md→PATCH-NOTES.md 改名均未 commit）。

**建议流程**：修订完成并 commit 后，重跑一次红线扫描（grep 192.168/peerId/UUID/密钥）+ 干净副本补丁复验，再作最终 PASS。

---

## 6. 评审快照说明

评审期间（19:29–19:45）工作区存在并行编辑：README.md、docs/ROADMAP.md 被修改，docs/PATCHES.md 已改名为 docs/PATCH-NOTES.md（均已反映在本文档）。机制研究/使用指南/全景图/修复报告的敏感内容扫描为 19:4x 快照，若修订正在进行，请以发布前最后一遍扫描为准（§5 流程已含）。

---

*评审人：reviewer-huahua · huahua-dsh-chatroom-release*
