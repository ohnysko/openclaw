import { channel } from "node:diagnostics_channel";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../../agents/admitted-run-context.js";
import {
  onDiagnosticEvent,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { createMainThreadStallMonitor } from "../../../infra/main-thread-stall.js";
import { resetLogger, setLoggerOverride } from "../../../logging/logger.js";
import { loggingState } from "../../../logging/state.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { createDeferredCore, type Deferred } from "../../../shared/deferred.js";
import { createGatewayMethodRegistry } from "../../methods/registry.js";
import { agentHandlers } from "../../server-methods/agent.js";
import { createLazyCoreHandlers } from "../../server-methods/lazy-core-handlers.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlers,
  RespondFn,
} from "../../server-methods/types.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";
import { captureGatewayRpcReceivedAt, createGatewayRpcDiagnostics } from "./request-diagnostics.js";
import { GatewayRequestStartTimeoutError } from "./request-start.js";
// Compile the real router before timed cases; family preparation remains controlled below.
import "../../server-methods.js";

const thread = vi.hoisted(() => ({ isMainThread: true }));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  get isMainThread() {
    return thread.isMainThread;
  },
}));

const scheduling = vi.hoisted(() => ({ start: vi.fn<() => Promise<void> | null>() }));
const traceId = "1".repeat(32);
const parentSpanId = "1".repeat(16);
vi.mock("./request-start.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./request-start.js")>()),
  scheduleGatewayRequestStart: scheduling.start,
}));

beforeEach(() => {
  thread.isMainThread = true;
  resetDiagnosticEventsForTest();
  scheduling.start.mockReset().mockImplementation(() => Promise.resolve());
});
afterEach(() => {
  vi.restoreAllMocks();
  resetDiagnosticEventsForTest();
});

function captureLogs(consoleLevel: "info" | "debug") {
  const output = vi.fn();
  setLoggerOverride({ level: "silent", consoleLevel });
  loggingState.rawConsole = { log: output, info: output, warn: output, error: output };
  onTestFinished(() => {
    setLoggerOverride(null);
    loggingState.rawConsole = null;
    resetLogger();
  });
  return output;
}

function expectEventSubset(events: unknown[], expected: Record<string, unknown>[]) {
  expect(events).toEqual(
    expect.arrayContaining(expected.map((event) => expect.objectContaining(event))),
  );
}

function observeRequests() {
  const events: Extract<DiagnosticEventPayload, { type: "gateway.rpc" }>[] = [];
  const finished = createDeferredCore();
  const unsubscribe = onInternalDiagnosticEvent(
    (event) => {
      if (event.type === "gateway.rpc") {
        events.push(event);
        if (event.phase === "dispatch") {
          finished.resolve();
        }
      }
    },
    { include: ["gateway.rpc"] },
  );
  onTestFinished(unsubscribe);
  return {
    events,
    finished: finished.promise,
    phase: (phase: (typeof events)[number]["phase"]) =>
      events.filter((event) => event.phase === phase),
  };
}

const respondOk: GatewayRequestHandler = ({ respond }) => respond(true, {});

function createRequest(
  handler: GatewayRequestHandler | GatewayRequestHandlers = respondOk,
  method = "health",
  options: Parameters<typeof createDispatchTestHarness>[0] = {},
) {
  const observed = observeRequests();
  const socket = new EventEmitter();
  const client = createOperatorWsClient({ socket });
  const harness = createDispatchTestHarness({
    ...options,
    extraHandlers: typeof handler === "function" ? { [method]: handler } : handler,
  });
  const dispatch = (
    params: Record<string, unknown> = {},
    connection = client,
    frame: { id?: string; traceparent?: string } = {},
  ) =>
    harness.dispatcher.dispatch(
      { type: "req", id: "private-request-id", method, params, ...frame },
      connection,
    );
  return {
    ...observed,
    ...harness,
    client,
    socket,
    dispatch,
    run: async (...args: Parameters<typeof dispatch>) => {
      await dispatch(...args);
      await observed.finished;
    },
  };
}

