import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionToolsVisibility } from "../../plugin-sdk/session-visibility.js";
import * as plugins from "../../plugins/runtime.js";
import * as sessionStateEvents from "../../sessions/session-state-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as testState from "../../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { truncateToolResultMessage } from "../embedded-agent-runner/tool-result-truncation.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import * as inProcessGateway from "./in-process-gateway.js";
import { createSessionStatusTool } from "./session-status-tool.js";
import { createSessionsHistoryTool } from "./sessions-history-tool.js";
import { createSessionsListTool } from "./sessions-list-tool.js";
import { createSessionsSearchTool } from "./sessions-search-tool.js";
import { createSessionsSendTool } from "./sessions-send-tool.js";
import { SessionsSendOutputSchema } from "./sessions-send-tool.schema.js";

type GatewayRequest = Parameters<AgentToolGatewayRequestCaller>[0];
const requesterKey = "agent:main:dashboard:requester";
const subagentRequesterKey = "agent:main:subagent:requester";
const workerKey = "agent:worker:main";
const workerSessionId = "91ee481c-f60c-42bc-a238-2fb0306e4f55";
const nativeChildKey = "agent:worker:subagent:owned-child";
const workerTarget = { agentId: "worker" };
const workerSession = { sessionKey: workerKey };
const replyText = "Result from the dispatched run only";
const runId = "send-policy-run";
const sessions = [
  { key: requesterKey, agentId: "main", sessionId: "requester-session" },
  { key: subagentRequesterKey, agentId: "main", sessionId: "subagent-requester-session" },
  { key: workerKey, agentId: "worker", sessionId: workerSessionId, label: "delegation-worker" },
  { key: "global", agentId: "worker", sessionId: "raw-worker-session", label: "raw-worker" },
  { key: "agent:stranger:main", agentId: "stranger", sessionId: "stranger-session" },
  {
    key: nativeChildKey,
    agentId: "worker",
    sessionId: "native-child-session",
    label: "native-child",
    spawnedBy: requesterKey,
  },
];

function configFor(
  outbound?: string[],
  visibility: SessionToolsVisibility = "self",
  global: NonNullable<OpenClawConfig["tools"]>["agentToAgent"] = {
    enabled: true,
    allow: ["main", "worker", "stranger"],
  },
): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      defaults: { sandbox: { sessionToolsVisibility: "spawned" } },
      entries: {
        main: outbound === undefined ? {} : { tools: { agentToAgent: { send: outbound } } },
        worker: { tools: { agentToAgent: { send: [] } } },
        stranger: {},
      },
    },
    session: { mainKey: "main", scope: "per-sender" },
    tools: {
      sessions: { visibility },
      agentToAgent: global,
    },
  };
}
const allowOnly = (...allow: string[]) => configFor(["worker"], "self", { enabled: true, allow });

const callGateway = vi.fn();
let replyPreview = replyText;
let historyMessages: ReturnType<typeof assistantReply>[] | undefined;

function assistantReply(text: string, id = runId) {
  return {
    role: "assistant" as const,
    __openclaw: { runId: id },
    content: [{ type: "text" as const, text }],
  };
}
function gatewayMethods() {
  return callGateway.mock.calls.map(([request]) => request.method);
}

function send(
  config = configFor(["worker"]),
  target: {
    agentId?: string;
    sessionKey?: string;
    label?: string;
    watch?: boolean;
    message?: string;
  } = workerTarget,
  options: { agentSessionKey?: string; sandboxed?: boolean } = {},
) {
  setRuntimeConfigSnapshot(config);
  return createSessionsSendTool({
    config,
    agentSessionKey: requesterKey,
    callGateway,
    idempotencyKey: runId,
    ...options,
  }).execute("send-policy", {
    message: "Please handle this task",
    timeoutSeconds: 1,
    ...target,
  });
}

function expectNoDispatch() {
  expect(
    gatewayMethods().filter((method) => method === "agent" || method === "agent.wait"),
  ).toEqual([]);
}
function gatewayParams(method: string) {
  return callGateway.mock.calls.find(([request]) => request.method === method)?.[0].params;
}
function expectOk(result: Awaited<ReturnType<typeof send>>, extra = {}) {
  expect(result.details).toMatchObject({ status: "ok", reply: replyText, ...extra });
}
function expectDenied(result: Awaited<ReturnType<typeof send>>, error?: string) {
  expect(result.details).toMatchObject({
    status: "forbidden",
    ...(error ? { error: expect.stringContaining(error) } : {}),
  });
  expectNoDispatch();
}

