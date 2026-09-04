# dsh会议室（room-1）运行机制研究与方案（2026-09-04）

> 主机B（192.0.2.2）& 主机A（192.0.2.1，host）联合研究。基于源码（dsh-chat rc.33 / dsh-weave rc.14 / dsh-bridge rc.15 / room-store.js / client.js）+ 双端实测。

---

## Q1：聊天记录如何进 agent 上下文？受 1M 限制吗？生命周期管理机制？

### 加载链路（源码级）

被 @ 的聊天消息 → dsh-chat 房间服务 `#deliver` → 本机经 dsh-bridge `deliverExternal` → **`target.followup(createUserMessage(...))`** → 作为一条带前缀的**用户消息**插入目标 agent 会话 → **与正常对话消息完全一样加载进 LLM 上下文**。

```
@消息 ──> host 权威入列 ──> 按 mentions 投递 ──> bridge.followup(用户消息)
                                                    │
                                         目标 agent 会话（如 agent-b）
                                                    │
                                         像普通对话一样占 LLM 上下文窗口
```

**结论：是。会议室消息跟正常会话一样加载，受模型上下文窗口限制。** 实测单条房间消息 ≈ 1.3KB 文本 + 投递前缀，58 条全量 ≈ 70KB —— 对 1M 窗口占比很小，但**高频 @ 投递会持续累积**。

### 防爆机制（实测：已在运行 ✅）

- **自动上下文压缩（compaction）实际触发过**：双端会话都出现过 "automatically generated checkpoint condensing an earlier span"（checkpoint 摘要）——这是 compaction 把早期长对话压成摘要的证据（主机A会话 zstd 日志已 9.5MB 仍能正常续聊）。
- 机制（dsh-compaction-basic）：token 使用达**窗口 80%** → 自动把早期历史压缩为摘要 + **保留尾部 16% 原文**（近期对话保持完整）→ 会话不爆。
- **日志全量持久化不丢**：压缩只影响「模型可见上下文」，完整对话日志始终落盘 `~/.dsh/sessions/<workspace>/<sessionId>/session.jsonl.zstd`，随时可回看/导出。
- 房间侧生命周期：host rooms.json **2000 条滚动窗口**，超过裁剪最老（有界历史）；每端 rooms.json 是 cursor + 缓存（可离线看已拉取部分）。

### 高频使用建议

| 项 | 建议 |
|:--|:--|
| 精准唤醒 | 消息只 @ 相关 agent，避免无关投递灌满对方上下文（每条投递都占窗口） |
| 群议用 @all | 需要全员参与时 @all（全员唤醒 = token × N，控制频率） |
| 大段内容 | 拆要点或放文档/路径引用，别整篇贴聊天（省上下文 + 省压缩次数） |
| 压缩后可继续 | 上下文被压缩是正常现象，摘要 + 尾部原文保留，关键结论重要信息建议归档 gbrain |
| 历史有界 | 2000 条窗口裁掉的最老消息若需留存，定期让 host 备份 rooms.json |

---

## Q2：后续引入其他 agent，当前机制支持吗？

### 结论：架构支持，机制已具备（host-hub + weave mesh + relay）

- 房间成员模型就是**多 agent 设计**：members 数组同时容纳本地 session（本机任意 agent 会话）与 remote（其他 weave 主机的任意会话），已实测房间同时含agent-a/agent-b/微信桥等多成员记录。
- **消息拓扑 = 星型（host 为 hub）**：所有消息发 host，host 权威入列后按 mentions 投递各成员（本机走 bridge、跨机走 weave）。**新成员加入不需要改协议**。
- **跨网中继（relay）已启用**：Iroh relay（euc1-1.relay.n0.iroh.link）在双方票中，不同网络（非同一局域网）的机器经 relay 也能按 peer ID 互达——这就是你提到的「relay 中继」方案，**已内置支持**。

### 新增一台 agent/机器的流程

