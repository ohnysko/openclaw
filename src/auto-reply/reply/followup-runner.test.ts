import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  resolveSessionTranscriptReadFence,
  runWithSessionTranscriptReadFence,
} from "../../config/sessions/session-transcript-read-fence.js";
import { createChatSendLateFollowupDisposition } from "../../gateway/server-methods/chat-send-late-followup.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type { FollowupExecutionResult } from "./followup-turn-execution.js";
import type { FollowupRun } from "./queue.js";
import type { AdmittedFollowupTurn } from "./reply-agent-turn-preparation.js";
import { createMockTypingController as createTypingController } from "./test-helpers.js";

const state = vi.hoisted(() => ({
  account: vi.fn(),
  admit: vi.fn(),
  completeLifecycle: vi.fn(),
  completedSourceDelivery: false,
  deliver: vi.fn(),
  execute: vi.fn(),
  resolveDecision: vi.fn(),
  clearRunContext: vi.fn(),
}));

vi.mock("../../infra/agent-run-registry.js", () => ({
  clearAgentRunContext: (...args: unknown[]) => state.clearRunContext(...args),
}));

vi.mock("../../agents/embedded-agent-runner/delivery-evidence.js", () => ({
  hasCompletedSourceReplyDeliveryEvidence: () => state.completedSourceDelivery,
}));

vi.mock("./agent-runner-result-accounting.js", () => ({
  accountFollowupTurn: (...args: unknown[]) => state.account(...args),
}));

vi.mock("./reply-agent-turn-preparation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reply-agent-turn-preparation.js")>()),
  prepareReplyAgentTurn: (...args: unknown[]) => state.admit(...args),
}));

vi.mock("./followup-turn-execution.js", () => ({
  executeFollowupTurn: (...args: unknown[]) => state.execute(...args),
}));

vi.mock("./followup-delivery.js", () => ({
  deliverFollowupDecision: (...args: unknown[]) => state.deliver(...args),
  resolveFollowupDeliveryDecision: (...args: unknown[]) => state.resolveDecision(...args),
}));

vi.mock("./queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue.js")>()),
  completeFollowupRunLifecycle: (...args: unknown[]) => state.completeLifecycle(...args),
}));

vi.mock("../../runtime.js", () => ({ defaultRuntime: { error: vi.fn() } }));

const { createFollowupRunner } = await import("./followup-runner.js");

