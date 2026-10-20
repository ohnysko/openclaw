import { expect, it, vi } from "vitest";
import type { createSessionsSpawnTool as SpawnToolFactory } from "./sessions-spawn-tool.js";

/** Visible child rollback tests share the parent suite's spawn entry point and lifecycle. */
export function registerSessionsSpawnVisibleCleanupTests({
  createTool,
}: {
  createTool: typeof SpawnToolFactory;
}) {
  const key = "agent:main:dashboard:child";
  const receipt = {
    key,
    sessionId: "created-child",
    entry: { lifecycleRevision: "birth-revision" },
  };
  async function executeVisible(
    callGateway: NonNullable<Parameters<typeof createTool>[0]>["callGateway"],
    options: NonNullable<Parameters<typeof createTool>[0]> = {},
    id = "visible-failure",
  ) {
    return (
      await createTool({
        agentSessionKey: "agent:main:main",
        config: { agents: { entries: { main: {} } } },
        countActiveRuns: () => 0,
        callGateway,
        ...options,
      }).execute(id, { task: "inspect", visible: true })
    ).details;
  }
  function expectError(details: unknown, error: string) {
    expect(details).toMatchObject({
      status: "error",
      error: expect.stringContaining(error),
      childSessionKey: key,
    });
  }

  it.each(["not-started", "missing-run-id", "registration"] as const)(
    "cleans up the created visible session after %s failure",
    async (failure) => {
      const callGateway = vi
        .fn()
        .mockResolvedValueOnce({
          ...receipt,
          runStarted: failure !== "not-started",
          ...(failure === "registration" ? { runId: "child-run" } : {}),
          runError: "startup failed",
        })
        .mockResolvedValueOnce({ deleted: true });
      const registerRun = vi.fn(() => {
        throw new Error("registry unavailable");
      });
      const details = await executeVisible(callGateway, { registerRun });

      expectError(details, "Session removed.");
      expect(callGateway).toHaveBeenCalledTimes(2);
      expect(callGateway).toHaveBeenNthCalledWith(2, "sessions.delete", {
        key,
        agentId: "main",
        expectedSessionId: "created-child",
        expectedLifecycleRevision: "birth-revision",
        deleteTranscript: true,
        emitLifecycleHooks: false,
      });
      expect(registerRun).toHaveBeenCalledTimes(failure === "registration" ? 1 : 0);
    },
  );

  it.each([
    [
      "initial child start",
      false,
      undefined,
      { code: "UNAVAILABLE", message: "child chat.send rejected before input admission" },
      undefined,
      "child chat.send rejected before input admission",
    ],
    [
      "run registration",
      true,
      "child-run",
      undefined,
      "registry unavailable",
      "Session cleanup unconfirmed.",
    ],
  ] as const)(
    "reports the retained child when %s and cleanup fail",
    async (_failure, runStarted, runId, runError, registrationError, expectedError) => {
      const callGateway = vi
        .fn()
        .mockResolvedValueOnce({
          ...receipt,
          runStarted,
          ...(runId ? { runId } : {}),
          ...(runError ? { runError } : {}),
        })
        .mockRejectedValueOnce(new Error("lifecycle drain unavailable"));
      const details = await executeVisible(
        callGateway,
        registrationError
          ? {
              registerRun: () => {
                throw new Error(registrationError);
              },
            }
          : {},
      );

      expectError(details, expectedError);
      if (runId) {
        expect(details).toMatchObject({ runId });
      }
      expect(details).toMatchObject({
        error: expect.stringContaining("Session cleanup unconfirmed."),
      });
      expect(callGateway).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["sessionId", "lifecycleRevision"] as const)(
    "keeps a failed visible child when its creation receipt omits %s",
    async (missing) => {
      const callGateway = vi.fn().mockResolvedValueOnce({
        key,
        ...(missing === "sessionId" ? {} : { sessionId: "created-child" }),
        entry: missing === "lifecycleRevision" ? {} : { lifecycleRevision: "birth-revision" },
        runStarted: false,
        runError: "startup failed",
      });
      const details = await executeVisible(callGateway, {}, "visible-missing-identity");

      expectError(details, "Session cleanup unconfirmed.");
      expect(callGateway).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, "", " \t\n "])(
    "refuses a started visible run with missing or blank session identity %j",
    async (sessionId) => {
      const callGateway = vi.fn().mockResolvedValueOnce({
        key,
        sessionId,
        entry: { lifecycleRevision: "birth-revision" },
        runStarted: true,
        runId: "child-run",
      });
      const registerRun = vi.fn();
      const details = await executeVisible(
        callGateway,
        { registerRun },
        "visible-missing-identity",
      );

      expectError(details, "sessions.create did not return its sessionId");
      expect(details).toMatchObject({ runId: "child-run" });
      expect(details).toMatchObject({
        error: expect.stringContaining("inspect this child session and run before retrying"),
      });
      expect(registerRun).not.toHaveBeenCalled();
      expect(callGateway).toHaveBeenCalledTimes(1);
    },
  );
}
