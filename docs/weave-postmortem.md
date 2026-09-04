# 主机A & 主机B 跨机 Weave 通信问题复盘报告（2026-09-04）

> ⚠️ **历史快照**：本报告复盘 **Fix1（inject bug）+ Fix2（随机端口）** 的根因归纳与修复 6 步（写于 Fix2 落地时点，修复后状态已生效）。与 `docs/weave-integration-report.md`（联调过程）互补：联调 = 过程，复盘 = 根因 A/B 归纳。后由 `docs/fix3-frame-limit-postmortem.md` 接续 Fix3/Fix4；现状统一以 `docs/PATCH-NOTES.md` 为准。

## 一、问题现象

【主机A/host】remoteSessions 长期空；QUIC 直连 7–23ms 通但 weave 应用层入站一律报错；多次重启后双方票全失效、投递 0 member。
【主机B】chat_send 间歇报 "not a member of this room"；本地 rooms.json 出现自己 session+remote 双记录、已删的 room-2 重启复活；手改 rooms.json 无效（运行时用内存态）；消息发送超时。

## 二、怎么产生的

【根因A·代码缺陷】dsh-weave rc.14 `#dispatch` ~289 行无条件访问未 inject 的 dshBridge → 任何入站帧（catalog/邀请/投递）抛 "cannot get property dshBridge without inject"。npm 无修复版。
【根因B·端口随机】iroh bind() 未指定端口 → 每次启动随机 UDP 端口 → peers.json 里对方票（地址快照）重启即废；票无 relay 时彻底失联。
【诱发】多次重启 DSH → 端口每次变 → 双方互持旧票 → 死锁失联；linked room 失去 host 同步 → 脏状态。
【机制补充】room-1 是主机A host 房间，主机B 本地 linked room，chat_send 硬检查本地成员 + host 权威在主机A 侧 → 两端不一致时间歇报错；靠 chat_join + 重启归位。

## 三、做了哪些修复

1. **Fix1（双边）**：289 行 dshBridge 访问包 try/catch，bridge 仅"未认领消息"需要。
2. **Fix2（双边，已对齐）**：Endpoint 固定 UDP 64605——主机A 走 `DSH_WEAVE_PORT` 环境变量（默认 64605），主机B 走 Config `bindAddr` 字段；最终语义为 `DSH_WEAVE_PORT` 优先、无则 `bindAddr`。
3. **patch-weave.ps1 脚本化**（幂等 + 备份 + 语法校验），升级后重跑即可。
4. **单方面恢复法**：iroh 构造对方当前地址 ticket（`EndpointTicket.fromAddr(new EndpointAddr(peerId, relay, ["IP:64605"]))`）再 `weave_trust`，不等对方出票先恢复单向。
5. **最后一次换票**：双方固定端口版官方新票（IPv4 64605 + relay euc1-1）互 trust 存档。
6. **房间归位**：host 权威记录干净，主机B 本地靠 host 同步 + 重启归位，仍乱则由 host 重置。

## 四、以后怎么规避

1. 端口固定 64605，重启不变 → 不再端口漂移失联。
2. 票含 relay → DHCP 换 IP 也能经 relay 按 peer ID 找到 → 日常重启无需换票。
3. 失联排查：查 peers.json 对方票是否 64605 → 旧则构造 ticket + trust 单方恢复。
4. 升级 dsh-weave 覆盖补丁 → 重跑 patch-weave.ps1。
5. 房间脏状态勿手改 rooms.json，靠 host 同步 + chat_join/重启。
6. 经验：验证连通用真 QUIC 握手（UDP 垃圾包被静默丢弃、ping/TCP 测 QUIC 端口无意义）；重启后先换票。