describe("sessions_send directed policy at the tool boundary", () => {
  let state: testState.OpenClawTestState;
  let originalRegistry: ReturnType<typeof plugins.captureActivePluginRegistrySnapshot>;

  beforeAll(async () => {
    originalRegistry = plugins.captureActivePluginRegistrySnapshot();
    state = await testState.createOpenClawTestState({ scenario: "minimal" });
    setRuntimeConfigSnapshot(configFor());
    plugins.setActivePluginRegistry(createSessionConversationTestRegistry());
    for (const { key, agentId, sessionId, ...entry } of sessions) {
      const target = { agentId, sessionKey: key };
      await replaceSessionEntry(target, { sessionId, updatedAt: 1, ...entry });
    }
  });

  beforeEach(() => {
    callGateway.mockReset();
    replyPreview = replyText;
    historyMessages = undefined;
    callGateway.mockImplementation(async (request: GatewayRequest) => {
      const params = isRecord(request.params) ? request.params : {};
      if (request.method === "sessions.resolve") {
        const row = sessions.find(
          (session) =>
            (params.key === session.key ||
              params.sessionId === session.sessionId ||
              (params.label !== undefined && params.label === session.label)) &&
            (!params.agentId || params.agentId === session.agentId) &&
            (!params.spawnedBy || params.spawnedBy === session.spawnedBy),
        );
        if (row) {
          return { key: row.key, agentId: row.agentId };
        }
        if (params.allowMissing) {
          return {};
        }
        throw new Error("No session found");
      }
      if (request.method === "sessions.list") {
        return {
          sessions: sessions
            .filter((session) => !params.spawnedBy || params.spawnedBy === session.spawnedBy)
            .map((session) => Object.assign({ classification: "main" }, session)),
        };
      }
      if (request.method === "agent") {
        return { runId, status: "accepted" };
      }
      if (request.method === "agent.wait") {
        expect(params.runId).toBe(runId);
        return {
          runId,
          status: "ok",
          terminalReply: { disposition: "visible", text: replyPreview },
        };
      }
      if (request.method === "chat.history" && historyMessages) {
        return { messages: historyMessages };
      }
      throw new Error("Unexpected Gateway method: " + request.method);
    });
  });

  it.each([
    ["agent ID", workerTarget, configFor([]), true],
    ["global disable", workerSession, configFor(["worker"], "self", { enabled: false }), true],
    [
      "unrelated reload",
      workerSession,
      { ...configFor(["worker"]), gateway: { port: 19870 } },
      false,
    ],
  ] as const)("rechecks current policy after resolving %s", async (_name, target, next, denied) => {
    const resolving = createDeferredCore();
    const resume = createDeferredCore();
    const resolve = callGateway.getMockImplementation()!;
    callGateway.mockImplementation(async (request: GatewayRequest) => {
      if (request.method === "sessions.resolve") {
        resolving.resolve();
        await resume.promise;
      }
      return await resolve(request);
    });
    const pending = send(undefined, target);
    try {
      await resolving.promise;
      setRuntimeConfigSnapshot(next);
      resume.resolve();
      expect((await pending).details).toMatchObject({ status: denied ? "forbidden" : "ok" });
      if (denied) {
        expectNoDispatch();
      } else {
        expect(gatewayMethods()).toContain("agent");
      }
    } finally {
      resume.resolve();
      await Promise.allSettled([pending]);
    }
  });

  afterEach(vi.restoreAllMocks);

  afterAll(async () => {
    plugins.restoreActivePluginRegistrySnapshot(originalRegistry);
    await state.cleanup();
  });

  it("prefers sessionKey over a redundant label without trimming the message", async () => {
    const result = await send(undefined, {
      sessionKey: workerKey,
      label: "stale-label",
      message: "    indented body",
    });

    expect(result.details).toMatchObject({ status: "ok", sessionKey: workerKey });
    expect(gatewayParams("agent")).toMatchObject({
      sessionKey: workerKey,
      message: expect.stringMatching(/\n {4}indented body$/u),
    });
    expect(callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.resolve",
        params: expect.objectContaining({ label: "stale-label" }),
      }),
    );
  });

  it("sends by session ID under self visibility and returns only that run's reply", async () => {
    const result = await send(undefined, { sessionKey: workerSessionId });

    expectOk(result, { sessionKey: workerKey, runId });
    const dispatches = callGateway.mock.calls.filter(([request]) => request.method === "agent");
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.[0].params).toMatchObject({
      agentId: "worker",
      sessionKey: workerKey,
      inputProvenance: { sourceSessionKey: requesterKey, sourceTool: "sessions_send" },
    });
    expect(gatewayMethods().filter((method) => method === "agent.wait")).toHaveLength(1);
  });

  it.each([
    ["long reply", `${"a".repeat(5_000)}TAIL`, `${"a".repeat(4_095)}…`],
    [
      "whitespace-shortened preview",
      `${"a".repeat(4_000)}${" ".repeat(100)}TAIL`,
      `${"a".repeat(4_000)}…`,
    ],
    ["literal ellipsis", "Still thinking…", "Still thinking…"],
    ["tool-budget overflow", `${"a".repeat(20_000)}TAIL`, `${"a".repeat(4_095)}…`],
    ["unavailable full reply", undefined, `${"a".repeat(4_095)}…`],
  ] satisfies [string, string | undefined, string][])(
    "returns the accepted run's %s with explicit tool-budget truncation",
    async (_name, full, preview) => {
      replyPreview = preview;
      historyMessages = [
        ...(full === undefined ? [] : [assistantReply(full)]),
        assistantReply("Unrelated answer", "later-run"),
      ];
      const result = await send();
      expect(result.details).toMatchObject({ status: "ok", reply: full ?? preview });
      if (full === undefined) {
        expect(result.details).toMatchObject({
          replyTruncated: true,
          note: expect.stringContaining("missing section or a file"),
        });
      } else {
        expect(result.details).not.toHaveProperty("replyTruncated");
      }
      expect(Value.Check(SessionsSendOutputSchema, result.details)).toBe(true);

      const projected = truncateToolResultMessage(
        {
          ...result,
          role: "toolResult",
          toolName: "sessions_send",
          toolCallId: "send-policy",
          isError: false,
          timestamp: 1,
        },
        16_000,
      );
      const text = projected.content.find((block) => block.type === "text")?.text;
      if (full && full.length > 16_000) {
        expect(text).toMatch(/\d+ more characters truncated/);
        expect(text).toContain("ask the target session for the missing section or a file");
        expect(text).toContain("do not repeat the original task");
      } else {
        expect(projected.content).toEqual(result.content);
      }
    },
  );

  it.each([
    ["unlisted key", configFor(["worker"], "all"), { sessionKey: "agent:stranger:main" }, "send"],
    ["omitted outbound policy", configFor(), workerTarget, undefined],
    ["requester excluded", allowOnly("worker"), workerTarget, "allow"],
    ["target excluded", allowOnly("main"), workerTarget, "allow"],
  ] satisfies [string, OpenClawConfig, Parameters<typeof send>[1], string | undefined][])(
    "denies %s before dispatch",
    async (_name, config, target, error) => {
      expectDenied(await send(config, target), error && `tools.agentToAgent.${error}`);
    },
  );

  it.each(["send-only", "readable", "raw-target"] as const)(
    "reports the requested watch for a %s target",
    async (access) => {
      const watch = vi.spyOn(sessionStateEvents, "registerSessionStateWatch");
      if (access !== "raw-target") {
        watch.mockResolvedValue(true);
      }
      const config = configFor(["worker"], access === "send-only" ? "self" : "all");
      const result = await send(config, {
        agentId: "worker",
        watch: true,
        ...(access === "raw-target" ? { label: "raw-worker" } : {}),
      });
      expect(watch).toHaveBeenCalledTimes(access === "readable" ? 1 : 0);
      if (access === "send-only") {
        expectDenied(result);
        expectOk(await send(config));
        expect(watch).not.toHaveBeenCalled();
      } else {
        expectOk(
          result,
          access === "readable"
            ? { watched: true }
            : {
                watched: false,
                watchError: expect.stringContaining("agent-qualified"),
              },
        );
        expect(gatewayMethods()).toEqual(expect.arrayContaining(["agent", "agent.wait"]));
      }
    },
  );

  it.each([requesterKey, subagentRequesterKey])(
    "keeps sandbox spawned-only for requester %s",
    async (agentSessionKey) => {
      const config = configFor(["worker"], "all");
      expectDenied(await send(config, workerSession, { agentSessionKey, sandboxed: true }));
      expectOk(await send(config, workerSession, { agentSessionKey }));
    },
  );

  it.each([false, true])("retains owned-child access (interrupted=%s)", async (interrupted) => {
    const target = { agentId: "worker", sessionKey: nativeChildKey };
    const entry = { sessionId: "native-child-session", updatedAt: 1, spawnedBy: requesterKey };
    await replaceSessionEntry(target, {
      ...entry,
      ...(interrupted ? { status: "interrupted" as const } : {}),
    });
    try {
      const result = await send(
        configFor([], "tree"),
        interrupted ? { sessionKey: nativeChildKey } : { label: "native-child", agentId: "worker" },
      );
      expectOk(result, { sessionKey: nativeChildKey });
      const prompt = gatewayParams("agent")?.message;
      if (interrupted) {
        for (const text of [
          "Please handle this task",
          "interrupted by a gateway restart",
          "marked interrupted, missing, or aborted",
          "unknown outcome",
          "not proof of tool failure",
        ]) {
          expect(prompt).toContain(text);
        }
      } else {
        expect(prompt).not.toContain("gateway restart");
      }
    } finally {
      await replaceSessionEntry(target, entry);
    }
  });

  it("does not turn a send grant into list, history, search, or status access", async () => {
    const config = configFor(["worker"]);
    setRuntimeConfigSnapshot(config);
    const options = { config, agentSessionKey: requesterKey, callGateway };
    const listed = await createSessionsListTool(options).execute("list", {});
    expect(listed.details).toMatchObject({ count: 1, sessions: [{ key: requesterKey }] });

    expectDenied(await createSessionsHistoryTool(options).execute("history", workerSession));
    expectDenied(
      await createSessionsSearchTool(options).execute("search", {
        ...workerSession,
        query: "private",
      }),
    );
    vi.spyOn(inProcessGateway, "callAgentToolGatewayRequest").mockImplementation(callGateway);
    await expect(createSessionStatusTool(options).execute("status", workerSession)).rejects.toThrow(
      "visibility",
    );
    expectNoDispatch();
    expect(gatewayMethods()).not.toContain("sessions.search");
    expect(gatewayMethods()).not.toContain("chat.history");
  });
});