function privateClient(id: string) {
  const client = createOperatorWsClient({ clientInfo: { id, mode: "backend" } });
  Object.assign(client.connect.client, {
    displayName: "private-",
    instanceId: "private-",
    platform: "private-",
  });
  client.connect.userAgent = "private-";
  return client;
}

type ReceiptCase = [Record<string, unknown>, Record<string, unknown>];
function checkReceipt(
  method: string,
  field: string,
  defaults: Record<string, unknown>,
  paramsDefaults: Record<string, unknown> = {},
) {
  return async (params: Record<string, unknown>, shape: Record<string, unknown>) => {
    const clientKind = "openclaw-control-ui";
    const fixture = createRequest(respondOk, method);
    await fixture.run({ ...paramsDefaults, ...params }, privateClient(clientKind));
    expect(fixture.phase("received")).toEqual([
      expect.objectContaining({
        method,
        [field]: { clientKind, source: "wire", ...defaults, ...shape },
      }),
    ]);
    expect(JSON.stringify(fixture.events)).not.toContain("private-");
  };
}

function mockHeap(heapUsed: number) {
  const memory = { ...process.memoryUsage(), heapUsed };
  const sample = vi.spyOn(process, "memoryUsage").mockImplementation(() => ({ ...memory }));
  return { memory, sample };
}

function expectPhaseCounts(fixture: ReturnType<typeof createRequest>, ...phases: string[]) {
  expect(
    phases.map((phase) => fixture.events.filter((event) => event.phase === phase).length),
  ).toEqual(phases.map(() => 1));
}

function finishAfterTest(dispatch: Promise<unknown>, ...gates: Deferred[]) {
  onTestFinished(async () => {
    gates.forEach((gate) => gate.resolve());
    await dispatch;
  });
}

function createPausedRequest(handler: GatewayRequestHandler, method = "health") {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const fixture = createRequest(async (request) => {
    entered.resolve();
    await release.promise;
    await handler(request);
  }, method);
  return {
    ...fixture,
    entered: entered.promise,
    release,
    start: async () => {
      finishAfterTest(fixture.dispatch(), release);
      await entered.promise;
    },
    finish: async () => {
      release.resolve();
      await fixture.finished;
    },
  };
}

