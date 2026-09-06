# 文件传输 L1 规格（FILE-TRANSFER-L1）

> 项目：huahua-dsh-chatroom ｜ 里程碑：R1（ROADMAP L64-78）｜ 路线：**A —— 零 dsh-chat 改动**
> 状态：🔧 实施中（2026-09-06 启动）｜ 事实溯源：`docs/mechanism-study.md` Q5、`docs/ROADMAP.md` R1
> 实现注记：host rc.5 的 defineTool `parameters` 用字典写法（rc.7 数组写法不兼容）——适配随 commit 363fbaa 落地；跨机 URL 用 config.filePublicBase（默认 http://127.0.0.1:<port>）。

## 0. 定位

在「dsh-chat × dsh-weave 跨机聊天室」里提供**房间内文件传输**：**消息只传规范文本元数据，文件本体走局域网 HTTP**。附件存储与 HTTP 服务由本仓库 kit 插件承载（不修改上游 dsh-chat / dsh-weave / dsh-bridge 的任何文件），先闭环 agent↔agent HTTP 互传；UI 拖拽上传列为第二期。

**验收（对照 ROADMAP L77）**
1. 房间内 A→B 传 **>1MB** 文件成功；
2. 消息窗口**只增几十字节**（仅一条规范文本）；
3. 下载后 **sha256 校验一致**。

## 1. 附件元数据 schema

`manifest.json` 中的一条记录：

```json
{
  `id`: `7f9c1e…uuid/ulid…`,          // 唯一 id：UUID v4（或 ulid），由上传端生成
  `name`: `报告.pdf`,                  // 原文件名（服务端清洗路径分隔符）
  `size`: 2411724,                     // 字节数
  `sha256`: `ab12…(64 hex)`,           // 内容哈希（下载校验依据）
  `roomId`: `<roomId>`,                // 所属房间（软校验依据）
  `uploadedAt`: `2026-09-06T01:00:00.000Z` // ISO-8601 UTC
}
```

## 2. 存储布局（host 本地）

```
~/.dsh/dsh-chat/attachments/<roomId>/
  ├── <id>            # 实体文件（二进制原样，不加密 v1）
  └── manifest.json   # 该房间附件索引（原子写：写 <id>.tmp → rename）
```

- 目录/文件由 host 进程持有；非 host 成员不直接读写，一律经 HTTP。
- `manifest.json` 的**原子写**：先写同目录临时文件，`fs.rename` 覆盖；损坏/缺失时置空数组（仅该房间附件索引重置，不影响其它）。

## 3. 消息文本规范（窗口只增几十字节）

发送方在房间里发**一条文本消息**，格式（agent 与 UI 通用）：

```
[文件] 报告.pdf (2.3MB) http://<host>:<port>/chat-file/<id>?room=<roomId>
```

- 多文件=多行，每行一个 `[文件]` 条目；
- 大小展示：<1KB→B、<1MB→KB、否则 MB（保留 1 位小数）——由 `file-msg.js` 的 `formatSize` 提供；
- URL 协议/端口由 kit 插件运行配置决定（默认端口 3090，可用 `DSH_CHATROOM_FILE_PORT` 覆盖）；
- **识别规则（收件侧）**：命中行首 `[文件] ` → 提取末尾 `http(s)://…/chat-file/<id>?room=<roomId>` → 走 `chatroom_file_fetch` 下载。纯函数解析器：`lib/file-msg.js` 导出 `parseFileMsgLine(line)` / `formatFileMsg(meta, baseUrl)`，单测覆盖。

## 4. HTTP 端点契约（kit 插件内置小服务器）

### POST /chat-file/upload?room=<roomId>
- Content-Type：`multipart/form-data`，字段 `file`（二进制）。
- 校验：字段存在、`roomId` 非空且房间存在于 host（`rooms.json`，宽松：v1 房间不存在则 400）；大小上限默认 `200MB`（配置 `maxFileBytes`）。
- 成功 → 落盘 `attachments/<roomId>/<id>`、追加 manifest（原子写）→ `200`：
```json
{ "id": "<id>", "name": "报告.pdf", "size": 2411724, "sha256": "ab12…", "url": "http://<host>:<port>/chat-file/<id>?room=<roomId>" }
```
- 失败：400（参数）/ 413（超 maxFileBytes）/ 500。

### GET /chat-file/<id>?room=<roomId>（支持 HEAD）
- 校验：`<id>` 在 `manifest.json` 中存在且 `roomId` 匹配 → 否则 **404**。
- 成功 → `200` + 头：
  - `Content-Length`：实体字节数
  - `X-SHA256`：实体 sha256（**校验头**，agent 下载后比对）
  - `Content-Type`：由扩展名映射（未知→`application/octet-stream`）
  - `Content-Disposition`：`attachment; filename*=UTF-8''<urlencoded name>`

### 其它
- 非 GET/POST/HEAD → 405；默认绑定 `0.0.0.0`（可配 `bindHost`）。

### 部署前置条件：防火墙放行（必读）

Windows 默认拦截入站：**file-server 端口（默认 3090）必须在 host 机防火墙放行**，否则其它机器（含同局域网双机）无法访问（参考同日 A→B 传输教训：8000 需 netsh 放行）。以**管理员 PowerShell** 在 host 机执行：

```powershell
netsh advfirewall firewall add rule name="dsh-chatroom file 3090" dir=in action=allow protocol=TCP localport=3090 profile=private,domain
netsh advfirewall firewall show rule name="dsh-chatroom file 3090"
```

- **双机同局域网**：A/B 各自跑 file-server 时，**提供端（发送端 host）放行即可**；若双向互传则两侧都放行。
- **跨网**（不在同一局域网）：需走 host 公网端口映射或既有隧道（见 ROADMAP / mechanism-study 注记），并对公网入口放行。
- 绑定建议：仅本机自测可 `bindHost=127.0.0.1`；需要局域网访问用 `0.0.0.0` + 防火墙放行。

