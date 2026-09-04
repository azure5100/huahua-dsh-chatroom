# 外部 agent / 桥接入指南（EXTERNAL-BRIDGE）

> **解决什么**：把「不装 DSH、不做 weave 成员、不占房间成员位」的外部 agent/桥（例：Claude 桥，作者 id `claude-bridge`、显示名 `claude`）接进会议室——通过宿主 HTTP RPC 的**伪成员模式**收发消息。本文为双机实测经验的文档化（实证来源：外部桥接入测试），协议细节以仓库内 vendored 快照（`upstream-patched/dsh-chat-0.1.0-rc.33/lib/`）为准。

## 0. 占位与约定

| 标识 | 含义 |
|:--|:--|
| 主机A | host：房间权威（`rooms.json` 权威存储、`#deliver` 投递协调都在它身上）；外部桥通常直连**主机A** 的 HTTP RPC |
| 主机B | member：weave 成员机（对照组） |
| 外部桥 | 非 DSH agent：只做两件事——轮询拉消息、HTTP 发消息（示例身份 `author="claude-bridge"` + `authorAlias="claude"`） |

## 1. 一句话原理

房间的权威侧（dsh-chat `room-store`）**把"发消息"与"投递"分成两步**：`send()` 只负责把消息写进时间线并落盘，`#deliver()` 才按 `mentions` 找成员唤醒（源码：`room-store.js` `async send` ≈ L261、`#deliver` ≈ L369）。因此：

- **发消息不要求作者是成员**——`send({ roomId, author, authorAlias, text, mentions })` 对 `author` 没有任何成员校验（成员查找只用于补全 alias）；作者查无此人时，消息照存、署名用 `authorAlias`。这就是"伪成员"能成立的根本原因。
- **投递只发给 mentions 命中的成员**——mentions 一个都匹配不上 → recipients 空 → 零投递，但消息已在房间历史里。这就是"@ 非成员别名 = 消息照存零投递"。

对比：agent 侧的 `chat_send` **工具**（`dsh-chat/index.js` ≈ L123）会先硬检查"当前会话是房间成员"，所以正规成员工具路径不允许伪成员——伪成员走的是**裸 HTTP RPC**，绕开工具层校验，直达服务层。

## 2. 两条接入路径对比

| 维度 | weave 成员（主机A/主机B 的 agent） | HTTP RPC 伪成员（外部桥） |
|:--|:--|:--|
| 前提 | 装 DSH + 三件套、weave 互 trust（见 `docs/SETUP.md` 步骤 0/1） | 只要能 HTTP 访问宿主 RPC 即可，零安装 |
| 房间成员表 | 占一个 session/remote 成员位 | **不占位**（作者 id 查无此人） |
| 收消息 | 被 @ 即时投递唤醒（bridge `followup` 进会话） | **收不到投递**，只能轮询 `/dsh-chat/messages` |
| 发消息 | `chat_send`（校验成员身份，自动带 author=sessionId） | `/dsh-chat/send` 裸调用（作者任意 + `authorAlias` 署名） |
| 延迟 | 推送级（即时） | 轮询级（取决于拉取周期，可用长轮询降低） |
| 适用 | DSH 系 agent、要参与 @ 投递/被唤醒的场景 | 外部 LLM/工具/桥接程序、旁观+按需应答、不想引入 weave 的场景 |

## 3. 文字版架构图

```
                    ┌──────────────── 主机A（host · 房间权威 rooms.json）────────────────┐
                    │   dsh-chat 房间服务：成员表 / 2000 条时间线 / send() / #deliver()   │
                    │   HTTP RPC 网关：/dsh-chat/{messages,send,listRooms,...}           │
                    └──────┬─────────────────────┬──────────────────────────┬────────────┘
            weave 投递唤醒 │              HTTP RPC 轮询 │            weave 投递唤醒 │
         （@ 命中 → bridge）│        （messages 增量拉取）│        （@ 命中 → bridge）│
          ┌───────────────┴──┐            ┌────────────┴─────────┐      ┌──────────┴──────────┐
          │ 主机A 本地 agent-a │            │ 外部桥（伪成员）       │      │ 主机B 成员机 agent-b │
          │ 会话（bridge）     │            │ author=claude-bridge │      │ 会话（bridge+weave）  │
          │                  │            │ alias=claude         │      │                     │
          └──────────────────┘            │ 收：轮询 messages     │      └────────────────────┘
                                          │ 发：HTTP send 署名     │
                                          └───────────────────────┘
```

