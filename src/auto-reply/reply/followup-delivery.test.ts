import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatSendLateFollowupDisposition } from "../../gateway/server-methods/chat-send-late-followup.js";
import type * as ProviderRuntime from "../../plugins/provider-runtime.js";
import { retireSessionControllerInput } from "../../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { getSessionControllerEntryForOperation } from "../../sessions/session-controller.state.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type { AgentTurnExecutionResult } from "./agent-runner-execution.types.js";
import { deliverFollowupDecision, resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import {
  createAccounting,
  createDefaults,
  createSettledExecution,
  createTurn,
} from "./followup-delivery.test-helpers.js";
import { scheduleFollowupDrain } from "./queue/drain.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import type { FollowupRun } from "./queue/types.js";
import type { AdmittedFollowupTurn } from "./reply-agent-turn-preparation.js";
import { createMockReplyOperation } from "./test-helpers.js";

const deliveryState = vi.hoisted(() => ({
  followupRoute: undefined as { route: "dispatcher" | "origin" | "drop" } | undefined,
  routeReply: vi.fn(),
  runtimeError: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock("./queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue.js")>()),
  enqueueFollowupRun: deliveryState.enqueue,
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: () => undefined,
  getLoadedChannelPlugin: () => undefined,
}));

vi.mock("../../plugins/provider-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ProviderRuntime>()),
  resolveProviderFollowupFallbackRoute: () => deliveryState.followupRoute,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: deliveryState.runtimeError },
}));

vi.mock("./route-reply.js", () => ({
  isRoutableChannel: (channel: string | undefined) => channel === "discord" || channel === "slack",
  routeReply: deliveryState.routeReply,
}));

afterEach(() => {
  deliveryState.followupRoute = undefined;
  deliveryState.routeReply.mockReset();
  deliveryState.runtimeError.mockReset();
  deliveryState.enqueue.mockReset();
});

function settledCase(finalText = "", turn = createTurn()) {
  const execution = createSettledExecution(finalText);
  const resolve = (
    payloads: ReplyPayload[] = [],
    accounting: Parameters<typeof createAccounting>[1] = {},
    opts?: Parameters<typeof resolveFollowupDeliveryDecision>[0]["opts"],
  ) =>
    resolveFollowupDeliveryDecision({
      turn,
      execution,
      accounting: createAccounting(payloads, accounting),
      opts,
    });
  return { turn, execution, resolve };
}

type DeliveryParams = Parameters<typeof deliverFollowupDecision>[0];
function deliverDecision(
  turn: AdmittedFollowupTurn,
  decision: DeliveryParams["decision"],
  options: Partial<Omit<DeliveryParams, "turn" | "decision">> = {},
) {
  return deliverFollowupDecision({
    turn,
    decision,
    defaults: createDefaults(vi.fn(async () => {})),
    runId: turn.runId,
    runFollowup: vi.fn(async () => {}),
    ...options,
  });
}
const reply = (...payloads: ReplyPayload[]) => ({ kind: "deliver" as const, payloads });

const missingReply = {
  text: "No answer was returned. Ask again if you still need one.",
  isError: true,
  isStatusNotice: true,
};

