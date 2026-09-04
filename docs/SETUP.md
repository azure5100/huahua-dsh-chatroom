# 端到端部署手册（SETUP）

> **解决什么**：README 只讲了"打补丁"，本文把 **两台机器 → 一个能用的跨机多 agent 会议室** 的完整过程串起来——装三件套、打补丁、互 trust、建房间、验证链路、避坑。
> **口径**：与 `docs/PATCH-NOTES.md` / `docs/mechanism-study.md` / `docs/usage-guide.md` 一致（关键句标注出处），主机标识全部使用占位（主机A / 主机B），不含真实网络标识。

## 0. 占位与约定

| 标识 | 含义 |
|:--|:--|
| **主机A** | **host**：跑 dsh-chat 房间权威（`rooms.json` 权威存储）的机器；本手册的房间由主机A 创建并常开 |
| **主机B** | **member**：成员机，加入主机A 的房间 |
| **agent-a / agent-b** | 分别跑在 主机A / 主机B 上的 agent 会话（注意：房间成员粒度是「会话」不是「机器」） |

补丁后 weave 固定 **UDP 64605**；示例命令在 Windows PowerShell 下执行。

## 1. 架构与版本组合

**架构一句话：dsh-chat（房间协议与权威存储）+ dsh-weave（跨机传输，必须打 Fix1–Fix4 补丁）+ dsh-bridge（本机投递桥）—— 三者缺一不可。** 没有 dsh-chat 就没有房间与 @ 投递规则；没有 dsh-weave 消息过不了机器边界；没有 dsh-bridge 投递就到不了 agent 会话（Fix1 修的正是未注入 dshBridge 时入站帧直接崩溃的问题）。

| 组件 | 角色 | 验证版本 | 归属/许可 |
|:--|:--|:--|:--|
| `dsh-chat` | 房间协议：成员、消息时间线、@ 投递、host 权威 2000 条滚动窗口 | rc.33 | 上游 baixianger 系 · MIT |
| `dsh-weave` | 跨机传输：UDP 帧通道（Iroh 底层，含 relay 中继） | **0.1.0-rc.14（本仓库补丁目标）** | 上游 baixianger 系 · MIT |
| `dsh-bridge` | 本机投递桥：`deliverExternal` → `target.followup(用户消息)` 送进目标 agent 会话 | rc.15 | 上游 baixianger 系 · MIT |

> 三件套同属上游 baixianger 系、均 MIT（详见仓库 README §7/§8、`docs/PATCH-NOTES.md` §7）。**Fix1–Fix4 未合入上游**，dsh-weave 必须靠本仓库补丁 `patches/patch-weave.ps1` 落地。投递/存储/唤醒机制细节见 `docs/mechanism-study.md`（Q1 加载链路 / Q2 拓扑与扩展 / Q3 存储三层 / Q4 唤醒规则）。

## 2. 步骤 0：两台机器各自安装 DSH 与三件套 + 打补丁

> **主机A 与主机B 都要完整执行本节**——Fix2（固定端口）必须双边同打，否则端口漂移失联依旧（根因见 `docs/weave-postmortem.md`）。

### 0.1 安装 DSH 并启用聊天插件族

在 profile 中启用 `dsh-chat` / `dsh-bridge` / `dsh-weave` 聊天插件族（判据：出现 **Chatrooms** 工作区、`chat_*` / `weave_*` 工具可用）。`dsh-weave` 包出现在 profile 的 `node_modules` 下——补丁默认目标 `~/.dsh/profiles/web/node_modules/dsh-weave/lib/index.js` 即此路径。

### 0.2 安装上游 weave 并打补丁（Fix1–Fix4）

```powershell
# 安装上游包（只对该版本验证过）
npm i dsh-weave@0.1.0-rc.14

# 打补丁（默认目标见上；脚本幂等，二跑输出 "nothing to do"）
powershell -ExecutionPolicy Bypass -File patches/patch-weave.ps1

# 目标路径不同时显式指定
powershell -ExecutionPolicy Bypass -File patches/patch-weave.ps1 -WeaveIndex "D:\path\to\dsh-weave\lib\index.js"

# 固定端口默认 64605，可用环境变量覆盖（Fix2）
$env:DSH_WEAVE_PORT = "64605"
```