function createQueuedRun(overrides: Partial<FollowupRun> = {}): FollowupRun {
  return {
    prompt: "queued prompt",
    enqueuedAt: 1,
    run: {
      agentId: "agent",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: "main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      provider: "anthropic",
      model: "claude",
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
    ...overrides,
  };
}

function createRunner(overrides: Partial<Parameters<typeof createFollowupRunner>[0]> = {}) {
  return createFollowupRunner({
    typing,
    typingMode: "never",
    defaultModel: "claude",
    ...overrides,
  });
}

function admit(turn: AdmittedFollowupTurn, execution: FollowupExecutionResult) {
  state.admit.mockResolvedValue({ kind: "admitted", turn });
  state.execute.mockResolvedValue(execution);
  state.account.mockResolvedValue(undefined);
}

function createTurn(
  order: string[] = [],
  result: AdmittedFollowupTurn["operation"]["result"] = null,
) {
  const operation = {
    result,
    complete: vi.fn(() => order.push("operation-complete")),
    fail: vi.fn(() => order.push("operation-failed")),
  };
  return {
    runId: "run-1",
    queued: createQueuedRun(),
    operation,
    config: {},
    session: { kind: "session", key: "main", current: () => undefined, publish: vi.fn() },
    sendPolicy: "allow",
    preflightCompactionApplied: false,
  } as unknown as AdmittedFollowupTurn & { operation: typeof operation };
}

function createRejectedExecution(order: string[] = []): FollowupExecutionResult {
  return {
    commentaryPayloadsEnabled: false,
    execution: {
      runId: "run-1",
      outcome: { kind: "rejected", payload: { text: "failed" } },
    },
    runStartedAt: 1,
    sessionCtx: {},
    pendingToolTasks: new Set(),
    progress: {
      drain: vi.fn(async () => {
        order.push("progress-drained");
      }),
    },
  } as FollowupExecutionResult;
}

function createSettledExecution(): FollowupExecutionResult {
  return {
    ...createRejectedExecution(),
    execution: {
      runId: "run-1",
      outcome: {
        kind: "settled",
        status: "ok",
        result: { payloads: [], meta: { durationMs: 0 } },
        resolved: { provider: "anthropic", model: "claude" },
        fallback: { exhausted: false, attempts: [] },
        autoCompactionCount: 0,
      },
    },
  };
}

let turn: ReturnType<typeof createTurn>;
let typing: ReturnType<typeof createTypingController>;
let execution: FollowupExecutionResult;

beforeEach(() => {
  vi.clearAllMocks();
  state.completedSourceDelivery = false;
  turn = createTurn();
  typing = createTypingController();
  execution = createSettledExecution();
  admit(turn, execution);
  state.resolveDecision.mockReturnValue({ kind: "suppress", reason: "silent" });
  state.deliver.mockResolvedValue({ kind: "completed", payloads: [] });
});

describe("createFollowupRunner", () => {
  it.each([
    { kind: "pending", failed: false },
    { kind: "pending", failed: true },
    { kind: "source-retry", failed: false },
    { kind: "source-retry", failed: true },
  ] as const)(
    "distinguishes transport handoff from source retry ($kind, failed=$failed)",
    async ({ kind, failed }) => {
      const end = vi.fn();
      turn.queued.deliveryCorrelations = [{ begin: () => end }];
      admit(turn, failed ? createRejectedExecution() : createSettledExecution());
      state.deliver.mockResolvedValue({ kind, payloads: [] });

      await createRunner()(turn.queued);

      expect(end).toHaveBeenCalledExactlyOnceWith(
        kind === "source-retry" && !failed
          ? undefined
          : {
              visibleReplySent: false,
              failed,
              completed: !failed,
              ...(kind === "pending" ? { transportPending: true } : {}),
            },
      );
    },
  );

  it("reads the current transcript without borrowing the interrupted turn's admission fence", async () => {
    const admission = {
      agentId: "agent",
      sessionId: "session",
      sessionKey: "main",
      storePath: "/tmp/store",
      generation: "generation",
      entryId: "interrupted-user-message",
      rawSeq: 1,
      effectiveParentId: null,
      activeMessagePosition: 1,
      logicalTurnId: "interrupted-turn",
      role: "user" as const,
    };
    state.admit.mockImplementation(async () => {
      expect(resolveSessionTranscriptReadFence(admission)).toBeUndefined();
      return { kind: "admitted", turn };
    });
    state.execute.mockImplementation(async () => {
      await Promise.resolve();
      expect(resolveSessionTranscriptReadFence(admission)).toBeUndefined();
      return createSettledExecution();
    });
    state.account.mockResolvedValue(undefined);
    await runWithSessionTranscriptReadFence(admission, async () => {
      await createRunner()(turn.queued);
      expect(resolveSessionTranscriptReadFence(admission)).toBe(admission);
    });
    expect(state.execute).toHaveBeenCalledOnce();
  });

  it.each(["start", "end", "rejected"] as const)(
    "delivers compaction notices at the owning phase (%s)",
    async (phase) => {
      const immediate = phase === "start";
      if (!immediate) {
        const source = createChatSendLateFollowupDisposition({
          runId: "source-run",
          originatingChannel: "webchat",
          logGateway: { info: vi.fn() } as never,
          deliver: async () => ({ kind: "delivered" }),
        });
        source.recordQueued();
        turn.queued.originatingChannel = "webchat";
        turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver: source.deliver };
      } else {
        turn.queued.originatingChannel = "discord";
      }
      const failure = new Error("session generation changed after compaction");
      const notice = {
        text: immediate ? "Compacting context" : "Context compacted",
        replyToCurrent: true,
        isCompactionNotice: true,
      };
      const order: string[] = [];
      state.admit.mockImplementation(
        async (
          params: Parameters<
            typeof import("./reply-agent-turn-preparation.js").prepareReplyAgentTurn
          >[0],
        ) => {
          await params.onCompactionNotice?.(immediate ? "start" : "end", notice.text, turn);
          if (phase === "rejected") {
            throw failure;
          }
          if (immediate) {
            order.push("compaction-finished");
          }
          return { kind: "admitted", turn };
        },
      );
      state.execute.mockImplementation(async () => {
        order.push("execution-settled");
        return execution;
      });
      state.deliver.mockImplementation(async (params: { kind?: string }) => {
        order.push(
          immediate
            ? params.kind === "block"
              ? "notice-delivered"
              : "final-delivered"
            : "delivery",
        );
        return { kind: "completed", payloads: [] };
      });
      const run = createRunner()(turn.queued);
      if (phase === "rejected") {
        await expect(run).rejects.toBe(failure);
        for (const mock of [state.execute, state.deliver, state.completeLifecycle]) {
          expect(mock).not.toHaveBeenCalled();
        }
      } else {
        await run;
        expect(order).toEqual(
          immediate
            ? ["notice-delivered", "compaction-finished", "execution-settled", "final-delivered"]
            : ["execution-settled", "delivery", "delivery"],
        );
        if (!immediate) {
          expect(state.deliver).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
              kind: "block",
              decision: { kind: "deliver", payloads: [notice] },
              runId: turn.runId,
            }),
          );
        }
      }
    },
  );

  it("closes the current run once after transferring source delivery to recovery", async () => {
    const deliver = vi.fn(async () => {});
    turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver };
    admit(turn, createSettledExecution());
    state.resolveDecision.mockReturnValue({
      kind: "retry-source-delivery",
      run: turn.queued,
      finalTextLength: 300,
      resolved: { provider: "anthropic", model: "claude" },
    });
    state.deliver.mockResolvedValue({ kind: "source-retry" });

    await createRunner()(turn.queued);

    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        runId: turn.runId,
        completion: { kind: "completed" },
        payloads: [],
      }),
    );
    expect(state.execute).toHaveBeenCalledOnce();
    expect(state.completeLifecycle).toHaveBeenCalledWith(turn.queued);
  });

  it.each(["silent", "send-policy", "room-event", "message-tool-only"] as const)(
    "settles the queued source when final delivery is suppressed by %s",
    async (reason) => {
      const deliver = vi.fn(async () => {});
      turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver };
      state.resolveDecision.mockReturnValue({ kind: "suppress", reason });

      await createRunner()(turn.queued);

      expect(deliver).toHaveBeenCalledExactlyOnceWith({
        kind: "queued-followup",
        runId: turn.runId,
        originatingChannel: undefined,
        payloads: [],
        completion: {
          kind: "completed",
          ...(reason === "silent" || reason === "message-tool-only"
            ? { allowCanvasOnly: true }
            : {}),
        },
      });
      expect(state.execute).toHaveBeenCalledOnce();
      expect(state.completeLifecycle).toHaveBeenCalledWith(turn.queued);
    },
  );

  it.each(["timeout", "user", "restart", "superseded"] as const)(
    "preserves %s classification when the queue owns completion",
    async (reason) => {
      const deliver = vi.fn(async () => {});
      turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver };
      if (reason === "timeout" && execution.execution.outcome.kind === "settled") {
        execution.execution.outcome = {
          ...execution.execution.outcome,
          status: "failed",
          terminalFailurePayload: { text: "Provider timed out", isError: true },
          result: {
            payloads: [],
            meta: {
              durationMs: 1000,
              timeoutPhase: "provider",
              stopReason: "timeout",
              aborted: true,
              providerStarted: true,
            },
          },
        };
      } else if (reason !== "timeout") {
        execution.execution.outcome = { kind: "aborted", reason };
      }

      await createRunner()(turn.queued);

      expect(deliver).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          completion:
            reason === "timeout"
              ? {
                  kind: "failed",
                  error: "Provider timed out",
                  stopReason: "timeout",
                  errorKind: "timeout",
                }
              : { kind: "aborted", stopReason: reason === "user" ? "aborted" : reason },
        }),
      );
      expect(state.execute).toHaveBeenCalledOnce();
    },
  );

  it("retains its Gateway and drops caller authority through the delivery retry handoff", async () => {
    const resolveGatewayContext = () => undefined;
    const otherGatewayContext = () => undefined;
    const staleAuthority = vi.fn();
    const observed: unknown[] = [];
    let retry: ((queued: FollowupRun) => Promise<void>) | undefined;
    state.admit.mockImplementation(async () => {
      const scope = getPluginRuntimeGatewayRequestScope();
      observed.push({
        resolver: scope?.resolveGatewayContext,
        authority: scope?.assertNodeExecutionCurrent,
      });
      return { kind: "admitted", turn };
    });
    state.execute.mockResolvedValue(createRejectedExecution());
    state.account.mockResolvedValue(undefined);
    state.deliver
      .mockResolvedValue({ kind: "completed", payloads: [] })
      .mockImplementationOnce(
        async (
          params: Parameters<typeof import("./followup-delivery.js").deliverFollowupDecision>[0],
        ) => {
          retry = params.runFollowup;
          return { kind: "source-retry" };
        },
      );
    const run = createRunner({
      resolveGatewayContext,
      typingMode: "instant",
    });
    await withPluginRuntimeGatewayRequestScope(
      {
        resolveGatewayContext: otherGatewayContext,
        assertNodeExecutionCurrent: staleAuthority,
        isWebchatConnect: () => false,
      },
      async () => {
        await run(turn.queued);
        if (!retry) {
          throw new Error("expected delivery retry callback");
        }
        await retry(turn.queued);
      },
    );
    expect(observed).toEqual([
      { resolver: resolveGatewayContext, authority: undefined },
      { resolver: resolveGatewayContext, authority: undefined },
    ]);
    expect(state.execute).toHaveBeenCalledTimes(2);
  });

  it("completes lifecycle and both typing signals for an already-aborted item", async () => {
    const controller = new AbortController();
    controller.abort();
    const endCorrelation = vi.fn();
    const queued = createQueuedRun({
      abortSignal: controller.signal,
      deliveryCorrelations: [{ begin: () => endCorrelation }],
    });

    await createRunner({ typingMode: "instant" })(queued);

    expect(state.admit).not.toHaveBeenCalled();
    expect(state.completeLifecycle).toHaveBeenCalledWith(queued);
    expect(typing.markRunComplete).toHaveBeenCalledOnce();
    expect(typing.markDispatchIdle).toHaveBeenCalledOnce();
    expect(endCorrelation).toHaveBeenCalledExactlyOnceWith({
      visibleReplySent: false,
      failed: true,
      completed: false,
    });
  });

  it("settles invalidated claimed input without executing or replaying", async () => {
    const endCorrelation = vi.fn();
    const queued = createQueuedRun({ deliveryCorrelations: [{ begin: () => endCorrelation }] });
    state.admit.mockResolvedValue({ kind: "skipped", reason: "lifecycle-invalidated" });

    await expect(createRunner({ typingMode: "instant" })(queued)).resolves.toBeUndefined();

    expect(state.completeLifecycle).toHaveBeenCalledWith(queued);
    expect(typing.markRunComplete).toHaveBeenCalledOnce();
    expect(typing.markDispatchIdle).toHaveBeenCalledOnce();
    expect(state.execute).not.toHaveBeenCalled();
    expect(endCorrelation).toHaveBeenCalledExactlyOnceWith({
      visibleReplySent: false,
      failed: true,
      completed: false,
    });
  });

  it.each(["aborted", "lifecycle-invalidated", "goal-inactive"])(
    "settles a terminal admission skip (%s) and releases its operation",
    async (reason) => {
      const order: string[] = [];
      turn = createTurn(order);
      const endCorrelation = vi.fn();
      turn.queued.deliveryCorrelations = [{ begin: () => endCorrelation }];
      state.admit.mockResolvedValue({
        kind: "skipped",
        reason,
        operation: turn.operation,
      });

      await createRunner({ typingMode: "instant" })(turn.queued);

      expect(order).toEqual(["operation-complete"]);
      expect(state.completeLifecycle).toHaveBeenCalledWith(turn.queued);
      expect(endCorrelation).toHaveBeenCalledExactlyOnceWith({
        visibleReplySent: false,
        failed: true,
        completed: false,
      });
    },
  );

  it("restores unexpected execution failures after releasing the admitted operation", async () => {
    const order: string[] = [];
    turn = createTurn(order);
    const failure = new Error("candidate failed before settlement");
    state.admit.mockResolvedValue({ kind: "admitted", turn });
    state.execute.mockRejectedValue(failure);

    await expect(createRunner({ typingMode: "instant" })(turn.queued)).rejects.toBe(failure);

    expect(state.completeLifecycle).not.toHaveBeenCalled();
    expect(state.clearRunContext).toHaveBeenCalledWith("run-1");
    expect(order).toEqual(["operation-complete"]);
    expect(typing.markRunComplete).toHaveBeenCalledOnce();
    expect(typing.markDispatchIdle).toHaveBeenCalledOnce();
  });

  it("consumes a user abort before execution starts", async () => {
    turn = createTurn([], { kind: "aborted", code: "aborted_by_user" });
    const deliver = vi.fn(async () => {});
    turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver };
    state.admit.mockResolvedValue({ kind: "admitted", turn });
    state.execute.mockRejectedValue(new Error("aborted before execution start"));

    await createRunner({ typingMode: "instant" })(turn.queued);

    expect(state.completeLifecycle).toHaveBeenCalledWith(turn.queued);
    expect(state.clearRunContext).toHaveBeenCalledWith("run-1");
    expect(turn.operation.fail).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        completion: { kind: "aborted", stopReason: "aborted" },
        payloads: [],
      }),
    );
  });

  it("consumes revoked operator input instead of retrying a pre-execution refusal", async () => {
    const failure = new Error("original operator role changed");
    turn.queued.operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "guest",
      scopes: ["operator.write"],
      assertCurrent: () => {
        throw failure;
      },
    });
    state.admit.mockRejectedValueOnce(failure);

    await expect(createRunner()(turn.queued)).resolves.toBeUndefined();

    expect(state.execute).not.toHaveBeenCalled();
    expect(state.completeLifecycle).toHaveBeenCalledWith(turn.queued);
    expect(typing.markRunComplete).toHaveBeenCalledOnce();
  });

  it.each(["delivery", "progress"] as const)("does not replay after %s fails", async (phase) => {
    const failure = new Error(
      phase === "delivery" ? "terminal delivery failed" : "presentation failed",
    );
    const source = vi.fn(async () => {});
    turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver: source };
    if (phase === "delivery") {
      const rejected = createRejectedExecution();
      admit(turn, rejected);
      state.resolveDecision.mockReturnValue({
        kind: "deliver",
        payloads: [{ text: "terminal failure", isError: true }],
      });
      state.deliver.mockRejectedValue(failure);
    } else {
      execution.progress.drain = vi.fn(async () => {
        throw failure;
      });
    }
    await createRunner({ typingMode: "instant" })(turn.queued);
    for (const mock of [state.execute, state.account, state.deliver]) {
      expect(mock).toHaveBeenCalledOnce();
    }
    expect(state.completeLifecycle).toHaveBeenCalledWith(turn.queued);
    if (phase === "delivery") {
      expect(state.clearRunContext).toHaveBeenCalledWith("run-1");
      expect(turn.operation.fail).toHaveBeenCalledWith("run_failed", failure);
      expect(source).toHaveBeenCalledWith(
        expect.objectContaining({
          completion: { kind: "failed", error: failure.message },
          payloads: [],
        }),
      );
    } else {
      expect(turn.operation.fail).toHaveBeenCalledWith("run_failed", expect.any(Error));
      expect(source).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          completion: { kind: "failed", error: failure.message },
        }),
      );
    }
  });

  it("holds the reply operation through progress drain, accounting, and delivery", async () => {
    const order: string[] = [];
    turn = createTurn(order);
    execution = createRejectedExecution(order);
    const sourceDelivery = vi.fn(async () => {
      order.push("completion");
    });
    const presentationGate = createDeferred();
    const presentationStarted = createDeferred();
    const endCorrelation = vi.fn();
    turn.queued.deliveryCorrelations = [{ begin: () => endCorrelation }];
    let presentation: Promise<void> | undefined;
    turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver: sourceDelivery };
    const decision = {
      kind: "deliver" as const,
      payloads: [{ text: "done\nUsage: 1.3k total" } satisfies ReplyPayload],
    };
    state.admit.mockResolvedValue({ kind: "admitted", turn });
    state.execute.mockResolvedValue(execution);
    state.account.mockImplementation(async () => {
      order.push("accounted");
      return { payloadArray: [{ text: "raw accounting reply" }] };
    });
    state.resolveDecision.mockImplementation(() => {
      order.push("decision");
      return decision;
    });
    state.deliver.mockImplementation(
      async (
        params: Parameters<typeof import("./followup-delivery.js").deliverFollowupDecision>[0],
      ) => {
        expect(params.decision).toEqual(decision);
        order.push("delivered");
        return { kind: "completed", payloads: decision.payloads };
      },
    );
    state.completeLifecycle.mockImplementation(() => order.push("lifecycle-complete"));

    const run = createRunner({
      typingMode: "instant",
      opts: {
        onQueuedFollowupSettled: () => {
          presentation = (async () => {
            order.push("presentation-settling");
            presentationStarted.resolve();
            await presentationGate.promise;
            order.push("presentation-settled");
          })();
          return presentation;
        },
      },
    })(turn.queued);

    const settledRun = Promise.allSettled([run]);
    try {
      await Promise.race([presentationStarted.promise, run]);
      expect(order).toContain("presentation-settling");
      expect(state.completeLifecycle).not.toHaveBeenCalled();
      expect(turn.operation.complete).not.toHaveBeenCalled();
      expect(endCorrelation).not.toHaveBeenCalled();
    } finally {
      presentationGate.resolve();
      await settledRun;
      await presentation;
    }
    await run;

    expect(endCorrelation).toHaveBeenCalledExactlyOnceWith(undefined);

    expect(order).toEqual([
      "progress-drained",
      "accounted",
      "decision",
      "delivered",
      "completion",
      "presentation-settling",
      "presentation-settled",
      "lifecycle-complete",
      "operation-complete",
    ]);
    expect(sourceDelivery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ payloads: decision.payloads }),
    );
    expect(state.clearRunContext).toHaveBeenCalledWith("run-1");
  });

  it.each(["delivered", "filtered", "delivery-failed", "completion-failed"])(
    "closes queued continuation adoption after its delivery owner settles (%s)",
    async (outcome) => {
      let continuationOpen = true;
      let openAtCleanup: boolean | undefined;
      const adoptionResults: Array<boolean | undefined> = [];
      const adopt = vi.fn(() => continuationOpen);
      const statusPayload = setReplyPayloadMetadata(
        { text: "The worker is continuing." },
        {
          continuationStatus: true,
          progressContinuation: {
            adopt,
            close: () => {
              continuationOpen = false;
            },
          },
        },
      );
      const decision = { kind: "deliver", payloads: [statusPayload] };
      const draft = { push: () => undefined, retire: () => undefined };
      turn.queued.queuedFollowupReplyDisposition = {
        kind: "deliver",
        deliver: async (batch) => {
          for (const payload of batch.payloads) {
            adoptionResults.push(
              getReplyPayloadMetadata(payload)?.progressContinuation?.adopt(draft),
            );
          }
          if (outcome === "completion-failed") {
            throw new Error("completion failed after adoption");
          }
        },
      };
      state.admit.mockResolvedValue({ kind: "admitted", turn });
      state.execute.mockResolvedValue(createSettledExecution());
      state.account.mockResolvedValue({});
      state.resolveDecision.mockResolvedValue(decision);
      state.deliver.mockImplementation(async () => {
        if (outcome === "delivery-failed") {
          throw new Error("delivery failed before adoption");
        }
        return {
          kind: "completed",
          payloads: outcome === "filtered" ? [] : decision.payloads,
        };
      });

      await createRunner({
        opts: {
          onQueuedFollowupSettled: async () => {
            openAtCleanup = continuationOpen;
          },
        },
      })(turn.queued);

      expect(adopt()).toBe(false);
      expect(openAtCleanup).toBe(true);
      expect(adoptionResults).toEqual(
        outcome === "delivered" || outcome === "completion-failed" ? [true] : [],
      );
      expect(state.execute).toHaveBeenCalledOnce();
      expect(state.completeLifecycle).toHaveBeenCalledWith(turn.queued);
    },
  );

  it.each([true, false])(
    "projects queued commentary with the refreshed durable owner when enabled is %s",
    async (commentaryPayloadsEnabled) => {
      execution = Object.assign(createRejectedExecution(), {
        commentaryPayloadsEnabled,
      });
      admit(turn, execution);

      await createRunner({
        typingMode: "instant",
        opts: { commentaryPayloadsEnabled: !commentaryPayloadsEnabled },
      })(turn.queued);

      expect(state.resolveDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          opts: expect.objectContaining({ commentaryPayloadsEnabled }),
        }),
      );
    },
  );

  it.each([true, false])(
    "settles source delivery correlations with visible=%s",
    async (visible) => {
      const onObservedReplyDelivery = vi.fn(async () => {});
      const endCorrelation = vi.fn();
      turn.queued.deliveryCorrelations = [{ begin: () => endCorrelation }];
      state.completedSourceDelivery = visible;
      state.admit.mockResolvedValue({ kind: "admitted", turn });
      state.execute.mockResolvedValue(execution);
      state.account.mockResolvedValue({});

      await createRunner({
        typingMode: "instant",
        opts: { onObservedReplyDelivery },
      })(turn.queued);

      expect(onObservedReplyDelivery).toHaveBeenCalledTimes(visible ? 1 : 0);
      expect(endCorrelation).toHaveBeenCalledExactlyOnceWith({
        visibleReplySent: visible,
        failed: false,
        completed: true,
      });
    },
  );
});