describe("resolveFollowupDeliveryDecision", () => {
  const sourceReplyTarget = {
    tool: "message",
    provider: "discord",
    to: "channel:C1",
    text: "Still working",
  };
  const progressTarget = { ...sourceReplyTarget, sourceReplyFinal: false };
  const finalTarget = { ...sourceReplyTarget, sourceReplyFinal: true };
  const progressPayload = { text: "Still working", sourceReplyFinal: false };

  it.each([
    { state: undefined, routed: true, delivered: true },
    { state: "missing", routed: true, delivered: false },
    { state: undefined, routed: false, delivered: false },
  ] as const)("checks source evidence $state/$routed", async ({ state, routed, delivered }) => {
    const { execution, resolve } = settledCase("Completed.");
    execution.outcome.result.sourceReplyDeliveryState = state;
    execution.outcome.result.messagingToolSentTexts = ["Completed."];
    execution.outcome.result.messagingToolSentTargets = routed
      ? [{ ...sourceReplyTarget, text: "Completed." }]
      : undefined;
    expect(await resolve([{ text: "Completed." }])).toMatchObject(
      delivered
        ? { kind: "suppress", reason: "silent" }
        : reply({ isError: true, text: expect.any(String) }),
    );
  });

  it.each([
    [{ total: 1250 }, undefined, "queued reply\nUsage: 1.3k total"],
    [
      { cacheRead: 800, cacheWrite: 200 },
      undefined,
      "queued reply\nUsage: ? in / ? out · cache 800 cached / 200 new",
    ],
    [{ total: 1250 }, "off", "queued reply"],
  ] as const)("delivers usage %j with preference %s", async (usage, sessionMode, expected) => {
    const { turn, resolve } = settledCase(
      "queued reply",
      createTurn({ config: { messages: { responseUsage: "tokens" } } }),
    );
    const sourceDispatcher = vi.fn(async () => {});
    turn.queued.originatingChannel = "webchat";
    turn.queued.originatingTo = undefined;
    turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver: sourceDispatcher };
    turn.session.current = () => ({
      sessionId: "session",
      updatedAt: 1,
      responseUsage: sessionMode,
    });

    const delivery = await deliverDecision(
      turn,
      await resolve([{ text: "queued reply" }], { usage }),
    );
    expect(delivery).toMatchObject({ kind: "completed", payloads: [{ text: expected }] });
    expect(sourceDispatcher).not.toHaveBeenCalled();
  });

  it.each([
    ["yielded", undefined, false],
    ["continuationPending", undefined, false],
    ["yielded", "Research started; results will follow.", false],
    ["yielded", "Research started; results will follow.", true],
  ] as const)(
    "delivers waiting status for %s (%s, private partial=%s)",
    async (continuation, yieldAcknowledgment, privatePartial) => {
      const { turn, execution, resolve } = settledCase();
      execution.outcome.result.meta = { durationMs: 0, [continuation]: true, yieldAcknowledgment };
      if (privatePartial) {
        turn.queued.originatingChatType = "group";
        turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
      } else {
        execution.outcome.result.acceptedSessionSpawns = [
          {
            runId: "child-run",
            childSessionKey: "agent:main:subagent:child",
            expectsCompletionMessage: true,
          },
        ];
      }
      const decision = await resolve(privatePartial ? [{ text: "Private partial output." }] : []);
      expect(decision).toMatchObject(
        yieldAcknowledgment
          ? reply({ text: yieldAcknowledgment })
          : { kind: "suppress", reason: "silent" },
      );
    },
  );

  it.each([
    ["required", true, true],
    ["optional", true, true],
    ["required", false, true],
    ["optional", false, true],
    ["result-required", false, true],
    ["required", false, false],
    ["optional", false, false],
  ] as const)("settles %s (heartbeat=%s, silent=%s)", async (expectation, heartbeat, silent) => {
    const { replyOperation, failMock } = createMockReplyOperation();
    const { turn, execution, resolve } = settledCase("", createTurn({ operation: replyOperation }));
    turn.queued.run.terminalReplyExpectation = expectation;
    if (silent) {
      Object.assign(execution.outcome.result.meta, {
        finalAssistantRawText: "NO_REPLY",
        terminalReply: { disposition: "silent" },
      });
      if (!heartbeat) {
        turn.queued.strandedReplyRetry = true;
        Object.assign(execution.outcome.result.meta, {
          yielded: true,
          yieldAcknowledgment: "An unsent confirmation",
        });
      }
    }
    const decision = await resolve(
      silent && !heartbeat ? [{ text: "Earlier answer" }] : [],
      {},
      heartbeat ? { isHeartbeat: true } : undefined,
    );
    const expected =
      !silent && expectation === "required"
        ? reply(missingReply)
        : { kind: "suppress", reason: "silent" };
    if (heartbeat) {
      expect(decision).toEqual(expected);
    } else {
      expect(decision).toMatchObject(expected);
      expect(failMock).toHaveBeenCalledTimes(
        silent ? Number(expectation === "result-required") : Number(expectation === "required"),
      );
    }
  });

  it.each(["automatic", "message_tool_only"] as const)(
    "preserves pending audio in %s",
    async (sourceReplyDeliveryMode) => {
      const { turn, execution, resolve } = settledCase();
      turn.queued.run.sourceReplyDeliveryMode = sourceReplyDeliveryMode;
      execution.outcome.result.meta = {
        durationMs: 0,
        finalAssistantRawText: "NO_REPLY",
        terminalReply: { disposition: "silent" },
      };
      const media = setReplyPayloadMetadata(
        {
          text: "Unsent caption",
          mediaUrl: "https://example.invalid/pending.opus",
          audioAsVoice: true,
        },
        { assistantTranscriptOwned: true, deliverDespiteSourceReplySuppression: true },
      );
      const decision = await resolve([{ text: "Unsent confirmation" }, media]);
      expect(decision).toMatchObject({
        kind: "deliver",
        payloads: [{ mediaUrl: "https://example.invalid/pending.opus", audioAsVoice: true }],
      });
      if (decision.kind === "deliver") {
        expect(decision.payloads).toHaveLength(1);
        expect(decision.payloads[0]?.text).toBeUndefined();
        expect(
          getReplyPayloadMetadata(expectDefined(decision.payloads[0], "queued media payload")),
        ).toMatchObject({
          assistantTranscriptOwned: true,
          deliverDespiteSourceReplySuppression: true,
        });
      }
    },
  );

  it.each(["hook", "approval"] as const)(
    "preserves %s output despite silent terminal",
    async (source) => {
      const { execution, resolve } = settledCase();
      execution.outcome.result.meta = {
        durationMs: 0,
        terminalReply: { disposition: "silent" },
        ...(source === "hook"
          ? { error: { kind: "hook_block", message: "Blocked by policy." } as const }
          : {}),
      };
      execution.outcome.result.didSendDeterministicApprovalPrompt = source === "approval";
      const payload = { text: "Approval or policy notice", isStatusNotice: true };
      expect(await resolve([payload])).toMatchObject(reply(payload));
    },
  );

  it.each(["room-event", "send-policy", "aborted"] as const)(
    "suppresses %s before final projection",
    async (reason) => {
      const turn = createTurn({ sendPolicy: reason === "send-policy" ? "deny" : "allow" });
      if (reason === "room-event") {
        turn.queued.currentInboundEventKind = "room_event";
      }
      const execution: AgentTurnExecutionResult =
        reason === "aborted"
          ? {
              runId: "run-1",
              outcome: { kind: "aborted", reason: "user", compaction: { count: 1, durable: [] } },
            }
          : createSettledExecution(reason === "room-event" ? "private room final" : "blocked");
      expect(
        await resolveFollowupDeliveryDecision({
          turn,
          execution,
          accounting: reason === "aborted" ? createAccounting([{ text: "late reply" }]) : undefined,
        }),
      ).toEqual({ kind: "suppress", reason });
    },
  );

  const stalledOperation = {
    result: { kind: "failed", code: "run_stalled" },
    staleExpiryReason: "stuck_recovery",
  } as AdmittedFollowupTurn["operation"];
  const stoppedOperation = {
    result: { kind: "aborted", code: "aborted_by_user" },
  } as AdmittedFollowupTurn["operation"];
  it.each([
    ["automatic", stalledOperation, true, true],
    ["message_tool_only", stalledOperation, true, true],
    [undefined, stalledOperation, false, false],
    [undefined, stoppedOperation, true, false],
  ] as const)("settles stalled recovery in %s mode", async (mode, operation, recovery, visible) => {
    const turn = createTurn({ operation });
    turn.queued.stalledTurnRecovery = recovery;
    turn.queued.run.sourceReplyDeliveryMode = mode;
    const decision = await resolveFollowupDeliveryDecision({
      turn,
      execution: { runId: "run-1", outcome: { kind: "aborted", reason: "user" } },
    });
    if (visible) {
      expect(decision).toMatchObject(
        reply({
          text: "⚠️ This turn was interrupted because it stopped making progress. Please try again.",
          isError: true,
        }),
      );
    } else {
      expect(decision).toEqual({ kind: "suppress", reason: "aborted" });
    }
  });

  it.each([
    ["private failure", undefined, false, "channel", "message-tool-only", "private failure detail"],
    ["internal failure", undefined, false, "internal", "silent", "internal failure"],
    ["optional WebChat failure", "optional", false, "webchat", "silent", "internal failure"],
    ["approved required failure", "required", true, "channel", undefined, "visible failure"],
    ["approved optional failure", "optional", true, "channel", undefined, "visible failure"],
  ] as const)(
    "applies queued rejection visibility for %s",
    async (_name, expectation, approved, source, reason, text) => {
      const turn = createTurn();
      turn.queued.run.terminalReplyExpectation = expectation;
      if (source === "internal") {
        turn.queued.run.inputProvenance = { kind: "internal_system", sourceTool: "test" };
      } else if (source === "webchat") {
        turn.queued.originatingChannel = "webchat";
        turn.queued.run.messageProvider = "webchat";
      } else {
        turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
      }
      if (approved) {
        turn.queued.originatingChatType = "group";
        turn.queued.originatingReplyToMode = "all";
      }
      const payload = approved
        ? setReplyPayloadMetadata(
            { text, isError: true },
            { deliverDespiteSourceReplySuppression: true },
          )
        : { text };
      const decision = await resolveFollowupDeliveryDecision({
        turn,
        execution: { runId: "run-1", outcome: { kind: "rejected", payload } },
        opts: source === "webchat" ? { onBlockReply: vi.fn(async () => {}) } : undefined,
      });
      if (approved) {
        expect(decision).toMatchObject(reply(payload));
        if (decision.kind === "deliver") {
          expect(getReplyPayloadMetadata(decision.payloads[0] ?? {})?.replyDelivery).toEqual({
            chatType: "group",
            replyToMode: "all",
          });
        }
      } else {
        expect(decision).toEqual({ kind: "suppress", reason });
      }
    },
  );

  it.each<[ReplyPayload | undefined, boolean, boolean, false?]>([
    [undefined, false, false],
    [{ mediaUrl: "file:///tmp/generated.png" }, false, true],
    [{ text: "   " }, false, false],
    [{ text: "HEARTBEAT_OK" }, false, false],
    [{ text: "hidden reasoning", isReasoning: true }, false, false],
    [{ mediaUrl: "file:///tmp/already-sent.png" }, true, false],
    [{ text: "Private terminal diagnostic." }, false, false, false],
  ])("checks pending content %j", async (payload, sent, deliver, marked) => {
    const { turn, execution, resolve } = settledCase(
      marked === false ? "" : "The answer is ready.",
    );
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
    if (sent && payload?.mediaUrl) {
      execution.outcome.result.messagingToolSentMediaUrls = [payload.mediaUrl];
    }
    if (payload && marked !== false) {
      setReplyPayloadMetadata(payload, { deliverDespiteSourceReplySuppression: true });
    }
    const decision = await resolve(payload ? [payload] : []);
    expect(decision).toMatchObject(
      deliver
        ? reply({ mediaUrl: payload?.mediaUrl })
        : {
            kind: "retry-source-delivery",
            run: { strandedReplyRetry: true, disableCollectBatching: true },
          },
    );
  });

  it("normalizes compaction notices with the runtime provider and originating context", async () => {
    const { turn, resolve } = settledCase();
    turn.queued.originatingChatType = "group";
    turn.queued.originatingReplyToMode = "all";
    const decision = await resolve([{ text: "done" }], {
      providerUsed: "claude-cli",
      modelUsed: "claude-sonnet-4-6",
      compactionNotice: { text: "compacted" },
    });
    expect(decision).toMatchObject({
      kind: "deliver",
      resolved: { provider: "claude-cli", model: "claude-sonnet-4-6" },
    });
    if (decision.kind === "deliver") {
      expect(getReplyPayloadMetadata(decision.payloads[0] ?? {})?.replyDelivery).toEqual({
        chatType: "group",
        replyToMode: "all",
      });
    }
  });

  const failedAfterProgress = "The run failed after progress.";
  const privateFinal = "This private text must not replace the sanitized failure.";
  it.each([
    ["internal", undefined, "", "empty", "internal failure"],
    ["private", "required", "", "empty", "terminal failure"],
    ["private", "optional", "", "empty", "terminal failure"],
    ["private", undefined, privateFinal, "empty", "terminal failure"],
    ["group", "optional", "", "empty", failedAfterProgress],
    ["group", "optional", "", "empty", "Rate limit reached. Try again later."],
    ["group", "optional", "", "empty", "NO_REPLY."],
    ["group", "optional", "", "empty", "NO_REPLY"],
    ["group", "optional", "", "delivered", failedAfterProgress],
    ["group", "optional", "", "pending", failedAfterProgress],
    ["group", "optional", "", "blocked", failedAfterProgress],
    ["group", "optional", "", "ready", failedAfterProgress],
  ] as const)("settles %s/%s/%s/%s/%s", async (source, expectation, final, evidence, text) => {
    const { turn, execution, resolve } = settledCase(final);
    turn.queued.run.terminalReplyExpectation = expectation;
    if (source === "internal") {
      turn.queued.run.inputProvenance = { kind: "internal_system", sourceTool: "test" };
    } else if (source === "private") {
      turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
    } else {
      turn.queued.originatingChatType = "group";
    }
    const failure = { text, isError: true };
    Object.assign(execution.outcome, { status: "failed", terminalFailurePayload: failure });
    if (evidence === "delivered" || evidence === "pending") {
      execution.outcome.result.sourceReplyDeliveryState = evidence;
    } else if (evidence === "blocked") {
      execution.outcome.result.didSendDeterministicApprovalPrompt = true;
    }
    const payloads = final
      ? [{ text: "private partial" }]
      : evidence === "ready"
        ? [{ text: "The answer is ready." }]
        : [];
    const decision = await resolve(payloads, { terminalFailurePayload: failure });
    if (source === "internal") {
      expect(decision).toEqual({ kind: "suppress", reason: "silent" });
    } else {
      expect(decision).toMatchObject(
        source === "private"
          ? reply(failure)
          : evidence === "empty"
            ? reply({ isError: true })
            : evidence === "ready"
              ? reply(...payloads)
              : { kind: "suppress", reason: "silent" },
      );
    }
  });

  it.each([
    ["progress-only target", { messagingToolSentTargets: [progressTarget] }, true],
    ["progress-only source payload", { messagingToolSourceReplyPayloads: [progressPayload] }, true],
    ["final source reply", { messagingToolSentTargets: [finalTarget] }, false],
    ["unclassified target", { messagingToolSentTargets: [sourceReplyTarget] }, true],
    ["legacy source reply", { didDeliverSourceReplyViaMessageTool: true }, false],
    ["unscoped outbound send", { didSendViaMessagingTool: true }, true],
    ["deterministic approval prompt", { didSendDeterministicApprovalPrompt: true }, false],
    [
      "visible progress while yielded",
      {
        meta: { durationMs: 0, yielded: true },
        messagingToolSentTargets: [progressTarget],
      },
      false,
    ],
    [
      "visible progress while continuation is pending",
      {
        meta: { durationMs: 0, continuationPending: true },
        messagingToolSentTargets: [progressTarget],
      },
      false,
    ],
    [
      "pending tool call",
      {
        meta: { durationMs: 0, pendingToolCalls: [{ id: "tool-1", name: "exec", arguments: {} }] },
      },
      false,
    ],
  ])("checks empty-reply evidence: %s", async (_label, evidence, expectFallback) => {
    const { execution, resolve } = settledCase();
    Object.assign(execution.outcome.result, evidence);
    expect(await resolve()).toMatchObject(
      expectFallback ? reply(missingReply) : { kind: "suppress", reason: "silent" },
    );
  });
});

