# Kit 本地开发包启动故障复盘（2026-09-06）

> 关联：huahua-dsh-chatroom kit 装入 web profile 后首次启动失败 → 修复记录（桌面）+ 本文复盘。经验已双覆盖：usage-guide FAQ（L56-58）+ FILE-TRANSFER-L1.md 实现注记。

## 一、问题现象

web profile 加入 `huahua-dsh-chatroom`（本地 `link:` 开发包，bundles 第 81 位）后首次启动失败，进程约 47 秒退出。关键错误：

```
failed to import loader entry dsh-chatroom-kit (huahua-dsh-chatroom):
Cannot find package '@deepseek-ai/dsh-tools' imported from <kit>/lib/index.js
Error [ERR_MODULE_NOT_FOUND]
```

## 二、根因（两层）

### 根因 1：裸目录无法解析 `@deepseek-ai/*` peer 包

- kit 直接 `import { defineTool } from "@deepseek-ai/dsh-tools"`、`import Schema from "@deepseek-ai/schemastery"`；
- 源码在盘符根目录（无父级 node_modules、自身也无 node_modules）→ Node ESM 向上找不到 `@deepseek-ai/*`；
- DSH 的 flat-fallback 目录（`$DSH_HOME/profiles/node_modules`，每包一 symlink）**只对 profile node_modules 层级下的包生效**——`link:` 包真实位置在 profile 树外时失效。

### 根因 2：插件按新版 dsh-tools 契约写，host 是旧版

解析修复后暴露 API 契约错配（host fallback 的 dsh-tools 为 rc.5，插件按 `^0.1.0-rc.7` 写）：

| 写法 | rc.5 契约 | rc.7 写法（不兼容） |
|:--|:--|:--|
| defineTool parameters 外层 | 属性字典（自动包 object） | `Schema.object({...})` 实例 |
| 每个参数值 | raw JSON-schema `{ type, required, description }` | `Schema.string().description(...)` |

## 三、修复

### 修复 1：源码目录 node_modules → junction 指向 flat fallback

```
cmd /c mklink /J <kit源码目录>\node_modules %USERPROFILE%\.dsh\profiles\node_modules
```

- 使 kit `lib/*.js` 的 `@deepseek-ai/*` 全部解析成功（引用 host 同源版本）；
- 改即生效；可逆（删除 junction 还原）。

### 修复 2：defineTool parameters 适配 rc.5 契约

两处（chatroom_file_upload / chatroom_file_fetch）改为：

```js
parameters: {
  filePath: { type: "string", required: true, description: "本地文件绝对路径" },
  roomId:   { type: "string", required: true, description: "房间标识（必填）" }
}
```

注意：`export const Config = Schema.object({...})` 是 schemastery 配置契约（合法），**不改**；只改 defineTool 的 parameters。

## 四、验证

- 模块加载 OK（导出 Config/apply/inject/name）；
- 完整启动稳定 100s+ 零错误；
- 端口三通：3080（web）HTTP 200 / 3082（隧道）200 / 3090（chatroom file-server）在线；
- 测试实例停后端口释放。

## 五、规避与后续

1. **本地 link: 开发包若 import 任何 `@deepseek-ai/*`/bare 包**，必须保证其物理路径的 node_modules 解析链存在——自身 pnpm install 或 junction 指向 `$DSH_HOME/profiles/node_modules`（纯 node 内置模块的包不受限）。
2. **插件 peer 版本 vs host 实际版本对齐检查**：新装插件后先看其 peer 范围 vs fallback 目录实际版本；以 host 契约为准适配。
3. **host 升级后可回退适配**：若升级后 host dsh-tools 达 rc.7，`Schema.object(...)` 原写法可能原生兼容——届时还原修复 2（以 host 实际契约为准）。
4. **新插件合入 profile 后冒烟顺序**：`--dump-config` 查重复 id → 实际 boot 观察 60s+ → 检查新增端口/路由。

## 六、技术档案

- `defineTool` 参数契约（rc.5 host 权威）：`parameters: { <name>: { type, required?, description?, ... } }` + raw JSON-schema；`output: { schema, render(args, value) }`。
- Flat fallback 目录：`$DSH_HOME/profiles/node_modules`（130+ `@deepseek-ai/*` + cordis symlink，boot 时 healProfilesModuleFallback 维护）——profile 树外代码解析 in-box 包的唯一枢纽。