describe("authenticated Gateway RPC diagnostics", () => {
  it("attributes a registered handler stall with diagnostics disabled", async () => {
    let now = 0;
    const monitor = createMainThreadStallMonitor(() => now);
    onTestFinished(() => monitor.stop());
    const fixture = createRequest(({ respond }) => {
      now += 250;
      respond(true, {});
    });
    setDiagnosticsEnabledForProcess(false);
    await fixture.dispatch();
    expect(monitor.drain().stalls).toEqual([
      { elapsedMs: 250, task: "gateway:rpc:health", taskMs: 250 },
    ]);
    expect(fixture.events).toEqual([]);
  });

  it.each([
    ["openclaw-control-ui", "control-ui"],
    ["webchat-ui", "control-ui"],
    ["webchat", "control-ui"],
    ["openclaw-browser-copilot", "control-ui"],
    ["openclaw-macos", "macos"],
    ["openclaw-ios", "ios"],
    ["openclaw-watchos", "ios"],
    ["openclaw-android", "android"],
    ["cli", "cli"],
    ["openclaw-tui", "cli"],
    ["node-host", "node"],
    ["openclaw-worker", "node"],
    ["gateway-client", "other"],
    ["openclaw-linux", "other"],
    ["test", "other"],
  ] as const)("attributes ordinary RPCs from %s as %s", async (id, clientKind) => {
    const fixture = createRequest();
    await fixture.run({}, privateClient(id));
    expect(fixture.phase("received")[0]).toMatchObject({ method: "health", clientKind });
    expect(JSON.stringify(fixture.events)).not.toContain("private-");
  });

  it.each<ReceiptCase>([
    [
      { sessionKey: "private-", agentId: "private-", compact: true },
      { scope: "session", compact: true },
    ],
    [
      { agentId: "private-", offset: 50 },
      { scope: "agent", page: "append" },
    ],
    [{ compact: "private-", offset: "private-", query: "private-" }, {}],
  ])(
    "attributes cron receipt (%j)",
    checkReceipt("cron.list", "cronList", {
      scope: "global",
      compact: false,
      page: "first",
    }),
  );

  it.each<ReceiptCase>([
    [
      { view: "configured", agentId: "private-", preparedOnly: true },
      { view: "configured", scope: "agent", preparedOnly: true },
    ],
    [
      { sessionKey: "private-", agentId: "private-", refresh: true },
      { scope: "session", refresh: true },
    ],
    [
      { view: "provider-config", authProfileId: "private-" },
      { view: "provider-config", scope: "auth-profile" },
    ],
    [{ view: "private-", refresh: "private-" }, { view: "other" }],
  ])(
    "attributes model catalog receipt (%j)",
    checkReceipt("models.list", "modelsList", {
      view: "default",
      scope: "global",
      preparedOnly: false,
      refresh: false,
    }),
  );

  it.each([
    { source: "dashboard", rowMode: "compact", bytes: 204_800, elapsed: 0 },
    { source: "private-", rowMode: undefined, bytes: 100, elapsed: 1_000 },
  ])("attributes session list diagnostics without private filters ($source)", async (query) => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const output = captureLogs("debug");
    const fixture = createRequest(({ respond }) => {
      now += query.elapsed;
      respond(true, {});
    }, "sessions.list");
    fixture.send.mockReturnValue({ kind: "sent", bytes: query.bytes });
    await fixture.run(
      {
        source: query.source,
        rowMode: query.rowMode,
        limit: 60,
        offset: 120,
        ownerId: "private-",
        search: "private-",
      },
      fixture.client,
      { id: "session-list-diagnostics" },
    );
    expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    expect(fixture.phase("received")[0]).toMatchObject({
      sessionsList: {
        clientKind: fixture.client.connect.client.id,
        source: "wire",
        callerSource: query.rowMode ? "dashboard" : "unspecified",
        rowMode: query.rowMode ?? "full",
        filter: "search",
      },
    });
    expect(JSON.stringify(fixture.events)).not.toContain("private-");
    const log = output.mock.calls.flat().join("\n");
    expect(log).toContain("sessions.list");
    expect(log).toContain(`source=${query.rowMode ? "dashboard" : "unspecified"}`);
    expect(log).toContain(`rowMode=${query.rowMode ?? "full"}`);
    expect(log).toContain("limit=60 offset=120 filterKind=ownerId+search");
    expect(log).toContain(`bytes=${query.bytes}`);
    expect(log).not.toContain("private-");
  });

  it.each<ReceiptCase>([
    [{ spawnedBy: "private-", ownerId: "private-" }, { filter: "children" }],
    [{ ownerId: "private-", involvingMe: true }, { filter: "owner" }],
    [{ involvingProfileId: "private-", activeOnly: true }, { filter: "involving" }],
    [{ activeMinutes: 15 }, { filter: "active" }],
    [{ activeOnly: false, agentId: "private-" }, { filter: "general" }],
  ])(
    "bounds session list filter attribution (%j)",
    checkReceipt(
      "sessions.list",
      "sessionsList",
      { callerSource: "sidebar", rowMode: "other" },
      { source: "sidebar", rowMode: "private-" },
    ),
  );

  it.each([true, false])(
    "records frame bytes and logs, sampling heap only on the main thread (main=%s)",
    async (main) => {
      thread.isMainThread = main;
      const { memory, sample } = mockHeap(4096);
      let now = 1000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const output = captureLogs("info");
      const completion = createDeferredCore();
      const fixture = createRequest(async ({ respond }) => {
        now = 2000;
        respond(true, { accepted: true });
        await completion.promise;
        respond(true, { final: true });
        memory.heapUsed = 2048;
        fixture.send.mockReturnValue({ kind: "unavailable" });
        respond(true);
      });
      fixture.send.mockReturnValue({ kind: "sent", bytes: 1234 });
      const dispatch = fixture.dispatch();
      finishAfterTest(dispatch, completion);
      await fixture.awaitResponseFrame("private-request-id");
      fixture.send.mockReturnValue({ kind: "sent", bytes: 8192 });
      completion.resolve();
      await dispatch;
      await fixture.finished;
      expect(fixture.phase("handler")[0]).toMatchObject({
        heapDeltaBytes: main ? -2048 : undefined,
      });
      expect(sample).toHaveBeenCalledTimes(main ? 2 : 0);
      expect(output).toHaveBeenCalledWith(expect.stringMatching(/res.*health.*1000ms.*bytes=1234/));
      expect(fixture.phase("response")).toMatchObject([
        { responseBytes: 1234, firstResponse: true },
        { responseBytes: 8192, firstResponse: false },
        { outcome: "unavailable", firstResponse: undefined, responseBytes: undefined },
      ]);
    },
  );

  it.each(["nested", "crossing", "unobserved"])(
    "discards entire overlapping handler windows (%s) and resumes after settlement",
    async (overlap) => {
      const { memory } = mockHeap(1024);
      const first = createPausedRequest(() => {
        memory.heapUsed += 4096;
      });
      const second = createPausedRequest(() => {
        memory.heapUsed += 8192;
      }, "cron.status");
      const firstDispatch = first.dispatch();
      await first.entered;
      if (overlap === "unobserved") {
        setDiagnosticsEnabledForProcess(false);
      }
      const secondDispatch = second.dispatch();
      finishAfterTest(Promise.all([firstDispatch, secondDispatch]), first.release, second.release);
      onTestFinished(() => setDiagnosticsEnabledForProcess(true));
      await awaitGateBeforeSettlement(
        second.entered,
        secondDispatch,
        "overlapping request settled before handler entry",
      );
      setDiagnosticsEnabledForProcess(true);
      if (overlap === "crossing") {
        first.release.resolve();
        await firstDispatch;
        second.release.resolve();
      } else {
        second.release.resolve();
        await secondDispatch;
        first.release.resolve();
      }
      await Promise.all([firstDispatch, secondDispatch]);
      await waitForDiagnosticEventsDrained();
      const handlers = first.phase("handler");
      expect(handlers).toHaveLength(overlap === "unobserved" ? 1 : 2);
      expect(
        first.events.filter(
          (event) => "heapDeltaBytes" in event && event.heapDeltaBytes !== undefined,
        ),
      ).toEqual([]);
      first.events.length = 0;
      await first.dispatch();
      await waitForDiagnosticEventsDrained();
      expect(first.phase("handler")[0]).toMatchObject({
        heapDeltaBytes: 4096,
      });
    },
  );

  it.each(["family", "nested family", "family rejection"])(
    "keeps %s preparation separate from actual handler entry",
    async (preparation) => {
      let now = 100;
      const { memory } = mockHeap(1024);
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const reached = createDeferredCore();
      const release = createDeferredCore();
      const handler: GatewayRequestHandler = ({ respond }) => {
        memory.heapUsed += 2048;
        now = 240;
        respond(true);
      };
      const fixture = createRequest(
        createLazyCoreHandlers({
          methods: ["health"],
          loadHandlers: async () => {
            reached.resolve();
            await release.promise;
            if (preparation === "family rejection") {
              throw new Error("expected handler preparation failure");
            }
            const handlers = { health: handler };
            return preparation === "nested family"
              ? createLazyCoreHandlers({ methods: ["health"], loadHandlers: async () => handlers })
              : handlers;
          },
        }),
      );
      finishAfterTest(fixture.dispatch(), release);
      await reached.promise;
      memory.heapUsed += 8192;
      now = 200;
      release.resolve();
      await fixture.finished;
      await waitForDiagnosticEventsDrained();
      if (preparation === "family rejection") {
        expect(fixture.phase("handler").length > 0).toBe(false);
        expect(fixture.events.at(-1)).toMatchObject({ phase: "dispatch", outcome: "threw" });
        return;
      }
      expect(fixture.phase("handler")[0]).toMatchObject({
        admissionMs: 100,
        durationMs: 40,
        outcome: "returned",
        heapDeltaBytes: 2048,
      });
    },
  );

  it("separates start admission, first response, and handler settlement without delaying ACK", async () => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const queue = createDeferredCore();
    const queued = createDeferredCore();
    scheduling.start.mockImplementation(() => {
      queued.resolve();
      return queue.promise;
    });
    const completion = createDeferredCore();
    const fixture = createRequest(async ({ respond }) => {
      now = 150;
      respond(true, { accepted: true });
      await completion.promise;
      respond(true, { final: true });
    });
    const dispatch = fixture.dispatch();
    finishAfterTest(dispatch, queue, completion);
    await queued.promise;
    now = 120;
    queue.resolve();
    expect(await fixture.awaitResponseFrame("private-request-id")).toMatchObject({
      payload: { accepted: true },
    });
    await waitForDiagnosticEventsDrained();
    expect(fixture.phase("response")).toMatchObject([{ outcome: "ok", durationMs: 50 }]);
    expect(fixture.phase("handler").length > 0).toBe(false);
    now = 220;
    completion.resolve();
    await fixture.finished;
    expect(fixture.phase("handler")).toMatchObject([
      { outcome: "returned", durationMs: 100, admissionMs: 20 },
    ]);
    expect(fixture.phase("dispatch")).toMatchObject([
      { outcome: "returned", durationMs: 120, queueWaitMs: 20, response: "sent" },
    ]);
    expectPhaseCounts(fixture, "received", "response");
    expect(JSON.stringify(fixture.events)).not.toContain("private-request-id");
  });

  it.each([true, false])(
    "keeps late responses single and trace-bound (trace=%s)",
    async (hasTrace) => {
      let retainedRespond: RespondFn | undefined;
      const fixture = createRequest(({ respond }) => {
        retainedRespond = respond;
      });
      await fixture.dispatch({}, fixture.client, {
        id: "trace-request",
        ...(hasTrace ? { traceparent: `00-${traceId}-${parentSpanId}-01` } : {}),
      });
      await fixture.finished;
      expect(fixture.events.at(-1)).toMatchObject({ phase: "dispatch", response: "none" });
      const unrelated = createDiagnosticTraceContext({ parentSpanId: "2222222222222222" });
      runWithDiagnosticTraceContext(unrelated, () => {
        retainedRespond?.(true, { late: true });
        retainedRespond?.(true, { later: true });
        expect(getActiveDiagnosticTraceContext()).toEqual(unrelated);
      });
      await waitForDiagnosticEventsDrained();
      expectPhaseCounts(fixture, "response", "handler", "dispatch");
      expect(
        fixture.events
          .filter((event) => event.phase !== "received")
          .every((event) => event.trace?.traceId === (hasTrace ? traceId : undefined)),
      ).toBe(true);
    },
  );

  it.each(
    (["shared-auth", "runtime"] as const).flatMap((reason) =>
      [
        { parent: "valid", traceparent: `00-${traceId}-${parentSpanId}-01` },
        { parent: "invalid", traceparent: `00-${"0".repeat(32)}-${parentSpanId}-01` },
        { parent: "absent", traceparent: undefined },
      ].map((parent) => Object.assign(parent, { reason })),
    ),
  )(
    "preserves supplied parent semantics through early $reason denial (parent=$parent)",
    async ({ reason, parent, traceparent }) => {
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true));
      const ambient = createDiagnosticTraceContext();
      const authority = vi.fn(() => false);
      const fixture = createRequest(handler, "health", {
        getRequiredSharedGatewaySessionGeneration: () => "new-generation",
        buildRequestContext: () => ({ validateAgentRuntimeApprovalAuthority: authority }),
      });
      const { client } = fixture;
      if (reason === "shared-auth") {
        client.usesSharedGatewayAuth = true;
        client.sharedGatewaySessionGeneration = "previous-generation";
      } else {
        const operationalRunInstance = createOperationalRunInstanceRef("early-denial");
        client.internal = {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: "agent:main:test",
            operationalRunInstance,
            delegatedAuthority: {
              kind: "local",
              operationalRunInstance,
              lifecycleGeneration: "test-generation",
              claimId: "test-claim",
            },
          },
        };
      }
      await runWithDiagnosticTraceContext(ambient, () =>
        fixture.run({}, client, { id: "early-denial", traceparent }),
      );
      expect(handler).not.toHaveBeenCalled();
      const phases = fixture.events.filter((event) => event.phase !== "received");
      expect(phases.map((event) => event.phase)).toEqual(
        reason === "runtime" ? ["response", "dispatch"] : ["dispatch"],
      );
      expect(phases.at(-1)).toMatchObject({ phase: "dispatch", outcome: "rejected" });
      expect(phases.map((event) => [event.trace?.traceId, event.trace?.parentSpanId])).toEqual(
        phases.map(() =>
          parent === "valid" ? [traceId, parentSpanId] : [ambient.traceId, undefined],
        ),
      );
      if (reason === "runtime") {
        expect(authority).toHaveBeenCalledWith(client.internal?.agentRuntimeIdentity);
        expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
      } else {
        expect(fixture.send).not.toHaveBeenCalled();
      }
      expect(fixture.close).toHaveBeenCalledWith(4001, expect.any(String));
      expect(getActiveDiagnosticTraceContext()).toBeUndefined();
    },
  );

  it.each(["authorization", "capacity", "timeout"])(
    "records %s rejection without a handler sample",
    async (reason) => {
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true));
      const fixture = createRequest(handler, "sessions.list");
      if (reason === "authorization") {
        fixture.client.connect.scopes = [];
      } else if (reason === "capacity") {
        scheduling.start.mockReturnValue(null);
      } else {
        scheduling.start.mockRejectedValue(new GatewayRequestStartTimeoutError());
      }
      await fixture.run();
      expect(handler).not.toHaveBeenCalled();
      expect(fixture.phase("handler").length > 0).toBe(false);
      expectEventSubset(fixture.events, [
        { phase: "response", outcome: "error" },
        { phase: "dispatch", outcome: "rejected" },
      ]);
      if (reason === "capacity") {
        expect(fixture.events.at(-1)).not.toHaveProperty("queueWaitMs");
      } else if (reason === "timeout") {
        expect(fixture.events.at(-1)).toHaveProperty("queueWaitMs");
        expect(fixture.send).toHaveBeenCalledWith(
          expect.objectContaining({
            ok: false,
            error: expect.objectContaining({
              code: "UNAVAILABLE",
              retryable: true,
              details: { reason: "request-start-timeout" },
            }),
          }),
        );
      }
    },
  );

  it.each(["unavailable", "suppressed"] as const)(
    "records %s delivery independently of settlement",
    async (outcome) => {
      const fixture = createPausedRequest(({ respond, signal }) => {
        expect(signal).toBeUndefined();
        respond(true, { private: "must not send after revocation" });
        respond(true, { duplicate: true });
      });
      await fixture.start();
      if (outcome === "unavailable") {
        expect(fixture.socket.listenerCount("close")).toBe(0);
        fixture.socket.emit("close");
        fixture.send.mockReturnValue({ kind: "unavailable" });
      } else {
        fixture.client.invalidated = true;
      }
      await fixture.finish();
      expect(fixture.phase("response")).toMatchObject([{ outcome }]);
      expect(fixture.events.at(-1)).toMatchObject({
        phase: "dispatch",
        outcome: "returned",
        response: outcome,
      });
      expectEventSubset(fixture.events, [{ phase: "handler", outcome: "returned" }]);
      if (outcome === "suppressed") {
        expect(fixture.send).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["sent", "unavailable"] as const)(
    "measures serialization fallback only when its send is %s",
    async (fallback) => {
      const fixture = createRequest();
      fixture.send
        .mockReturnValueOnce({
          kind: "serialization",
          error: new Error("synthetic encoding fault"),
        })
        .mockReturnValueOnce(
          fallback === "sent" ? { kind: "sent", bytes: 256 } : { kind: "unavailable" },
        );
      await fixture.run();
      expect(fixture.send).toHaveBeenCalledTimes(2);
      expect(fixture.phase("response")).toMatchObject([
        {
          outcome: fallback === "sent" ? "error" : "unavailable",
          responseBytes: fallback === "sent" ? 256 : undefined,
        },
      ]);
    },
  );

  it("reports request-owned cancellation separately from transport delivery failure", async () => {
    const entered = createDeferredCore();
    const fixture = createRequest(async ({ signal }) => {
      const cancelled = createDeferredCore();
      signal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
      entered.resolve();
      await cancelled.promise;
    }, "sessions.companion.ask");
    const dispatch = fixture.dispatch();
    try {
      await entered.promise;
      fixture.socket.emit("close");
      await dispatch;
      await fixture.finished;
      expect(fixture.events.at(-1)).toMatchObject({
        phase: "dispatch",
        outcome: "cancelled",
        response: "none",
      });
      expect(fixture.phase("response").length > 0).toBe(false);
      expect(fixture.socket.listenerCount("close")).toBe(0);
    } finally {
      fixture.socket.emit("close");
      await dispatch;
    }
  });

  it("distinguishes a throwing handler from the error response it sends", async () => {
    const fixture = createRequest(() => {
      throw new Error("synthetic handler failure");
    });
    await fixture.run();
    expectEventSubset(fixture.events, [
      { phase: "handler", outcome: "threw" },
      { phase: "response", outcome: "error" },
      { phase: "dispatch", outcome: "threw" },
    ]);
    expect(JSON.stringify(fixture.events)).not.toContain("synthetic handler failure");
  });

  it("captures payload-free RPC timings for channel subscribers with diagnostics disabled", async () => {
    const events: unknown[] = [];
    const source = channel("openclaw.gateway.rpc");
    const listener = (event: unknown) => events.push(event);
    source.subscribe(listener);
    onTestFinished(() => source.unsubscribe(listener));
    const fixture = createRequest(({ respond }) => respond(true, { private: "response content" }));
    setDiagnosticsEnabledForProcess(false);
    expect(captureGatewayRpcReceivedAt()).toEqual(expect.any(Number));
    await fixture.dispatch();
    expect(fixture.send).toHaveBeenCalledOnce();
    expectEventSubset(events, [
      { operation: "health.received" },
      { operation: "health.response", durationMs: expect.any(Number) },
      { operation: "health.handler", admissionMs: expect.any(Number) },
      { operation: "health.dispatch", durationMs: expect.any(Number) },
    ]);
    expect(JSON.stringify(events)).not.toContain("private");
    expect(JSON.stringify(events)).not.toContain("response content");
  });

  it.each(["disabled", "trusted-filtered"] as const)(
    "takes no clocks or registry lookups when diagnostics are %s or uninterested",
    (mode) => {
      const clock = vi.spyOn(performance, "now");
      const memory = vi.spyOn(process, "memoryUsage");
      const registry = vi.fn();
      expect(createGatewayRpcDiagnostics("health", registry, {})).toBeUndefined();
      const stopPublic = onDiagnosticEvent(() => {});
      onTestFinished(stopPublic);
      expect(createGatewayRpcDiagnostics("health", registry, {})).toBeUndefined();
      stopPublic();
      const unsubscribe = onInternalDiagnosticEvent(() => {}, {
        include: ["gateway.rpc"],
        ...(mode === "trusted-filtered" ? { includeTrusted: [] } : {}),
      });
      if (mode === "disabled") {
        setDiagnosticsEnabledForProcess(false);
      }
      expect(captureGatewayRpcReceivedAt()).toBeUndefined();
      expect(createGatewayRpcDiagnostics("health", registry, {})).toBeUndefined();
      const readParams = vi.fn();
      expect(
        createGatewayRpcDiagnostics(
          "sessions.list",
          registry,
          {},
          {
            clientKind: "openclaw-control-ui",
            source: "wire",
            get params() {
              return readParams();
            },
          },
        ),
      ).toBeUndefined();
      expect(readParams).not.toHaveBeenCalled();
      unsubscribe();
      expect(clock).not.toHaveBeenCalled();
      expect(memory).not.toHaveBeenCalled();
      expect(registry).not.toHaveBeenCalled();
    },
  );

  it("labels registered methods exactly and folds arbitrary names across registry replacement", async () => {
    const { events } = observeRequests();
    let registry = createGatewayMethodRegistry([
      {
        name: "workboard.cards.list",
        handler: () => {},
        owner: { kind: "plugin", pluginId: "workboard" },
        scope: "operator.read",
      },
    ]);
    const getRegistry = () => registry;
    createGatewayRpcDiagnostics("node.invoke.result", getRegistry, {});
    createGatewayRpcDiagnostics("workboard.cards.list", getRegistry, {});
    createGatewayRpcDiagnostics("aux.status", undefined, { "aux.status": () => {} });
    await waitForDiagnosticEventsDrained();
    expect(events.map((event) => event.method)).toEqual([
      "node.invoke.result",
      "workboard.cards.list",
      "aux.status",
    ]);
    events.length = 0;
    registry = createGatewayMethodRegistry([]);
    createGatewayRpcDiagnostics("workboard.cards.list", getRegistry, {});
    for (let index = 0; index < 1000; index++) {
      createGatewayRpcDiagnostics(`private-method-${index}`, getRegistry, {});
    }
    createGatewayRpcDiagnostics("constructor", getRegistry, {});
    createGatewayRpcDiagnostics("__proto__", getRegistry, {});
    await waitForDiagnosticEventsDrained();
    expect(new Set(events.map((event) => event.method))).toEqual(new Set(["other"]));
    expect(JSON.stringify(events)).not.toContain("private-");
  });
});

describe("Gateway observation response ordering", () => {
  afterEach(() => resetGatewayWorkAdmission());
  it("does not send a second response when shutdown follows a completed observation", async () => {
    const fixture = createDispatchTestHarness({
      extraHandlers: { "agent.wait": agentHandlers["agent.wait"]! },
      buildRequestContext: () => ({
        dedupe: new Map(),
        getRuntimeConfig: () => ({}),
      }),
    });
    const shutdown = fixture.awaitResponseFrame("completed").then(() => {
      markGatewayRestartDraining("stop (SIGTERM)");
    });
    await fixture.dispatcher.dispatch(
      {
        type: "req",
        id: "completed",
        method: "agent.wait",
        params: { runId: "missing-completed", timeoutMs: 0 },
      },
      createOperatorWsClient(),
    );
    await shutdown;
    expect(fixture.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ok: true }));
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });
});
