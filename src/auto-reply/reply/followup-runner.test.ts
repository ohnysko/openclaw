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
import type { deliverFollowupDecision } from "./followup-delivery.js";
import {
  createSettledExecution as createSettledResult,
  createTurn as createDeliveryTurn,
} from "./followup-delivery.test-helpers.js";
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
  clearAgentRunContext: state.clearRunContext,
}));

vi.mock("../../agents/embedded-agent-runner/delivery-evidence.js", () => ({
  hasCompletedSourceReplyDeliveryEvidence: () => state.completedSourceDelivery,
}));

vi.mock("./agent-runner-result-accounting.js", () => ({ accountFollowupTurn: state.account }));

vi.mock("./reply-agent-turn-preparation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reply-agent-turn-preparation.js")>()),
  prepareReplyAgentTurn: state.admit,
}));

vi.mock("./followup-turn-execution.js", () => ({ executeFollowupTurn: state.execute }));

vi.mock("./followup-delivery.js", () => ({
  deliverFollowupDecision: state.deliver,
  resolveFollowupDeliveryDecision: state.resolveDecision,
}));

vi.mock("./queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue.js")>()),
  completeFollowupRunLifecycle: state.completeLifecycle,
}));

vi.mock("../../runtime.js", () => ({ defaultRuntime: { error: vi.fn() } }));

const { createFollowupRunner } = await import("./followup-runner.js");
type DeliveryParams = Parameters<typeof deliverFollowupDecision>[0];

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

function attachSource(deliver = vi.fn(async () => {})) {
  turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver };
  return deliver;
}

function correlate(queued = turn.queued) {
  const end = vi.fn();
  queued.deliveryCorrelations = [{ begin: () => end }];
  return end;
}

function expectTypingClosed() {
  expect(typing.markRunComplete).toHaveBeenCalledOnce();
  expect(typing.markDispatchIdle).toHaveBeenCalledOnce();
}

function expectSourceBatch(mock: unknown, batch: Record<string, unknown>) {
  expect(mock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(batch));
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
  const fixture = createDeliveryTurn({ operation: operation as AdmittedFollowupTurn["operation"] });
  fixture.queued.prompt = "queued prompt";
  delete fixture.queued.originatingChannel;
  delete fixture.queued.originatingTo;
  delete fixture.queued.run.messageProvider;
  fixture.session.publish = vi.fn();
  return Object.assign(fixture, { operation });
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
    progress: { drain: vi.fn(async () => void order.push("progress-drained")) },
  } as FollowupExecutionResult;
}

