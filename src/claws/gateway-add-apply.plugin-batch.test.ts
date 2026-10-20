import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawLifecyclePlanResult } from "../../packages/gateway-protocol/src/schema/claws.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { PluginInstallRuntimeBatch } from "../plugins/install-runtime-batch.js";
import { getPluginCache } from "../plugins/plugin-cache.js";
import {
  hasPluginLifecycleLease,
  withPluginLifecycleLease,
} from "../plugins/plugin-lifecycle-lease.js";
import { createInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import * as leaseAcquisition from "../state/openclaw-state-lease-acquisition.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { ClawHubClawTrust, withResolvedClawHubSource } from "./clawhub-source.js";
import { applyClawAddForGateway } from "./gateway-add-apply.js";
import type { ClawAddPlan, ClawReadResult } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  build: vi.fn(),
  project: vi.fn(),
  plansMatch: vi.fn(),
  configuredAccess: vi.fn(),
  stage: vi.fn(),
}));

// mock-isolation: The batch test supplies a fixed Claw source instead of fetching one.
vi.mock("./clawhub-source.js", () => ({ withResolvedClawHubSource: mocks.resolve }));
// mock-isolation: Planning outputs are fixed so this suite can exercise batch application only.
vi.mock("./gateway-add-plan.js", () => ({
  buildGatewayClawAddPlan: mocks.build,
  projectGatewayClawAddPlan: mocks.project,
}));
// mock-isolation: Source-root comparison is controlled while testing batch ownership.
vi.mock("./gateway-plan-projection.js", () => ({ plansMatchAcrossSourceRoots: mocks.plansMatch }));
// mock-isolation: Configured-access disclosure is a fixed input to the batch scenario.
vi.mock("./gateway-disclosure.js", () => ({ projectClawConfiguredAccess: mocks.configuredAccess }));
// mock-isolation: Staging is a fixture; the real mutation would alter shared plugin state.
vi.mock("./add-stateless.js", () => ({ stageClawAddHostRequirementsStateless: mocks.stage }));

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

type ReadResult = Extract<ClawReadResult, { ok: true }>;
const source = {
  manifest: { agent: { id: "workflow-operator" } },
  source: { packageRoot: "/tmp/claw-source" },
} as ReadResult;
const persisted = { source: { packageRoot: "/tmp/claw-cache" } } as ReadResult;
const trust: ClawHubClawTrust = {
  riskAcknowledgementRequired: false,
  trustRecord: {
    clawhubTrustDisposition: "clean",
    clawhubTrustCheckedAt: "2026-10-02T00:00:00.000Z",
  },
};
const plan = {
  agent: { finalId: "workflow-operator", config: { id: "workflow-operator" } },
  blockers: [],
  actions: [
    {
      kind: "package",
      details: {
        kind: "plugin",
        source: "clawhub",
        ref: "@fixture/plugin",
        version: "1",
        integrity: `sha256:${"a".repeat(64)}`,
        ownerAction: "reuse",
        installId: "fixture",
      },
    },
  ],
  planIntegrity: "sha256:canonical",
} as unknown as ClawAddPlan;
const configuredAccess = {
  desired: { tools: { allowed: ["read"] } },
} as NonNullable<ClawLifecyclePlanResult["configuredAccess"]>;
const projection = {
  planIntegrity: "sha256:reviewed",
  blockers: [],
  pluginReviews: [],
  skillReviews: [],
  configuredAccess,
  readiness: { ready: true, requirements: [] },
} as unknown as ClawLifecyclePlanResult;
const config: OpenClawConfig = { gateway: { controlUi: { experimental: { claws: true } } } };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockImplementation(
    async (input: Parameters<typeof withResolvedClawHubSource>[0]) => ({
      value: await input.run(source, trust, async () => persisted),
    }),
  );
  mocks.build.mockResolvedValue(plan);
  mocks.project.mockReturnValue(projection);
  mocks.plansMatch.mockReturnValue(true);
  mocks.configuredAccess.mockReturnValue(configuredAccess);
});

const disabledConfig = { ...config, plugins: { entries: { fixture: { enabled: false } } } };
const writeJson = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value));
const agent = { finalId: "workflow-operator" };
const partial = (code: string, message = "Runtime activation failed") => ({
  agent,
  status: "partial" as const,
  error: { code, message },
});
const complete = { agent, status: "complete" as const };
const reloadReceipt = { operationId: "reload", generation: 2, pluginIds: ["fixture"] };
type ApplyInput = Parameters<typeof applyClawAddForGateway>[0];
function applyInput(
  env: Awaited<ReturnType<typeof fixture>>["env"],
  reloadPlugins: ApplyInput["reloadPlugins"],
  assertCurrent: () => void = () => {},
): ApplyInput {
  return {
    source: { packageName: "@openclaw/workflow-operator", version: "1.0.0" },
    planIntegrity: projection.planIntegrity,
    getPlanningContext: async () => ({ config, sourceMcpServers: {} }),
    policyConfig: { configPath: env.OPENCLAW_CONFIG_PATH, env },
    assertCurrent,
    reloadPlugins,
  };
}