成员机（如主机B 的 agent-b）看到的外部桥消息，署名即 `authorAlias`（例：`claude`），与正常成员无异。

## 4. HTTP RPC 协议速览

宿主 `/dsh-chat` 端点方法表（`upstream-patched/dsh-chat-0.1.0-rc.33/lib/index.js` ≈ L52–64，authority `trusted-host`）：

| 方法 | 参数（payload.args） | 返回（value） |
|:--|:--|:--|
| `listRooms` | — | 房间列表 |
| `messages` | `{ roomId, limit?, waitMs? }`（limit 上限 500，默认 100；waitMs ≤ 25s 长轮询，`room-store.js` `MAX_READ_WAIT_MS`） | 最近消息数组 |
| `send` | `{ request: { roomId, author, authorAlias?, text, mentions? } }` | `{ id, deliveries: [...] }` |
| `createRoom` / `addMember` / `removeMember` / `remoteSessions` | `{ request }` / `{ roomId, member }` 等 | — |

HTTP 载体为 client-request 协议（UI 同款，抓包实录见 `docs/fix3-frame-limit-postmortem.md` 排障工具箱）：

```http
POST /dsh-chat/<method>
Content-Type: application/json

{ "type": "client-request", "rpcId": "<uuid>", "method": "<method>", "payload": { "args": { ...上述参数... } } }
```

响应统一包一层：`{ "ok": true, "value": <方法返回> }`；宿主 handler 抛错时 `ok: false` 或 HTTP 错误（含真实错误文本）。

## 5. 伪成员模式：send 作者落空 → authorAlias 署名

**机制**（`room-store.js` `send()` ≈ L261–278）：作者查找只用于两处增强——(1) 命中成员且该成员无 alias 时用 `authorAlias` 反填成员 alias；(2) 消息对象里 `authorAlias: member?.alias ?? authorAlias`。**作者不是成员时消息照常创建**：`author` 记你传的 id，`authorAlias` 记你传的显示名。

```http
POST /dsh-chat/send
{ "type": "client-request", "rpcId": "…", "method": "send",
  "payload": { "args": { "request": {
      "roomId": "<roomId>",            // 目标房间（listRooms 或 UI 中取得）
      "author": "claude-bridge",       // 非成员 id：成员查找落空 → 伪成员
      "authorAlias": "claude",         // 显示名：房间时间线以此署名
      "text": "收到，已处理 ✅",
      "mentions": []                   // 不唤醒任何成员（或按需 @ 真成员）
  } } } }
```

效果：

- 消息进入房间时间线，UI/成员机显示作者为 **claude**；
- 房间成员表不变：不新增 session/remote 成员、不产生 weave peer、不留脏成员（对比 weave-postmortem 里"房间脏状态"那类坑）；
- 该伪成员**收不到任何 @ 投递**——因为它不在成员表里，`#deliver` 的 recipients 匹配不到它。

> ⚠️ **作者 id 冲突红线**：`author` 不要撞任何真实成员 id/别名——一旦撞上，`member.alias` 命中会反填并冒充该成员署名。外部桥用独立命名空间（如 `claude-bridge`）即安全。

## 6. @ 非成员别名 = 消息照存零投递

**机制**：`#mentions()`（≈ L329）把 mentions 逐个解析为成员引用；`#deliver()`（≈ L369–373）只向 mentions 命中的成员投递。`@claude` 这类别名在成员表查无此人 → recipients 空 → **零投递**，但消息已由 `send()` 先行写入房间历史——两条路径解耦，互不影响。

用法：人类或任意 agent 在房间里发 `@claude 帮我总结今天的进展`，**不唤醒任何 DSH 成员**（不打扰），消息落时间线；外部桥轮询捕获后自行处理。这就是"外部 agent 不装 weave、不做成员"的标准接入姿势：

```
UI/agent 发 "@claude <任务>" ──> host 入列（时间线 +1，零投递）
                                      │
                       外部桥轮询 messages（增量）──> 识别 mentions/文本含自身 alias
                                      │
                   处理任务 ──> HTTP send 回房间（署名 claude）
```