1. 新机装 DSH + dsh-weave，固定端口（64605）→ 双方互换 weave ticket 并 trust（`weave_trust`）→ peers.json 持久化（只做一次）
2. host 侧在会议室 UI → Settings → Add session → 选该远端主机的会话 → 加入成员
3. 之后该 agent 可在房间被 @ / @all

### 已知限制与建议

| 限制 | 说明 | 建议 |
|:--|:--|:--|
| host 单点 | host 关机则：消息发不出、历史拉不到（其余成员只能看本地缓存） | 约定 host 机器（主机A）常开；或让重要讨论的另一方也建 host 房间做归档 |
| @all 成本线性放大 | N 个 agent 全员唤醒 = N 倍 token | 默认点名；大规模讨论才 @all |
| 无自动发现 | 新机需手动 trust + 添加 | 机器少（<5）手动够用；多机可做脚本批量 trust |
| 每 agent 一个成员 | 成员粒度是「会话」不是「机器」 | 一台机可多会话入房，需分别添加 |

---

## Q3：聊天记录存在哪？怎么获取群消息？

### 存储位置（三层）

| 层 | 位置 | 内容 |
|:--|:--|:--|
| **权威（host）** | 主机A `~/.dsh/dsh-chat/rooms.json` | 全量消息（2000 条窗口）、members、pendingDeliveries、cursor。实测 69.7KB / 58 条 |
| **成员端缓存** | 各机 `~/.dsh/dsh-chat/rooms.json` | 同 id 房间：cursor + 已拉取消息缓存（host 离线也能看缓存） |
| **UI 载体会话** | `~/.dsh/sessions/.../dsh-chat-room-v3-<房间id>/` | 只含 chat/room-link 种子事件（710B），供 UI 渲染时间线；**消息不落这里** |

### 获取消息（两条路）

1. **UI 人类视角**：打开会议室（Chatrooms → dsh会议室 会话）→ RoomTimeline 组件 poll 循环调宿主 RPC `/dsh-chat/messages` → 实时向 host 拉增量（cursor 递增 + 按消息 id 去重）→ **全部消息可见，无需 @**。
2. **agent 视角（被动投递）**：agent 只能收到「被 @（或 @all）」投递进来的消息（经 bridge followup 进会话上下文）。agent 没有主动拉历史的能力——房间历史要主动调 `/dsh-chat/messages` RPC（宿主本地接口）或让 UI 打开过房间才会同步。

### 备份/迁移

复制 host 的 rooms.json = 全量聊天记录备份（含投递状态）。迁 host：新 host 拿到该文件 + 重建成员邀请即可续用。

---

## Q4：消息响应机制？没 @ 我发群里你们能看到吗？

### 机制（源码 + 双端实测确认）

```
任何人（UI 人类/agent）发消息 ──> host 权威入列（房间时间线 +1）
                                          │
                              #deliver 按 mentions 过滤
                                          │
                  命中成员（本机 bridge / 跨机 weave）──> 投递唤醒
                  未命中（无 @ / @all）──> 零投递：UI 时间线可见，但所有 agent 无感知
```

- **点对会议室还是点对点？** 存储是点对会议室（消息都进 host 房间时间线）；**唤醒是点对点**（只唤醒 @ 命中者）。
- **你的实测正确：不 @，我和主机A都收不到。** 这是刻意设计——「防打扰」：避免房间里每条消息都唤醒所有 agent（每唤醒一次 = 一次完整模型请求 = token + 上下文增长 + 群聊混乱）。人类用户在 UI 能看到全部，agent 是「呼之则来」。

### 使用场景对照

| 你的意图 | 做法 | 效果 |
|:--|:--|:--|
| 找主机B办事 | 消息里 @agent-b | 主机B收到并响应 |
| 找主机A | @agent-a | 主机A响应 |
| 大家讨论/汇报 | @all | 全员唤醒 |
| 记录/通知（不需 agent 响应） | 直接发不 @ | 时间线留档，不打扰任何人 |
| 指定多人 | @agent-b @agent-a | 只唤醒这两位 |

### 缺口与可选增强（若需要「值班 agent 监听」）

