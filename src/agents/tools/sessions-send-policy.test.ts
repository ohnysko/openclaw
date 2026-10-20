import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionToolsVisibility } from "../../plugin-sdk/session-visibility.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import * as sessionStateEvents from "../../sessions/session-state-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
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

const requesterKey = "agent:main:dashboard:requester";
const subagentRequesterKey = "agent:main:subagent:requester";
const workerKey = "agent:worker:main";
const workerSessionId = "91ee481c-f60c-42bc-a238-2fb0306e4f55";
const nativeChildKey = "agent:worker:subagent:owned-child";
const acpChildKey = "agent:worker:acp:owned-child";
const replyText = "Result from the dispatched run only";
const runId = "send-policy-run";
function ownedChild(key: string, name: string) {
  return {
    key,
    agentId: "worker",
    sessionId: `${name}-session`,
    label: name,
    spawnedBy: requesterKey,
  };
}
const sessions = [
  { key: requesterKey, agentId: "main", sessionId: "requester-session" },
  { key: subagentRequesterKey, agentId: "main", sessionId: "subagent-requester-session" },
  { key: workerKey, agentId: "worker", sessionId: workerSessionId, label: "delegation-worker" },
  { key: "global", agentId: "worker", sessionId: "raw-worker-session", label: "raw-worker" },
  { key: "agent:stranger:main", agentId: "stranger", sessionId: "stranger-session" },
  ownedChild(nativeChildKey, "native-child"),
  ownedChild(acpChildKey, "acp-child"),
];

function configFor(
  options: {
    send?: string[];
    visibility?: SessionToolsVisibility;
    global?: NonNullable<OpenClawConfig["tools"]>["agentToAgent"];
  } = {},
): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      defaults: { sandbox: { sessionToolsVisibility: "spawned" } },
      entries: {
        main: options.send === undefined ? {} : { tools: { agentToAgent: { send: options.send } } },
        worker: { tools: { agentToAgent: { send: [] } } },
        stranger: {},
      },
    },
    session: { mainKey: "main", scope: "per-sender" },
    tools: {
      sessions: { visibility: options.visibility ?? "self" },
      agentToAgent: options.global ?? { enabled: true, allow: ["main", "worker", "stranger"] },
    },
  };
}

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
function mockReplyHistory(preview: string, messages: ReturnType<typeof assistantReply>[]) {
  replyPreview = preview;
  historyMessages = messages;
}

function gatewayMethods() {
  return callGateway.mock.calls.map(([request]) => request.method);
}

function send(
  config: OpenClawConfig,
  target: {
    agentId?: string;
    sessionKey?: string;
    label?: string;
    watch?: boolean;
    message?: string;
  } = { agentId: "worker" },
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
  expect(gatewayMethods()).not.toContain("agent");
  expect(gatewayMethods()).not.toContain("agent.wait");
}
function gatewayParams(method: string) {
  return callGateway.mock.calls.find(([request]) => request.method === method)?.[0].params;
}
function expectOk(result: Awaited<ReturnType<typeof send>>, extra = {}) {
  expect(result.details).toMatchObject({ status: "ok", reply: replyText, ...extra });
}

