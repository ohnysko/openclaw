import { Value } from "typebox/value";
import { expect, it, vi, type Mock } from "vitest";
import { finalizeAgentToolAvailability } from "../agent-tool-availability.js";
import { createAgentsWaitTool } from "./agents-wait-tool.js";
import type { InProcessGatewayCaller } from "./in-process-gateway.js";
import type { createSessionsSpawnTool as SpawnToolFactory } from "./sessions-spawn-tool.js";

export function registerSessionsSpawnInputTests(setup: {
  createTool: typeof SpawnToolFactory;
  registerAcpBackendForTest: () => void;
  mockGateway: (response: Record<string, unknown>) => InProcessGatewayCaller;
  mocks: {
    spawnSubagentDirectMock: Mock;
    spawnAcpDirectMock: Mock;
    inProcessCreationMock: Mock;
  };
}) {
  const timeoutError = "runTimeoutSeconds must be a non-negative integer";
  const worktreeError = "Hidden native subagents require worktree=true";
  const correctedInput = {
    task: "Review the API change",
    group: "Reviews",
    projectGitUrl: "https://github.com/example/project.git",
    worktreeName: "api-review",
    worktreeBaseRef: "origin/main",
  };

  it.each([false, true])(
    "keeps collector inputs within the declared spawn contract (placement=%s)",
    (workerPlacement) => {
      const tool = setup.createTool({ workerPlacement });
      finalizeAgentToolAvailability([tool, createAgentsWaitTool({})]);
      expect(Value.Check(tool.parameters, { task: "ordinary child" })).toBe(true);
      expect(Value.Check(tool.parameters, { task: "collector child", collect: true })).toBe(
        !workerPlacement,
      );
    },
  );

  it.each([
    [{ completionTarget: "parent", runtime: "acp" }, /completionTarget/],
    [{ completionTarget: "parent", visible: true }, /completionTarget/],
    [{ completionTarget: "channel" }, /completionTarget/],
    [{ outputSchema: { type: "object" } }, "requires collect=true"],
    [{ groupId: "swarm:custom" }, "requires collect=true"],
    [{ runTimeoutSeconds: -1 }, timeoutError],
    [{ runTimeoutSeconds: "not-a-number" }, timeoutError],
    [
      { timeout_seconds: 2 },
      'sessions_spawn does not support "timeout_seconds". Use "runTimeoutSeconds" for a per-run timeout.',
    ],
    [
      { channel: "example" },
      'sessions_spawn does not support "channel"; remove channel-delivery parameters.',
    ],
    [
      { runtime: "acp", lightContext: true },
      "lightContext is only supported for runtime='subagent'.",
    ],
    [
      { runtime: "acp", projectId: "example", worktree: true },
      'Managed worktree parameters are unavailable with runtime="acp"',
    ],
    [{ projectId: "example" }, worktreeError],
    [{ worktreeName: "review" }, worktreeError],
    [{ worktreeBaseRef: "origin/main" }, worktreeError],
    [
      { placement: { kind: "profile", profileId: "build" } },
      "Cloud placement requires visible=true and worktree=true. Corrected call: sessions_spawn(",
    ],
  ] as const)("rejects %j before dispatch", async (input, error) => {
    setup.registerAcpBackendForTest();
    const tool = setup.createTool({ config: { tools: { swarm: true } } });
    await expect(tool.execute("invalid", { task: "inspect", ...input })).rejects.toThrow(error);
    expect(setup.mocks.spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(setup.mocks.spawnAcpDirectMock).not.toHaveBeenCalled();
    expect(setup.mocks.inProcessCreationMock).not.toHaveBeenCalled();
  });

  it("gives an executable visible retry for visible-only parameters on a hidden spawn", async () => {
    const callGateway = setup.mockGateway({
      key: "agent:main:dashboard:child",
      sessionId: "visible-child",
      runStarted: true,
      runId: "run-visible",
    });
    const tool = setup.createTool({
      registerRun: vi.fn(),
      countActiveRuns: () => 0,
      config: { agents: { entries: { main: {} } }, tools: { swarm: true } },
      callGateway,
    });
    finalizeAgentToolAvailability([tool, createAgentsWaitTool({})]);
    const error = await tool
      .execute("hidden-visible-options", {
        ...correctedInput,
        completionTarget: "parent",
        cleanup: "delete",
        mode: "run",
        thread: false,
        thinking: "high",
        lightContext: true,
        attachments: [{ name: "notes.txt", content: "review notes" }],
        attachAs: { mountPath: "/inputs" },
        collect: true,
        outputSchema: { type: "object" },
        fastMode: "auto",
        groupId: "review-batch",
        streamTo: "parent",
        resumeSessionId: "prior-acp-session",
      })
      .catch((reason: unknown) => reason);
    if (!(error instanceof Error)) {
      throw new Error("Expected visible-only parameter rejection");
    }
    expect(error.message).toContain("Parameters require visible=true: group, projectGitUrl");
    expect(callGateway).not.toHaveBeenCalled();
    expect(setup.mocks.spawnSubagentDirectMock).not.toHaveBeenCalled();
    const corrected: unknown = JSON.parse(
      /Corrected visible call: sessions_spawn\((.*)\)$/.exec(error.message)?.[1] ?? "",
    );
    expect(corrected).toEqual({
      ...correctedInput,
      worktree: true,
      runtime: "subagent",
      visible: true,
    });

    const result = await tool.execute("corrected-visible", corrected);

    expect(result.details).toMatchObject({ status: "accepted", runId: "run-visible" });
    expect(callGateway).toHaveBeenCalledOnce();
  });
}
