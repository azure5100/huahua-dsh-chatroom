# DSH Weave

[English](README.md) | [简体中文](README.zh.md)

> 在多台机器之间连接 DeepSeek Harness 节点的私有点对点网络层。

**DSH Weave** 把多个本地 DSH 实例组成明确授信的网络：节点可以发现可信对端、
交换感知会话的事件、投递工作，并在连接中断后重新连接，而不在执行链路中引入中心服务器。

| 阶段 | 传输 | 范围 |
| --- | --- | --- |
| 传输 MVP | Iroh + QUIC | 显式信任的 DSH 节点 |

## 核心能力

- 持久化的本地节点身份与显式的对端信任。
- Iroh 提供的加密 QUIC 连接，支持直连与必要时的 relay 回退。
- 为上层插件提供远程 Host、工作区与会话目录。
- 分开表示 Host 连通性与 Agent 状态，避免把离线误解为空闲。
- 在 DSH 设置中管理 ticket 交换、relay 状态和可信对端。

## 快速开始

```bash
dsh plugin --profile web add dsh-weave@next
dsh web
```

在两台 Host 上分别打开 **设置 → Weave**，将每个节点的 ticket 复制到另一台 Host，
并在接收方明确确认信任。仅知道 endpoint ticket 不会自动获得权限。

传输 MVP 提供 Iroh endpoint、ticket 交换、显式对端信任，以及交给
`dsh-bridge` 的消息帧。当两个插件在同一 Host 中运行时，Weave 负责网络，
Bridge 负责本地会话投递。

## 产品边界

`dsh-bridge` 是本地合约，连接同一 Host 内的会话；`dsh-weave` 在 Host 之间传输已批准的消息；
`dsh-chat` 则是可选的 Web 群聊界面。

```text
DSH 节点 A ── dsh-bridge ── dsh-weave ── Iroh ── Iroh ── dsh-weave ── dsh-bridge ── DSH 节点 B
```

Iroh 负责带身份验证的加密 QUIC 连接、尽可能直连，以及需要时的 relay 回退。
Weave 负责 DSH Host 身份、信任、endpoint 刷新、连通状态、工作区/会话目录与认证请求投递。

远程目录将 Agent 状态表示为 `idle`、`running` 或 `offline`；Host 连通性则单独表示为
`unknown`、`connecting`、`online` 或 `offline`。恢复持久化离线会话仍由 `dsh-bridge` 负责。

## 配对与投递

节点 ticket 需要通过另一条可信渠道交换，然后再显式信任。即使 Iroh 已加密连接，
`dsh-weave` 仍会拒绝来自未信任 endpoint 的帧。传输身份与 DSH 授权是两个独立层次。

节点 Iroh 身份持久化在 `~/.dsh/dsh-weave/identity.json`，文件仅所有者可访问。
已信任 peer id 与其最近接受的 endpoint ticket 同样会在本地持久化，因此重启后不会生成新身份，
已配对 Host 也能继续发现。当对端的可达地址发生变化时，需要重新信任新 ticket。

Weave 设置页会显示当前 Iroh ticket、relay 模式与已配对 endpoint 身份。
`dsh-chat` 等上层插件只消费稳定 Host id 和远程会话目录，不保存 peer endpoint ticket，
也不拥有传输身份、配对或 relay 策略。

## 安全边界

- Iroh 的认证 QUIC 传输提供端到端加密。
- 传输身份之上还有 mesh allowlist 和能力授权。
- 在接收节点批准前，默认拒绝远程工作。
- 密钥、模型提供商凭据和原始文件系统访问不会作为普通会话事件传输。
- 自托管 relay/发现服务是生产路径；公共 relay 仅用于开发。

更详细的设计见 [架构](docs/ARCHITECTURE.md)、[线上协议](docs/PROTOCOL.md) 和 [安全模型](docs/SECURITY.md)。

## 当前进度

- [x] 发布 v1 协议合约
- [x] `dsh-bridge` 本地事件适配器
- [x] Iroh endpoint 适配器与基于 ticket 的信任流程
- [ ] 远程任务请求 / 批准 / 结果流
- [ ] 持久化 outbox 与重连回放
- [ ] 自托管 relay 与发现指南

## 开发

```bash
npm run check
```

## 许可证

MIT © Xiang Bai