## 7. 轮询要点

- **增量语义与 UI 同口径**：`messages` 返回房间最近 N 条（上限 500）；桥在本地维护"已见消息"集合，按消息 `id` 去重、丢弃游标之前已处理的消息（与 UI RoomTimeline 的 poll + 去重一致，见 `docs/mechanism-study.md` Q3）。服务端 2000 条滚动窗口会裁旧消息，桥侧如要全量归档需自行持久化。
- **降低空转**：`messages` 支持 `waitMs` 长轮询（≤ 25s）——请求挂着等新消息，到期返回，可当"轻推送"用；定时轮询（如 5–15s）也够用。
- **识别"给我的"**：匹配 `msg.mentions` 中是否含自身 alias（未匹配成员时 mentions 按原样文本存储，所以直接比对 `"claude"` 即可）；也可退化为全文匹配 `@claude`。想全员参与的消息用 `@all`（若房间有真成员会唤醒他们——按需使用）。
- **应答落回房间**：桥的回复必须**再调 `send`** 才会出现在时间线——桥没有"会话"，不存在"收到投递后回复自动进房"（对照成员 agent 规则见 `docs/usage-guide.md` §7）。

最小桥循环（示意，Python 风格）：

```python
seen = set()
while True:
    events = rpc("messages", args={"roomId": ROOM_ID, "limit": 100, "waitMs": 20000})
    for msg in events["value"]:
        if msg["id"] in seen:
            continue
        seen.add(msg["id"])
        if "claude" in (msg.get("mentions") or []):
            reply = handle_task(msg["text"])            # 你的处理逻辑
            rpc("send", args={"request": {
                "roomId": ROOM_ID, "author": "claude-bridge",
                "authorAlias": "claude", "text": reply, "mentions": []}})
```

## 8. 边界与注意事项

| 项 | 说明 |
|:--|:--|
| 宿主在线依赖 | 桥直连的宿主（通常主机A）关机则拉不到也发不出——与 weave 成员同受 host 单点影响（`docs/mechanism-study.md` Q2） |
| 历史有界 | 房间只保留最近 2000 条（host `rooms.json`）；桥若要长期记忆须自行落库 |
| 权限面 | `/dsh-chat` RPC authority 为 `trusted-host`——桥需能访问宿主受信 HTTP 端口；暴露公网前务必自行加鉴权/内网隔离 |
| 身份安全 | 伪成员身份无密码学绑定：任何能调 `send` 的人都能以 `claude-bridge` 署名发言——接入方自行控制访问面 |
| 别和正式成员打架 | 若某天把桥升级为 weave 真成员（alias `claude` 注册进成员表），`@claude` 就会命中真成员并走投递——同一 alias 不要双轨共存 |

## 9. 与 weave 成员方式的选型建议

- **一次性/轻参与**（查个状态、转发个通知、低频问答）：HTTP 伪成员 + 轮询，零安装零信任成本，最省事。
- **高频对答、要即时唤醒、要进 agent 会话上下文**：上 weave 真成员（`docs/SETUP.md` 步骤 1–2），投递直达会话、延迟最低。
- **混合**：真成员承载高频 agent，外部桥做"值班/旁观/聚合"角色（对应 `docs/ROADMAP.md` R2 的落地形态之一——R2 的原生"agent 主动读消息工具"做的是同一件事，只是给 DSH 内 agent；本文是给 DSH **外** agent 的现成路径）。

## 10. 相关文档

| 文档 | 用途 |
|:--|:--|
| `docs/SETUP.md` | 三件套标准部署（weave 成员路径）；本文是它的"外部接入"姊妹篇 |
| `docs/mechanism-study.md` | Q3 拉取/存储、Q4 唤醒机制（"不 @ 收不到"的权威解释） |
| `docs/usage-guide.md` | @ 规则、agent 操作速查（对照 chat_send 成员校验） |
| `docs/PATCH-NOTES.md` | Fix1–Fix4（本文依赖补丁后房间/帧能力正常） |
| `upstream-patched/dsh-chat-0.1.0-rc.33/lib/` | 协议事实来源：`index.js`（RPC 表）、`room-store.js`（send/#deliver/#mentions） |

---

*实证口径：dsh-chat rc.33（vendored 快照）· 外部桥接入实测 · 2026-09-04 批次*
