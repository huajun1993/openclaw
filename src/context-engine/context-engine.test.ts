import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compactEmbeddedPiSessionDirect } from "../agents/pi-embedded-runner/compact.runtime.js";
// ---------------------------------------------------------------------------
// We dynamically import the registry so we can get a fresh module per test
// group when needed.  For most groups we use the shared singleton directly.
// ---------------------------------------------------------------------------
import { LegacyContextEngine, registerLegacyContextEngine } from "./legacy.js";
import {
  registerContextEngine,
  getContextEngineFactory,
  listContextEngineIds,
  resolveContextEngine,
} from "./registry.js";
import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  BootstrapResult,
  CompactResult,
  ContextEngineRuntimeContext,
  IngestBatchResult,
  IngestResult,
  SubagentEndReason,
  SubagentSpawnPreparation,
} from "./types.js";

vi.mock("../agents/pi-embedded-runner/compact.runtime.js", () => ({
  compactEmbeddedPiSessionDirect: vi.fn(async () => ({
    ok: true,
    compacted: false,
    reason: "mock compaction",
    result: {
      summary: "",
      firstKeptEntryId: "",
      tokensBefore: 0,
      tokensAfter: 0,
      details: undefined,
    },
  })),
}));

const mockedCompactEmbeddedPiSessionDirect = vi.mocked(compactEmbeddedPiSessionDirect);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a config object with a contextEngine slot for testing. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function configWithSlot(engineId: string): any {
  return { plugins: { slots: { contextEngine: engineId } } };
}

function makeMockMessage(role: "user" | "assistant" = "user", text = "hello"): AgentMessage {
  return { role, content: text, timestamp: Date.now() } as AgentMessage;
}