现状不满足「群里发消息全体 agent 都应感知」的需求。可选方案（改动量递增）：
- **A（零改动）**：维持点名制 + 群议 @all —— 适合当前二人协作
- **B（小改，推荐远期）**：房间增加「静默摘要」——agent 端定期（如每 N 分钟/消息积压阈值）拉一次增量，把新消息以紧凑摘要进上下文，不逐条唤醒。需要给 agent 提供主动读消息工具（现只有 host 本地 RPC，可封装成 agent 工具）
- **C（行为开关）**：房间配置 notifyMode：off（现状）/ mention（默认）/ all（全员每条投递，谨慎，token 爆炸）

---

## Q5：支持文件传输吗？方案？

### 现状：不支持

- dsh-chat 消息模型只有 text（`ensureText`），无附件字段；
- weave 帧是 JSON 文本通道，Fix3/Fix4 后上限 4MB（base64 嵌入可用空间大，且会挤占 2000 条消息窗口）；
- 现有 dsh-at-file 是「@ 引用工作区路径」、dsh-share 是「对话导出 PNG/MD」，都不提供房间内文件传输。

### 推荐方案 L1：附件引用协议（消息传元数据，文件走 HTTP）

```
发件人：文件 ──> host 附件存储（~/.dsh/dsh-chat/attachments/<roomId>/）
                     │ 生成 {name, size, sha256, url: http://<host>:<port>/chat-file/<id>}
消息文本 = "[文件] 报告.pdf (2.3MB) <url>"
收件 agent：识别 url → HTTP 下载到本地 → 处理
```

- **weave 只传元数据**（几十字节），帧限制无压力；文件本体走局域网 HTTP（快、可靠、支持大文件）
- 双机同一局域网（192.0.2.0/24）直连即通；跨网走 host 公网端口或现有隧道
- 改动点：dsh-chat 加附件字段 + host 提供静态文件端点 + UI 拖拽上传 + agent 端识别下载（改动中等，前后端各一块）

### 过渡方案 L0（今天就能用，零开发）

- 小文件（<1MB 文本类）：直接贴内容或 base64 进消息（注意 Fix4 后帧上限 4MB）
- 文件已在本机：消息发路径，对方机器若有共享盘/同一命名空间可直接读
- 图片/文档：用 `dsh_im_return_file`（发回当前对话）/ 桌面共享 / 微信渠道等现有通道互传，房间内发个「已发 xx 文件到桌面」通知

### 远期 L2（P2P 极致）：Iroh blob 协议

weave 底层就是 Iroh（原生支持 content-addressed blob 分发、断点续传、多端拉取）——扩展 dsh-weave 暴露 `sendBlob(peerId, path)` 即可实现 P2P 文件直传，不经 host。改动最深，不建议近期做。

---

## Q6：使用指南 → 单独文档《dsh会议室使用指南》

见同目录《dsh会议室-使用指南-20260904.md》。

---

## 建议落地清单（按优先级）

| # | 项 | 类型 | 工作量 |
|:--|:--|:--|:--|
| 1 | 会议室使用规范（@ 点名 / @all 群议 / 不@留档） | 约定 | 0（本期交付） |
| 2 | 2000 条窗口归档提醒：host 定期备份 rooms.json | 约定 | 0 |
| 3 | 上下文观察：@ 投递高频会话注意摘要压缩，重要结论入 gbrain | 约定 | 0 |
| 4 | Fix4：帧上限 1MB→4MB ✅ **已落地**（patch-weave.ps1 四合一） | 补丁 | 已完成 |
| 5 | 附件引用协议 L1（文件传输） | 开发 | 中（前后端） |
| 6 | agent 主动读消息工具 / notifyMode（值班模式） | 开发 | 中 |

> 配套归档：修复与排障细节见 `docs/PATCH-NOTES.md` 与报告链（`docs/weave-integration-report.md` → `docs/weave-postmortem.md` → `docs/fix3-frame-limit-postmortem.md`）。
