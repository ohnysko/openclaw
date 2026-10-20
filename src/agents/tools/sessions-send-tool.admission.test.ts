import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureGatewayDeviceRevocation,
  readGatewayDeviceSourceAuthority,
} from "../../gateway/device-revocation.js";
import { readInProcessSessionDeliveryGeneration } from "../../gateway/in-process-session-delivery.js";
import * as operatorCapture from "../../gateway/operator-run-authority.js";
import * as operatorContinuation from "../../gateway/server-plugin-in-process-dispatch.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { readSessionSendDeliveryAdmission } from "../../gateway/session-send-delivery.js";
import { drainSystemEvents, peekSystemEvents } from "../../infra/system-events.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { createReplyTurnParticipants } from "../../sessions/session-controller.tool-authority.js";
import * as sessionStateEvents from "../../sessions/session-state-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import { attachActiveEmbeddedRun, detachActiveEmbeddedRun } from "../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../embedded-agent-runner/runs.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "../harness/tool-authority.runtime.js";
import { createOpenClawTools } from "../openclaw-tools.js";
import {
  createSessionsSendTestCaller,
  setSessionsSendTestActiveRun,
} from "../openclaw-tools.sessions-steering.test-support.js";
import {
  readFollowupRequest,
  SessionFollowupCompletion,
} from "../subagents/completion/session-followup-completion.js";
import "../test-helpers/fast-openclaw-tools-sessions.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import * as inProcessGateway from "./in-process-gateway.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import * as sessionsSendFollowup from "./sessions-send-followup-custody.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";
import * as sessionsSendDelivery from "./sessions-send-tool.delivery.js";
import { createSessionsSendTool } from "./sessions-send-tool.js";

vi.mock("./sessions-send-tool.a2a.js", () => ({
  runSessionsSendA2AFlow: vi.fn(async () => {}),
}));

const requesterSessionKey = "agent:main:main";
const targetSessionKey = "agent:main:dashboard:admission-target";
const runId = "sessions-send-admission-run";
const config = {
  agents: { ownership: "explicit", entries: { main: {} } },
  session: { mainKey: "main", scope: "per-sender" },
  tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
} satisfies OpenClawConfig;

type GatewayRequest = Parameters<AgentToolGatewayRequestCaller>[0];
function mockGateway(
  handle: (request: GatewayRequest) => Promise<unknown> = async (request) => {
    throw new Error(`Unexpected Gateway method: ${request.method}`);
  },
  list = false,
) {
  return vi.fn().mockImplementation((request: GatewayRequest) => {
    if (request.method === "sessions.resolve") {
      return Promise.resolve({ key: targetSessionKey, agentId: "main" });
    }
    if (list && request.method === "sessions.list") {
      return Promise.resolve({
        sessions: [{ key: targetSessionKey, agentId: "main", kind: "direct" }],
      });
    }
    return handle(request);
  });
}
function createTool(options: Parameters<typeof createSessionsSendTool>[0] = {}) {
  return createSessionsSendTool({
    agentSessionKey: requesterSessionKey,
    config,
    idempotencyKey: runId,
    ...options,
  });
}
function execute(
  tool: ReturnType<typeof createTool>,
  id: string,
  input: Record<string, unknown> = {},
) {
  return tool.execute(id, {
    sessionKey: targetSessionKey,
    message: "Continue the task",
    mode: "followup",
    timeoutSeconds: 0,
    ...input,
  });
}
function putSession(sessionKey: string, entry: Parameters<typeof replaceSessionEntry>[1]) {
  return replaceSessionEntry({ agentId: "main", sessionKey }, entry);
}
function interceptGateway(callGateway: AgentToolGatewayRequestCaller) {
  const gateway = vi
    .spyOn(inProcessGateway, "callAgentToolGatewayRequest")
    .mockImplementation(callGateway);
  const mutation = vi
    .spyOn(sessionsSendDelivery, "callSessionsSendGateway")
    .mockImplementation(callGateway);
  return () => {
    gateway.mockRestore();
    mutation.mockRestore();
  };
}
function inOperatorScope<T>(
  context: ReturnType<typeof createContext>,
  owner: ReturnType<typeof createOperatorClient>,
  source: ReturnType<typeof captureGatewayDeviceRevocation>,
  work: () => Promise<T>,
) {
  return withPluginRuntimeGatewayRequestScope(
    {
      client: owner,
      context,
      isWebchatConnect: () => false,
      hasCurrentClientAuthority: source.isCurrent,
    },
    () =>
      withOperatorToolGatewayAuthority(
        {
          authenticatedUserProfile: owner.authenticatedUserProfile,
          scopes: owner.connect.scopes ?? [],
        },
        work,
      ),
  );
}
async function completeRun(request: GatewayRequest, sessionKey: string, sessionId: string) {
  if (!isRecord(request.params) || typeof request.params.runId !== "string") {
    throw new Error("Expected agent wait run ID");
  }
  await appendTranscriptMessage(
    { agentId: "main", sessionKey, sessionId },
    {
      message: {
        role: "assistant",
        __openclaw: { runId: request.params.runId },
        phase: "final_answer",
        stopReason: "stop",
        content: [{ type: "text", text: "Task complete" }],
      },
    },
  );
  return { status: "ok", terminalReply: { disposition: "visible", text: "Task complete" } };
}

