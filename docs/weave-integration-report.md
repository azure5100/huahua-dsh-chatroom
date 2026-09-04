# DSH Weave 跨机联调实战报告：主机A × 主机B

> ⚠️ **历史快照（2026-09-04 联调当时）**：本报告记录 Fix1（inject bug）定位与联调打通实况；文中「重启后端口会变、需重新换票」为 **Fix2 修复前**的实况——现部署已固定 UDP 64605（Fix2）并经 Fix3/Fix4 演进，端口与帧上限现状以 `docs/PATCH-NOTES.md` 为准。

> 日期：2026-09-04 ｜ 执行：主机B（192.0.2.2）+ 主机A（192.0.2.1）
> 目标：打通两台 DSH 实例的 Weave 跨机聊天室
> 结论：✅ 成功（发现并修复 dsh-weave rc.14 代码缺陷）

---

## 一、背景

两台机器上的 DeepSeek Harness（DSH）实例需要通过 **Weave**（基于 Iroh/QUIC 的 P2P 网络）建立跨机连接，实现 dsh-chat 聊天室互通。

**参与节点**：
- **主机B**：192.0.2.2，Windows，DSH web（PID（重启后变化））
- **主机A**：192.0.2.1，DSH web（重启后 PID/端口变化（随机高位））

**技术栈**：
- `dsh-weave` v0.1.0-rc.14（Iroh P2P 传输插件）
- `dsh-bridge`（本地会话桥接）
- `dsh-chat` v0.1.0-rc.33（跨机群聊）
- Iroh QUIC + relay 兜底（euc1-1.relay.n0.iroh.link）

---

## 二、排障过程（多阶段）

### Phase 1：网络排查（误判为网络问题）

| 尝试 | 结果 |
|---|---|
| 双向信任 ticket | ✅ 成功（主机A `peerId-A` ↔ 主机B `peerId-B`） |
| ping 192.0.2.2 | ❌ 不通（ICMP 被 Windows 防火墙默认拦） |
| UDP 端口探测（64605 及高位段） | ❌ 无响应 |
| 中继可达性（euc1-1 relay） | ✅ TCP 443 通 |

**误判**：以为是 IP 变化 / 防火墙 / NAT 问题。实际排查：
- IP 未变（192.0.2.2）
- node.exe 有 Public 入站放行规则
- 网络 profile 是 Public（家用路由网络）

### Phase 2：发现代码缺陷（真正的根因）

**主机A直接发协议帧测试** → 主机B的 DSH 收到任何入站消息都报错：

```
cannot get property "dshBridge" without inject
```

**根因定位**（`dsh-weave/lib/index.js` 第 289 行）：
```js
const bridge = this.ctx?.dshBridge ?? this.ctx?.get?.("dshBridge");
```

这行**无条件执行**，但 dsh-weave 的**依赖注入列表里没有 dshBridge** → Cordis 一碰就抛错。后果：节点**无法处理任何入站消息**（session.catalog、房间邀请、消息投递全部失败）。

### Phase 3：双边打补丁

**修复**（把 bridge 获取包进 try/catch，仅消息未被认领时才需要）：
```js
let bridge;
try { bridge = this.ctx?.dshBridge ?? this.ctx?.get?.("dshBridge"); } catch { bridge = undefined; }
if (!claimed && bridge) await bridge.deliverExternal(...);
```

**操作**：
1. 编辑 `~/.dsh/profiles/web/node_modules/dsh-weave/lib/index.js` 第 289 行
2. `node --check` 语法验证 OK
3. 重启 DSH web（PID（重启后变化））

### Phase 4：换票重启 + 验证

| 步骤 | 结果 |
|---|---|
| 重启后 weave 新端口 | 双方为随机高位 UDP 端口（重启漂移实况，另见 mDNS 5353） |
| 重新生成 ticket | ✅ 双方换新票 |
| 双向信任 | ✅ 重新 trust |
| **跨机消息投递** | ✅ **主机A → 主机B 收到** |
| **反向投递** | ✅ **主机B → 主机A 收到** |

### Phase 5：房间统一（踩坑记录）

**问题**：双方各建了一个「dsh会议室」：
- 主机A先建：`room-1`（房主主机A）
- 主机B后建：`room-2`（房主主机B）

**清理**：删除主机B的重复房间 `room-2`，统一用主机A的 `room-1`。

**⚠️ 踩坑**：用 PowerShell `ConvertTo-Json` 处理 rooms.json 时，**GBK 编码把 UTF-8 中文写坏**（文件损坏、消息记录可能丢失）——本机老问题（中文 Windows 编码规范）。已用 **Python（原生 UTF-8）重建 rooms.json**，完整保留 5 条跨机消息，无数据丢失。

---

## 三、最终成果

| 项 | 状态 |
|---|---|
| **Weave 跨机连接** | ✅ 打通 |
| **双向消息投递** | ✅ 验证通过 |
| **聊天室** | 「dsh会议室」`room-1`（统一） |
| **成员** | 主机A + 主机B |
| **消息历史** | ✅ 5 条完整保留 |
| **代码缺陷** | ✅ 双边补丁修复 |

---

## 四、关键经验与教训

### 技术经验
1. **Weave/Iroh ticket 不含固定端口**——Iroh 用 peerId + relay 寻址，QUIC 动态协商端口（重启后端口会变，但 ticket 本身不因端口变化失效）
2. **Iroh 端点用动态 UDP 端口**（646xx 段或 3xxx 段），不是固定端口；跨机联调时两端都要确认**当前实际监听端口**
3. **Windows 防火墙默认拦 ICMP**（ping 不通 ≠ 主机不在线，ARP 表有记录即在线）；node.exe 需要 Public/Private profile 的入站放行规则
4. **中继（relay）可达性关键**——直连失败时 Iroh 自动走 relay 兜底

### 代码缺陷教训（dsh-weave rc.14）
- **`ctx.get?.("service")` 在未 inject 时会抛错**，不是返回 undefined——必须包 try/catch 或用显式 inject
- 条件获取 service 应只在**真正需要时**执行（bridge 仅当消息未被认领才需要）

### 编码规范（本机老问题）
- **PowerShell `ConvertTo-Json` 用 GBK 处理 UTF-8 中文会损坏文件**——处理含中文的 JSON 一律用 Python（原生 UTF-8）或指定编码

### 协作经验
- 跨机排障时**双方要提供**：当前真实 IP、重启后最新 ticket、防火墙状态、实际监听端口
- 房间只保留一个，避免消息不同步
- 直接发协议帧测试比 ping/端口探测更能定位问题（发现 inject bug 的关键一步）

---

## 五、文件与配置

| 项 | 位置 |
|---|---|
| dsh-weave 插件 | `~/.dsh/profiles/web/node_modules/dsh-weave/` |
| 补丁文件 | `~/.dsh/profiles/web/node_modules/dsh-weave/lib/index.js`（289 行 try/catch） |
| 聊天室存储 | `~/.dsh/dsh-chat/rooms.json` |
| Weave 信任状态 | `~/.dsh/dsh-weave/peers.json` |

---

## 六、后续建议

1. **上游修复**：dsh-weave rc.14 的 inject bug 建议反馈给上游（npm 上 rc.14 已是最新，无官方修复）
2. **重启流程**：双方重启 DSH web 后 weave 端口会变，需重新交换 ticket（可通过 Settings → Weave 页面复制）
3. **房间备份**：rooms.json 含中文，操作时用 UTF-8 工具，定期备份