## 5. agent 识别与下载规则

1. 收到含 `[文件]` 行文本 → `parseFileMsgLine` 提取 `{name,size,url}`；
2. 调 `chatroom_file_fetch(url, opts)`：GET → 按 `X-SHA256` 校验本地哈希，不一致即报错重下（1 次重试）；
3. 默认保存到 `~/.dsh/dsh-chat/downloads/<roomId>/`（可传 `saveDir`）；
4. 下载失败/校验失败 → 房间内回发 `⚠️ 文件接收失败：<原因>`（不静默）。

## 6. 验收命令（本地自测 + 双机对照）

```powershell
fsutil file createnew D:\tmp\big.bin 2097152
curl -F "file=@D:\tmp\big.bin" "http://<host>:3090/chat-file/upload?room=<roomId>"
curl -o D:\tmp\big.down.bin "<url>"
certutil -hashfile D:\tmp\big.down.bin SHA256
```

**防火墙可达性自检（另一台机）**：先按 §4.5 放行 3090，再从 B 机执行 `curl -I "http://<host>:3090/chat-file/<id>?room=<roomId>"` —— 返回 200/404 皆证明 TCP 可达（非超时）；若超时/拒绝先查防火墙规则。

验收检查表：□ >1MB 传输成功 □ 窗口仅增几十字节 □ sha256 一致 □ 404/权限分支正常 □ agent fetch 工具可自动下载。

**验收状态（实时）**：✅ **双向 HTTP 闭环（2026-09-06）**
- **A→B**：1.5MB（1536KB）经 B 机下载，sha256=`01c7f068dc601f8d3456c673a3ed41384e8b252db7fa106b7af862e6f77e2800` 一致，未受防火墙拦截；
- **B→A**：大力 B 机上传 r1-b2a.bin（1572864B，id=`76e04586d7ea4e3cb0201f74c7f8e6d5`，roomB），A 侧下载复核 sha256=`106f0647ae10a6516b1ab2968038161e287ef40d1b22ca047531ed768e594ef1` 一致（X-SHA256 匹配）。
✅ **agent 层跨机链路 PASS（2026-09-06）**：kit 装入 A 机宿主（新 host 运行、3090 内嵌 file-server），`chatroom_file_upload` → `filePublicBase` LAN URL（`http://192.168.1.3:3090/chat-file/…`）→ B 机大力下载 1,572,864B，sha256=`a6aa3be3296f0791990e4e91c9ce3036ef1d83065fcf25e62390343a9f78a37d` 与上传一致 → **R1 全链路验收完成**（HTTP A→B / B→A / agent 工具 / 跨机 LAN URL 全闭环）。
测试已落库：`tests/file-server.test.js`（5 用例）+ `tests/file-msg.test.js`（8 用例），全仓 `node --test` 通过（19/19+）。
后续可选：房间内 agent 完整互传（含大力侧 kit 重启后的端到端消息流）。
✅ **房间内 agent 双向互传闭环（2026-09-06）**：kit 装入 A/B 双机（A rc.5 / B rc.2 均可用），filePublicBase 各自指向本机 LAN IP：
- **A→B**：A 机 agent `chatroom_file_upload` → LAN URL → B 机下载校验一致；
- **B→A**：B 机 agent upload（LAN URL `http://192.168.1.168:3090/chat-file/f1594b6a…`，59B 含时间戳）→ A 机跨机 fetch，sha256=`3ec6bf1a12540898a5c7d21a07b71c45f68f80796dbb3c69fc79cfdfe32c25e1` 双向一致（X-SHA256 匹配）；
- 防火墙放行（双机 3090 入站）+ 消息窗口仅增文件文本行（几十字节）。
→ **R1 文件传输 L1 全量收官**（HTTP 双向 + agent 双向 + 双机 kit 环境兼容）。

## 7. 安全与边界（v1）

- 仅局域网/受控网络使用；跨网需走 host 公网端口或既有隧道；
- `room` 为软校验（防串房），v1 不做令牌鉴权（后续 `X-Room-Token` 可选）；
- **防火墙/网络前置**：见 §4.5——端口 3090 需 netsh 放行；双机各自放行；跨网走 host 公网端口/隧道。
- **room 软校验说明**：v1 的 `room` 参数仅为**防误传/防串房**，**不具备鉴权**（参数可被伪造）；若文件敏感，需先加认证层（如 `X-Room-Token` 或 host 白名单 IP）再对外暴露。
- 上传大小上限可配；建议定期人工清理附件目录（自动过期=非目标）。
- **非目标（明确不做）**：UI 拖拽上传（第二期）；dsh-chat 消息模型加附件字段（路线 B，未选）；L2 Iroh blob P2P 直传（远期 F1）；加密/自动过期/配额计费。

## 8. 落地文件（对应仓库）

| 文件 | 内容 |
|:--|:--|
| `docs/FILE-TRANSFER-L1.md` | 本规格 |
| `lib/file-server.js` | HTTP 上传/下载小服务（manifest 原子写、sha256、大小上限） |
| `lib/file-msg.js` | 纯函数：formatFileMsg / parseFileMsgLine / formatSize |
| `lib/index.js` | 挂载 file-server（端口 3090 默认）+ chatroom_file_upload / chatroom_file_fetch 工具与 RPC |
| `tests/file-server.test.js` | 真实 HTTP roundtrip（sha256、>1MB、404） |
| `tests/file-msg.test.js` | 消息文本解析/生成单测 |

---
*本文随 R1 实施演进更新；验收结论将回填 §6 状态。*