# Gateway 模块深度分析

> 对应源码目录：`src/gateway/`  
> 本文聚焦**流程主线**，关键位置附源码片段，力求简明扼要。

---

## 目录

1. [整体结构](#整体结构)
2. [启动流程](#启动流程)
3. [WebSocket 连接与握手](#websocket-连接与握手)
4. [RPC 请求分发](#rpc-请求分发)
5. [认证体系](#认证体系)
6. [HTTP 路由](#http-路由)
7. [频道管理](#频道管理)
8. [Hook 系统](#hook-系统)
9. [配置热重载](#配置热重载)
10. [关闭流程](#关闭流程)

---

## 整体结构

```
src/gateway/
├── server.ts                   # 公开导出入口（re-export）
├── server.impl.ts              # startGatewayServer()  ← 主流程
├── server-runtime-state.ts     # 创建 HTTP/WS 服务器、广播器
├── server-http.ts              # HTTP 请求路由（Hooks/控制台/健康检查）
├── server-methods.ts           # RPC 方法注册表 + 分发
├── server-methods/             # 各领域 RPC 处理器（agent/chat/sessions/...）
├── server/
│   ├── ws-connection.ts        # WebSocket 连接入口
│   └── ws-connection/
│       ├── message-handler.ts  # 消息解析 + 握手认证
│       └── auth-context.ts     # 设备/Token 认证上下文
├── auth.ts                     # 认证模式（Token/Password/TrustedProxy）
├── auth-rate-limit.ts          # IP 限速
├── hooks.ts                    # HTTP Hooks 配置解析
├── channel-health-monitor.ts   # 频道健康检查
├── config-reload.ts            # 配置热重载监听器
└── server-close.ts             # 优雅关闭处理
```

---

## 启动流程

> 入口：`startGatewayServer(port, opts)` — `server.impl.ts:267`

```
startGatewayServer(port, opts)
  │
  ├─ 1. 读取并迁移配置（migrateLegacyConfig）
  ├─ 2. 校验配置合法性（formatConfigIssueLines）
  ├─ 3. 激活 Secrets 快照（activateRuntimeSecrets）
  ├─ 4. 确保 Gateway Auth 存在（ensureGatewayStartupAuth）
  ├─ 5. 加载插件（loadGatewayPlugins）
  ├─ 6. 解析运行时配置（resolveGatewayRuntimeConfig）
  ├─ 7. 创建 HTTP/WS 运行时状态（createGatewayRuntimeState）
  │     └─ 创建 HTTP Server + WebSocket Server + 广播器
  ├─ 8. 注册代理事件处理器（onAgentEvent → createAgentEventHandler）
  ├─ 9. 启动辅助服务
  │     ├─ 服务发现（startGatewayDiscovery）
  │     ├─ Heartbeat Runner（startHeartbeatRunner）
  │     ├─ 频道健康监控（startChannelHealthMonitor）
  │     ├─ Cron 服务（cron.start()）
  │     └─ Tailscale 暴露（startGatewayTailscaleExposure）
  ├─ 10. 挂载 WS 处理器（attachGatewayWsHandlers）
  ├─ 11. 启动频道（startChannels）
  ├─ 12. 触发 gateway_start 插件 Hook
  └─ 13. 返回 { close() }
```

**关键源码（`server.impl.ts:267`）：**

```typescript
export async function startGatewayServer(
  port = 18789,
  opts: GatewayServerOptions = {},
): Promise<GatewayServer> {
  // 1. 读取配置，检测遗留格式并自动迁移
  let configSnapshot = await readConfigFileSnapshot();
  if (configSnapshot.legacyIssues.length > 0) {
    const { config: migrated } = migrateLegacyConfig(configSnapshot.parsed);
    await writeConfigFile(migrated);
  }

  // 2-4. 激活 Secrets & 确保 Auth
  cfgAtStart = (await activateRuntimeSecrets(cfgAtStart, { reason: "startup", activate: true })).config;
  const authBootstrap = await ensureGatewayStartupAuth({ cfg: cfgAtStart, ... });

  // 5. 加载插件（含频道插件）
  const { pluginRegistry, gatewayMethods } = loadGatewayPlugins({ cfg, ... });

  // 7. 创建 HTTP/WS 运行时（HTTP Server + WSS + Broadcaster）
  const { httpServer, wss, clients, broadcast, ... } = await createGatewayRuntimeState({ ... });

  // 10. 挂载 WS 连接处理器
  attachGatewayWsHandlers({ wss, clients, resolvedAuth, ... });

  // 11. 启动所有频道（Telegram polling / Discord WS / etc.）
  await startGatewaySidecars({ cfg, pluginRegistry, startChannels, ... });

  // 12. 触发 gateway_start hook
  void hookRunner.runGatewayStart({ port }, { port });

  return { close: async (opts) => { ... } };
}
```

---

## WebSocket 连接与握手

> 主链路：`ws-connection.ts` → `message-handler.ts`

### 连接建立

```
wss.on("connection", (socket, upgradeReq))   ← ws-connection.ts:115
  │
  ├─ 生成 connId（UUID）
  ├─ 立即发送 connect.challenge（含 nonce）
  ├─ 启动握手超时定时器（handshakeTimeoutMs）
  └─ 挂载消息处理器（attachGatewayWsMessageHandler）
```

**关键源码（`ws-connection.ts:174`）：**

```typescript
// 连接后立即发出挑战（challenge）
const connectNonce = randomUUID();
send({
  type: "event",
  event: "connect.challenge",
  payload: { nonce: connectNonce, ts: Date.now() },
});

// 握手超时保护
const handshakeTimer = setTimeout(() => {
  if (!client) {
    close();   // 超时未完成握手则断开
  }
}, handshakeTimeoutMs);
```

### 握手协议（message-handler.ts）

```
客户端发送第一帧
  { type:"req", method:"connect", params: ConnectParams }
  │
  ├─ 协议版本协商（minProtocol / maxProtocol）
  ├─ 角色解析（operator / viewer / node）
  ├─ 来源（Origin）安全检查（Control UI / Webchat）
  ├─ 认证：
  │   ├─ Token 认证（authorizeGatewayConnect）
  │   ├─ 设备 Token 认证（verifyDeviceToken）
  │   └─ Tailscale 认证（resolveVerifiedTailscaleUser）
  ├─ 认证成功 → 创建 GatewayWsClient，加入 clients 集合
  └─ 握手成功 → 发送 connect.success 事件，后续帧进入 RPC 分发
```

**关键源码（`message-handler.ts:369`）：**

```typescript
// 协议版本协商
if (maxProtocol < PROTOCOL_VERSION || minProtocol > PROTOCOL_VERSION) {
  sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, "protocol mismatch");
  close(1002, "protocol mismatch");
  return;
}

// 角色解析
const role = parseGatewayRole(connectParams.role ?? "operator");
if (!role) {
  sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, "invalid role");
  close(1008, "invalid role");
  return;
}
```

### 帧格式

| 方向 | 格式 |
|------|------|
| 请求 | `{ type:"req", id:string, method:string, params:{} }` |
| 响应 | `{ type:"res", id:string, ok:boolean, payload?:{}, error?:{} }` |
| 事件 | `{ type:"event", event:string, payload:{} }` |

---

## RPC 请求分发

> 核心：`handleGatewayRequest()` — `server-methods.ts:100`

```
WS 帧（type:"req"）到达
  │
  ├─ authorizeGatewayMethod()    ← 角色 + Scope 鉴权
  ├─ consumeControlPlaneWriteBudget()  ← 写操作限速
  ├─ 查找 handler（extraHandlers → coreGatewayHandlers）
  └─ handler({ req, params, client, respond, context })
```

**关键源码（`server-methods.ts:100`）：**

```typescript
export async function handleGatewayRequest(
  opts: GatewayRequestOptions & { extraHandlers?: GatewayRequestHandlers },
): Promise<void> {
  // 1. 角色 + scope 鉴权
  const authError = authorizeGatewayMethod(req.method, client);
  if (authError) { respond(false, undefined, authError); return; }

  // 2. 控制平面写操作限速（config.apply / config.patch / update.run）
  if (CONTROL_PLANE_WRITE_METHODS.has(req.method)) {
    const budget = consumeControlPlaneWriteBudget({ client });
    if (!budget.allowed) { respond(false, undefined, errorShape(...)); return; }
  }

  // 3. 查找并调用 handler
  const handler = opts.extraHandlers?.[req.method] ?? coreGatewayHandlers[req.method];
  if (!handler) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `unknown method: ${req.method}`));
    return;
  }
  await withPluginRuntimeGatewayRequestScope(
    { context, client, isWebchatConnect },
    () => handler({ req, params, client, isWebchatConnect, respond, context }),
  );
}
```

### 核心 RPC 方法分布

| 模块文件 | 方法前缀 | 主要功能 |
|----------|---------|---------|
| `agent.ts` | `agent.*` | 代理运行、流式输出 |
| `chat.ts` | `chat.*` | 对话消息、流式增量 |
| `sessions.ts` | `sessions.*` | 会话列表、历史 |
| `channels.ts` | `channels.*` | 频道状态、配置 |
| `health.ts` | `health` | 服务健康快照 |
| `send.ts` | `send.*` | 主动发送消息 |
| `models.ts` | `models.*` | 模型列表与切换 |
| `config.ts` | `config.*` | 配置读写 |
| `skills.ts` | `skills.*` | 技能（Skill）管理 |
| `devices.ts` | `devices.*` | 设备配对 |
| `cron.ts` | `cron.*` | 定时任务 |
| `update.ts` | `update.*` | 版本更新 |

---

## 认证体系

> `auth.ts`，支持 4 种模式：

```
ResolvedGatewayAuth.mode
  ├── "none"           无需认证（开发/内网）
  ├── "token"          Bearer Token（默认）
  ├── "password"       密码认证
  └── "trusted-proxy"  反向代理注入用户头
```

**`authorizeGatewayConnect()` 主流（`auth.ts:369`）：**

```typescript
export async function authorizeGatewayConnect(params): Promise<GatewayAuthResult> {
  // trusted-proxy 模式：验证来源 IP + 用户头
  if (auth.mode === "trusted-proxy") {
    return authorizeTrustedProxy({ req, trustedProxies, trustedProxyConfig });
  }

  // none 模式：直通
  if (auth.mode === "none") {
    return { ok: true, method: "none" };
  }

  // 限速检查（IP 维度）
  const rlCheck = limiter.check(ip, rateLimitScope);
  if (!rlCheck.allowed) {
    return { ok: false, reason: "rate_limited", rateLimited: true };
  }

  // Tailscale Header Auth（仅 WS Control UI）
  if (allowTailscaleHeaderAuth && auth.allowTailscale) {
    const tailscaleCheck = await resolveVerifiedTailscaleUser({ req, tailscaleWhois });
    if (tailscaleCheck.ok) return { ok: true, method: "tailscale" };
  }

  // Token / Password 验证（恒定时间比较，防时序攻击）
  if (auth.mode === "token") {
    if (!safeEqualSecret(connectAuth.token, auth.token)) {
      limiter.recordFailure(ip, rateLimitScope);
      return { ok: false, reason: "token_mismatch" };
    }
    return { ok: true, method: "token" };
  }
  // password 模式同理...
}
```

### 设备 Token 认证（移动端配对）

```
移动端首次连接
  └─ connectParams.device = { publicKey, signature, ... }
      │
      ├─ verifyDeviceToken()           验证已配对设备
      ├─ requestDevicePairing()        请求新配对（二维码）
      └─ approveDevicePairing()        操作员审批配对
```

---

## HTTP 路由

> `server-http.ts` — `createGatewayHttpServer()` 中的统一请求处理器

```
HTTP 请求进入
  │
  ├─ /health / /healthz / /ready / /readyz  → 健康探针
  ├─ /v1/chat/completions                    → OpenAI 兼容 Chat API
  ├─ /v1/responses                           → OpenResponses API
  ├─ {hooksBasePath}/*                       → 用户定义 Webhooks（Hook 系统）
  ├─ /api/channels/mattermost/*              → Mattermost Slash 命令
  ├─ /api/channels/slack/*                   → Slack 事件回调
  ├─ /tools/invoke                           → 工具 HTTP 调用
  ├─ /avatar/*                               → 代理头像
  ├─ /canvas/*                               → Canvas A2UI
  ├─ /plugins/*                              → 插件注册的 HTTP 路由
  └─ /*                                      → Control UI 静态资源（SPA）
```

### WebSocket Upgrade

```
HTTP Upgrade → ws://
  │
  attachGatewayUpgradeHandler()
  └─ wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
```

---

## 频道管理

> `server-channels.ts` — `createChannelManager()`

```
startChannels()
  │
  ├─ 遍历所有已启用频道插件（listChannelPlugins()）
  ├─ 每个频道 → startChannel(channelId, accountId)
  │   ├─ 调用 plugin.start(cfg, runtime)
  │   ├─ 失败后按指数退避重试（最多 10 次，上限 5 分钟）
  │   └─ 维护 abort + task Map（可独立停止）
  └─ 返回 getRuntimeSnapshot()（供 health / status 查询）
```

**退避策略（`server-channels.ts:13`）：**

```typescript
const CHANNEL_RESTART_POLICY: BackoffPolicy = {
  initialMs: 5_000,   // 初始 5s
  maxMs: 5 * 60_000,  // 最大 5 分钟
  factor: 2,          // 每次翻倍
  jitter: 0.1,        // 10% 随机抖动
};
const MAX_RESTART_ATTEMPTS = 10;
```

**频道健康监控（`channel-health-monitor.ts`）：**

```
定时器（默认 5 分钟）触发
  └─ 遍历所有频道 → 调用 heartbeat adapter
      ├─ 成功 → 更新状态为 connected
      └─ 失败 → 更新状态为 error，触发重启逻辑
```

---

## Hook 系统

> `hooks.ts` + `server-http.ts`

### 配置结构

```yaml
hooks:
  enabled: true
  token: "secret-token"
  path: "/hooks"          # 默认路径
  mappings:               # 路径→代理/频道映射
    - path: "/hooks/alert"
      agent: "my-agent"
      channel: telegram
```

### HTTP Hook 请求流

```
POST /hooks/alert
  │
  ├─ Bearer Token 校验（safeEqualSecret）
  ├─ 幂等键去重（idempotency key）
  ├─ 解析请求体（JSON，最大 256KB）
  ├─ 应用 Hook 映射（applyHookMappings）
  │   └─ 选择目标 agentId + sessionKey + channel
  └─ dispatchAgentHook()
      └─ agentCommand({ message, sessionKey, deliver: true })
```

---

## 配置热重载

> `config-reload.ts` — `startGatewayConfigReloader()`

```
文件监听（watchPath = ~/.openclaw/config.yaml）
  │
  变化检测 → buildConfigReloadPlan(prevConfig, nextConfig)
  │
  ├─ 热重载（Hot Reload）：不重启，原地更新
  │   ├─ Hooks 配置更新
  │   ├─ Heartbeat Runner 更新
  │   ├─ Cron 任务更新
  │   └─ 频道启停（startChannel / stopChannel）
  │
  └─ 需重启（Restart）：调用 requestGatewayRestart()
      └─ SIGUSR1 信号触发进程重启（macOS App 托管时生效）
```

**关键源码（`server.impl.ts:987`）：**

```typescript
startGatewayConfigReloader({
  initialConfig: cfgAtStart,
  readSnapshot: readConfigFileSnapshot,
  onHotReload: async (plan, nextConfig) => {
    // 先激活新 Secrets 快照，再应用配置变更
    const prepared = await activateRuntimeSecrets(nextConfig, { reason: "reload", activate: true });
    await applyHotReload(plan, prepared.config);
  },
  onRestart: async (plan, nextConfig) => {
    await activateRuntimeSecrets(nextConfig, { reason: "restart-check", activate: false });
    requestGatewayRestart(plan, nextConfig);
  },
  watchPath: CONFIG_PATH,
});
```

---

## 关闭流程

> `server-close.ts` — `createGatewayCloseHandler()`

```
gateway.close()
  │
  ├─ 1. 触发 gateway_stop 插件 Hook（fire-and-wait，最多 10s）
  ├─ 2. 广播 gateway.stopping 事件给所有客户端
  ├─ 3. 停止定时器（tick / health / dedupe / media cleanup）
  ├─ 4. 停止 Cron 服务
  ├─ 5. 停止 Heartbeat Runner
  ├─ 6. 停止所有频道（stopChannel × N）
  ├─ 7. 停止插件服务（pluginServices.stop()）
  ├─ 8. 关闭 Bonjour 服务发现
  ├─ 9. 关闭 Tailscale 暴露
  ├─ 10. 关闭 WebSocket Server（断开所有客户端）
  └─ 11. 关闭 HTTP Server
```

---

## 核心数据流总结

```
外部客户端（CLI / iOS / Android / Web）
         │ WebSocket
         ▼
  ws-connection.ts
  ├─ Challenge/Nonce ──────────────→ 客户端
  ├─ 握手认证（Token/Device/Tailscale）
  └─ 握手成功 → 加入 clients 集合
         │ JSON Frame (type:"req")
         ▼
  message-handler.ts
  └─ handleGatewayRequest()
         │
         ├─ 鉴权 + 限速
         └─ handler(req, context)
               │
               ├─ agent.*  → agentCommand() → ACP 子进程 → LLM → 流式广播
               ├─ send.*   → ChannelOutboundAdapter → 消息平台
               ├─ health   → 返回快照
               └─ config.* → writeConfigFile()
```

---

*文档生成时间：2026-03-14*
