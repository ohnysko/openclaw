import { beforeEach, describe, expect, it, vi } from "vitest";

const launchAgentPlistExists = vi.hoisted(() => vi.fn());
const repairLaunchAgentBootstrap = vi.hoisted(() => vi.fn());
const assertNoSystemLaunchDaemonOwnership = vi.hoisted(() => vi.fn());

vi.mock("../../daemon/launchd.js", () => ({
  formatLaunchAgentGuiSessionError: (params: {
    detail: string;
    domain: string;
    actionHint: string;
  }) =>
    [
      `launchctl bootstrap failed: ${params.detail}`,
      `LaunchAgent ${params.actionHint} requires a logged-in macOS GUI session for this user (${params.domain}).`,
    ].join("\n"),
  launchAgentPlistExists: (env: Record<string, string | undefined>) => launchAgentPlistExists(env),
  repairLaunchAgentBootstrap: (args: { env?: Record<string, string | undefined> }) =>
    repairLaunchAgentBootstrap(args),
  resolveLaunchAgentLabel: (env: Record<string, string | undefined>) =>
    env.OPENCLAW_LAUNCHD_LABEL ?? "ai.openclaw.gateway",
}));

vi.mock("../../daemon/launchd-system.js", () => ({
  assertNoSystemLaunchDaemonOwnership: (label: string) =>
    assertNoSystemLaunchDaemonOwnership(label),
}));

const { recoverInstalledLaunchAgent } = await import("./launchd-recovery.js");
const recover = (result: "started" | "restarted" = "started") =>
  recoverInstalledLaunchAgent({ result });

describe("recoverInstalledLaunchAgent", () => {
  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    assertNoSystemLaunchDaemonOwnership.mockReset().mockResolvedValue(undefined);
    launchAgentPlistExists.mockReset().mockResolvedValue(true);
    repairLaunchAgentBootstrap.mockReset().mockResolvedValue({ ok: true, status: "repaired" });
  });

  it("returns null outside macOS", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    await expect(recover()).resolves.toBeNull();
    expect(launchAgentPlistExists).not.toHaveBeenCalled();
    expect(assertNoSystemLaunchDaemonOwnership).not.toHaveBeenCalled();
  });

  it("returns null when the LaunchAgent plist is missing", async () => {
    launchAgentPlistExists.mockResolvedValue(false);

    await expect(recover()).resolves.toBeNull();
    expect(assertNoSystemLaunchDaemonOwnership).toHaveBeenCalledWith("ai.openclaw.gateway");
    expect(repairLaunchAgentBootstrap).not.toHaveBeenCalled();
  });

  it("returns a loaded recovery result when bootstrap repair succeeds", async () => {
    await expect(recover("restarted")).resolves.toEqual({
      result: "restarted",
      loaded: true,
      message: "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.",
    });
    expect(launchAgentPlistExists).toHaveBeenCalledWith(process.env);
    expect(repairLaunchAgentBootstrap).toHaveBeenCalledWith({ env: process.env });
  });

  it("returns null when bootstrap repair fails", async () => {
    repairLaunchAgentBootstrap.mockResolvedValue({
      ok: false,
      status: "kickstart-failed",
      detail: "permission denied",
    });

    await expect(recover()).resolves.toBeNull();
  });

  it("surfaces headless GUI bootstrap failures instead of falling back to unmanaged restart", async () => {
    repairLaunchAgentBootstrap.mockResolvedValue({
      ok: false,
      status: "gui-session-unavailable",
      detail: "Bootstrap failed: 125: Domain does not support specified action",
      domain: "gui/501",
    });

    await expect(recover("restarted")).rejects.toThrow("requires a logged-in macOS GUI session");
  });

  it("surfaces system ownership even when no user LaunchAgent plist exists", async () => {
    launchAgentPlistExists.mockResolvedValue(false);
    assertNoSystemLaunchDaemonOwnership.mockRejectedValue(
      new Error("System LaunchDaemon system/ai.openclaw.gateway owns this label"),
    );

    await expect(recover()).rejects.toThrow(
      "System LaunchDaemon system/ai.openclaw.gateway owns this label",
    );
    expect(launchAgentPlistExists).not.toHaveBeenCalled();
  });

  it("preserves typed system-launchdaemon-unverifiable bootstrap failures", async () => {
    repairLaunchAgentBootstrap.mockResolvedValue({
      ok: false,
      status: "system-launchdaemon-unverifiable",
      detail: "system ownership recovery guidance",
    });

    await expect(recover("restarted")).rejects.toThrow("system ownership recovery guidance");
  });
});