async function trackActualReplyFlow() {
  const { runSessionsSendA2AFlow: runActualFlow } = await vi.importActual<
    typeof import("./sessions-send-tool.a2a.js")
  >("./sessions-send-tool.a2a.js");
  const settled = createDeferredCore();
  vi.mocked(runSessionsSendA2AFlow).mockImplementationOnce(async (params) => {
    try {
      await runActualFlow(params);
    } finally {
      settled.resolve();
    }
  });
  return settled;
}

describe("sessions_send dispatch admission", () => {
  let state: OpenClawTestState;
  let registerWatch: MockInstance<typeof sessionStateEvents.registerSessionStateWatch>;

  beforeEach(async () => {
    state = await createOpenClawTestState({ scenario: "minimal" });
    setRuntimeConfigSnapshot(config);
    setActivePluginRegistry(createSessionConversationTestRegistry());
    resetGatewayWorkAdmission();
    vi.mocked(runSessionsSendA2AFlow).mockReset();
    registerWatch = vi.spyOn(sessionStateEvents, "registerSessionStateWatch");
    for (const [sessionKey, sessionId] of [
      [requesterSessionKey, "requester-session"],
      [targetSessionKey, "target-session"],
    ] as const) {
      await putSession(sessionKey, { sessionId, updatedAt: Date.now() });
    }
  });

  afterEach(async () => {
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    registerWatch.mockRestore();
    resetGatewayWorkAdmission();
    await state.cleanup();
  });

  it("applies peer preferences to new notifications without revoking accepted events", async () => {
    const callGateway = vi.fn();
    callGateway.mockResolvedValue({ key: targetSessionKey, agentId: "main" });
    const tool = createTool({ callGateway });
    const first = await tool.execute("notify-peer", {
      sessionKey: targetSessionKey,
      message: "accepted notice",
      mode: "notify",
    });
    expect(first.details).toMatchObject({
      status: "queued",
      durability: "process",
      runStarted: false,
    });
    await putSession(targetSessionKey, {
      sessionId: "target-session",
      updatedAt: 2,
      communication: { receive: "never" },
    });
    expect(peekSystemEvents(targetSessionKey)).toHaveLength(1);
    const second = await tool.execute("notify-denied", {
      sessionKey: targetSessionKey,
      message: "unaccepted notice",
      mode: "notify",
    });
    expect(second.details).toMatchObject({ status: "forbidden" });
    const consumed = drainSystemEvents(targetSessionKey);
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toContain("accepted notice");
    expect(consumed[0]).not.toContain("unaccepted notice");
    expect(runSessionsSendA2AFlow).not.toHaveBeenCalled();
  });

  it.each(["send", "receive"] as const)(
    "rechecks an in-place default %s policy publication at final input admission",
    async (direction) => {
      const currentConfig: OpenClawConfig = {
        ...config,
        session: { ...config.session, communication: { send: "always", receive: "always" } },
      };
      setRuntimeConfigSnapshot(currentConfig);
      let admitted = false;
      const callGateway = mockGateway(async (request) => {
        if (request.method === "agent") {
          currentConfig.session!.communication![direction] = "never";
          setRuntimeConfigSnapshot(currentConfig);
          request.assertDispatchCurrent?.();
          request.sessionMutationCommitGuard?.();
          admitted = true;
          return { runId, status: "accepted" };
        }
        throw new Error(`Unexpected Gateway method: ${request.method}`);
      });
      const result = await execute(
        createTool({ config: currentConfig, callGateway }),
        "revoked-default",
      );
      expect(admitted).toBe(false);
      expect(result.details).toMatchObject({
        status: "error",
        error: expect.stringContaining("communication"),
      });
      expect(runSessionsSendA2AFlow).not.toHaveBeenCalled();
    },
  );

  it("releases steering custody only when the selected physical native attempt settles", async () => {
    const context = createContext([], () => config);
    const owner = createOperatorClient({ profileName: "steer-owner", scopes: ["operator.write"] });
    const source = captureGatewayDeviceRevocation(
      context,
      { deviceId: "steer-device", role: "operator" },
      () => true,
    );
    const accepted = createDeferredCore();
    const receipt = createDeferredCore();
    const sessionFile = "/synthetic/steering-custody/session.jsonl";
    let continuationSignal: AbortSignal | undefined;
    const capture = operatorContinuation.captureOperatorToolGatewayContinuationContext;
    const observeCapture = vi
      .spyOn(operatorContinuation, "captureOperatorToolGatewayContinuationContext")
      .mockImplementation((...args) =>
        capture(...args)?.then((captured) => {
          continuationSignal = captured.signal;
          return captured;
        }),
      );
    let queueReturned = false;
    const selected = createEmbeddedRunHandle({
      runId: "selected-steer-run",
      guarded: true,
      supportsTranscriptCommitWait: true,
      queueMessage: async (_text, options) => {
        options?.onQueueAccepted?.(true);
        accepted.resolve();
        await receipt.promise;
        queueReturned = true;
        options?.onQueueSettled?.();
      },
    });
    const sibling = createEmbeddedRunHandle({ runId: "sibling-steer-run" });
    const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
    const operations = [selected, sibling].map((handle, index) => {
      const operation = createReplyOperation({
        sessionKey: targetSessionKey,
        sessionId: "target-session",
        agentId: "main",
        resetTriggered: false,
        target: captureSessionTarget({
          storeScope: index === 0 ? storePath : `${storePath}.other`,
          sessionKey: targetSessionKey,
          agentId: "main",
          incarnation: "target-session",
        }),
      });
      if (index === 1) {
        attachActiveEmbeddedRun(
          "target-session",
          handle,
          targetSessionKey,
          undefined,
          "main",
          operation,
        );
      }
      return operation;
    });
    const captured = await operatorCapture.captureGatewayOperatorRunAuthority({
      client: owner,
      context,
      hasCurrentClientAuthority: source.isCurrent,
    });
    if (!captured) {
      throw new Error("Expected the authenticated steering owner");
    }
    const requesterOrigin = {
      sessionKey: requesterSessionKey,
      operatorProfileId: captured.authority.profileId,
    };
    const admission = prepareAgentRunAdmission({
      cfg: config,
      operatorAuthority: captured.authority,
      operationalRunInstance: createOperationalRunInstanceRef("selected-steer-run"),
      facts: {
        agentId: "main",
        runId: "selected-steer-run",
        ingress: { kind: "system", state: "present", boundary: "steering-custody-test" },
      },
    });
    const nativeReady = createDeferredCore();
    const native = (async () => {
      try {
        await withPreparedEmbeddedRunToolAuthority(
          {
            admittedRunContext: await admission.admit("embedded", "steering-custody-test"),
            replyOperation: operations[0],
          },
          {
            config,
            agentId: "main",
            sessionId: "target-session",
            sessionKey: targetSessionKey,
            runId: "selected-steer-run",
            sessionFile,
            workspaceDir: "/synthetic/steering-custody",
            provider: "openai",
            modelId: "gpt-test",
            requesterOrigin,
          },
          undefined,
          async (prepared) => {
            selected.toolAuthorityFingerprint = prepared.toolAuthorityFingerprint;
            attachActiveEmbeddedRun(
              "target-session",
              selected,
              targetSessionKey,
              sessionFile,
              "main",
              prepared.replyOperation,
            );
            nativeReady.resolve();
            await receipt.promise;
          },
        );
      } finally {
        admission.close();
        captured.release();
      }
    })();
    const gateway = vi
      .spyOn(inProcessGateway, "callAgentToolGatewayRequest")
      .mockImplementation(mockGateway(undefined, true));
    const mutation = vi
      .spyOn(sessionsSendDelivery, "callSessionsSendGateway")
      .mockImplementation(gateway);
    const pending = (async () => {
      await awaitGateBeforeSettlement(nativeReady.promise, native, "Native owner was not prepared");
      return await inOperatorScope(context, owner, source, () =>
        withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: requesterSessionKey,
            requesterOrigin,
            operatorAuthority:
              getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority,
            gatewayContextResolver: () => context,
            receiptAuthority: () => true,
          },
          () => execute(createTool(), "steer-physical-owner", { mode: "steer" }),
        ),
      );
    })();
    try {
      await awaitGateBeforeSettlement(
        accepted.promise,
        pending.then((result) => {
          throw new Error(
            `Steering ended before native acceptance: ${JSON.stringify(result.details)}`,
          );
        }),
        "Steering did not reach native acceptance",
      );
      expect(continuationSignal?.aborted).toBe(false);
      vi.useFakeTimers();
      detachActiveEmbeddedRun("target-session", sibling, targetSessionKey);
      await vi.advanceTimersByTimeAsync(0);
      expect(continuationSignal?.aborted).toBe(false);
      detachActiveEmbeddedRun("target-session", selected, targetSessionKey);
      await vi.advanceTimersByTimeAsync(0);
      expect(queueReturned).toBe(false);
      expect(continuationSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
      receipt.resolve();
      try {
        await Promise.all([pending, native]);
      } finally {
        for (const [index, handle] of [selected, sibling].entries()) {
          detachActiveEmbeddedRun("target-session", handle, targetSessionKey);
          operations[index]!.complete();
        }
        gateway.mockRestore();
        mutation.mockRestore();
        observeCapture.mockRestore();
        source.release();
      }
    }
  });

  it("queues an unsupported durable steer once without injecting volatile guidance", async () => {
    const context = createContext([], () => config);
    const caller = createSessionsSendTestCaller(requesterSessionKey);
    const queueMessage = vi.fn(async () => {});
    const handle = createEmbeddedRunHandle({
      guarded: true,
      queueMessage,
      supportsTranscriptCommitWait: false,
    });
    const close = await setSessionsSendTestActiveRun(
      "target-session",
      handle,
      targetSessionKey,
      requesterSessionKey,
      config,
    );
    const callGateway = mockGateway(async (request) => {
      if (request.method !== "agent") {
        throw new Error(`Unexpected Gateway method: ${request.method}`);
      }
      expect(
        readSessionSendDeliveryAdmission({
          agentId: "main",
          sessionKey: targetSessionKey,
          sessionId: "target-session",
          runId,
        })?.delivery,
      ).toMatchObject({
        source: { sessionKey: requesterSessionKey, sessionId: "requester-session" },
        target: { sessionKey: targetSessionKey, sessionId: "target-session" },
      });
      return { runId, status: "accepted" };
    });
    try {
      const result = await withGatewayToolCallerIdentity(
        {
          ...caller,
          gatewayContextResolver: () => context,
          receiptAuthority: () => true,
        },
        () => execute(createTool({ callGateway }), "durable-steer-fallback", { mode: "steer" }),
      );
      expect(result.details).toMatchObject({ status: "accepted", targetDisposition: "queued" });
      expect(queueMessage).not.toHaveBeenCalled();
      expect(callGateway.mock.calls.filter(([request]) => request.method === "agent")).toHaveLength(
        1,
      );
    } finally {
      await close();
    }
  });

  const callerKeys = [requesterSessionKey, "agent:main:telegram:direct:peer-1"];
  it.each(callerKeys)("retains accepted reply source (%s)", async (sourceKey) => {
    if (sourceKey !== requesterSessionKey) {
      await putSession(sourceKey, { sessionId: "key-only-requester", updatedAt: 1 });
      await putSession(targetSessionKey, {
        sessionId: "target-session",
        updatedAt: 1,
        spawnedBy: sourceKey,
      });
    }
    const context = createContext();
    // The admitted Gateway owns one current snapshot, not the factory's fresh {} per read.
    context.getRuntimeConfig = () => config;
    const owner = createOperatorClient({ profileName: "send-owner", scopes: ["operator.write"] });
    const source = captureGatewayDeviceRevocation(
      context,
      { deviceId: "send-device", role: "operator" },
      () => true,
    );
    const finish = createDeferredCore();
    let completion: SessionFollowupCompletion | undefined;
    const capturing = createDeferredCore();
    const allowCapture = createDeferredCore();
    let invocationStarted = false;
    let returned = false;
    const capture = operatorCapture.captureGatewayOperatorRunAuthority;
    const heldCapture = vi
      .spyOn(operatorCapture, "captureGatewayOperatorRunAuthority")
      .mockImplementation(async (...args) => {
        const captured = await capture(...args);
        if (invocationStarted) {
          capturing.resolve();
          await allowCapture.promise;
        }
        return captured;
      });
    vi.mocked(runSessionsSendA2AFlow).mockImplementationOnce(() => finish.promise);
    const callGateway = mockGateway(async (request) => {
      if (request.method === "agent") {
        const followup = readFollowupRequest(runId, targetSessionKey);
        if (followup) {
          completion = SessionFollowupCompletion.bind(followup);
          followup.completion = completion;
          completion.markAccepted(runId);
          await completion.settle(runId, {
            status: "ok",
            replyText: "Task complete",
            terminalReply: { disposition: "visible", text: "Task complete" },
          });
          completion.finishExecution(runId);
        }
        return { runId, status: "accepted" };
      }
      throw new Error(`Unexpected Gateway method: ${request.method}`);
    }, true);
    try {
      const pending = inOperatorScope(context, owner, source, async () => {
        const participants = createReplyTurnParticipants({
          operatorAuthority:
            getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority,
        });
        try {
          return await withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: sourceKey,
              personalToolParticipants: participants,
              gatewayContextResolver: () => context,
              receiptAuthority: () => true,
            },
            () => {
              invocationStarted = true;
              return execute(
                createTool({ agentSessionKey: sourceKey, callGateway }),
                "send-followup",
              );
            },
          );
        } finally {
          returned = true;
          participants.close();
        }
      });
      await awaitGateBeforeSettlement(
        capturing.promise,
        pending.then((result) => {
          throw new Error(
            `Send settled before reply-source capture: ${JSON.stringify(result.details)}`,
          );
        }),
        "Send completed without reaching reply-source capture",
      );
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
      expect(returned).toBe(false);
      expect(runSessionsSendA2AFlow).not.toHaveBeenCalled();
      allowCapture.resolve();
      const result = await pending;
      expect(result.details).toMatchObject({
        status: "accepted",
        delivery: { status: "pending" },
      });
      expect(runSessionsSendA2AFlow).toHaveBeenCalledOnce();
      expect(runSessionsSendA2AFlow).toHaveBeenCalledWith(
        expect.objectContaining({ requesterSessionKey: sourceKey, targetSessionKey }),
      );
      source.release();
      expect(readGatewayDeviceSourceAuthority(source.isCurrent)?.()).toBe(true);
    } finally {
      vi.useRealTimers();
      allowCapture.resolve();
      finish.resolve();
      completion?.close();
      heldCapture.mockRestore();
      source.release();
    }
  });

  it.each([
    { name: "numeric thread", sourceKey: requesterSessionKey, threadId: 42 },
    { name: "legacy DM", sourceKey: "agent:main:telegram:direct:peer-1", threadId: "42" },
    {
      name: "current source over fallback",
      sourceKey: requesterSessionKey,
      threadId: "42",
      fallback: true,
    },
    { name: "opaque self-send", sourceKey: "agent:main:direct:identity-linked-person", self: true },
  ])("preserves the admitted $name route after a later inbound turn", async (scenario) => {
    const { sourceKey } = scenario;
    const self = "self" in scenario;
    const targetKey = self ? sourceKey : targetSessionKey;
    const sourceId = self ? "self-session" : "requester-session";
    const targetId = self ? sourceId : "target-session";
    const originalRoute = { channel: "telegram", accountId: "default", to: "original-recipient" };
    const laterRoute = { channel: "telegram", accountId: "other", to: "later-recipient" };
    const entry = { sessionId: sourceId, updatedAt: 1, lifecycleRevision: "original-generation" };
    const settled = await trackActualReplyFlow();
    await putSession(sourceKey, {
      ...entry,
      ...(self ? { delivery: normalizeSessionDeliveryState({ context: originalRoute }) } : {}),
    });
    if (!self) {
      await putSession(targetKey, { sessionId: targetId, updatedAt: 1, spawnedBy: sourceKey });
    }
    let completion: Record<string, unknown> | undefined;
    const callGateway = vi.fn().mockImplementation(async (request: GatewayRequest) => {
      switch (request.method) {
        case "sessions.resolve":
          return { key: targetKey, agentId: "main" };
        case "sessions.list":
          return {
            sessions: [
              {
                key: targetKey,
                agentId: "main",
                ...(self ? { deliveryContext: laterRoute } : { kind: "direct" }),
              },
            ],
          };
        case "agent.wait":
          return completeRun(request, targetKey, targetId);
        case "agent":
          if (!isRecord(request.params)) {
            throw new Error("Expected agent request parameters");
          }
          if (request.params.sessionKey === targetKey) {
            await putSession(sourceKey, {
              ...entry,
              updatedAt: 2,
              delivery: normalizeSessionDeliveryState({ context: laterRoute }),
            });
            return { runId };
          }
          completion = request.params;
          return { runId: "completion-run" };
        case "send":
          if (self) {
            return { messageId: "final-reply" };
          }
      }
      throw new Error(`Unexpected Gateway method: ${request.method}`);
    });
    const restoreGateway = interceptGateway(callGateway);
    // Cross-session routing has a transport fixture, not a native custody receipt.
    const prepareFollowup = self
      ? undefined
      : vi.spyOn(sessionsSendFollowup, "prepareSessionsSendFollowup").mockResolvedValue(undefined);
    try {
      const tool = createOpenClawTools({
        agentSessionKey: sourceKey,
        sessionId: sourceId,
        agentChannel: originalRoute.channel,
        agentAccountId: originalRoute.accountId,
        ...(self
          ? { currentMessagingTarget: originalRoute.to }
          : {
              agentTo: originalRoute.to,
              agentThreadId: scenario.threadId,
            }),
        ...("fallback" in scenario
          ? {
              agentTo: "stale-recipient",
              agentThreadId: 99,
              currentMessagingTarget: originalRoute.to,
              currentChannelId: "native-channel-id",
              currentThreadTs: "42",
            }
          : {}),
        config,
        disableMessageTool: true,
        disablePluginTools: true,
        wrapBeforeToolCallHook: false,
      }).find((candidate) => candidate.name === "sessions_send");
      expect(tool).toBeDefined();
      const result = await execute(tool!, self ? "self-followup" : "send-routed-task", {
        sessionKey: targetKey,
      });
      expect(result.details).toMatchObject({ status: "accepted", delivery: { status: "pending" } });
      await settled.promise;
      if (!self) {
        expect(completion).toMatchObject({
          sessionKey: sourceKey,
          expectedExistingSessionId: sourceId,
          expectedExistingSessionLifecycleRevision: entry.lifecycleRevision,
          ...originalRoute,
          threadId: "42",
          deliver: false,
          sourceReplyDeliveryMode: "message_tool_only",
        });
      } else {
        const requests = callGateway.mock.calls.map(([request]) => request);
        expect.soft(requests.filter((request) => request.method === "agent")).toEqual([
          expect.objectContaining({
            params: expect.objectContaining({
              ...originalRoute,
              sessionKey: sourceKey,
              deliver: false,
              sourceReplyDeliveryMode: "message_tool_only",
              inputProvenance: expect.objectContaining({
                kind: "inter_session",
                sourceSessionKey: sourceKey,
              }),
            }),
          }),
        ]);
        expect.soft(requests.filter((request) => request.method === "send")).toEqual([
          expect.objectContaining({
            params: expect.objectContaining({ ...originalRoute, message: "Task complete" }),
          }),
        ]);
        const sendParams = requests.find((request) => request.method === "send")?.params;
        expect(readInProcessSessionDeliveryGeneration(sendParams)).toMatchObject({
          agentId: "main",
          sessionKey: sourceKey,
          sessionId: sourceId,
          lifecycleRevision: entry.lifecycleRevision,
        });
        expect(sendParams).toHaveProperty("idempotencyKey", `sessions-send:${runId}`);
        expect(sendParams).not.toHaveProperty("sessionGeneration");
      }
    } finally {
      prepareFollowup?.mockRestore();
      restoreGateway();
    }
  });

  it.each([
    { admission: "rejected", timeoutSeconds: 1 },
    { admission: "pending", timeoutSeconds: 1 },
  ] as const)(
    "does not install a watch or start A2A when admission is $admission (wait $timeoutSeconds)",
    async ({ admission, timeoutSeconds }) => {
      const callGateway = mockGateway(async (request) => {
        if (request.method === "agent") {
          if (admission === "rejected") {
            throw new Error("Task admission failed before dispatch");
          }
          return { runId, status: "in_flight", admissionPending: true };
        }
        if (request.method === "agent.wait") {
          return { status: "timeout" };
        }
        throw new Error(`Unexpected Gateway method: ${request.method}`);
      }, true);
      const tool = createTool({ callGateway });

      const result = await execute(tool, "send-followup", { watch: true, timeoutSeconds });

      const requests = callGateway.mock.calls.map(([request]) => request);
      expect.soft(result.details).toMatchObject({
        status: "error",
        runId,
        sessionKey: targetSessionKey,
        error:
          admission === "rejected"
            ? "Task admission failed before dispatch"
            : expect.stringMatching(/admission|unconfirmed|pending/i),
      });
      if (admission === "pending") {
        expect.soft(result.details).toMatchObject({
          sentBeforeError: true,
          error: expect.stringMatching(/(?:inspect|check).*before.*retry/i),
        });
      } else {
        expect.soft(result.details).not.toHaveProperty("sentBeforeError");
      }
      expect.soft(registerWatch).not.toHaveBeenCalled();
      expect.soft(runSessionsSendA2AFlow).not.toHaveBeenCalled();
      expect.soft(requests.filter((request) => request.method === "agent")).toHaveLength(1);
      expect.soft(requests.some((request) => request.method === "agent.wait")).toBe(false);
    },
  );
});