function createSettledExecution(): FollowupExecutionResult {
  return {
    ...createRejectedExecution(),
    execution: createSettledResult(),
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
      const end = correlate();
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
    await runWithSessionTranscriptReadFence(admission, async () => {
      await createRunner()(turn.queued);
      expect(resolveSessionTranscriptReadFence(admission)).toBe(admission);
    });
    expect(state.execute).toHaveBeenCalledOnce();
  });

  it.each(["start", "end", "rejected"] as const)("owns compaction (%s)", async (phase) => {
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
        immediate ? (params.kind === "block" ? "notice-delivered" : "final-delivered") : "delivery",
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
  });

  it("closes the current run once after transferring source delivery to recovery", async () => {
    const deliver = attachSource();
    state.resolveDecision.mockReturnValue({ kind: "retry-source-delivery" });
    state.deliver.mockResolvedValue({ kind: "source-retry" });

    await createRunner()(turn.queued);

    expectSourceBatch(deliver, {
      runId: turn.runId,
      completion: { kind: "completed" },
      payloads: [],
    });
    expect(state.execute).toHaveBeenCalledOnce();
    expect(state.completeLifecycle).toHaveBeenCalledWith(turn.queued);
  });

  it.each(["silent", "send-policy", "room-event", "message-tool-only"] as const)(
    "settles the queued source when final delivery is suppressed by %s",
    async (reason) => {
      const deliver = attachSource();
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
      const deliver = attachSource();
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

      expectSourceBatch(deliver, {
        completion:
          reason === "timeout"
            ? {
                kind: "failed",
                error: "Provider timed out",
                stopReason: "timeout",
                errorKind: "timeout",
              }
            : { kind: "aborted", stopReason: reason === "user" ? "aborted" : reason },
      });
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
    state.deliver.mockImplementationOnce(async (params: DeliveryParams) => {
      retry = params.runFollowup;
      return { kind: "source-retry" };
    });
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

  it.each([
    ["already-aborted", false],
    ["lifecycle-invalidated", false],
    ["aborted", true],
    ["lifecycle-invalidated", true],
    ["goal-inactive", true],
  ] as const)("settles terminal %s (owned=%s)", async (reason, ownsOperation) => {
    const order: string[] = [];
    turn = createTurn(order);
    const endCorrelation = correlate();
    if (reason === "already-aborted") {
      turn.queued.abortSignal = AbortSignal.abort();
    } else {
      state.admit.mockResolvedValue({
        kind: "skipped",
        reason,
        ...(ownsOperation ? { operation: turn.operation } : {}),
      });
    }
    await expect(createRunner({ typingMode: "instant" })(turn.queued)).resolves.toBeUndefined();
    if (reason === "already-aborted") {
      expect(state.admit).not.toHaveBeenCalled();
    }
    expect(state.execute).not.toHaveBeenCalled();
    expect(order).toEqual(ownsOperation ? ["operation-complete"] : []);
    expect(state.completeLifecycle).toHaveBeenCalledWith(turn.queued);
    expectTypingClosed();
    expect(endCorrelation).toHaveBeenCalledExactlyOnceWith({
      visibleReplySent: false,
      failed: true,
      completed: false,
    });
  });

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
    expectTypingClosed();
  });

  it("consumes a user abort before execution starts", async () => {
    turn = createTurn([], { kind: "aborted", code: "aborted_by_user" });
    const deliver = attachSource();
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
    const source = attachSource();
    if (phase === "delivery") {
      admit(turn, createRejectedExecution());
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
      expectSourceBatch(source, { completion: { kind: "failed", error: failure.message } });
    }
  });

  it("holds the reply operation through progress drain, accounting, and delivery", async () => {
    const order: string[] = [];
    turn = createTurn(order);
    execution = createRejectedExecution(order);
    const sourceDelivery = attachSource(vi.fn(async () => void order.push("completion")));
    const presentationGate = createDeferred();
    const presentationStarted = createDeferred();
    const endCorrelation = correlate();
    const decision = {
      kind: "deliver" as const,
      payloads: [{ text: "done\nUsage: 1.3k total" } satisfies ReplyPayload],
    };
    admit(turn, execution);
    state.account.mockImplementation(async () => {
      order.push("accounted");
      return { payloadArray: [{ text: "raw accounting reply" }] };
    });
    state.resolveDecision.mockImplementation(() => {
      order.push("decision");
      return decision;
    });
    state.deliver.mockImplementation(async (params: DeliveryParams) => {
      expect(params.decision).toEqual(decision);
      order.push("delivered");
      return { kind: "completed", payloads: decision.payloads };
    });
    state.completeLifecycle.mockImplementation(() => order.push("lifecycle-complete"));

    const run = createRunner({
      typingMode: "instant",
      opts: {
        onQueuedFollowupSettled: async () => {
          order.push("presentation-settling");
          presentationStarted.resolve();
          await presentationGate.promise;
          order.push("presentation-settled");
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
    expectSourceBatch(sourceDelivery, { payloads: decision.payloads });
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

  it.each([true, false])("uses durable commentary setting (%s)", async (enabled) => {
    execution = Object.assign(createRejectedExecution(), { commentaryPayloadsEnabled: enabled });
    admit(turn, execution);

    await createRunner({
      typingMode: "instant",
      opts: { commentaryPayloadsEnabled: !enabled },
    })(turn.queued);

    expect(state.resolveDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        opts: expect.objectContaining({ commentaryPayloadsEnabled: enabled }),
      }),
    );
  });

  it.each([true, false])("settles source visibility (%s)", async (visible) => {
    const onObservedReplyDelivery = vi.fn(async () => {});
    const endCorrelation = correlate();
    state.completedSourceDelivery = visible;

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
  });
});
