import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  requireNativeSqliteDatabase,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
  openOpenClawAgentDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runInMemoryTestBackgroundContext } from "./background-context.test-support.js";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import type { MemoryIndexManager } from "./manager.js";
import "./test-runtime-mocks.js";

let providerConstructionError: Error | null = null;
let providerConstructionGate: Promise<void> | null = null;
let providerAvailable = false;
let providerEmbeddingError: Error | null = null;
let providerQueryError: Error | null = null;
let providerQueryCalls = 0;
let providerBatchCalls = 0;
const createProvider = vi.hoisted(() =>
  vi.fn(async () => {
    await providerConstructionGate;
    if (providerConstructionError) {
      throw providerConstructionError;
    }
    if (providerAvailable) {
      return {
        requestedProvider: "auto",
        provider: {
          id: "openai",
          model: "mock-embed",
          embedBatch: async (texts: string[]) => {
            providerBatchCalls += 1;
            if (providerEmbeddingError) {
              throw providerEmbeddingError;
            }
            return texts.map(() => [1, 0]);
          },
          embed: async () => {
            providerQueryCalls += 1;
            if (providerQueryError) {
              throw providerQueryError;
            }
            return [1, 0];
          },
        },
      };
    }
    return {
      requestedProvider: "auto",
      provider: null,
      providerUnavailableReason: "No embeddings provider available.",
    };
  }),
);
function missingProviderAuth() {
  return Object.assign(
    new Error(
      'No API key resolved for provider "openai" (auth mode: api-key, checked: OPENAI_API_KEY).',
    ),
    { name: "MissingProviderAuthError", code: "missing-api-key", provider: "openai" },
  );
}

type ManagerInternals = {
  writeMeta(meta: MemoryIndexMeta): Promise<void>;
  awaitManagerIdle(): Promise<void>;
  syncMemoryFiles(params: { needsFullReindex: boolean }): Promise<unknown>;
  loadVectorExtension(): Promise<boolean>;
  embeddingBootstrapFailure?: unknown;
  provider?: { id: string } | null;
};
const internals = (manager: MemoryIndexManager) => manager as unknown as ManagerInternals;

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: createProvider,
  resolveEmbeddingProviderAdapterTransport: (providerId: string) =>
    providerId === "local" ? "local" : "remote",
  resolveEmbeddingProviderIndexIdentity: () => undefined,
  resolveEmbeddingProviderFallbackModel: () => "fts-only",
}));

