# Agents 模块深度分析

> 对应源码目录：`src/agents/`  
> 本文聚焦**代理生命周期、工具调用、Auth Profiles** 三条主线，关键位置附源码片段。

---

## 目录

1. [整体结构](#整体结构)
2. [代理生命周期](#代理生命周期)
3. [工具体系](#工具体系)
4. [Auth Profiles（认证轮转）](#auth-profiles认证轮转)
5. [上下文与系统提示词](#上下文与系统提示词)
6. [会话管理与压缩](#会话管理与压缩)
7. [ACP 子代理生成](#acp-子代理生成)
8. [Exec 工具（Bash 执行）](#exec-工具bash-执行)
9. [失效转移与重试](#失效转移与重试)
10. [核心数据流总结](#核心数据流总结)

---

## 整体结构

```
src/agents/
├── pi-embedded-runner/         # ★ 核心运行引擎
│   ├── run.ts                  # runEmbeddedPiAgent()  ← 主入口
│   ├── run/attempt.ts          # runEmbeddedAttempt()  ← 单次尝试
│   ├── runs.ts                 # 全局活跃 Run 注册表
│   ├── system-prompt.ts        # 系统提示词构建
│   ├── compact.ts              # 上下文溢出压缩
│   ├── model.ts                # 模型解析
│   ├── lanes.ts                # 并发泳道
│   └── skills-runtime.ts       # Skills 技能注入
│
├── auth-profiles/              # Auth Profile 体系
│   ├── types.ts                # 类型定义
│   ├── store.ts                # 持久化（JSON + 文件锁）
│   ├── order.ts                # 排序与轮转策略
│   ├── usage.ts                # 冷却期 / 失败统计
│   ├── oauth.ts                # OAuth 令牌刷新
│   └── credential-state.ts     # 凭据有效性评估
│
├── tools/                      # 内置工具定义（agent-facing）
│   ├── message-tool.ts         # 消息发送工具
│   ├── memory-tool.ts          # 记忆写入工具
│   ├── sessions-*.ts           # 会话生命周期工具
│   ├── web-fetch.ts / web-search.ts  # Web 工具
│   └── ...
│
├── bash-tools.exec.ts          # Exec/Shell 工具（createExecTool）
├── bash-tools.process.ts       # 持久化进程工具
├── pi-tools.ts                 # 工具装配（createOpenClawCodingTools）
├── tool-policy.ts              # 工具访问策略
├── tool-policy-pipeline.ts     # 多层策略管道
├── acp-spawn.ts                # ACP 子代理生成
├── workspace.ts                # 工作区文件读取
├── workspace-run.ts            # 工作区解析（运行时）
├── bootstrap-files.ts          # Bootstrap 文件（AGENTS.md 等）
└── context-window-guard.ts     # 上下文窗口保护
```

---

## 代理生命周期

### 主入口：`runEmbeddedPiAgent()`

> `src/agents/pi-embedded-runner/run.ts:262`

```
runEmbeddedPiAgent(params)
  │
  ├─ 1. 入队（泳道隔离）
  │     enqueueSession() → enqueueGlobal()
  │     └─ 同一 sessionKey 串行执行；全局泳道控制并发上限
  │
  ├─ 2. 工作区解析
  │     resolveRunWorkspaceDir({ workspaceDir, sessionKey, agentId })
  │     └─ 优先使用显式路径，否则按 agentId 推断
  │
  ├─ 3. Plugin Hooks（前置）
  │     before_model_resolve → 允许插件覆盖 provider/model
  │     before_agent_start   → 旧版模型覆盖钩子
  │
  ├─ 4. 模型解析
  │     resolveModel(provider, modelId, agentDir, config)
  │     └─ 返回 model + authStorage + modelRegistry
  │
  ├─ 5. Auth Profile 解析（见 §Auth Profiles）
  │     resolveAuthProfileOrder() → profileCandidates[]
  │
  ├─ 6. API Key 应用
  │     applyApiKeyInfo(candidate) → authStorage.setRuntimeApiKey(...)
  │
  └─ 7. 重试循环（主循环）
         while (true) {
           runEmbeddedAttempt(...)    ← 单次尝试
           处理溢出/失败/降级/切换 Auth Profile
         }
```

**关键源码（`run.ts:281`）：**

```typescript
// 入队：session 泳道 + global 泳道双层队列
return enqueueSession(() =>
  enqueueGlobal(async () => {
    // 工作区解析
    const workspaceResolution = resolveRunWorkspaceDir({
      workspaceDir: params.workspaceDir,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      config: params.config,
    });

    // 插件 Hook：before_model_resolve
    if (hookRunner?.hasHooks("before_model_resolve")) {
      modelResolveOverride = await hookRunner.runBeforeModelResolve(
        { prompt: params.prompt },
        hookCtx,
      );
    }

    // 模型解析
    const { model, error, authStorage, modelRegistry } = resolveModel(
      provider, modelId, agentDir, params.config,
    );

    // Auth Profile 排序
    const profileOrder = resolveAuthProfileOrder({ cfg, store, provider, preferredProfile });
    const profileCandidates = lockedProfileId ? [lockedProfileId] : profileOrder;

    // 应用 API Key
    await applyApiKeyInfo(profileCandidates[profileIndex]);

    // 主重试循环
    while (true) {
      const attempt = await runEmbeddedAttempt({ ...params, model, provider });
      // 处理溢出压缩、失败转移、切换 Profile...
    }
  }),
);
```

### 单次尝试：`runEmbeddedAttempt()`

> `src/agents/pi-embedded-runner/run/attempt.ts`

```
runEmbeddedAttempt(params)
  │
  ├─ 1. 工具装配（createOpenClawCodingTools）
  │     - 核心工具 + 渠道专属工具 + Skills 工具 + 插件工具
  │     - 经工具策略管道过滤（applyToolPolicyPipeline）
  │
  ├─ 2. 系统提示词构建（buildEmbeddedSystemPrompt）
  │     - AGENTS.md / SOUL.md / HEARTBEAT.md / 技能提示 / 沙盒信息
  │
  ├─ 3. 加载 / 创建会话
  │     prepareSessionManagerForRun() → SessionManager
  │     └─ 加载历史、修复损坏转录、限制轮次
  │
  ├─ 4. 创建 AgentSession（pi-coding-agent）
  │     createAgentSession(model, tools, system, messages, ...)
  │
  ├─ 5. 流式推理（streaming）
  │     agent.stream() → AsyncIterable<AgentMessage>
  │     └─ 每个 chunk → onPartialReply / onBlockReply
  │
  ├─ 6. 工具调用响应（LLM → 工具 → LLM）
  │     每当 LLM 返回 tool_use → 对应工具执行 → tool_result 回注
  │
  └─ 7. 会话持久化 + 事件广播
        saveSession() / emitSessionTranscriptUpdate()
```

---

## 工具体系

### 工具装配流程

> `src/agents/pi-tools.ts` — `createOpenClawCodingTools()`

```
createOpenClawCodingTools(options)
  │
  ├─ 基础工具集
  │   ├─ codingTools (read / write / edit / exec / process)
  │   ├─ createOpenClawTools() （消息/记忆/会话/Web/TTS 等）
  │   ├─ listChannelAgentTools() （渠道专属工具，如 telegram-actions）
  │   └─ Skills 技能工具（resolveEmbeddedRunSkillEntries）
  │
  ├─ 工具策略管道（applyToolPolicyPipeline）
  │   7 层策略按优先级逐层过滤：
  │   Profile 策略 → Provider Profile 策略 → 全局 allow →
  │   Provider allow → Agent allow → Agent Provider allow → Group allow
  │
  ├─ 消息渠道专属过滤（applyMessageProviderToolPolicy）
  │   如 voice 渠道 → 禁止 tts 工具（避免双重 TTS）
  │
  ├─ 模型专属过滤（applyModelProviderToolPolicy）
  │   如 xAI → 禁止 web_search（xAI 自带 native search）
  │
  └─ 工具定义适配（toClientToolDefinitions）
       根据 provider 清理/转换 schema（Gemini / Claude / OpenAI 差异）
```

### 工具策略管道（关键源码）

> `src/agents/tool-policy-pipeline.ts:66`

```typescript
export function applyToolPolicyPipeline(params: {
  tools: AnyAgentTool[];
  toolMeta: (tool: AnyAgentTool) => { pluginId: string } | undefined;
  warn: (message: string) => void;
  steps: ToolPolicyPipelineStep[];   // 7 层策略
}): AnyAgentTool[] {
  let filtered = params.tools;
  for (const step of params.steps) {
    if (!step.policy) continue;
    // 剥离仅限插件工具的 allowlist 条目（避免误过滤内置工具）
    let policy = step.stripPluginOnlyAllowlist
      ? stripPluginOnlyAllowlist(step.policy, pluginGroups, coreToolNames).policy
      : step.policy;
    filtered = filterToolsByPolicy(filtered, policy);
  }
  return filtered;
}
```

### 内置工具列表

| 工具名 | 文件 | 功能 |
|--------|------|------|
| `read` | pi-tools.read.ts | 读取文件 |
| `write` | pi-tools.read.ts | 写入文件（追加 / 覆盖） |
| `edit` | pi-tools.read.ts | 精确字符串替换 |
| `exec` | bash-tools.exec.ts | Shell 命令执行 |
| `process` | bash-tools.process.ts | 持久化进程交互 |
| `apply_patch` | apply-patch.ts | diff/patch 格式更改 |
| `message` | tools/message-tool.ts | 向渠道发消息 |
| `memory` | tools/memory-tool.ts | 写入持久记忆 |
| `web_fetch` | tools/web-fetch.ts | HTTP 抓取 |
| `web_search` | tools/web-search.ts | Web 搜索 |
| `sessions_send` | tools/sessions-send-tool.ts | 跨会话消息 |
| `sessions_spawn` | tools/sessions-spawn-tool.ts | 子会话生成 |
| `sessions_yield` | tools/sessions-yield-tool.ts | 中断并等待输入 |
| `cron` | tools/cron-tool.ts | 定时任务管理 |
| `tts` | tools/tts-tool.ts | 语音合成 |
| `image` | tools/image-tool.ts | 图像生成 |
| `browser` | tools/browser-tool.ts | 浏览器自动化 |

---

## Auth Profiles（认证轮转）

### 数据模型

> `src/agents/auth-profiles/types.ts`

```typescript
// 三种凭据类型
type ApiKeyCredential  = { type: "api_key"; provider: string; key?: string; ... };
type TokenCredential   = { type: "token";   provider: string; token?: string; ... };
type OAuthCredential   = { type: "oauth";   provider: string; ... };  // 可自动刷新

// Auth Profile 存储文件（~/.openclaw/auth.json）
type AuthProfileStore = {
  version: number;
  profiles: Record<string, AuthProfileCredential>;
  order?: Record<string, string[]>;     // 每 provider 的显式排序
  lastGood?: Record<string, string>;    // 上次成功使用的 profileId
  usageStats?: Record<string, ProfileUsageStats>;  // 冷却期、失败计数
};
```

### 排序策略

> `src/agents/auth-profiles/order.ts:67`

```
resolveAuthProfileOrder({ cfg, store, provider, preferredProfile })
  │
  ├─ 1. 清理过期冷却期（clearExpiredCooldowns）
  ├─ 2. 显式排序优先（store.order → config.auth.order）
  ├─ 3. 无显式排序：使用配置的 auth.profiles 顺序 / store 内同 provider 列表
  ├─ 4. 按 lastUsed 时间戳排序（轮询均衡）
  └─ 5. 置顶：preferredProfile 排在最前
```

**关键源码（`order.ts:67`）：**

```typescript
export function resolveAuthProfileOrder(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  preferredProfile?: string;
}): string[] {
  clearExpiredCooldowns(store, Date.now());

  const storedOrder    = findNormalizedProviderValue(store.order, providerKey);
  const configuredOrder = findNormalizedProviderValue(cfg?.auth?.order, providerKey);
  const explicitOrder  = storedOrder ?? configuredOrder;
  const baseOrder      = explicitOrder ?? listProfilesForProvider(store, provider);

  // 过滤不可用（凭据无效 / provider 不匹配）
  const validProfiles  = baseOrder.filter((id) =>
    resolveAuthProfileEligibility({ cfg, store, provider, profileId: id }).eligible,
  );

  // 按 lastUsed 排序（最旧的排前 → 轮询）
  const sorted = validProfiles.slice().sort((a, b) => {
    const au = store.usageStats?.[a]?.lastUsed ?? 0;
    const bu = store.usageStats?.[b]?.lastUsed ?? 0;
    return au - bu;
  });

  // preferredProfile 置顶
  if (preferredProfile && sorted.includes(preferredProfile)) {
    return [preferredProfile, ...sorted.filter((id) => id !== preferredProfile)];
  }
  return sorted;
}
```

### 冷却期机制

> `src/agents/auth-profiles/usage.ts`

```
API 调用失败
  │
  markAuthProfileFailure({ store, profileId, reason, ... })
  │
  ├─ reason: "rate_limit"   → cooldownUntil = now + 计算冷却时长
  ├─ reason: "overloaded"  → cooldownUntil = now + 短暂退避
  ├─ reason: "auth"        → disabledUntil = now + 较长禁用时长
  └─ reason: "billing"     → disabledReason = "billing"（需手动恢复）

isProfileInCooldown(store, profileId)
  └─ 检查 max(cooldownUntil, disabledUntil) > now
```

### 切换 Auth Profile（关键源码）

> `run.ts:640`

```typescript
// 当前 profile 失败后，尝试下一个
const advanceAuthProfile = async (): Promise<boolean> => {
  let nextIndex = profileIndex + 1;
  while (nextIndex < profileCandidates.length) {
    const candidate = profileCandidates[nextIndex];
    // 跳过处于冷却期的候选
    if (candidate && isProfileInCooldown(authStore, candidate)) {
      nextIndex += 1;
      continue;
    }
    await applyApiKeyInfo(candidate);
    profileIndex = nextIndex;
    thinkLevel = initialThinkLevel;    // 切换 profile 后重置思考等级
    attemptedThinking.clear();
    return true;
  }
  return false;   // 无可用 profile → 触发 FailoverError
};
```

### OAuth 令牌刷新

> `src/agents/auth-profiles/oauth.ts`

```
resolveApiKeyForProfile(profileId, store)
  └─ 如果 credential.type === "oauth"
       ├─ 检查 access_token 是否即将过期（refresh_margin = 5 分钟）
       ├─ 使用 refresh_token 调用 provider 的 token endpoint
       ├─ 更新 store.profiles[profileId].access_token
       └─ 返回新的 access_token 作为 API Key
```

---

## 上下文与系统提示词

### Bootstrap 文件体系

> `src/agents/bootstrap-files.ts`

```
工作区根目录 (~/.openclaw/workspace/)
├─ AGENTS.md     ← 角色设定、行为规则（主提示词）
├─ SOUL.md       ← 个性/语气定义
├─ TOOLS.md      ← 工具使用指南
├─ IDENTITY.md   ← 身份信息
├─ USER.md       ← 用户偏好
├─ HEARTBEAT.md  ← 心跳检查指令
├─ MEMORY.md     ← 持久记忆（由 memory 工具写入）
└─ BOOTSTRAP.md  ← 可选：每次运行前的任务指令
```

### 系统提示词构建

> `src/agents/system-prompt.ts` — `buildAgentSystemPrompt()`

```
buildEmbeddedSystemPrompt(params)
  │
  ├─ 硬编码核心指令（角色、能力、工具使用规范）
  ├─ Bootstrap 文件注入（resolveBootstrapContextForRun）
  │   └─ AGENTS.md + SOUL.md + 其他 bootstrap 文件
  ├─ Skills 技能提示词（resolveSkillsPromptForRun）
  ├─ 消息工具提示（messageToolHints，包含频道操作列表）
  ├─ 沙盒信息（sandboxInfo：容器路径 / 工具限制）
  ├─ 运行时元数据（host / OS / arch / model / channel）
  └─ 上下文截断警告（bootstrapTruncationWarningLines）
```

### 上下文窗口保护

> `src/agents/context-window-guard.ts`

```typescript
const CONTEXT_WINDOW_HARD_MIN_TOKENS = 8_192;   // 低于此值 → 拒绝运行
const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_768; // 低于此值 → 警告日志

const ctxGuard = evaluateContextWindowGuard({ info: ctxInfo, ... });
if (ctxGuard.shouldBlock) {
  throw new FailoverError(`Model context window too small (${ctxGuard.tokens} tokens).`);
}
```

---

## 会话管理与压缩

### SessionManager（pi-coding-agent）

```
prepareSessionManagerForRun({ sessionFile, ... })
  │
  ├─ 加载或创建 ~/.openclaw/sessions/<sessionId>.jsonl
  ├─ 修复损坏的 tool_use / tool_result 配对
  │   sanitizeToolUseResultPairing()
  ├─ 限制历史轮次（limitHistoryTurns）
  │   DM 频道：默认 50 轮；group 频道：配置驱动
  └─ 返回 SessionManager（管理 JSONL 文件的读写）
```

### 上下文溢出压缩

> `src/agents/pi-embedded-runner/compact.ts`

```
检测到上下文溢出（isLikelyContextOverflowError）
  │
  ├─ 尝试截断过大 tool 结果（truncateOversizedToolResultsInSession）
  │   └─ 如果有过大内容 → 重试（无需压缩）
  │
  └─ 启动压缩（compactEmbeddedPiSession）
       ├─ 构建"summarize this session"提示词
       ├─ 运行 LLM 生成会话摘要
       ├─ 将历史消息替换为摘要（保留最近 N 轮）
       └─ 触发 compact.hooks → 广播 session.compacted 事件
```

**关键源码（`run.ts:995`）：**

```typescript
if (contextOverflowError) {
  if (overflowCompactionAttempts >= MAX_OVERFLOW_COMPACTION_ATTEMPTS) {
    // 压缩失败次数过多 → 返回错误
    return { payloads: [{ text: "Context overflow; compaction failed.", isError: true }], ... };
  }
  overflowCompactionAttempts += 1;
  // 启动压缩并重试
  await compactEmbeddedPiSession({ sessionId, provider, model, config, ... });
  continue;   // 回到 while(true) 重试
}
```

---

## ACP 子代理生成

> `src/agents/acp-spawn.ts` — ACP（Agent Communication Protocol）

```
spawnAcpAgent(task, context, config)
  │
  ├─ 策略检查（resolveAcpAgentPolicyError）
  │   └─ 配置或多代理策略不允许 → 抛出错误
  │
  ├─ 创建子代理 sessionKey（子代理前缀 agent:<agentId>:<sessionId>）
  │
  ├─ 启动 ACP 会话（getAcpSessionManager().startSession）
  │   └─ 通过 Gateway 的 sessions.spawn RPC 创建子任务
  │
  ├─ 如果 streamTo="parent"：
  │   startAcpSpawnParentStreamRelay()
  │   └─ 子代理的流式输出实时中继到父代理响应中
  │
  └─ 等待子代理完成（或 mode="session" 则立即返回句柄）
```

---

## Exec 工具（Bash 执行）

> `src/agents/bash-tools.exec.ts` — `createExecTool()`

### 执行流程

```
LLM 请求 exec { command, workdir, ... }
  │
  ├─ 1. 安全检查（normalizeExecSecurity）
  │     mode: "ask" → 需要操作员审批（ExecApprovalManager）
  │     mode: "safe-bins" → 只允许白名单命令
  │     mode: "allow" → 无限制
  │
  ├─ 2. 沙盒路径验证（assertSandboxPath）
  │     命令只能在 workspaceDir 内操作（符号链接穿越检测）
  │
  ├─ 3. 执行宿主选择（normalizeExecHost）
  │     host: "gateway" → 在 Gateway 进程中执行
  │     host: "node"    → 在已配对的移动节点上执行
  │     host: "sandbox" → 在 Docker/OCI 沙盒中执行
  │
  ├─ 4. 启动进程（runExecProcess）
  │     ├─ PTY（伪终端）模式：支持颜色输出 / 交互式程序
  │     ├─ 后台模式（backgroundMs > 0）
  │     └─ 超时控制（timeoutSec）
  │
  └─ 5. 输出截断与格式化（truncateMiddle）
        最大输出：DEFAULT_MAX_OUTPUT（约 50KB）
```

**审批流程（`bash-tools.exec-approval-request.ts`）：**

```
ask=true 且命令不在自动批准列表
  │
  ├─ 发出 exec.approval.request 事件（Gateway 广播）
  ├─ 等待操作员通过 Control UI 批准/拒绝（最长 5 分钟）
  └─ 批准 → 继续执行 | 拒绝 → 返回拒绝错误
```

---

## 失效转移与重试

### 失效错误分类

> `src/agents/failover-error.ts` + `pi-embedded-helpers.ts`

```typescript
type FailoverReason =
  | "auth"           // 认证失败 → 切换 Auth Profile
  | "auth_permanent" // 永久认证失败（如密钥被吊销）
  | "overloaded"     // 服务过载 → 指数退避后切换
  | "rate_limit"     // 速率限制 → 冷却后切换
  | "billing"        // 账单问题 → 标记失败
  | "model_not_found"// 模型不可用 → 尝试 fallback
  | "timeout"        // 超时 → 不记录为 auth 失败
  | "context_overflow"→ 触发压缩
  | "unknown"        // 未分类
```

### 重试主循环（简化）

> `run.ts:815`

```typescript
while (true) {
  if (runLoopIterations >= MAX_RUN_LOOP_ITERATIONS) {
    return { payloads: [{ text: "Exceeded retry limit.", isError: true }], ... };
  }
  runLoopIterations += 1;

  const attempt = await runEmbeddedAttempt({ provider, model, ... });

  // 上下文溢出 → 压缩后重试
  if (contextOverflowError) {
    await compactEmbeddedPiSession(...);
    continue;
  }

  // 认证失败 → 切换 Auth Profile
  if (isAuthAssistantError(assistantErrorText)) {
    await maybeMarkAuthProfileFailure({ profileId: lastProfileId, reason: "auth" });
    const advanced = await advanceAuthProfile();
    if (!advanced) throw new FailoverError("No available auth profiles");
    continue;
  }

  // 模型降级（thinking level）
  if (shouldTryLowerThinkingLevel) {
    thinkLevel = pickFallbackThinkingLevel(thinkLevel);
    continue;
  }

  // 成功 → 标记 Auth Profile 良好并返回
  await markAuthProfileGood({ store, profileId: lastProfileId });
  return buildSuccessResult(attempt);
}
```

---

## 核心数据流总结

```
外部消息（Telegram / iMessage / WhatsApp / WebChat）
         │
         ▼ agentCommand()  →  runEmbeddedPiAgent()
  ┌─────────────────────────────────────────────────────┐
  │ pi-embedded-runner/run.ts                            │
  │  1. 泳道入队（session → global）                    │
  │  2. 工作区解析                                      │
  │  3. before_model_resolve hook                        │
  │  4. 模型解析 → resolveModel()                       │
  │  5. Auth Profile 排序 → resolveAuthProfileOrder()   │
  │  6. API Key 应用 → authStorage.setRuntimeApiKey()   │
  │  7. 重试主循环:                                     │
  │      runEmbeddedAttempt()                           │
  │        ├─ createOpenClawCodingTools() [工具装配]    │
  │        ├─ buildEmbeddedSystemPrompt()               │
  │        ├─ prepareSessionManagerForRun()             │
  │        └─ createAgentSession() + stream()           │
  │               │                                     │
  │               ↓ LLM 推理（流式）                   │
  │         tool_use → 执行工具 → tool_result           │
  │               │                                     │
  │         最终文本 → onPartialReply/onBlockReply      │
  │                    → 广播给 WebSocket 客户端        │
  └─────────────────────────────────────────────────────┘
         │ 错误路径
         ├─ Auth 失败 → advanceAuthProfile() → 重试
         ├─ 溢出     → compactEmbeddedPiSession() → 重试
         └─ 所有 Profile 失败 → FailoverError → 外部降级
```

---

*文档生成时间：2026-03-14*