describe("sessions_send directed policy at the tool boundary", () => {
  let state: OpenClawTestState;
  let originalRegistry: ReturnType<typeof captureActivePluginRegistrySnapshot>;

  beforeAll(async () => {
    originalRegistry = captureActivePluginRegistrySnapshot();
    state = await createOpenClawTestState({ scenario: "minimal" });
    setRuntimeConfigSnapshot(configFor());
    setActivePluginRegistry(createSessionConversationTestRegistry());
    for (const { key, agentId, sessionId, ...entry } of sessions) {
      await replaceSessionEntry(
        { agentId, sessionKey: key },
        { sessionId, updatedAt: 1, ...entry },
      );
      await appendTranscriptMessage(
        { agentId, sessionKey: key, sessionId },
        {
          message: {
            ...assistantReply(replyText),
            phase: "final_answer",
            stopReason: "stop",
          },
        },
      );
    }
  });

  beforeEach(() => {
    callGateway.mockReset();
    replyPreview = replyText;
    historyMessages = undefined;
    callGateway.mockImplementation(
      async (request: Parameters<AgentToolGatewayRequestCaller>[0]) => {
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
      },
    );
  });

  it.each([
    ["agent ID", { agentId: "worker" }, configFor({ send: [] }), true],
    [
      "global disable",
      { sessionKey: workerKey },
      configFor({ send: ["worker"], global: { enabled: false } }),
      true,
    ],
    [
      "unrelated reload",
      { sessionKey: workerKey },
      { ...configFor({ send: ["worker"] }), gateway: { port: 19870 } },
      false,
    ],
  ] as const)("rechecks current policy after resolving %s", async (_name, target, next, denied) => {
    const resolving = createDeferredCore();
    const resume = createDeferredCore();
    const resolve = callGateway.getMockImplementation()!;
    callGateway.mockImplementation(
      async (request: Parameters<AgentToolGatewayRequestCaller>[0]) => {
        if (request.method === "sessions.resolve") {
          resolving.resolve();
          await resume.promise;
        }
        return await resolve(request);
      },
    );
    const pending = send(configFor({ send: ["worker"] }), target);
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    restoreActivePluginRegistrySnapshot(originalRegistry);
    await state.cleanup();
  });

  it("prefers sessionKey over a redundant label without trimming the message", async () => {
    const result = await send(configFor({ send: ["worker"] }), {
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
    const result = await send(configFor({ send: ["worker"] }), {
      sessionKey: workerSessionId,
    });

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
    { name: "long reply", full: `${"a".repeat(5_000)}TAIL`, preview: `${"a".repeat(4_095)}…` },
    {
      name: "whitespace-shortened preview",
      full: `${"a".repeat(4_000)}${" ".repeat(100)}TAIL`,
      preview: `${"a".repeat(4_000)}…`,
    },
    { name: "literal ellipsis", full: "Still thinking…", preview: "Still thinking…" },
    {
      name: "tool-budget overflow",
      full: `${"a".repeat(20_000)}TAIL`,
      preview: `${"a".repeat(4_095)}…`,
    },
  ])(
    "returns the accepted run's full $name with explicit tool-budget truncation",
    async ({ full, preview }) => {
      mockReplyHistory(preview, [
        assistantReply(full),
        assistantReply("Unrelated answer", "later-run"),
      ]);

      const result = await send(configFor({ send: ["worker"] }));
      expect(result.details).toMatchObject({ status: "ok", reply: full });
      expect(result.details).not.toHaveProperty("replyTruncated");
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
      if (full.length > 16_000) {
        expect(text).toMatch(/\d+ more characters truncated/);
        expect(text).toContain("ask the target session for the missing section or a file");
        expect(text).toContain("do not repeat the original task");
      } else {
        expect(projected.content).toEqual(result.content);
      }
    },
  );

  it("reports a truncated preview when the accepted run's full reply is unavailable", async () => {
    const preview = `${"a".repeat(4_095)}…`;
    mockReplyHistory(preview, [assistantReply("Unrelated answer", "other-run")]);
    const result = await send(configFor({ send: ["worker"] }));
    expect(result.details).toMatchObject({
      status: "ok",
      reply: preview,
      replyTruncated: true,
      note: expect.stringContaining("missing section or a file"),
    });
    expect(Value.Check(SessionsSendOutputSchema, result.details)).toBe(true);
  });

  it.each([
    [
      "unlisted key",
      { send: ["worker"], visibility: "all" },
      { sessionKey: "agent:stranger:main" },
      "tools.agentToAgent.send",
    ],
    ["omitted outbound policy", {}, { agentId: "worker" }, undefined],
    [
      "requester excluded",
      { send: ["worker"], global: { enabled: true, allow: ["worker"] } },
      { agentId: "worker" },
      "tools.agentToAgent.allow",
    ],
    [
      "target excluded",
      { send: ["worker"], global: { enabled: true, allow: ["main"] } },
      { agentId: "worker" },
      "tools.agentToAgent.allow",
    ],
  ] satisfies [
    string,
    Parameters<typeof configFor>[0],
    Parameters<typeof send>[1],
    string | undefined,
  ][])("denies %s before dispatch", async (_name, options, target, error) => {
    const config = configFor(options);
    const result = await send(config, target);
    expect(result.details).toMatchObject({ status: "forbidden" });
    if (error) {
      expect(result.details).toMatchObject({ error: expect.stringContaining(error) });
    }
    expectNoDispatch();
  });

  it.each(["send-only", "readable", "raw-target"] as const)(
    "reports the requested watch for a %s target",
    async (access) => {
      const watch = vi
        .spyOn(sessionStateEvents, "registerSessionStateWatch")
        .mockResolvedValue(true);
      const config = configFor({
        send: ["worker"],
        visibility: access === "send-only" ? "self" : "all",
      });
      const result = await send(config, {
        agentId: "worker",
        watch: true,
        ...(access === "raw-target" ? { label: "raw-worker" } : {}),
      });
      if (access === "send-only") {
        expect(result.details).toMatchObject({ status: "forbidden" });
        expectNoDispatch();
        expect(watch).not.toHaveBeenCalled();
        expectOk(await send(config));
        expect(watch).not.toHaveBeenCalled();
      } else if (access === "readable") {
        expectOk(result, { watched: true });
        expect(watch).toHaveBeenCalledOnce();
      } else {
        expectOk(result, {
          watched: false,
          watchError: expect.stringContaining("agent-qualified"),
        });
        expect(watch).not.toHaveBeenCalled();
        expect(gatewayMethods()).toContain("agent");
        expect(gatewayMethods()).toContain("agent.wait");
      }
    },
  );

  it.each([requesterKey, subagentRequesterKey])(
    "keeps sandbox spawned-only for requester %s",
    async (agentSessionKey) => {
      const config = configFor({ send: ["worker"], visibility: "all" });
      const denied = await send(
        config,
        { sessionKey: workerKey },
        { agentSessionKey, sandboxed: true },
      );
      expect(denied.details).toMatchObject({ status: "forbidden" });
      expectNoDispatch();

      const allowed = await send(config, { sessionKey: workerKey }, { agentSessionKey });
      expectOk(allowed);
    },
  );

  it.each([false, true])("retains owned-child access (interrupted=%s)", async (interrupted) => {
    const target = { agentId: "worker", sessionKey: nativeChildKey };
    const entry = { sessionId: "native-child-session", updatedAt: 1, spawnedBy: requesterKey };
    if (interrupted) {
      await replaceSessionEntry(target, { ...entry, status: "interrupted" });
    }
    try {
      const result = await send(
        configFor({ send: [], visibility: "tree" }),
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
      if (interrupted) {
        await replaceSessionEntry(target, entry);
      }
    }
  });

  it("does not turn a send grant into list, history, search, or status access", async () => {
    const config = configFor({ send: ["worker"] });
    setRuntimeConfigSnapshot(config);
    const options = { config, agentSessionKey: requesterKey, callGateway };
    const listed = await createSessionsListTool(options).execute("list", {});
    expect(listed.details).toMatchObject({ count: 1, sessions: [{ key: requesterKey }] });

    const history = await createSessionsHistoryTool(options).execute("history", {
      sessionKey: workerKey,
    });
    expect(history.details).toMatchObject({ status: "forbidden" });
    const search = await createSessionsSearchTool(options).execute("search", {
      sessionKey: workerKey,
      query: "private",
    });
    expect(search.details).toMatchObject({ status: "forbidden" });
    const statusGateway = vi
      .spyOn(inProcessGateway, "callAgentToolGatewayRequest")
      .mockImplementation(callGateway);
    try {
      await expect(
        createSessionStatusTool({ config, agentSessionKey: requesterKey }).execute("status", {
          sessionKey: workerKey,
        }),
      ).rejects.toThrow("visibility");
    } finally {
      statusGateway.mockRestore();
    }
    expectNoDispatch();
    expect(gatewayMethods()).not.toContain("sessions.search");
    expect(gatewayMethods()).not.toContain("chat.history");
  });
});