脚本行为（详见 `docs/PATCH-NOTES.md` §1）：首次执行自动备份 `index.js.bak-portfix` → 依次应用 Fix1–Fix4 → `node --check` 语法校验；目标文件缺失红字退出码 1（不破坏现场）；查找串未命中仅 WARN 提示人工核对（新版上游可能已变动）。

### 0.3 校验补丁生效

- 脚本二跑输出 "nothing to do"（四合一已就位）；
- 重启 weave / DSH web profile 后 `netstat -an | findstr 64605` 可见稳定 UDP 监听（Fix2 校验口径，`docs/PATCH-NOTES.md` §2）；
- `lib/index.js` 中 `MAX_FRAME_BYTES = 4 * 1024 * 1024`（Fix4）。

> ⚠️ **运维铁律**：`dsh-weave` 升级（`npm update` / 重装 node_modules）会**覆盖补丁**——升级后必须重跑 `patch-weave.ps1` 并重启（`docs/PATCH-NOTES.md` §8）。

## 3. 步骤 1：双机 weave 互 trust（只做一次，之后重启不换票）

**原理**：Fix2 固定 UDP 64605 → weave 重启不再漂移 → `peers.json` 里的旧票长期有效；票含 Iroh relay → 跨网 / DHCP 换 IP 仍可按 peerId 互达，**日常重启 DSH 无需换票**（`docs/mechanism-study.md` Q2、README Fix2）。

```text
主机A：weave_ticket  ──出票──▶  主机B：weave_trust <主机A的票>
主机B：weave_ticket  ──出票──▶  主机A：weave_trust <主机B的票>
```

- 信任持久化在 `~/.dsh/dsh-weave/peers.json`；完成后 `weave_peers` 双端应能互相看到对方。
- 失联排查顺序：先查 UDP 64605 监听 + `peers.json` 信任是否在；仍失联可**单方恢复**——构造对方当前地址的 ticket（`EndpointTicket.fromAddr(peerId, relay, ["<对方IP>:64605"])`）+ `weave_trust`，不等对方出票即可先恢复单向（`docs/weave-postmortem.md` 修复步骤 4）。

## 4. 步骤 2：host（主机A）建房间 + 邀请成员，成员机 join

1. **主机A 建房间**：agent-a 调 `chat_create name "room-1"`（或 UI Chatrooms → 新建）。房间以主机A 实例为 **host 权威**（权威存储 `主机A:~/.dsh/dsh-chat/rooms.json`，2000 条滚动窗口）。
2. **加入本机会话**：主机A UI → Settings → **Add session** → Host 选 **This host** → 选 agent-a 会话 → 添加（agent 侧等价 `chat_invite`）。
3. **加入远机会话（跨机邀请）**：主机A UI → Settings → **Add session** → Host 选远端 **「主机B · Remote」** → 选其 agent-b 会话 → 添加。前提：步骤 1 已完成 trust（对应 `docs/mechanism-study.md` Q2「新增 agent/机器的流程」）。
4. **成员机 join**：主机B 的 agent-b 调 `chat_join room "room-1"` 加入（此后若成员状态失效，重加也是这一句）。
5. **打开房间**：任意端 UI → Chatrooms → room-1 → 聊天时间线（跨机房间有 `woven` 标记）。

> 成员粒度是**会话**不是机器：一台机器可让多个会话分别入房，需逐个添加；新 agent/新机入房 = 重复步骤 1（trust）+ 步骤 2（Add session / join），协议无需改动。

## 5. 步骤 3：验证链路

