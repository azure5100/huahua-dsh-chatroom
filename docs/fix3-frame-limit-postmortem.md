---
title: "dsh-weave Fix3：4KB ack 通道限制导致会议室 UI 历史不显示（2026-09-04）"
type: report
tags: [dsh, iroh, weave, dsh-chat, 排障, 复盘, 跨机]
date: 2026-09-04
---

# dsh-weave Fix3：4KB ack 通道限制导致会议室 UI 历史不显示

> 续接 [[nango-dsh-weave-复盘-20260904]]（Fix1 inject bug + Fix2 固定端口）。本页记录第三个独立根因与修复：**weave 回执（ack）通道读取上限 4KB，导致 room.read 批量历史响应超限抛 `TooLong`，UI 一直报 HTTP 500，历史聊天记录永远拉不到**。

## 一、问题现象

【用户视角】「会议室看不到聊天记录」。ea4228fb（dsh会议室，host=大力 f7bd62da，linked=丽丽 session-3950c88a）在 UI 里历史全空。
【数据视角】丽丽本地 rooms.json 缓存停在 **27 条**（cursor=27），大力 host 权威 **43+ 条**。重启 DSH、chat_join 重加成员均无效——缓存纹丝不动。

## 二、诊断过程（证据链）

1. **排除网络层**：chat_send（room.post）发消息成功、大力秒回（host 43 条）→ weave 连接与双向投递正常，问题只出在「读历史」路径。
2. **无头浏览器复现**（Playwright 打开 http://127.0.0.1:3080 → Chatrooms → dsh会议室）：RoomTimeline 正常挂载，但页面顶部红字 **`transport failure for /dsh-chat/messages: HTTP 500`**，消息区空态。
3. **重放宿主 RPC 拿真实错误**：抓到 UI 的 RPC 协议（`POST /dsh-chat/<method>`，body=`{"type":"client-request","rpcId":"<uuid>","method":"messages","payload":{"args":{...}}}`），直接重放 → **`handler failure: Error: TooLong`**（Iroh readToEnd 超限错误）。
4. **大小边界测试**：limit=1/5 → 200 OK；limit=10 → TooLong。错误与响应体量正相关 → 指向帧大小上限。
5. **源码定位**（`~/.dsh/profiles/web/node_modules/dsh-weave/lib/index.js`）：
   - L32 `const MAX_FRAME_BYTES = 64 * 1024` —— 入站帧读取上限（L260 readToEnd）
   - **L236 `stream.recv.readToEnd(4096)` —— 真凶**：`#sendTo` 等待对端回执（ack）只给 **4KB**，而 dsh-chat 的 `room.read` 把整批历史消息（events）+ members 放进 ack 的 `result` 回传 → 消息一多必然超限
6. **解释 27 条定格**：本地缓存是消息还少时（响应 <4KB）最后一次成功 readHost 的快照；此后 host 消息累积越过 4KB，UI 的每次拉取都 500，缓存永不前进。重启/join 都不触发重新拉取，UI poll 每次都在报错重试。

## 三、消息拉取机制（知识沉淀）

- **UI 侧**（dsh-chat client.js RoomTimeline）：挂载即 poll 循环调 `messages(roomId, limit=200, waitMs)`——首次 `waitMs=0` 立即拉，之后 `waitMs=25000` 阻塞等新消息；失败则 1s 后重试并红字显示错误。RoomTimeline 只在含 `chat/room-link` 事件的房间会话视图渲染（Chatrooms 工作区 → dsh会议室 会话）。
- **服务端**（room-store.js `#readHost`）：linked room（有 hostId）读消息 = 向 host 发 `room.read`（带本地 cursor 增量请求）→ host 返回 cursor 之后的 events + 权威 members → 本地**按消息 id 去重**合并进缓存 → `cursor = host 返回的 cursor` → 落盘 rooms.json。cursor 语义 = host 端消息序号，幂等安全（重复拉取只补缺失）。
- **weave 帧协议**：发起方 `openBi` → `writeAll(frame)` + finish → 对端 `#accept` 里 `readToEnd(上限)` 读帧 → dispatch 处理 → `writeAll(ack)`（**ack 的 result 承载 RPC 响应**）→ 发起方 `readToEnd(4096)` 读 ack。**ack 读取上限 = RPC 响应体量上限**，这是本 bug 的架构性根因。

## 四、修复（Fix3 补丁，双边）

`~/.dsh/profiles/web/node_modules/dsh-weave/lib/index.js` 两处：

```js
// 1. L32：单帧上限 64KB → 1MB（入站 readToEnd 同步放宽）
const MAX_FRAME_BYTES = 1024 * 1024;

// 2. L236：ack 回执读取 4096 → 1MB（room.read 批量响应走此通道）
stream.recv.readToEnd(MAX_FRAME_BYTES)
```

- `node --check` 语法验证通过。
- 重启宿主加载（重启姿势见下）。
- 大力同步补丁并重启；patch-weave.ps1 升级为 **Fix1+Fix2+Fix3 三合一**，升级 dsh-weave 后重跑一次全打。

## 五、验证结果（双端互验）

- 修复前：limit=10 → TooLong；修复后：**limit=200 → 200 OK，54 条全量返回**。
- 大力侧：limit=200 拉取成功（52KB 响应 / 53 条完整返回，此前 4KB 即 TooLong）。
- 本地缓存 27 → 50 → 53 → **54 条**，cursor 与 host 完全一致。
- UI 无头浏览器实测：RoomTimeline 从第一条欢迎语到最新消息完整渲染，**HTTP 500 消失**。
- 中间态备忘：丽丽先重启、大力未重启时，messages 报 `Read(ConnectionLost(ApplicationClosed))`——那是大力旧代码（未加载 Fix3）实例处理大响应的表现，大力重启后消失，**非连接问题**。

## 六、重启姿势（避免二次踩坑）

- 用户用桌面 DSH-Panel 重启失败过一次：**旧进程没被杀掉，新实例抢不到 3080/64605 端口，静默退出**（多出个将死进程）。
- 正确姿势：先杀占用 3080（TCP）与 64605（UDP）的监听进程（`taskkill /PID <pid> /F`，Panel 的 Stop 即此逻辑），等端口释放，再起新宿主。
- 自用脚本：`D:\Deepseek-harness\restart-dsh-fix3.ps1`（杀监听者 → Start-Process 新宿主 lib 模式 → 等 HTTP ready）。

## 七、经验与规避

1. **UI 报错表象要挖宿主 RPC 层**：`transport failure for /dsh-chat/messages: HTTP 500` 不是传输断了，是宿主 handler 抛异常。直接重放 RPC（client-request 协议）可拿到真实错误文本。
2. **TooLong = Iroh readToEnd 超限**，方向要分清：读 ack（4KB）是 RPC 响应瓶颈；读入站帧（64KB）是消息体瓶颈。改上限按需。
3. **成员/缓存脏状态不是所有问题的答案**：本案例 27 条缓存纹丝不动是「拉取永远失败」的特征，与同步无关——先验证读路径是否成功，再动状态。
4. 补丁三合一（Fix1 inject try/catch + Fix2 固定端口 64605 + Fix3 帧大小 1MB）后，**升级 dsh-weave 必须重跑 patch-weave.ps1**，否则上述问题复发。
5. 排障工具箱：Playwright 无头浏览器复现 UI + 监听网络请求抓 RPC 协议 + Python 重放宿主 RPC + netstat 查端口归属 + `Get-CimInstance Win32_Process` 查进程树。
