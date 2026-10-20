import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const script = path.resolve("scripts/ios-resource-timeline.mjs");
const moduleUrl = JSON.stringify(pathToFileURL(script).href);
const posixIt = process.platform === "win32" ? it.skip : it;

function run(output: string, source: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    process.execPath,
    [script, "--output", output, "--", process.execPath, "--input-type=module", "-e", source],
    {
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, OPENCLAW_IOS_RESOURCE_DIAGNOSTICS: "1", ...env },
    },
  );
}

describe("iOS resource timeline workload boundary", () => {
  it.each([
    ["private-api-token", "other"],
    ["qualification-native-build", "qualification-native-build"],
  ])("preserves workload exit and output while sanitizing phase %s", (phase, expected) => {
    const output = path.join(tempDirs.make("ios-resource-timeline-"), "timeline.jsonl");
    const result = run(
      output,
      `
      import { markIosResourcePhase } from ${moduleUrl};
      markIosResourcePhase(${JSON.stringify(phase)});
      console.log(process.env.OPENCLAW_IOS_RESOURCE_PHASE_PATH);
      process.exit(23);
    `,
    );
    expect(result.status).toBe(23);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(existsSync(result.stdout.trim())).toBe(false);
    const raw = readFileSync(output, "utf8");
    expect(raw).not.toMatch(/private-api-token|--input-type|OPENCLAW_IOS_RESOURCE_PHASE_PATH/u);
    const records = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({
      type: "start",
      collectorCpuScope: "node-only-excludes-observation-subprocesses",
    });
    expect(records.at(-1)).toMatchObject({ type: "end", phase: expected, code: 23, signal: null });
  });

  it.each(["disabled", "unwritable"])("runs the workload when diagnostics are %s", (mode) => {
    const parent = path.join(tempDirs.make("ios-resource-timeline-"), "parent");
    if (mode === "unwritable") {
      writeFileSync(parent, "ordinary file");
    }
    const output = path.join(parent, "timeline.jsonl");
    const result = run(
      output,
      `console.log(process.env.OPENCLAW_IOS_RESOURCE_PHASE_PATH ?? "no collector"); process.exit(17);`,
      {
        OPENCLAW_IOS_RESOURCE_DIAGNOSTICS: mode === "disabled" ? "0" : "1",
        OPENCLAW_IOS_RESOURCE_PHASE_PATH: "/stale/parent/collector",
      },
    );
    expect(result.status).toBe(17);
    expect(result.stdout).toBe("no collector\n");
    expect(existsSync(output)).toBe(false);
  });

  posixIt("retains the child's terminating signal", () => {
    const output = path.join(tempDirs.make("ios-resource-timeline-"), "timeline.jsonl");
    const result = run(output, `process.kill(process.pid, "SIGTERM");`);
    expect(result.signal).toBe("SIGTERM");
    expect(result.status).toBeNull();
    expect(JSON.parse(readFileSync(output, "utf8").trim().split("\n").at(-1)!)).toMatchObject({
      type: "end",
      code: null,
      signal: "SIGTERM",
    });
  });

  posixIt("forwards cancellation without changing the workload's handled exit", async () => {
    const output = path.join(tempDirs.make("ios-resource-timeline-"), "timeline.jsonl");
    const child = spawn(
      process.execPath,
      [
        script,
        "--output",
        output,
        "--",
        process.execPath,
        "-e",
        `
      process.on("SIGTERM", () => { console.log("cancelled"); process.exit(19); });
      process.stdin.resume(); console.log("ready");
    `,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (stdout === "ready\n") {
        child.kill("SIGTERM");
      }
    });
    try {
      const result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      expect(result).toEqual({ code: 19, signal: null });
      expect(stdout).toBe("ready\ncancelled\n");
    } finally {
      child.kill("SIGKILL");
      child.stdin.destroy();
    }
  });
});