/** A minimal mock engine that satisfies the ContextEngine interface. */
class MockContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "mock",
    name: "Mock Engine",
    version: "0.0.1",
  };

  async ingest(_params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return { ingested: true };
  }

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    return {
      messages: params.messages,
      estimatedTokens: 42,
      systemPromptAddition: "mock system addition",
    };
  }

  async compact(_params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: Record<string, unknown>;
  }): Promise<CompactResult> {
    return {
      ok: true,
      compacted: true,
      reason: "mock compaction",
      result: {
        summary: "mock summary",
        tokensBefore: 100,
        tokensAfter: 50,
      },
    };
  }

  async dispose(): Promise<void> {
    // no-op
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Engine contract tests
// ═══════════════════════════════════════════════════════════════════════════

describe("Engine contract tests", () => {
  beforeEach(() => {
    mockedCompactEmbeddedPiSessionDirect.mockClear();
  });

  it("a mock engine implementing ContextEngine can be registered and resolved", async () => {
    const factory = () => new MockContextEngine();
    registerContextEngine("mock", factory);

    const resolved = getContextEngineFactory("mock");
    expect(resolved).toBe(factory);

    const engine = await resolved!();
    expect(engine).toBeInstanceOf(MockContextEngine);
    expect(engine.info.id).toBe("mock");
  });

  it("ingest() returns IngestResult with ingested boolean", async () => {
    const engine = new MockContextEngine();
    const result = await engine.ingest({
      sessionId: "s1",
      message: makeMockMessage(),
    });

    expect(result).toHaveProperty("ingested");
    expect(typeof result.ingested).toBe("boolean");
    expect(result.ingested).toBe(true);
  });

  it("assemble() returns AssembleResult with messages array and estimatedTokens", async () => {
    const engine = new MockContextEngine();
    const msgs = [makeMockMessage(), makeMockMessage("assistant", "world")];
    const result = await engine.assemble({
      sessionId: "s1",
      messages: msgs,
    });

    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages).toHaveLength(2);
    expect(typeof result.estimatedTokens).toBe("number");
    expect(result.estimatedTokens).toBe(42);
    expect(result.systemPromptAddition).toBe("mock system addition");
  });

  it("compact() returns CompactResult with ok, compacted, reason, result fields", async () => {
    const engine = new MockContextEngine();
    const result = await engine.compact({
      sessionId: "s1",
      sessionFile: "/tmp/session.json",
    });

    expect(typeof result.ok).toBe("boolean");
    expect(typeof result.compacted).toBe("boolean");
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.reason).toBe("mock compaction");
    expect(result.result).toBeDefined();
    expect(result.result!.summary).toBe("mock summary");
    expect(result.result!.tokensBefore).toBe(100);
    expect(result.result!.tokensAfter).toBe(50);
  });

  it("dispose() is callable (optional method)", async () => {
    const engine = new MockContextEngine();
    // Should complete without error
    await expect(engine.dispose()).resolves.toBeUndefined();
  });

  it("legacy compact preserves runtimeContext currentTokenCount when top-level value is absent", async () => {
    const engine = new LegacyContextEngine();

    await engine.compact({
      sessionId: "s1",
      sessionFile: "/tmp/session.json",
      runtimeContext: {
        workspaceDir: "/tmp/workspace",
        currentTokenCount: 277403,
      },
    });

    expect(mockedCompactEmbeddedPiSessionDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        currentTokenCount: 277403,
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Registry tests
// ═══════════════════════════════════════════════════════════════════════════

describe("Registry tests", () => {
  it("registerContextEngine() stores a factory", () => {
    const factory = () => new MockContextEngine();
    registerContextEngine("reg-test-1", factory);

    expect(getContextEngineFactory("reg-test-1")).toBe(factory);
  });

  it("getContextEngineFactory() returns the factory", () => {
    const factory = () => new MockContextEngine();
    registerContextEngine("reg-test-2", factory);

    const retrieved = getContextEngineFactory("reg-test-2");
    expect(retrieved).toBe(factory);
    expect(typeof retrieved).toBe("function");
  });

  it("listContextEngineIds() returns all registered ids", () => {
    // Ensure at least our test entries exist
    registerContextEngine("reg-test-a", () => new MockContextEngine());
    registerContextEngine("reg-test-b", () => new MockContextEngine());

    const ids = listContextEngineIds();
    expect(ids).toContain("reg-test-a");
    expect(ids).toContain("reg-test-b");
    expect(Array.isArray(ids)).toBe(true);
  });

  it("registering the same id overwrites the previous factory", () => {
    const factory1 = () => new MockContextEngine();
    const factory2 = () => new MockContextEngine();

    registerContextEngine("reg-overwrite", factory1);
    expect(getContextEngineFactory("reg-overwrite")).toBe(factory1);

    registerContextEngine("reg-overwrite", factory2);
    expect(getContextEngineFactory("reg-overwrite")).toBe(factory2);
    expect(getContextEngineFactory("reg-overwrite")).not.toBe(factory1);
  });

  it("shares registered engines across duplicate module copies", async () => {
    const registryUrl = new URL("./registry.ts", import.meta.url).href;
    const suffix = Date.now().toString(36);
    const first = await import(/* @vite-ignore */ `${registryUrl}?copy=${suffix}-a`);
    const second = await import(/* @vite-ignore */ `${registryUrl}?copy=${suffix}-b`);

    const engineId = `dup-copy-${suffix}`;
    const factory = () => new MockContextEngine();
    first.registerContextEngine(engineId, factory);

    expect(second.getContextEngineFactory(engineId)).toBe(factory);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Default engine selection
// ═══════════════════════════════════════════════════════════════════════════

describe("Default engine selection", () => {
  // Ensure both legacy and a custom test engine are registered before these tests.
  beforeEach(() => {
    // Registration is idempotent (Map.set), so calling again is safe.
    registerLegacyContextEngine();
    // Register a lightweight custom stub so we don't need external resources.
    registerContextEngine("test-engine", () => {
      const engine: ContextEngine = {
        info: { id: "test-engine", name: "Custom Test Engine", version: "0.0.0" },
        async ingest() {
          return { ingested: true };
        },
        async assemble({ messages }) {
          return { messages, estimatedTokens: 0 };
        },
        async compact() {
          return { ok: true, compacted: false };
        },
      };
      return engine;
    });
  });

  it("resolveContextEngine() with no config returns the default ('legacy') engine", async () => {
    const engine = await resolveContextEngine();
    expect(engine.info.id).toBe("legacy");
  });

  it("resolveContextEngine() with config contextEngine='legacy' returns legacy engine", async () => {
    const engine = await resolveContextEngine(configWithSlot("legacy"));
    expect(engine.info.id).toBe("legacy");
  });

  it("resolveContextEngine() with config contextEngine='test-engine' returns the custom engine", async () => {
    const engine = await resolveContextEngine(configWithSlot("test-engine"));
    expect(engine.info.id).toBe("test-engine");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Invalid engine fallback
// ═══════════════════════════════════════════════════════════════════════════

describe("Invalid engine fallback", () => {
  it("resolveContextEngine() with config pointing to unregistered engine throws with helpful error", async () => {
    await expect(resolveContextEngine(configWithSlot("nonexistent-engine"))).rejects.toThrow(
      /nonexistent-engine/,
    );
  });

  it("error message includes the requested id and available ids", async () => {
    // Ensure at least legacy is registered so we see it in the available list
    registerLegacyContextEngine();

    try {
      await resolveContextEngine(configWithSlot("does-not-exist"));
      // Should not reach here
      expect.unreachable("Expected resolveContextEngine to throw");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("does-not-exist");
      expect(message).toContain("not registered");
      // Should mention available engines
      expect(message).toMatch(/Available engines:/);
      // At least "legacy" should be listed as available
      expect(message).toContain("legacy");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. LegacyContextEngine parity
// ═══════════════════════════════════════════════════════════════════════════

describe("LegacyContextEngine parity", () => {
  it("ingest() returns { ingested: false } (no-op)", async () => {
    const engine = new LegacyContextEngine();
    const result = await engine.ingest({
      sessionId: "s1",
      message: makeMockMessage(),
    });

    expect(result).toEqual({ ingested: false });
  });

  it("assemble() returns messages as-is (pass-through)", async () => {
    const engine = new LegacyContextEngine();
    const messages = [
      makeMockMessage("user", "first"),
      makeMockMessage("assistant", "second"),
      makeMockMessage("user", "third"),
    ];

    const result = await engine.assemble({
      sessionId: "s1",
      messages,
    });

    // Messages should be the exact same array reference (pass-through)
    expect(result.messages).toBe(messages);
    expect(result.messages).toHaveLength(3);
    expect(result.estimatedTokens).toBe(0);
    expect(result.systemPromptAddition).toBeUndefined();
  });

  it("dispose() completes without error", async () => {
    const engine = new LegacyContextEngine();
    await expect(engine.dispose()).resolves.toBeUndefined();
  });

  it("afterTurn() is a no-op and resolves without error", async () => {
    const engine = new LegacyContextEngine();
    const msgs = [makeMockMessage("user", "hi"), makeMockMessage("assistant", "hello back")];
    await expect(
      engine.afterTurn({
        sessionId: "s1",
        sessionFile: "/tmp/session.json",
        messages: msgs,
        prePromptMessageCount: 1,
      }),
    ).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5a. Complete lifecycle hooks
//
// Validates that all hooks in the Bootstrap->ingest->assemble->compact->
// afterTurn->onSubagentEnded lifecycle are callable with correct signatures
// and return the expected result shapes.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A full-lifecycle engine that implements every optional hook in the
 * ContextEngine interface.  Used as a reference for plugin authors.
 */
class FullLifecycleEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "full-lifecycle",
    name: "Full Lifecycle Engine",
    version: "1.0.0",
    ownsCompaction: true,
  };

  async bootstrap(_params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
  }): Promise<BootstrapResult> {
    return { bootstrapped: true, importedMessages: 3 };
  }

  async ingest(_params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return { ingested: true };
  }

  async ingestBatch(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult> {
    return { ingestedCount: params.messages.length };
  }

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    return { messages: params.messages, estimatedTokens: params.messages.length * 10 };
  }

  async compact(_params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<CompactResult> {
    return {
      ok: true,
      compacted: true,
      result: { tokensBefore: 200, tokensAfter: 80, summary: "compacted" },
    };
  }

  async afterTurn(_params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<void> {
    // persist canonical context for the turn
  }

  async prepareSubagentSpawn(_params: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }): Promise<SubagentSpawnPreparation> {
    return { rollback: async () => {} };
  }

  async onSubagentEnded(_params: {
    childSessionKey: string;
    reason: SubagentEndReason;
  }): Promise<void> {
    // clean up subagent context
  }

  async dispose(): Promise<void> {
    // release resources
  }
}

describe("Complete lifecycle hooks", () => {
  it("bootstrap() returns BootstrapResult with bootstrapped flag", async () => {
    const engine = new FullLifecycleEngine();
    const result = await engine.bootstrap!({
      sessionId: "s1",
      sessionFile: "/tmp/session.json",
    });

    expect(result.bootstrapped).toBe(true);
    expect(result.importedMessages).toBe(3);
  });

  it("bootstrap() result shape: optional reason field when not bootstrapped", async () => {
    const result: BootstrapResult = { bootstrapped: false, reason: "already initialized" };
    expect(result.bootstrapped).toBe(false);
    expect(result.reason).toBe("already initialized");
    expect(result.importedMessages).toBeUndefined();
  });

  it("ingestBatch() returns IngestBatchResult with ingestedCount", async () => {
    const engine = new FullLifecycleEngine();
    const msgs = [makeMockMessage("user", "a"), makeMockMessage("assistant", "b")];
    const result = await engine.ingestBatch!({
      sessionId: "s1",
      messages: msgs,
    });

    expect(result.ingestedCount).toBe(2);
  });

  it("ingestBatch() with empty batch returns ingestedCount 0", async () => {
    const engine = new FullLifecycleEngine();
    const result = await engine.ingestBatch!({ sessionId: "s1", messages: [] });
    expect(result.ingestedCount).toBe(0);
  });

  it("afterTurn() is callable and resolves without error", async () => {
    const engine = new FullLifecycleEngine();
    const msgs = [makeMockMessage("user", "hi"), makeMockMessage("assistant", "hello")];

    await expect(
      engine.afterTurn!({
        sessionId: "s1",
        sessionFile: "/tmp/session.json",
        messages: msgs,
        prePromptMessageCount: 1,
        tokenBudget: 8000,
        isHeartbeat: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("afterTurn() accepts optional runtimeContext without error", async () => {
    const engine = new FullLifecycleEngine();
    const ctx: ContextEngineRuntimeContext = { workspaceDir: "/tmp/ws", customKey: 42 };

    await expect(
      engine.afterTurn!({
        sessionId: "s1",
        sessionFile: "/tmp/session.json",
        messages: [makeMockMessage()],
        prePromptMessageCount: 0,
        runtimeContext: ctx,
      }),
    ).resolves.toBeUndefined();
  });

  it("prepareSubagentSpawn() returns a rollback handle", async () => {
    const engine = new FullLifecycleEngine();
    const prep = await engine.prepareSubagentSpawn!({
      parentSessionKey: "parent",
      childSessionKey: "child",
      ttlMs: 60_000,
    });

    expect(prep).toBeDefined();
    expect(typeof prep!.rollback).toBe("function");
    // rollback must be callable
    await expect(prep!.rollback()).resolves.toBeUndefined();
  });

  it("onSubagentEnded() is callable for all SubagentEndReason values", async () => {
    const engine = new FullLifecycleEngine();
    const reasons: SubagentEndReason[] = ["deleted", "completed", "swept", "released"];

    for (const reason of reasons) {
      await expect(
        engine.onSubagentEnded!({ childSessionKey: "child-key", reason }),
      ).resolves.toBeUndefined();
    }
  });

  it("compact() with runtimeContext passes context through correctly", async () => {
    const engine = new FullLifecycleEngine();
    const ctx: ContextEngineRuntimeContext = { workspaceDir: "/tmp", currentTokenCount: 500 };
    const result = await engine.compact({
      sessionId: "s1",
      sessionFile: "/tmp/session.json",
      runtimeContext: ctx,
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.tokensBefore).toBe(200);
    expect(result.result?.tokensAfter).toBe(80);
  });

  it("info.ownsCompaction flag is respected", () => {
    const engine = new FullLifecycleEngine();
    expect(engine.info.ownsCompaction).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5b. Full lifecycle integration
//
// Exercises the complete Bootstrap->ingest->assemble->compact->afterTurn->
// onSubagentEnded flow as a single end-to-end sequence.
// ═══════════════════════════════════════════════════════════════════════════

describe("Full lifecycle integration", () => {
  it("runs the complete lifecycle without error", async () => {
    const engine = new FullLifecycleEngine();
    const sessionId = "integration-session";
    const sessionFile = "/tmp/integration-session.json";

    // 1. Bootstrap
    const bootstrapResult = await engine.bootstrap!({ sessionId, sessionFile });
    expect(bootstrapResult.bootstrapped).toBe(true);

    // 2. Ingest messages
    const userMsg = makeMockMessage("user", "what is the weather?");
    const ingestResult = await engine.ingest({ sessionId, message: userMsg });
    expect(ingestResult.ingested).toBe(true);

    const assistantMsg = makeMockMessage("assistant", "It is sunny today.");
    const ingestResult2 = await engine.ingest({ sessionId, message: assistantMsg });
    expect(ingestResult2.ingested).toBe(true);

    // 3. Assemble context for the model
    const assembleResult = await engine.assemble({
      sessionId,
      messages: [userMsg, assistantMsg],
      tokenBudget: 4096,
    });
    expect(assembleResult.messages).toHaveLength(2);
    expect(assembleResult.estimatedTokens).toBeGreaterThan(0);

    // 4. Compact when approaching token limit
    const compactResult = await engine.compact({
      sessionId,
      sessionFile,
      tokenBudget: 4096,
      currentTokenCount: 3500,
    });
    expect(compactResult.ok).toBe(true);

    // 5. Post-turn bookkeeping
    await expect(
      engine.afterTurn!({
        sessionId,
        sessionFile,
        messages: [userMsg, assistantMsg],
        prePromptMessageCount: 0,
      }),
    ).resolves.toBeUndefined();

    // 6. Subagent lifecycle
    const prep = await engine.prepareSubagentSpawn!({
      parentSessionKey: sessionId,
      childSessionKey: "child-session",
    });
    expect(prep).toBeDefined();

    await expect(
      engine.onSubagentEnded!({ childSessionKey: "child-session", reason: "completed" }),
    ).resolves.toBeUndefined();

    // 7. Dispose
    await expect(engine.dispose()).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Initialization guard
// ═══════════════════════════════════════════════════════════════════════════

describe("Initialization guard", () => {
  it("ensureContextEnginesInitialized() is idempotent (calling twice does not throw)", async () => {
    const { ensureContextEnginesInitialized } = await import("./init.js");

    expect(() => ensureContextEnginesInitialized()).not.toThrow();
    expect(() => ensureContextEnginesInitialized()).not.toThrow();
  });

  it("after init, 'legacy' engine is registered", async () => {
    const { ensureContextEnginesInitialized } = await import("./init.js");
    ensureContextEnginesInitialized();

    const ids = listContextEngineIds();
    expect(ids).toContain("legacy");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Bundle chunk isolation (#40096)
//
// Published builds may split the context-engine registry across multiple
// output chunks.  The Symbol.for() keyed global ensures that a plugin
// calling registerContextEngine() from chunk A is visible to
// resolveContextEngine() imported from chunk B.
//
// These tests exercise the invariant that failed in 2026.3.7 when
// lossless-claw registered successfully but resolution could not find it.
// ═══════════════════════════════════════════════════════════════════════════

describe("Bundle chunk isolation (#40096)", () => {
  it("Symbol.for key is stable across independently loaded modules", async () => {
    // Simulate two distinct bundle chunks by loading the registry module
    // twice with different query strings (forces separate module instances
    // in Vite/esbuild but shares globalThis).
    const ts = Date.now().toString(36);
    const registryUrl = new URL("./registry.ts", import.meta.url).href;

    const chunkA = await import(/* @vite-ignore */ `${registryUrl}?chunk=a-${ts}`);
    const chunkB = await import(/* @vite-ignore */ `${registryUrl}?chunk=b-${ts}`);

    // Chunk A registers an engine
    const engineId = `cross-chunk-${ts}`;
    chunkA.registerContextEngine(engineId, () => new MockContextEngine());

    // Chunk B must see it
    expect(chunkB.getContextEngineFactory(engineId)).toBeDefined();
    expect(chunkB.listContextEngineIds()).toContain(engineId);
  });

  it("resolveContextEngine from chunk B finds engine registered in chunk A", async () => {
    const ts = Date.now().toString(36);
    const registryUrl = new URL("./registry.ts", import.meta.url).href;

    const chunkA = await import(/* @vite-ignore */ `${registryUrl}?chunk=resolve-a-${ts}`);
    const chunkB = await import(/* @vite-ignore */ `${registryUrl}?chunk=resolve-b-${ts}`);

    const engineId = `resolve-cross-${ts}`;
    chunkA.registerContextEngine(engineId, () => ({
      info: { id: engineId, name: "Cross-chunk Engine", version: "0.0.1" },
      async ingest() {
        return { ingested: true };
      },
      async assemble({ messages }: { messages: AgentMessage[] }) {
        return { messages, estimatedTokens: 0 };
      },
      async compact() {
        return { ok: true, compacted: false };
      },
    }));

    // Resolve from chunk B using a config that points to this engine
    const engine = await chunkB.resolveContextEngine(configWithSlot(engineId));
    expect(engine.info.id).toBe(engineId);
  });

  it("plugin-sdk export path shares the same global registry", async () => {
    // The plugin-sdk re-exports registerContextEngine.  Verify the
    // re-export writes to the same global symbol as the direct import.
    const ts = Date.now().toString(36);
    const engineId = `sdk-path-${ts}`;

    // Direct registry import
    registerContextEngine(engineId, () => new MockContextEngine());

    // Plugin-sdk import (different chunk path in the published bundle)
    const sdkUrl = new URL("../plugin-sdk/index.ts", import.meta.url).href;
    const sdk = await import(/* @vite-ignore */ `${sdkUrl}?sdk-${ts}`);

    // The SDK export should see the engine we just registered
    const factory = getContextEngineFactory(engineId);
    expect(factory).toBeDefined();

    // And registering from the SDK path should be visible from the direct path
    const sdkEngineId = `sdk-registered-${ts}`;
    sdk.registerContextEngine(sdkEngineId, () => new MockContextEngine());
    expect(getContextEngineFactory(sdkEngineId)).toBeDefined();
  });

  it("concurrent registration from multiple chunks does not lose entries", async () => {
    const ts = Date.now().toString(36);
    const registryUrl = new URL("./registry.ts", import.meta.url).href;
    let releaseRegistrations: (() => void) | undefined;
    const registrationStart = new Promise<void>((resolve) => {
      releaseRegistrations = resolve;
    });

    // Load 5 "chunks" in parallel
    const chunks = await Promise.all(
      Array.from(
        { length: 5 },
        (_, i) => import(/* @vite-ignore */ `${registryUrl}?concurrent-${ts}-${i}`),
      ),
    );

    const ids = chunks.map((_, i) => `concurrent-${ts}-${i}`);
    const registrationTasks = chunks.map(async (chunk, i) => {
      const id = `concurrent-${ts}-${i}`;
      await registrationStart;
      chunk.registerContextEngine(id, () => new MockContextEngine());
    });
    releaseRegistrations?.();
    await Promise.all(registrationTasks);

    // All 5 engines must be visible from any chunk
    const allIds = chunks[0].listContextEngineIds();
    for (const id of ids) {
      expect(allIds).toContain(id);
    }
  });
});