describe("deliverFollowupDecision", () => {
  it("retains the event source delivery owner through progress and final settlement", async () => {
    const source = vi.fn(async () => {});
    const laterDispatcher = vi.fn(async () => {});
    const turn = createTurn();
    turn.queued.run.internalEventExecution = { onStarted: vi.fn(), onTerminal: vi.fn() };
    turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver: source };

    const deliver = (text: string, kind?: DeliveryParams["kind"]) =>
      deliverDecision(turn, reply({ text }), {
        defaults: createDefaults(laterDispatcher),
        runId: "event-run",
        kind,
      });
    await deliver("progress", "block");
    expect(source).toHaveBeenCalledExactlyOnceWith({
      kind: "queued-followup",
      runId: "event-run",
      originatingChannel: "discord",
      payloads: [{ text: "progress" }],
      completion: { kind: "progress" },
    });
    const final = await deliver("done");
    expect(final).toEqual({ kind: "completed", payloads: [{ text: "done" }] });
    expect(source).toHaveBeenCalledOnce();
    expect(deliveryState.routeReply).not.toHaveBeenCalled();
    expect(laterDispatcher).not.toHaveBeenCalled();

    turn.queued.queuedFollowupReplyDisposition = undefined;
    await expect(deliver("must not reroute")).rejects.toThrow(
      "Internal event lost its originating delivery owner",
    );
    expect(deliveryState.routeReply).not.toHaveBeenCalled();
    expect(laterDispatcher).not.toHaveBeenCalled();
  });

  it("keeps dispatcher-only delivery out of a routable origin", async () => {
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    deliveryState.followupRoute = { route: "dispatcher" };

    await deliverDecision(createTurn(), reply({ text: "dispatcher only" }), {
      defaults: createDefaults(onBlockReply),
    });

    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(deliveryState.routeReply).not.toHaveBeenCalled();
  });

  it("keeps a queued WebChat reply bound to its original source dispatcher", async () => {
    const laterDispatcher = vi.fn(async (_payload: ReplyPayload) => {});
    const sourceDispatcher = vi.fn(async () => {});
    const turn = createTurn();
    turn.queued.originatingChannel = "webchat";
    turn.queued.originatingTo = undefined;
    turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver: sourceDispatcher };
    deliveryState.followupRoute = { route: "dispatcher" };

    const payloads = await deliverDecision(turn, reply({ text: "one" }, { text: "two" }), {
      defaults: createDefaults(laterDispatcher),
      runId: "source-run",
    });
    expect(payloads).toEqual({ kind: "completed", payloads: [{ text: "one" }, { text: "two" }] });
    expect(sourceDispatcher).not.toHaveBeenCalled();
    turn.queued.queuedFollowupReplyDisposition = { kind: "drop", reason: "source-unavailable" };
    await deliverDecision(turn, reply({ text: "must stay dropped" }), {
      defaults: createDefaults(laterDispatcher),
      runId: "dropped-run",
    });
    expect(laterDispatcher).not.toHaveBeenCalled();
  });

  it("drains a source-delivery retry from its explicit store after the original turn completes", async () => {
    vi.useFakeTimers();
    const sessionKey = "agent:main:explicit-store-source-retry";
    const storePath = "/synthetic/source-retry/sessions.json";
    const operation = createReplyOperation({
      sessionKey,
      sessionId: "source-retry-session",
      resetTriggered: false,
      target: captureSessionTarget({ storeScope: storePath, sessionKey, agentId: "main" }),
    });
    const owner = getSessionControllerEntryForOperation(operation);
    const { turn, resolve } = settledCase(
      "The source answer is ready.",
      createTurn({
        operation,
        config: { messages: { queue: { mode: "followup" } } },
        session: {
          kind: "session",
          key: sessionKey,
          storePath,
          current: () => undefined,
          publish() {},
        },
      }),
    );
    turn.queued.run = {
      ...turn.queued.run,
      agentId: "main",
      sessionId: "source-retry-session",
      sessionKey,
      sourceReplyDeliveryMode: "message_tool_only",
    };
    let retry: FollowupRun | undefined;
    deliveryState.enqueue.mockImplementationOnce(
      (...args: Parameters<typeof enqueueFollowupRun>) => {
        retry = args[1];
        return enqueueFollowupRun(...args);
      },
    );
    const dispatch = vi.fn(async (_run: FollowupRun) => {});
    try {
      const decision = await resolve();
      expect(decision.kind).toBe("retry-source-delivery");
      await expect(
        deliverDecision(turn, decision, {
          defaults: createDefaults(vi.fn()),
          runFollowup: dispatch,
        }),
      ).resolves.toEqual({ kind: "source-retry" });
      scheduleFollowupDrain(sessionKey, dispatch, owner);
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatch).not.toHaveBeenCalled();
      operation.complete();
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ prompt: expect.stringContaining("The source answer is ready.") }),
      );
    } finally {
      operation.complete();
      if (retry?.controllerInput) {
        retireSessionControllerInput(retry.controllerInput);
        await retry.controllerInput.settlement.promise;
        await retry.controllerInput.claim?.settlement.promise;
      }

      vi.useRealTimers();
    }
  });

  it("keeps recovery diagnostics deliverable after the original queued run completes", async () => {
    const delivered = vi.fn(async (_params: { runId: string; payloads: ReplyPayload[] }) => ({
      kind: "delivered" as const,
    }));
    const source = createChatSendLateFollowupDisposition({
      runId: "source-admission",
      originatingChannel: "webchat",
      logGateway: { info: vi.fn() } as never,
      deliver: delivered,
    });
    source.recordQueued();
    const { turn, resolve } = settledCase("The answer is ready.");
    turn.queued.originatingChannel = "webchat";
    turn.queued.originatingTo = undefined;
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
    turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver: source.deliver };
    const decision = await resolve();
    expect(decision.kind).toBe("retry-source-delivery");
    let retryRun: FollowupRun | undefined;
    deliveryState.enqueue.mockImplementation((_key: string, run: FollowupRun) => {
      retryRun = run;
      return true;
    });

    await deliverDecision(turn, decision);
    await source.deliver({
      kind: "queued-followup",
      runId: turn.runId,
      originatingChannel: "webchat",
      payloads: [],
      completion: { kind: "completed" },
    });
    if (!retryRun || retryRun.queuedFollowupReplyDisposition?.kind !== "deliver") {
      throw new Error("Recovery was not queued with its source delivery owner");
    }
    const retryTurn = { ...turn, runId: "retry-run", queued: retryRun };
    const diagnostic = await settledCase("Still unable to send the reply.", retryTurn).resolve();
    if (diagnostic.kind !== "deliver") {
      throw new Error("Recovery did not prepare its terminal delivery diagnostic");
    }
    await retryRun.queuedFollowupReplyDisposition.deliver({
      kind: "queued-followup",
      runId: retryTurn.runId,
      originatingChannel: "webchat",
      payloads: diagnostic.payloads,
      completion: { kind: "completed" },
    });
    expect(deliveryState.enqueue).toHaveBeenCalledOnce();
    expect(delivered.mock.calls).toMatchObject([
      [{ runId: turn.runId, payloads: [] }],
      [{ runId: "retry-run", payloads: [missingReply] }],
    ]);
  });

  it("keeps block-status delivery out of the assistant transcript", async () => {
    deliveryState.routeReply.mockResolvedValue({ ok: true, delivered: true });

    await deliverDecision(createTurn(), reply({ text: "compacting" }), { kind: "block" });

    expect(deliveryState.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({ mirror: false, replyKind: "block" }),
    );
  });

  it.each([
    [{ ok: false, delivered: false, error: "offline" }, false],
    [{ ok: false, delivered: true, error: "later chunk failed" }, true],
    [{ ok: true, delivered: false, suppressed: true, reason: "channel_transform" }, true],
  ] as const)("does not retry %j (dispatcher=%s)", async (result, dispatcher) => {
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});

    deliveryState.routeReply.mockResolvedValue(result);
    const defaults = createDefaults(onBlockReply);
    await deliverDecision(createTurn(), reply({ text: "reply" }), {
      defaults: { ...defaults, opts: dispatcher ? defaults.opts : undefined },
    });
    expect(onBlockReply).not.toHaveBeenCalled();
    if (!dispatcher) {
      expect(deliveryState.runtimeError).toHaveBeenCalledWith(
        expect.stringContaining("route-reply failed: offline"),
      );
    }
  });
});