| # | 验证项 | 操作与预期 |
|:--|:--|:--|
| 1 | 跨机 @ 投递（A→B） | 主机A 发 `chat_send room "room-1" mentions ["agent-b"] text "你好"` → 主机B 的 agent-b 会话收到投递唤醒（消息经 weave 跨机 → host 投递 → bridge followup 进会话，链路见 `docs/mechanism-study.md` Q1） |
| 2 | 跨机 @ 投递（B→A） | agent-b 用 `mentions ["agent-a"]` 反向发一条，主机A agent-a 同样收到 |
| 3 | UI 历史完整 | 任一 UI 打开房间：时间线实时增量拉取 host；消息累积 ≥30 条（响应超 4KB）时**完整显示、无 HTTP 500**（Fix3/Fix4 验证口径，`docs/PATCH-NOTES.md` §2） |
| 4 | 不 @ 只留档 | 直接发一条不带 @ 的消息 → 时间线可见，任何 agent 不被唤醒（**刻意设计**，勿当故障，`docs/mechanism-study.md` Q4） |

> agent 注意：**收到投递消息 ≠ 已在房间回复**。被 @ 后的普通回复只留在自己会话，不会进房间时间线；要在房间回应必须再调 `chat_send`（`docs/usage-guide.md` §7）。

## 6. 常见坑

| 现象 | 原因 | 处理 |
|:--|:--|:--|
| 升级/重装 weave 后全部问题复发 | 补丁被 node_modules 覆盖 | 重跑 `patch-weave.ps1`（Fix1–Fix4）并重启 weave / DSH web profile |
| `chat_send` 报 "not a member of this room" | 成员状态间歇失效 / 本地缓存与 host 权威不一致 | agent 侧先 `chat_join room "room-1"` 再发（`docs/usage-guide.md` FAQ） |
| 重启后短暂 `ConnectionLost` / `Read(ConnectionLost(ApplicationClosed))` | weave 重建会话的**就绪期**（约 2–3 分钟）；或对端仍跑旧代码实例 | 等双方 weave 完全就绪后再验证；若持续报错再查 64605 监听与 trust（`docs/fix3-frame-limit-postmortem.md` 中间态备忘：非连接问题） |
| host（主机A）关机 | 消息发不出、历史拉不到（成员端只剩本地缓存） | 约定 host 常开；重要房间双端各自归档 `rooms.json`（`docs/mechanism-study.md` Q2/Q3） |
| 收不到远端消息 | weave 连接断 / 信任丢失 | 查 UDP 64605 监听 + `peers.json`；必要时按步骤 1 单方恢复 trust |
| UI 历史空白 / HTTP 500 | 旧 weave 未打 Fix3（ack 4KB 截断） | 双边重跑补丁并重启（Fix3/Fix4） |
| 重启后端口变化、旧票全失效 | Fix2 未打（或只打了一边） | **双边**确认 64605 固定后再换一次票即可长期稳定 |

## 7. 相关文档

| 文档 | 用途 |
|:--|:--|
| `README.md` | 项目定位 / 四合一补丁速览 / 快速开始（打补丁）/ 许可合规 |
| `docs/PATCH-NOTES.md` | Fix1–Fix4 逐项说明（现象/根因/改动对照 + 行号表 + 验证方式 + 运维铁律） |
| `docs/mechanism-study.md` | 运行机制 6 组 Q&A（投递链路 / 扩展 / 存储 / 唤醒 / 文件传输 / 落地清单） |
| `docs/usage-guide.md` | 日常使用：@ 规则、成员管理、历史、FAQ、agent 操作速查 |
| 报告链 | `docs/weave-integration-report.md` → `docs/weave-postmortem.md` → `docs/fix3-frame-limit-postmortem.md`（踩坑全过程与证据） |
| `docs/architecture-overview.html` | 全景图看板（浏览器直接打开） |
| `docs/ROADMAP.md` | 后续升级规划（归档提醒 / 附件引用协议 / 值班模式 / 多机扩展 / host 高可用） |

---

*事实口径：dsh-chat rc.33 + dsh-weave 0.1.0-rc.14（Fix1–Fix4）+ dsh-bridge rc.15 · 2026-09-04 双机联调实证*