function writeIndex(
  env: NodeJS.ProcessEnv,
  installRecords: NonNullable<Parameters<typeof createInstalledPluginIndex>[0]>["installRecords"],
  revision: number,
) {
  const index = createInstalledPluginIndex({ plugins: [], installRecords });
  writeConfigMachineState("plugins.installedIndex", { revision, index }, { env });
}

async function fixture() {
  const root = dirs.make("gateway-claw-add-plugin-batch-");
  const env = {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  };
  await writeJson(env.OPENCLAW_CONFIG_PATH, config);
  const record = { source: "path" as const, installPath: root, version: "1" };
  writeIndex(env, { fixture: record }, 1);
  return { env, record };
}

describe("Gateway Claw Add plugin handoff", () => {
  it("uses migration policy committed while runtime activation waited for the plugin lease", async () => {
    const { env } = await fixture();
    await withEnvAsync(env, async () => {
      let pluginLeaseAcquisitions = 0;
      let migrationCommitted = false;
      const acquire = leaseAcquisition.acquireOpenClawStateLease;
      vi.spyOn(leaseAcquisition, "acquireOpenClawStateLease").mockImplementation(async (params) => {
        if (params.label.includes("plugin lifecycle lease") && ++pluginLeaseAcquisitions === 2) {
          await recordDeferredPluginMigrations({
            env,
            pending: [
              {
                pluginId: "legacy-fixture",
                reason: "Legacy config awaits plugin migration",
                command: "openclaw doctor --fix",
                configPaths: [["legacyFixture"]],
                validationExcludedPaths: [["legacyFixture"]],
              },
            ],
          });
          await writeJson(env.OPENCLAW_CONFIG_PATH, {
            ...config,
            legacyFixture: { value: "retained" },
          });
          migrationCommitted = true;
        }
        return await acquire(params);
      });
      const continueAdd = vi.fn(async () => complete);
      mocks.stage.mockImplementation(
        async (_plan: ClawAddPlan, options: { runtimeBatch: PluginInstallRuntimeBatch }) => {
          options.runtimeBatch.retain("fixture");
          return {
            kind: "ready",
            continue: continueAdd,
            failBeforeContinue: async (_error: unknown, code: string) => partial(code),
          };
        },
      );
      const reloadPlugins = vi.fn(async (_targets, options) =>
        withPluginLifecycleLease({ env }, async () => {
          options?.commitGuard?.();
          return reloadReceipt;
        }),
      );
      const result = await applyClawAddForGateway(applyInput(env, reloadPlugins));
      expect(migrationCommitted).toBe(true);
      expect(result).toMatchObject({ status: "complete" });
      expect(continueAdd).toHaveBeenCalledOnce();
    });
  });

  it("reproduces the real runtime batch refusal while any plugin lease is held", async () => {
    const { env } = await fixture();
    await withEnvAsync(env, async () => {
      const batch = new PluginInstallRuntimeBatch({ env }, vi.fn());
      await withPluginLifecycleLease({ env }, async (lease) => {
        await batch.prepare(lease);
        await expect(batch.finish(() => {})).rejects.toThrow(
          "Plugin batch was not prepared or its handoff already started",
        );
      });
      batch.close();
    });
  });

  it.each([
    "success",
    "stage-partial",
    "stage-partial-runtime-failure",
    "runtime-failure",
    "prepare-failure",
    "lease-finalizer-failure",
    "authority-lost",
    "policy-drift-at-commit",
    "owner-removed",
    "owner-replaced",
    "owner-reuse-removed",
    "plugin-disabled-reuse",
    "plugin-disabled-retained",
    "plugin-disabled-at-commit",
  ] as const)(
    "settles %s before workspace effects and resumes only after a fresh policy read",
    async (outcome) => {
      const { env, record } = await fixture();
      await withEnvAsync(env, async () => {
        const events: string[] = [];
        let authorityActive = true;
        const zeroTarget = outcome === "owner-reuse-removed" || outcome === "plugin-disabled-reuse";
        const disableAfterFinish =
          outcome === "plugin-disabled-reuse" || outcome === "plugin-disabled-retained";
        const stagePartial = outcome.startsWith("stage-partial");
        const skipReload =
          outcome === "prepare-failure" || outcome === "lease-finalizer-failure" || zeroTarget;
        const continueAdd = vi.fn(
          async (options: {
            getCurrentConfig: () => OpenClawConfig;
            assertReviewedConfig: (config: OpenClawConfig) => void;
          }) => {
            events.push("continue");
            expect(hasPluginLifecycleLease()).toBe(true);
            const currentConfig = options.getCurrentConfig();
            expect(currentConfig.gateway?.controlUi?.experimental?.claws).toBe(true);
            options.assertReviewedConfig(currentConfig);
            return complete;
          },
        );
        const failBeforeContinue = vi.fn(async (_error: unknown, code: string) => {
          events.push("fail");
          expect(hasPluginLifecycleLease()).toBe(false);
          return partial(code);
        });
        mocks.stage.mockImplementation(
          async (_plan: ClawAddPlan, options: { runtimeBatch: PluginInstallRuntimeBatch }) => {
            events.push("stage");
            expect(hasPluginLifecycleLease()).toBe(true);
            if (!zeroTarget) {
              options.runtimeBatch.retain(outcome === "prepare-failure" ? "missing" : "fixture");
            }
            if (outcome === "lease-finalizer-failure") {
              getPluginCache().instances.add({
                pluginId: "fixture",
                quiesce: () => true,
                dispose: async () => {
                  throw new Error("Plugin cache finalizer failed");
                },
              });
            }
            if (stagePartial) {
              return {
                kind: "partial",
                result: partial("package_install_failed", "Package installation failed"),
              };
            }
            return { kind: "ready", continue: continueAdd, failBeforeContinue };
          },
        );
        const reloadPlugins = vi.fn(async (_targets, reloadOptions) => {
          events.push("reload");
          expect(hasPluginLifecycleLease()).toBe(true);
          if (outcome === "policy-drift-at-commit" || outcome === "plugin-disabled-at-commit") {
            await writeJson(
              env.OPENCLAW_CONFIG_PATH,
              outcome === "plugin-disabled-at-commit"
                ? disabledConfig
                : { gateway: { controlUi: { experimental: { claws: false } } } },
            );
            reloadOptions?.commitGuard?.();
          }
          if (outcome === "runtime-failure" || outcome === "stage-partial-runtime-failure") {
            throw new Error("Runtime activation failed");
          }
          if (outcome === "authority-lost") {
            authorityActive = false;
          }
          return reloadReceipt;
        });

        const finish = PluginInstallRuntimeBatch.prototype.finish;
        if (outcome.startsWith("owner-") || disableAfterFinish) {
          vi.spyOn(PluginInstallRuntimeBatch.prototype, "finish").mockImplementation(
            async function (this: PluginInstallRuntimeBatch, warn) {
              const application = await finish.call(this, warn);
              if (disableAfterFinish) {
                await writeJson(env.OPENCLAW_CONFIG_PATH, disabledConfig);
                return application;
              }
              writeIndex(
                env,
                outcome === "owner-replaced"
                  ? { fixture: { ...record, installedAt: "2026-10-02T03:00:00.000Z" } }
                  : {},
                2,
              );
              return application;
            },
          );
        }

        const result = await applyClawAddForGateway(
          applyInput(env, reloadPlugins, () => {
            if (!authorityActive) {
              throw new Error("Gateway Add authority ended");
            }
          }),
        );

        const success = outcome === "success";
        expect(events).toEqual([
          "stage",
          ...(skipReload ? [] : ["reload"]),
          ...(stagePartial ? [] : [success ? "continue" : "fail"]),
        ]);
        const code =
          outcome === "stage-partial"
            ? "package_install_failed"
            : outcome === "authority-lost" || outcome.startsWith("owner-") || disableAfterFinish
              ? "policy_recheck_failed"
              : "package_runtime_failed";
        expect(result).toMatchObject(
          success ? { status: "complete" } : { status: "partial", error: { code } },
        );
        if (outcome === "stage-partial-runtime-failure") {
          expect(result.error?.message).toContain("package_install_failed");
          expect(result.error?.message).toMatch(/runtime activation failed/i);
        }
        expect(continueAdd).toHaveBeenCalledTimes(success ? 1 : 0);
        expect(failBeforeContinue).toHaveBeenCalledTimes(success || stagePartial ? 0 : 1);
        expect(reloadPlugins).toHaveBeenCalledTimes(skipReload ? 0 : 1);
      });
    },
  );
});