describe("memory manager FTS-only reindex", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir = "";
  let indexPath = "";
  let managers: MemoryIndexManager[] = [];
  const restoreClocks: Array<() => void> = [];
  function mockClock() {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    restoreClocks.push(() => clock.mockRestore());
    return {
      now,
      clock,
      recoverProvider(elapsed = 31_000) {
        providerConstructionError = null;
        providerAvailable = true;
        clock.mockReturnValue(now + elapsed);
      },
    };
  }
  const keywordResult = [expect.objectContaining({ path: "MEMORY.md", source: "memory" })];
  const activeProvider = { mode: "active", providerId: "openai" };
  function expectBootstrap(debug: unknown[], details: Record<string, unknown>) {
    expect(debug).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ embeddingBootstrap: expect.objectContaining(details) }),
      ]),
    );
  }
  function quotaFailure() {
    const error = Object.assign(new Error("embedding quota exhausted"), {
      status: 429,
      errorCode: "insufficient_quota",
    });
    providerEmbeddingError = providerQueryError = error;
  }
  async function failedBootstrap() {
    providerConstructionError = missingProviderAuth();
    const manager = await createManager();
    await expect(manager.search("Alpha topic")).resolves.toHaveLength(1);
    return manager;
  }
  async function indexedManager(provider?: string) {
    providerAvailable = true;
    const manager = await createManager({ provider });
    await manager.sync({ force: true });
    return manager;
  }
  function constructionBarrier() {
    const barrier = createDeferred<void>();
    providerConstructionGate = barrier.promise;
    return () => barrier.resolve();
  }
  async function searchWithDebug(manager: MemoryIndexManager) {
    const debug: unknown[] = [];
    const results = await manager.search("Alpha topic", { onDebug: (entry) => debug.push(entry) });
    return { results, debug };
  }
  async function writeMemory(text: string) {
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), text);
  }
  async function closeManager(manager: MemoryIndexManager) {
    await manager.close();
    await closeAllMemorySearchManagers();
  }
  async function searchAndSettle(manager: MemoryIndexManager) {
    await expect(manager.search("Alpha topic")).resolves.toHaveLength(1);
    await internals(manager).awaitManagerIdle();
  }

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-fts-only-"));
  });

  beforeEach(async () => {
    createProvider.mockClear();
    providerConstructionError = null;
    providerConstructionGate = null;
    providerAvailable = false;
    providerEmbeddingError = null;
    providerQueryError = null;
    providerQueryCalls = 0;
    providerBatchCalls = 0;
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await writeMemory("Alpha topic\n\nKeep this note.");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, "state"));
    indexPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
  });

  afterEach(async () => {
    for (const restore of restoreClocks.splice(0)) {
      restore();
    }
    for (const manager of managers.toReversed()) {
      await manager.close();
    }
    managers = [];
    await closeAllMemorySearchManagers();
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await closeAllMemorySearchManagers();
    // The agent close releases its leases through shared state and reopens it, so the
    // shared handle is released second; otherwise Windows fails the removal with EBUSY.
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  async function createManager(
    params: {
      provider?: string;
      purpose?: "status" | "cli";
      vectorEnabled?: boolean;
      rememberAcrossConversations?: boolean;
    } = {},
  ): Promise<MemoryIndexManager> {
    const cfg = {
      // Provider construction is mocked here; avoid cold-loading real plugins during config resolution.
      plugins: { enabled: false },
      memory: {
        backend: "builtin",

        search: {
          provider: params.provider,
          rememberAcrossConversations: params.rememberAcrossConversations,
          model: "",
          store:
            params.vectorEnabled === undefined
              ? undefined
              : { vector: { enabled: params.vectorEnabled } },
          cache: { enabled: false },
        },
      },
      agents: { defaults: { workspace: workspaceDir }, entries: { main: {} } },
    } as OpenClawConfig;
    setRuntimeConfigSnapshot(cfg);
    const result = await getMemorySearchManager({
      runInBackgroundContext: runInMemoryTestBackgroundContext,
      cfg,
      agentId: "main",
      purpose: params.purpose,
    });
    if (!result.manager) {
      throw new Error(result.error ?? "manager missing");
    }
    const manager = result.manager as unknown as MemoryIndexManager;
    managers.push(manager);
    return manager;
  }

  function countChunksContaining(term: string): number {
    const db = new DatabaseSync(indexPath);
    try {
      const row = db
        .prepare(`SELECT COUNT(*) as c FROM memory_index_chunks WHERE text LIKE ?`)
        .get(`%${term}%`) as { c: number } | undefined;
      return row?.c ?? 0;
    } finally {
      db.close();
    }
  }

  async function writeExistingMeta(manager: MemoryIndexManager, model: string): Promise<void> {
    await internals(manager).writeMeta({
      model,
      provider: "openai",
      chunkTokens: 600,
      chunkOverlap: 120,
      sources: ["memory"],
    });
  }

  it("keeps a reopened semantic index valid before discovering the provider model", async () => {
    const indexed = await indexedManager("openai");
    expect(indexed.status().chunks).toBeGreaterThan(0);
    await closeManager(indexed);
    createProvider.mockClear();

    const reopened = await createManager({ provider: "openai", purpose: "status" });
    const custom = reopened.status().custom;
    expect({ indexIdentity: custom?.indexIdentity, providerState: custom?.providerState }).toEqual({
      indexIdentity: { status: "valid" },
      providerState: { mode: "pending", requestedProvider: "openai" },
    });
    expect(createProvider).not.toHaveBeenCalled();
  });

  it.each(["first search", "failed background sync"])(
    "falls back to keyword matches after %s embedding failure",
    async (phase) => {
      providerAvailable = true;
      providerEmbeddingError = new Error("embedding request failed during bootstrap");
      const manager = await createManager();
      if (phase === "failed background sync") {
        await expect(manager.sync({ reason: "watch" })).rejects.toThrow(
          "embedding request failed during bootstrap",
        );
      }

      const { results, debug } = await searchWithDebug(manager);
      expect(results).toEqual(keywordResult);
      expect(providerQueryCalls).toBe(0);
      expectBootstrap(debug, {
        degradedTo: "keyword-only",
        provider: "openai",
        reason: expect.stringContaining("embedding request failed during bootstrap"),
      });
    },
  );

  it("backs off when the first keyword-only publication also fails", async () => {
    const { now, clock } = mockClock();
    providerAvailable = true;
    providerEmbeddingError = new Error("embedding request failed during bootstrap");
    const manager = await createManager();
    const metadata = vi.spyOn(internals(manager), "writeMeta").mockImplementationOnce(() => {
      throw new Error("keyword publication failed");
    });

    await expect(manager.search("Alpha topic")).resolves.toEqual([]);
    await expect(manager.search("Alpha topic")).resolves.toEqual([]);
    expect(metadata).toHaveBeenCalledOnce();

    providerAvailable = false;
    clock.mockReturnValue(now + 60_000);
    await expect(manager.search("Alpha topic")).resolves.toEqual(keywordResult);
  });

  it.each(["watch", "search maintenance"])("preserves quota cooldown after %s", async (origin) => {
    const manager = await indexedManager();
    const { now, clock } = mockClock();
    quotaFailure();
    await writeMemory("Alpha topic\n\nPending quota update.");
    // The observation fixture leaves dirty notification to the test.
    Reflect.set(manager, "dirty", true);
    if (origin === "watch") {
      await expect(manager.sync({ reason: "watch" })).rejects.toThrow("embedding quota exhausted");
    } else {
      await searchAndSettle(manager);
    }
    const requestsAfterFailure = providerBatchCalls + providerQueryCalls;

    for (const elapsed of [10_000, 29_999]) {
      clock.mockReturnValue(now + elapsed);
      await searchAndSettle(manager);
      expect(providerBatchCalls + providerQueryCalls).toBe(requestsAfterFailure);
      expect(manager.getCachedEmbeddingAvailability()?.cacheExpiresAtMs).toBe(now + 30_000);
      expect(countChunksContaining("Pending quota update")).toBe(0);
    }

    providerEmbeddingError = null;
    providerQueryError = null;
    clock.mockReturnValue(now + 30_000);
    await searchAndSettle(manager);
    expect(providerBatchCalls + providerQueryCalls).toBeGreaterThan(requestsAfterFailure);
    expect(countChunksContaining("Pending quota update")).toBeGreaterThan(0);
    expect(manager.status().custom?.providerState).toEqual(activeProvider);
  });

  it("updates a keyword-only index during the original embedding cooldown", async () => {
    const { now, clock } = mockClock();
    providerAvailable = true;
    quotaFailure();
    const manager = await createManager();
    await searchAndSettle(manager);
    const requestsAfterFailure = providerBatchCalls + providerQueryCalls;

    for (const [elapsed, marker] of [
      [10_000, "Gamma keyword update"],
      [29_999, "Delta keyword update"],
    ] as const) {
      clock.mockReturnValue(now + elapsed);
      await writeMemory(`${marker}\n\nKeep this note.`);
      Reflect.set(manager, "dirty", true);
      await manager.search(marker);
      await internals(manager).awaitManagerIdle();
      expect(providerBatchCalls + providerQueryCalls).toBe(requestsAfterFailure);
      expect(countChunksContaining(marker)).toBeGreaterThan(0);
      await expect(manager.search(marker)).resolves.toHaveLength(1);
      expect(manager.getCachedEmbeddingAvailability()?.cacheExpiresAtMs).toBe(now + 30_000);
    }
  });

  it.each([undefined, "openai"])(
    "handles query embedding failure for provider %s",
    async (provider) => {
      const manager = await indexedManager(provider);
      expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
      if (provider === undefined) {
        await expect(manager.search("Alpha topic")).resolves.toHaveLength(1);
        expect(providerQueryCalls).toBeGreaterThan(0);
      }
      providerQueryError = new Error("query embedding request failed at runtime");
      const search = manager.search("Alpha topic");
      if (provider === undefined) {
        expect(await search).toEqual(keywordResult);
      } else {
        await expect(search).rejects.toThrow("query embedding request failed at runtime");
      }
    },
  );

  it("keeps explicit required providers fail-closed when construction fails", async () => {
    providerConstructionError = missingProviderAuth();
    const manager = await createManager({ provider: "openai" });

    await expect(manager.sync({ reason: "session-startup-catchup", force: true })).rejects.toThrow(
      'No API key resolved for provider "openai"',
    );
    await expect(manager.search("Alpha topic")).rejects.toThrow(
      'No API key resolved for provider "openai"',
    );
    expect(countChunksContaining("Alpha topic")).toBe(0);
  });

  it("uses keyword search when provider construction fails against an existing semantic index", async () => {
    const credential = "sk-test-abcdefghijklmnopqrstuvwxyz123456";
    const { recoverProvider } = mockClock();
    const firstManager = await indexedManager();
    await expect(firstManager.probeVectorAvailability()).resolves.toBe(true);
    await closeManager(firstManager);
    providerAvailable = false;
    providerConstructionError = missingProviderAuth();
    providerConstructionError.message += ` apiKey=${credential}`;
    const manager = await createManager();
    const { results, debug } = await searchWithDebug(manager);
    expect(results).toEqual(keywordResult);
    expectBootstrap(debug, { degradedTo: "keyword-only" });
    expect(JSON.stringify(debug)).not.toContain(credential);
    expect(internals(manager)).toMatchObject({
      embeddingBootstrapFailure: expect.objectContaining({ degradedTo: "keyword-only" }),
      provider: null,
    });
    expect(manager.status()).toMatchObject({
      provider: "none",
      model: undefined,
      vector: { semanticAvailable: false },
      custom: { indexIdentity: { status: "valid" }, searchMode: "fts-only" },
    });

    recoverProvider();
    await expect(manager.probeEmbeddingAvailability()).resolves.toEqual({ ok: true });
    await expect(manager.search("Alpha topic")).resolves.toHaveLength(1);

    expect(providerQueryCalls).toBeGreaterThan(0);
    expect(manager.status()).toMatchObject({
      provider: "openai",
      vector: { semanticAvailable: true },
      custom: { providerState: activeProvider },
    });
  });

  it("caches a normal no-provider result after an expired bootstrap failure", async () => {
    const { now, clock } = mockClock();
    const manager = await failedBootstrap();

    providerConstructionError = null;
    clock.mockReturnValue(now + 31_000);
    const { results, debug } = await searchWithDebug(manager);
    expect(results).toHaveLength(1);
    const callsAfterRetry = createProvider.mock.calls.length;
    await expect(manager.search("Alpha topic")).resolves.toHaveLength(1);

    expect(createProvider).toHaveBeenCalledTimes(callsAfterRetry);
    expect(JSON.stringify(debug)).toContain("No embeddings provider available.");
  });

  it("degrades concurrent bootstrap waiters to the same keyword index", async () => {
    const releaseProviderConstruction = constructionBarrier();
    providerConstructionError = missingProviderAuth();
    const manager = await createManager();

    const backgroundSync = manager.sync({ reason: "startup" }).catch((err: unknown) => err);
    await vi.waitFor(() => expect(createProvider).toHaveBeenCalledOnce());
    const firstSearch = manager.search("Alpha topic");
    const secondSearch = manager.search("Alpha topic");
    releaseProviderConstruction();

    await expect(backgroundSync).resolves.toBeUndefined();
    const results = await Promise.all([firstSearch, secondSearch]);
    expect(results).toEqual([keywordResult, keywordResult]);
    expect(createProvider).toHaveBeenCalledOnce();
  });

  it("serializes provider construction when concurrent probes retry an expired failure", async () => {
    const { recoverProvider } = mockClock();
    const manager = await failedBootstrap();
    const callsBeforeRetry = createProvider.mock.calls.length;

    recoverProvider();
    const releaseProviderConstruction = constructionBarrier();
    const firstProbe = manager.probeEmbeddingAvailability();
    const secondProbe = manager.probeEmbeddingAvailability();
    await vi.waitFor(() => expect(createProvider).toHaveBeenCalledTimes(callsBeforeRetry + 1));
    releaseProviderConstruction();

    await expect(Promise.all([firstProbe, secondProbe])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
    expect(createProvider).toHaveBeenCalledTimes(callsBeforeRetry + 1);
    await expect(manager.search("Alpha topic")).resolves.toHaveLength(1);
    expect(manager.status()).toMatchObject({
      provider: "openai",
      custom: {
        indexIdentity: { status: "valid" },
        providerState: activeProvider,
      },
    });
  });

  it("keeps keyword results when semantic recovery reindex fails", async () => {
    const { now, clock, recoverProvider } = mockClock();
    const manager = await failedBootstrap();
    recoverProvider();
    await expect(manager.probeEmbeddingAvailability()).resolves.toEqual({ ok: true });
    providerEmbeddingError = new Error("embedding request failed during rebuild");
    const queryCallsAfterProbe = providerQueryCalls;
    const { results, debug } = await searchWithDebug(manager);
    expect(results).toHaveLength(1);
    expect(providerQueryCalls).toBe(queryCallsAfterProbe);
    expectBootstrap(debug, {
      degradedTo: "keyword-only",
      reason: expect.stringContaining("embedding request failed during rebuild"),
    });
    expect(JSON.stringify(debug)).not.toContain("No API key resolved");
    expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });

    for (const [elapsed, title] of [
      [31_000, "Gamma fallback refresh"],
      [62_000, "Delta fallback refresh"],
    ] as const) {
      clock.mockReturnValue(now + elapsed);
      await writeMemory(title);
      await expect(manager.sync({ reason: "watch", force: true })).resolves.toBeUndefined();
      await expect(manager.search(title)).resolves.toHaveLength(1);
      expect(providerQueryCalls).toBe(queryCallsAfterProbe);
    }

    providerEmbeddingError = null;
    clock.mockReturnValue(now + 93_000);
    await expect(manager.sync({ reason: "watch", force: true })).resolves.toBeUndefined();
    await expect(manager.search("Delta fallback refresh")).resolves.toHaveLength(1);
    expect(providerQueryCalls).toBeGreaterThan(queryCallsAfterProbe);
    const recoveredStatus = manager.status();
    expect(recoveredStatus.custom?.providerState).toEqual(activeProvider);
    expect(recoveredStatus.custom?.providerUnavailableReason).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "syncs regular memory when USER.md is a symlink",
    async () => {
      const linkedUserPath = path.join(workspaceDir, "shared-user.md");
      await fs.writeFile(linkedUserPath, "Linked user content must not be indexed.");
      await fs.symlink(linkedUserPath, path.join(workspaceDir, "USER.md"));
      const manager = await createManager({ provider: "none", vectorEnabled: false });

      await expect(manager.sync({ reason: "cli", force: true })).resolves.toBeUndefined();

      expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
      expect(countChunksContaining("Linked user content")).toBe(0);
    },
  );

  it("forces provider-none memory to FTS-only when vector config is omitted", async () => {
    const manager = await createManager({ provider: "none" });

    await manager.sync({ force: true });

    await expect(manager.probeEmbeddingAvailability()).resolves.toEqual({
      ok: false,
      error: "No embedding provider available (FTS-only mode)",
    });
    const status = manager.status();
    expect(createProvider).not.toHaveBeenCalled();
    expect(status.vector).toMatchObject({ enabled: false });
    expect(status.custom?.indexIdentity).toEqual({ status: "valid" });
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
  });

  it("ignores persisted vector rebuild debt after reopening an FTS-only index", async () => {
    const manager = await createManager({ provider: "none" });
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    db.prepare(
      `INSERT INTO memory_index_meta (key, value) VALUES ('memory_vector_rebuild_v1', '1')`,
    ).run();

    await manager.sync({ force: true });
    await closeManager(manager);

    const reopened = await createManager({ provider: "none", purpose: "status" });
    expect(reopened.status()).toMatchObject({
      dirty: false,
      vector: { enabled: false, index: { state: "empty" } },
      custom: { indexIdentity: { status: "valid" } },
    });
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
  });

  it("aborts instead of downgrading an existing semantic index to FTS-only", async () => {
    const manager = await createManager();
    await writeExistingMeta(manager, "mock-embed");

    await expect(manager.sync({ force: true })).rejects.toThrow(
      "Refusing to run sync in fts-only fallback mode to protect existing vector index (current model: mock-embed).",
    );
    expect(manager.status().provider).toBe("openai");
  });

  function indexIdentityStatus(manager: MemoryIndexManager): string | undefined {
    const identity = manager.status().custom?.indexIdentity as { status?: string } | undefined;
    return identity?.status;
  }

  function seedChunksWithNoMeta(model = "fts-only"): void {
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    db.exec(`
      INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES ('chunk-1', 'MEMORY.md', 'memory', 1, 3, 'hash-1', '${model}', 'Alpha topic keep note', x'', ${Date.now()});
      INSERT INTO memory_index_sources (path, source, hash, mtime, size)
        VALUES ('MEMORY.md', 'memory', 'hash-1', ${Date.now()}, 100);
    `);
  }

  it.each(["fts-only", "text-embedding-3-small"])(
    "reconciles missing identity for %s without a provider",
    async (model) => {
      seedChunksWithNoMeta(model);
      const manager = await createManager({ provider: "auto", vectorEnabled: false });
      if (model === "fts-only") {
        expect(indexIdentityStatus(manager)).toBe("missing");
      }
      // Non-forced sync simulates the Gateway's periodic sync loop.
      await manager.sync();
      const facts = manager.status();
      expect(indexIdentityStatus(manager)).toBe(model === "fts-only" ? "valid" : "missing");
      expect(facts.dirty).toBe(model !== "fts-only");
      if (model === "fts-only") {
        expect(facts.chunks).toBeGreaterThan(0);
      } else {
        expect(facts.chunks).toBe(1);
      }
    },
  );

  it("removes chunks and FTS rows when the dirty source file is already deleted", async () => {
    const db = requireNativeSqliteDatabase(openOpenClawAgentDatabase({ agentId: "main" }).db);
    const read = (sql: string) => db.prepare(sql).get();
    const countRows = (table: string, sourcePath?: string) =>
      sourcePath === undefined
        ? read(`SELECT COUNT(*) AS count FROM ${table}`)
        : db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE path = ?`).get(sourcePath);
    const expectVectorRows = () =>
      expect(countRows("memory_index_chunks_vec")).toEqual({ count: 2 });
    const expectExtensionBlocked = () =>
      expect(() => db.loadExtension("not-a-real-extension")).toThrow(
        "extension loading is not allowed",
      );
    expectExtensionBlocked();
    const loaded = await loadSqliteVecExtension({ db });
    expectExtensionBlocked();
    expect(() => db.prepare("SELECT load_extension(?)").get("not-a-real-extension")).toThrow(
      "not authorized",
    );
    expect(loaded.ok, loaded.error).toBe(true);
    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
    db.exec(`
        INSERT INTO memory_index_sources (path, source, hash, mtime, size)
          VALUES
            ('memory/deleted.md', 'memory', '', 200, 20),
            ('memory/ownerless.md', 'memory', '', 190, 20),
            ('sessions/excluded.jsonl', 'sessions', '', 200, 20);
        INSERT INTO memory_index_chunks
          (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES
          ('chunk-canonical', 'memory/deleted.md', 'memory', 1, 2, 'canonical-chunk-hash',
           'fts-only', 'obsolete saffronquasar', x'', 200),
          ('chunk-ownerless', 'memory/ownerless.md', 'memory', 1, 2, 'ownerless-chunk-hash',
           'fts-only', 'obsolete ambercomet', x'', 190);
        CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3]);
        INSERT INTO memory_index_chunks_vec VALUES ('chunk-canonical', '[1,0,0]');
        INSERT INTO memory_index_chunks_vec VALUES ('chunk-ownerless', '[0,1,0]');
        INSERT INTO memory_index_meta (key, value)
          VALUES ('memory_vector_rebuild_v1', 'clean');
      `);
    expectVectorRows();

    const manager = await createManager({
      provider: "none",
      vectorEnabled: false,
      rememberAcrossConversations: false,
    });
    expect(manager.status().fts?.available).toBe(true);
    expect(Reflect.get(manager, "sessionsFullRetryDirty")).toBe(false);

    for (const file of ["deleted", "ownerless"]) {
      expect(
        db.prepare("SELECT hash FROM memory_index_sources WHERE path = ?").get(`memory/${file}.md`),
      ).toEqual({ hash: "" });
    }
    expect(countRows("memory_index_chunks", "memory/deleted.md")).toEqual({ count: 1 });
    expect(countRows("memory_index_chunks_fts", "memory/deleted.md")).toEqual({ count: 1 });
    expect(countRows("memory_index_chunks_fts", "memory/ownerless.md")).toEqual({ count: 1 });

    await internals(manager).syncMemoryFiles({ needsFullReindex: false });

    for (const sourcePath of ["memory/deleted.md", "memory/ownerless.md"]) {
      for (const table of [
        "memory_index_sources",
        "memory_index_chunks",
        "memory_index_chunks_fts",
      ]) {
        expect(countRows(table, sourcePath), `${table}: ${sourcePath}`).toEqual({ count: 0 });
      }
    }
    // Disabled vectors retain their rows and record debt, including missing writes.
    expect(
      read("SELECT value FROM memory_index_meta WHERE key = 'memory_vector_rebuild_v1'"),
    ).toEqual({ value: "1" });
    expectVectorRows();
    // Reopen only the vector layer, not unrelated provider/cache lifecycles.
    const vectorState = Reflect.get(manager, "vector") as {
      available: boolean | null;
      enabled: boolean;
      extensionPath?: string;
    };
    Object.assign(vectorState, {
      enabled: true,
      available: true,
      extensionPath: loaded.extensionPath,
    });
    Reflect.set(Reflect.get(manager, "database"), "vectorReady", null);
    await expect(internals(manager).loadVectorExtension()).resolves.toBe(false);
    expect(read("SELECT vec_version() AS version")).toEqual({ version: expect.any(String) });
    expectVectorRows();
    expect(Reflect.get(manager, "memoryFullRetryDirty")).toBe(true);
  });
});
