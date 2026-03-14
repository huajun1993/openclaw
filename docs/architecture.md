# OpenClaw 架构分析

> 本文档基于 OpenClaw 源码进行深度分析，梳理其整体架构、模块职责、数据流向和扩展机制。

---

## 目录

1. [项目概览](#项目概览)
2. [目录结构](#目录结构)
3. [核心模块](#核心模块)
4. [频道（Channel）架构](#频道channel架构)
5. [网关（Gateway）系统](#网关gateway系统)
6. [插件（Plugin）体系](#插件plugin体系)
7. [代理（Agent）系统](#代理agent系统)
8. [CLI 架构](#cli-架构)
9. [构建系统](#构建系统)
10. [测试体系](#测试体系)
11. [移动端与桌面端应用](#移动端与桌面端应用)
12. [数据流向](#数据流向)
13. [关键设计模式](#关键设计模式)
14. [依赖概览](#依赖概览)

---

## 项目概览

OpenClaw 是一款多频道 AI 网关（Gateway），支持将 AI 代理（Agent）接入超过 20 种即时通讯平台（Telegram、Discord、Slack、WhatsApp、iMessage 等）。其核心理念是通过统一的插件化频道抽象，将 LLM/代理能力与各类消息平台解耦。

**主要能力：**

- 多频道消息收发（20+ 平台）
- 可扩展插件架构（36+ 官方扩展）
- AI 代理编排与工具调用
- 跨平台客户端（macOS、iOS、Android、Web）
- 完整的 CLI 工具链
- 灵活的 Hook/Webhook 自动化机制

---

## 目录结构

```
openclaw/
├── src/                    # 主 TypeScript 源码 (~593K LOC)
│   ├── cli/                # CLI 指令注册与参数解析
│   ├── commands/           # 具体命令实现（agent、message、config 等）
│   ├── channels/           # 频道注册表、路由抽象与会话管理
│   ├── routing/            # 消息路由与会话解析
│   ├── gateway/            # 网关服务器（WebSocket + HTTP）
│   ├── agents/             # 代理生命周期、工具调用、Auth Profiles
│   ├── plugins/            # 插件运行时、注册表、SDK 导出
│   ├── providers/          # LLM/模型 Auth Provider（OpenAI、Gemini 等）
│   ├── infra/              # 基础设施（文件系统、进程、端口、安全）
│   ├── media/              # 媒体管道（音频、图像、PDF、MIME）
│   ├── terminal/           # 终端 UI（ANSI、表格、提示符）
│   ├── config/             # 配置加载、Sessions、状态迁移
│   ├── hooks/              # Hook 系统（内部 + 插件 Hook）
│   ├── memory/             # 代理记忆存储与检索
│   ├── pairing/            # 设备配对与认证流程
│   ├── daemon/             # 进程生命周期、systemd/launchd 集成
│   ├── security/           # 安全边界与策略
│   ├── context-engine/     # LLM 上下文构建
│   └── test-helpers/       # 测试辅助工具
│
├── extensions/             # 36+ 官方频道插件
│   ├── telegram/           # Telegram Bot API
│   ├── discord/            # Discord Bot API
│   ├── slack/              # Slack Bot API
│   ├── whatsapp/           # WhatsApp Web（Baileys）
│   ├── signal/             # Signal 桥接
│   ├── imessage/           # iMessage（BlueBubbles）
│   ├── msteams/            # Microsoft Teams
│   ├── matrix/             # Matrix/Element
│   ├── line/               # LINE Bot API
│   ├── zalo/               # Zalo（越南）
│   ├── feishu/             # 飞书（Lark）
│   ├── voice-call/         # 语音通话
│   └── ...（共 36+ 个）
│
├── apps/                   # 移动端与桌面端应用
│   ├── ios/                # iOS 应用（Swift/Xcode）
│   ├── android/            # Android 应用（Kotlin）
│   ├── macos/              # macOS 应用（Swift）
│   └── shared/             # 共享 Swift 库（OpenClawKit）
│
├── docs/                   # Mintlify 文档
├── ui/                     # Web 控制台（Canvas）
├── scripts/                # 构建与自动化脚本
├── test/                   # 测试夹具与工具
├── openclaw.mjs            # CLI 入口（Node ≥ 22）
├── package.json            # pnpm workspace 根配置
├── tsdown.config.ts        # 构建配置（tsdown bundler）
└── tsconfig.json           # TypeScript 配置（ESM、Node/DOM）
```

---

## 核心模块

### src/cli — CLI 指令注册

负责将所有子命令注册到 Commander.js 程序树，处理参数解析、profile 切换和运行入口。

| 文件 | 职责 |
|------|------|
| `program/` | 主程序构建器，注册所有顶层命令 |
| `argv.ts` | 参数预处理、别名解析 |
| `profile.ts` | 配置文件（profile）切换 |
| `run-main.ts` | 运行入口包装，错误处理 |
| `progress.ts` | 终端进度条 / Spinner（clack/prompts） |

### src/commands — 命令实现

| 子目录 | 命令 |
|--------|------|
| `agent/` | `openclaw agent` — 代理交互与会话 |
| `auth-choice/` | `openclaw auth` — 认证选择流程 |
| `models-cli.ts` | `openclaw models` — 模型列表与切换 |
| `plugins-cli.ts` | `openclaw plugins` — 插件安装/卸载/列出 |
| `onboard-search.ts` | `openclaw onboard` — 引导式配置向导 |

### src/channels — 频道注册表

```
registry.ts    # 频道元数据、顺序、能力声明
dock.ts        # 统一频道操作接口（Dock 模式）
session.ts     # 频道会话状态
targets.ts     # 消息目标解析
```

### src/routing — 消息路由

```
resolve-route.ts    # 入站消息 → 目标账号/会话
account-id.ts       # 账号 ID 解析
session-key.ts      # 会话键（Session Key）派生
```

### src/infra — 基础设施

```
exec-approvals.ts       # 命令执行用户授权机制
host-env-security.ts    # 主机环境安全策略
device-bootstrap.ts     # 设备初始化与引导
```

### src/media — 媒体管道

```
audio.ts        # 音频编解码（FFmpeg）
image-ops.ts    # 图像处理（sharp）
pdf-extract.ts  # PDF 文本提取（pdfjs-dist）
mime.ts         # MIME 类型检测
```

---

## 频道（Channel）架构

### 频道插件接口

每个频道通过实现 `ChannelPlugin` 接口对外提供能力，接口由以下多个 Adapter 组成：

```typescript
interface ChannelPlugin {
  id: string;
  name: string;
  configSchema: PluginConfigSchema;
  capabilities: {
    messaging?: ChannelMessagingAdapter;    // 收发消息
    auth?: ChannelAuthAdapter;             // 登录/登出
    outbound?: ChannelOutboundAdapter;     // 主动发送
    resolver?: ChannelResolverAdapter;     // 用户 ID 解析
    gateway?: ChannelGatewayAdapter;       // 网关集成 Hook
    heartbeat?: ChannelHeartbeatAdapter;   // 健康检查
    directory?: ChannelDirectoryAdapter;  // 群组/联系人发现
    threading?: ChannelThreadingAdapter;  // 线程/对话管理
  }
}
```

### 内置频道 vs 扩展频道

OpenClaw 将所有频道实现以插件形式放在 `extensions/` 中，通过统一的 Plugin Registry 加载：

```
内置（Core）频道注册表 → src/channels/registry.ts
扩展（Extension）频道 → extensions/{name}/index.ts
     ↓ 均通过 api.registerChannel() 注册
Plugin Registry (src/plugins/registry.ts)
```

### 消息收发流程

```
入站消息（Telegram Webhook / Discord WS / etc）
  │
  ▼
ChannelMessagingAdapter.onMessage()
  │
  ▼
src/routing/resolve-route.ts
  │ 会话键 + 账号映射
  ▼
Gateway RPC → 代理（Agent）调度
  │
  ▼
代理处理 → 工具调用（可选）
  │
  ▼
ChannelOutboundAdapter.sendMessage()
  │
  ▼
用户收到回复（原频道）
```

---

## 网关（Gateway）系统

网关是 OpenClaw 的核心服务进程，负责：

- 管理频道连接生命周期
- 提供 WebSocket/HTTP API（供 CLI、移动端、Web UI 连接）
- 代理进程编排（ACP 协议）
- 插件加载与 Hook 触发
- 认证与安全管控

### 目录结构

```
src/gateway/
├── server.ts              # 服务器主入口，生命周期管理
├── boot.ts                # 启动序列（端口绑定、插件加载）
├── auth.ts                # 认证模式（默认 Token / ControlUI / 设备）
├── call.ts                # 函数/工具调用处理
├── server-methods/        # RPC 方法实现（20+ 处理器）
│   ├── server-methods.ts  # 方法注册表
│   ├── server-chat.ts     # 消息发送处理
│   ├── server-sessions.ts # 会话管理
│   ├── server-plugins.ts  # 插件加载
│   └── ...
└── protocol/              # 通信协议定义
    ├── protocol.schema.ts # 消息类型（Zod Schema）
    └── connect-error-details.ts
```

### 认证模式

| 模式 | 用途 |
|------|------|
| `default-token` | CLI 本地连接（设备令牌） |
| `control-ui` | Web 控制台（浏览器） |
| `device` | 移动端配对（iOS/Android） |

---

## 插件（Plugin）体系

### 插件类型

| 类型 | 注册方法 | 用途 |
|------|----------|------|
| **频道插件** | `api.registerChannel()` | 接入新消息平台 |
| **命令插件** | `api.registerCommand()` | 添加 CLI 子命令 |
| **Hook 插件** | `api.registerHook()` | 监听生命周期事件 |
| **HTTP 处理器** | `api.registerHttpHandler()` | Webhook 端点 |
| **工具插件** | `api.registerTool()` | 代理可调用工具 |
| **服务插件** | `api.registerService()` | 后台常驻服务 |
| **Provider 插件** | `api.registerProvider()` | LLM/模型认证 |

### 插件结构示例

```
extensions/telegram/
├── package.json        # "openclaw" 在 devDependencies / peerDependencies
├── index.ts            # Plugin 入口，导出 register() 函数
├── src/
│   ├── channel.ts      # ChannelPlugin 实现
│   ├── adapter.ts      # Messaging/Auth/Outbound Adapters
│   └── *.test.ts       # 测试
└── README.md
```

```typescript
// extensions/telegram/index.ts
export default {
  id: "telegram",
  name: "Telegram",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: telegramPlugin });
  }
};
```

### Plugin SDK 导出

插件通过 `openclaw/plugin-sdk` 访问 SDK，拥有 50+ 子路径导出：

```typescript
import { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { TelegramContext } from "openclaw/plugin-sdk/telegram";
```

### 插件注册表（运行时）

```
src/plugins/runtime.ts     # 全局单例注册表管理
  setActivePluginRegistry()
  getActivePluginRegistry()
  requireActivePluginRegistry()

src/plugins/registry.ts    # 注册 Channel / Tool / Hook / HTTP 路由
```

---

## 代理（Agent）系统

### 代理编排流程

```
openclaw agent [--message "..."]
  │
  ▼
src/commands/agent/          # CLI 代理命令
  │
  ▼
Gateway RPC (agent:spawn)
  │
  ▼
src/agents/acp-spawn.ts      # ACP（Agent Control Protocol）子进程启动
  │
  ▼
代理进程（独立 Node 子进程）
  │  ├─ Tool 调用（shell exec、web fetch 等）
  │  ├─ src/infra/exec-approvals.ts（执行授权）
  │  └─ 工具插件（Plugin Tools）
  │
  ▼
回复通过 Gateway 发回原频道
```

### Auth Profiles（认证配置）

```
src/agents/auth-profiles/
  ├── types.ts              # AuthProfile 接口定义
  ├── resolve.ts            # 从配置加载 Auth Profile
  └── providers/            # 各 LLM Provider 的 Token 获取逻辑
```

### 代理工具（Tools）

代理可以调用：

| 工具类别 | 来源 |
|----------|------|
| 内置 Shell 工具 | `src/agents/tools/` |
| 内置 Web 工具 | `src/agents/tools/` |
| 插件工具 | `api.registerTool()` |
| MCP（Model Context Protocol）工具 | `@modelcontextprotocol/sdk` |

---

## CLI 架构

```
openclaw.mjs                  # 入口（Node 版本检查 + 模块缓存）
  │
  ▼
src/entry.ts                  # 导入 CLI 程序构建器
  │
  ▼
src/cli/program.ts            # Commander.js 程序树
  │
  ├─ agent         → src/commands/agent/
  ├─ message       → src/commands/message-cli.ts
  ├─ config        → src/commands/config-cli.ts
  ├─ models        → src/commands/models-cli.ts
  ├─ plugins       → src/commands/plugins-cli.ts
  ├─ channels      → src/commands/channels-cli.ts
  ├─ gateway       → src/commands/gateway-cli.ts
  ├─ auth          → src/commands/auth-choice/
  ├─ onboard       → src/commands/onboard-search.ts
  ├─ skills        → src/commands/skills-cli.ts
  ├─ hooks         → src/commands/hooks-cli.ts
  └─ ...（100+ 子命令）
```

**依赖注入：**

```typescript
// 通过 createDefaultDeps() 注入默认实现
const deps = createDefaultDeps();
// 包含：logger、fs、exec、fetch、config loader 等
```

---

## 构建系统

### 构建流程

```
1. Canvas UI 资产打包
   pnpm canvas:a2ui:bundle
   └─ 打包 ui/src → 生成 bundle hash

2. TypeScript → JavaScript
   node scripts/tsdown-build.mjs
   └─ 使用 tsdown (0.21.2) 打包
   └─ 输出目录：dist/
   └─ 格式：ESM，Node 目标

3. Plugin SDK 类型声明
   pnpm build:plugin-sdk:dts
   └─ 从 tsconfig.plugin-sdk.dts.json 生成 .d.ts

4. 元数据写入
   node scripts/write-*.ts
   └─ Hook 元数据、导出清单、构建信息
```

### 关键配置文件

| 文件 | 用途 |
|------|------|
| `tsconfig.json` | TypeScript 编译（ES2023、ESM、strict） |
| `tsdown.config.ts` | 多入口打包（50+ 入口点） |
| `package.json exports` | 子路径导出映射（plugin-sdk/*） |

### 输出目录

```
dist/
├── index.js           # 主导出
├── entry.js           # CLI 入口
├── plugin-sdk/        # Plugin SDK（50+ 模块）
├── cli/               # CLI 命令
├── gateway/           # 网关服务器
├── channels/          # 频道适配器
└── ...（镜像 src/ 结构）
```

---

## 测试体系

### 测试分层

| 层次 | 配置文件 | 说明 |
|------|----------|------|
| **单元测试** | `vitest.config.ts` | `src/**/*.test.ts` |
| **E2E 测试** | `vitest.e2e.config.ts` | 完整系统集成 |
| **实时测试** | `vitest.live.config.ts` | 真实 API 凭证 |
| **网关测试** | `vitest.gateway.config.ts` | 服务器专项（forks 模式） |
| **频道测试** | `vitest.channels.config.ts` | 频道专项 |
| **扩展测试** | `vitest.extensions.config.ts` | 插件专项 |

### 覆盖率目标

```
lines:       70%
branches:    70%
functions:   70%
statements:  70%
```

### 运行命令

```bash
pnpm test                           # 全量单元测试
pnpm test:coverage                  # 带覆盖率报告
pnpm test -- src/commands/xxx.test.ts   # 单文件测试
pnpm test:e2e                       # E2E 测试
OPENCLAW_LIVE_TEST=1 pnpm test:live # 实时测试
pnpm test:docker:all                # Docker 集成测试
```

---

## 移动端与桌面端应用

### 应用架构

所有客户端均通过 **WebSocket + 二进制协议** 连接到本地或远程网关（Gateway）。

```
apps/
├── ios/                    # iOS 应用（Swift + Observation 框架）
│   ├── Sources/            # SwiftUI 视图层
│   └── project.yml         # XcodeGen 配置
│
├── android/                # Android 应用（Kotlin + Jetpack Compose）
│   ├── app/                # 主应用模块
│   └── benchmark/          # 性能基准测试
│
├── macos/                  # macOS 应用（Swift + SwiftUI）
│   ├── Sources/OpenClaw/   # 菜单栏应用，内嵌网关进程
│   └── Resources/          # 配置、图标、资产
│
└── shared/                 # 共享 Swift 库
    └── OpenClawKit/        # 网关通信、Session、消息模型
```

**macOS 应用特殊性：** macOS 应用内嵌了网关进程（Gateway），通过菜单栏图标控制启停。

---

## 数据流向

### 完整消息流

```
┌─────────────────────────────────────────────┐
│             外部消息平台                       │
│  (Telegram / Discord / Slack / WhatsApp...)  │
└───────────────────┬─────────────────────────┘
                    │  Webhook / WebSocket / Polling
                    ▼
┌─────────────────────────────────────────────┐
│           频道插件（Channel Plugin）           │
│   ChannelMessagingAdapter.onMessage()        │
└───────────────────┬─────────────────────────┘
                    │  标准化消息对象
                    ▼
┌─────────────────────────────────────────────┐
│           路由解析（Routing）                  │
│   src/routing/resolve-route.ts               │
│   ├─ 账号 ID 查找                            │
│   ├─ 会话键派生                               │
│   └─ 频道配对映射                             │
└───────────────────┬─────────────────────────┘
                    │  路由目标
                    ▼
┌─────────────────────────────────────────────┐
│           网关（Gateway）                     │
│   src/gateway/server.ts                      │
│   ├─ Hook 触发（agent:before-run）           │
│   ├─ 代理进程调度（ACP）                      │
│   └─ 会话状态管理                             │
└───────────────────┬─────────────────────────┘
                    │  ACP 协议
                    ▼
┌─────────────────────────────────────────────┐
│           代理进程（Agent Process）            │
│   src/agents/acp-spawn.ts                    │
│   ├─ LLM API 调用（OpenAI / Claude / etc）   │
│   ├─ Tool 调用（Shell / Web / Plugin）        │
│   └─ 记忆检索（Memory）                       │
└───────────────────┬─────────────────────────┘
                    │  代理回复
                    ▼
┌─────────────────────────────────────────────┐
│         出站适配器（Outbound Adapter）         │
│   ChannelOutboundAdapter.sendMessage()       │
└───────────────────┬─────────────────────────┘
                    │  平台 API 调用
                    ▼
┌─────────────────────────────────────────────┐
│             用户收到回复                       │
│             （原频道）                         │
└─────────────────────────────────────────────┘
```

### 客户端连接流

```
CLI / Mobile App / Web UI
  │  WebSocket (ws://)
  ▼
Gateway WebSocket Server
  │  RPC 方法调用
  ├─ agent:spawn
  ├─ message:send
  ├─ sessions:list
  ├─ channels:status
  └─ ...
```

---

## 关键设计模式

### 1. 依赖注入（Dependency Injection）

```typescript
// 通过 createDefaultDeps() 构建 CLI 依赖
const deps = createDefaultDeps();
// 包含：logger、fs（文件系统）、exec（进程执行）、
//       fetch（HTTP）、config loader 等
```

所有命令通过参数接收依赖，便于测试时替换 Mock 实现。

### 2. 插件注册表（Plugin Registry — 全局单例）

```typescript
// 运行时全局注册表
setActivePluginRegistry(registry);   // 初始化
getActivePluginRegistry();           // 获取（可为空）
requireActivePluginRegistry();       // 获取（不为空，否则抛出）
```

### 3. Dock 模式（Channel Dock）

`src/channels/dock.ts` 提供统一的频道操作门面（Facade），屏蔽不同频道的实现差异：

```
ChannelPlugin (扩展实现)
  ↓
Channel Dock (src/channels/dock.ts) — 统一接口
  ↓
Gateway (路由、会话管理)
```

### 4. Observer 模式（Hook System）

```typescript
// 插件注册 Hook
api.registerHook("agent:before-run", async (ctx) => {
  // 在代理运行前触发
});

// 网关触发 Hook
await hooksRunner.run("agent:before-run", context);
```

### 5. 适配器模式（Adapter Pattern）

每个频道插件通过多个 Adapter 接口实现特定能力，允许按需实现子集：

```
ChannelPlugin.capabilities
  ├── messaging    (必须)  — 消息收发
  ├── auth         (可选)  — 登录/登出
  ├── outbound     (可选)  — 主动发送
  ├── heartbeat    (可选)  — 健康检查
  └── directory    (可选)  — 联系人发现
```

---

## 依赖概览

### 运行时核心依赖

| 包 | 版本 | 用途 |
|----|------|------|
| `grammy` | ^1.41 | Telegram Bot API |
| `@slack/bolt` | ^4.6 | Slack SDK |
| `@whiskeysockets/baileys` | 7.0.0-rc.9 | WhatsApp Web |
| `discord-api-types` | — | Discord API |
| `@line/bot-sdk` | ^10.6 | LINE Bot API |
| `express` | ^5.2 | HTTP 服务器 |
| `hono` | 4.12.7 | 轻量 HTTP 框架 |
| `@modelcontextprotocol/sdk` | 1.27.1 | MCP 工具协议 |
| `zod` | ^4.3 | Schema 验证 |
| `commander` | ^14 | CLI 框架 |
| `yaml` | ^2.8 | YAML 解析 |
| `sharp` | ^0.34 | 图像处理 |
| `pdfjs-dist` | ^5.5 | PDF 解析 |

### 构建与开发依赖

| 包 | 版本 | 用途 |
|----|------|------|
| `tsdown` | 0.21.2 | TypeScript 打包 |
| `typescript` | ^5.9 | TypeScript 编译器 |
| `vitest` | ^4.1 | 测试框架 |
| `oxlint` | ^1.55 | Linter |
| `oxfmt` | 0.40 | 代码格式化 |
| `tsx` | ^4.21 | TypeScript 脚本执行 |

### 可选依赖

| 包 | 用途 |
|----|------|
| `node-llama-cpp` | 本地 LLM 推理 |
| `@napi-rs/canvas` | Canvas 渲染 |

---

## 代码规模统计

| 指标 | 数量 |
|------|------|
| TypeScript 源码行数 | ~593,000 |
| 官方扩展数量 | 36+ |
| Plugin SDK 导出入口 | 50+ |
| CLI 子命令数量 | 100+ |
| 支持频道数量 | 20+ |
| 测试套件配置 | 8 个 |
| 覆盖率目标 | 70% |

---

*本文档由源码分析自动生成，最后更新时间：2026-03-14*
