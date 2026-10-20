import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { mergeAcceptedSessionSpawnsForRun } from "../accepted-session-spawn.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import { expectRegisteredSubagentRun } from "../subagents/spawn/subagent-spawn.test-helpers.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import type { createSessionsSpawnTool as SpawnToolFactory } from "./sessions-spawn-tool.js";

/** Completion receipts share the parent suite's tool graph and reset lifecycle. */
export function registerSessionsSpawnCompletionTests({
  createTool: createSessionsSpawnTool,
  registerAcpBackendForTest,
  mocks: hoisted,
  mockCallArg,
}: {
  createTool: typeof SpawnToolFactory;
  registerAcpBackendForTest: () => void;
  mocks: { spawnSubagentDirectMock: Mock; spawnAcpDirectMock: Mock };
  mockCallArg: (
    mock: unknown,
    callIndex: number,
    argIndex: number,
    label: string,
  ) => Record<string, unknown>;
}) {
  function expectCompletion(mock: Mock, label: string) {
    const params = mockCallArg(mock, 0, 0, label);
    expect(params.expectsCompletionMessage).toBe(false);
    expect(params.completionTarget).toBeUndefined();
  }

  it("declares completion policy and forwards quiet to hidden, ACP, and visible spawns", async () => {
    const input = { expectsCompletionMessage: false };
    const expected = false;
    registerAcpBackendForTest();
    await withTestDir({ prefix: "openclaw-spawn-completion-" }, async (dir) => {
      const callGateway = vi.fn(async () => ({
        key: "agent:main:dashboard:child",
        sessionId: "visible-child",
        runStarted: true,
        runId: "run-visible",
      }));
      const registerRun = vi.fn();
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        config: { session: { store: path.join(dir, "sessions.json") } },
        callGateway: callGateway as never,
        registerRun,
        countActiveRuns: () => 0,
      });
      expect(tool.parameters).toMatchObject({
        properties: { expectsCompletionMessage: { type: "boolean" } },
      });

      await tool.execute("hidden", { task: "hidden child", ...input });
      expectCompletion(hoisted.spawnSubagentDirectMock, "spawnSubagentDirect");

      await tool.execute("acp", { task: "ACP child", runtime: "acp", ...input });
      expectCompletion(hoisted.spawnAcpDirectMock, "spawnAcpDirect");

      const visible = await tool.execute("visible", {
        task: "visible child",
        visible: true,
        ...input,
      });
      expect(visible.details).toMatchObject({ expectsCompletionMessage: expected });
      expectRegisteredSubagentRun(registerRun, { expectsCompletionMessage: expected });
      expect(mockCallArg(registerRun, 0, 0, "registerRun").completionTarget).toBeUndefined();
    });
  });

  it("retains committed child acceptance when the caller loses its result", async () => {
    hoisted.spawnSubagentDirectMock.mockResolvedValueOnce({
      status: "accepted",
      context: "isolated",
      childSessionKey: "agent:main:subagent:child",
      runId: "child-run",
      expectsCompletionMessage: true,
    });
    const instance = createOperationalRunInstanceRef("spawn-parent");
    await expect(
      withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey: "agent:main:main", operationalRunInstance: instance },
        async () => {
          const tool = createSessionsSpawnTool({ agentSessionKey: "agent:main:main" });
          await tool.execute("spawn-before-failure", { task: "finish the work" });
          throw new Error("provider transport failed after acceptance");
        },
      ),
    ).rejects.toThrow("provider transport failed");
    expect(mergeAcceptedSessionSpawnsForRun(instance)).toEqual([
      {
        runId: "child-run",
        childSessionKey: "agent:main:subagent:child",
        expectsCompletionMessage: true,
      },
    ]);
    expect(
      mergeAcceptedSessionSpawnsForRun(createOperationalRunInstanceRef("spawn-parent")),
    ).toEqual([]);
  });
}
