// Gateway connect pairing tests protect session exemptions and durable device grant bounds.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  GATEWAY_CLIENT_MODES as MODES,
  GATEWAY_CLIENT_NAMES as NAMES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import type { HelloOk } from "../../../../packages/gateway-protocol/src/schema/frames.js";
import type {
  UsersListResult,
  UsersSelfResult,
} from "../../../../packages/gateway-protocol/src/schema/users.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { replaceConfigFile } from "../../../config/config.js";
import {
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import type { GatewayAuthConfig } from "../../../config/types.gateway.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { readDeviceAuthTokenForTest } from "../../../infra/device-auth-store.test-support.js";
import { issueDeviceBootstrapToken } from "../../../infra/device-bootstrap.js";
import * as pairingApprovals from "../../../infra/device-pairing-approval.js";
import { ensureDeviceToken } from "../../../infra/device-pairing-tokens.js";
import * as devicePairing from "../../../infra/device-pairing.js";
import { getPairedDevice, listDevicePairing } from "../../../infra/device-pairing.js";
import { setLoggerOverride } from "../../../logging.js";
import { testApi as loggerTest } from "../../../logging/logger.test-support.js";
import {
  CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES,
  CONTROL_UI_OWNER_BOOTSTRAP_PROFILE,
} from "../../../shared/device-bootstrap-profile.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../../state/openclaw-state-db.js";
import { readUserGitHubConnectionAsync } from "../../../state/user-github-connections.js";
import { disconnectedUserGitHubConnection } from "../../../state/user-github-connections.kernel.js";
import { updateUserGitHubConnection } from "../../../state/user-github-connections.test-support.js";
import {
  hasMultipleResidentSessionSharingIdentities,
  publishUserProfilesChange,
} from "../../../state/user-profile-list.js";
import { setUserProfileRole } from "../../../state/user-profile-writes.worker.js";
import { repairMergedGatewayOwnerProfile } from "../../../state/user-profiles-owner-migration.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import {
  GatewayClient,
  type GatewayClientOptions,
  type GatewayReconnectPausedInfo,
} from "../../client.js";
import {
  loadDeviceIdentity,
  openTrackedWs,
  pairDeviceIdentity,
} from "../../device-authz.test-helpers.js";
import {
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicyForProfile,
} from "../../operator-role-policy.js";
import { resolveSessionCatalogVisibility } from "../../server-methods/session-catalog-visibility.js";
import { sessionReadHandlers } from "../../server-methods/sessions-read.js";
import { usersHandlers } from "../../server-methods/users.js";
import {
  ConnectErrorDetailCodes,
  CONTROL_UI_CLIENT,
  openTailscaleWs,
} from "../../server.auth.test-helpers.js";
import { sharingIdentity } from "../../session-sharing-policy.js";
import type { SessionsListResult } from "../../session-utils.types.js";
import {
  connectReq,
  installGatewayTestHooks,
  rpcReq,
  startServer,
  startServerWithClient,
  testState,
  testTailscaleWhois,
} from "../../test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

await import("../../server.js");

function clientInfo(id: string, mode: string, platform = "test") {
  return { id, mode, platform, version: "1.0.0" };
}
const BACKEND_CLIENT = clientInfo(NAMES.GATEWAY_CLIENT, MODES.BACKEND, "node");
const TUI_CLIENT = clientInfo(NAMES.TUI, MODES.CLI);

function operatorRoles(name = "guest", agents = ["guest"]) {
  return {
    default: name,
    definitions: {
      [name]: { sessions: { others: "none" }, agents, scopes: ["operator.read"] },
    },
  } satisfies NonNullable<OpenClawConfig["gateway"]>["roles"];
}

function updateGateway(overrides: NonNullable<OpenClawConfig["gateway"]>) {
  const current = getRuntimeConfigSnapshot();
  if (!current) {
    throw new Error("expected active Gateway config");
  }
  setRuntimeConfigSnapshot({ ...current, gateway: { ...current.gateway, ...overrides } });
}

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

function track<T>(resource: T, cleanup: (resource: T) => unknown | Promise<unknown>): T {
  cleanups.push(() => cleanup(resource));
  return resource;
}

function trackedClient(options: GatewayClientOptions) {
  const client = track(new GatewayClient(options), (value) => value.stopAndWait());
  client.start();
  return client;
}

function deadline<T>(message: string) {
  const deferred = createDeferred<T>();
  const timer = setTimeout(() => deferred.reject(new Error(message)), 2_500);
  cleanups.push(() => clearTimeout(timer));
  return { ...deferred, promise: deferred.promise.finally(() => clearTimeout(timer)) };
}

function connectClient(options: GatewayClientOptions, timeoutMessage?: string) {
  const hello = timeoutMessage ? deadline<HelloOk>(timeoutMessage) : createDeferred<HelloOk>();
  const client = trackedClient({
    ...options,
    onHelloOk: hello.resolve,
    onConnectError: hello.reject,
  });
  return { client, hello: hello.promise };
}

function cachedDeviceToken(deviceId: string) {
  return readDeviceAuthTokenForTest({ deviceId, role: "operator" })?.token;
}

async function expectRpcError(
  ws: Parameters<typeof rpcReq>[0],
  method: string,
  code: string,
  message: string,
  params: Record<string, unknown> = {},
) {
  expect(await rpcReq(ws, method, params)).toMatchObject({ ok: false, error: { code, message } });
}

async function expectPersonalProfile(ws: Parameters<typeof rpcReq>[0], profileId: string) {
  const response = await rpcReq<UsersListResult>(ws, "users.list", {});
  expect(response.ok).toBe(true);
  expect(response.payload?.profiles.find((profile) => profile.id === profileId)).toMatchObject({
    emails: ["person@example.test"],
    role: "guest",
  });
}

async function configureGateway(
  auth: GatewayAuthConfig,
  origin: string,
  overrides: NonNullable<OpenClawConfig["gateway"]> = {},
) {
  const config: OpenClawConfig = {
    gateway: { auth, controlUi: { allowedOrigins: [origin] }, ...overrides },
  };
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = config.gateway?.controlUi;
  await replaceConfigFile({ nextConfig: config, afterWrite: { mode: "auto" } });
  return config;
}

function pairOperator(
  name: string,
  client: { id: string; mode: string },
  scopes: string[],
  platform?: string,
) {
  return pairDeviceIdentity({
    name,
    role: "operator",
    scopes,
    clientId: client.id,
    clientMode: client.mode,
    platform,
  });
}

async function startControlUi(auth: GatewayAuthConfig, origin: string) {
  return trackServer(
    await startServerWithClient(undefined, {
      auth,
      controlUiEnabled: true,
      wsHeaders: { origin },
    }),
  );
}

function controlUiOptions(
  port: number,
  origin: string,
  identity: GatewayClientOptions["deviceIdentity"],
) {
  return {
    url: `ws://127.0.0.1:${port}`,
    origin,
    deviceIdentity: identity,
    clientName: CONTROL_UI_CLIENT.id,
    clientVersion: CONTROL_UI_CLIENT.version,
    platform: CONTROL_UI_CLIENT.platform,
    mode: CONTROL_UI_CLIENT.mode,
    role: "operator",
  } satisfies GatewayClientOptions;
}

function trackServer<
  T extends Pick<Awaited<ReturnType<typeof startServer>>, "server" | "envSnapshot"> & {
    ws?: { close(): void };
  },
>(started: T) {
  return track(started, async (value) => {
    value.ws?.close();
    await value.server.close();
    value.envSnapshot.restore();
  });
}

describe("gateway connect pairing exemptions", () => {
  test("keeps approved connects off recovery reads and checks current authority", async () => {
    const origin = "https://pairing.example.test";
    const auth = { mode: "token", token: "concurrent-pairing-secret" } as const;
    await configureGateway(auth, origin, { nodes: { pairing: { autoApproveLocal: false } } });
    const started = trackServer(await startServerWithClient(undefined, { auth }));
    const readPairing = devicePairing.listDevicePairing;
    const readPaired = devicePairing.getPairedDevice;
    const scopes = ["operator.read", "operator.write"];
    expect(
      (
        await connectReq(started.ws, {
          client: BACKEND_CLIENT,
          token: auth.token,
          scopes: ["operator.admin"],
        })
      ).ok,
    ).toBe(true);
    for (const decision of [
      "approved",
      "rejected",
      "revoked",
      "different key",
      "different role",
      "narrower scopes",
      "unapproved metadata",
      "different client identity",
      "inline approval revoked",
    ] as const) {
      updateGateway({
        nodes: { pairing: { autoApproveLocal: decision === "inline approval revoked" } },
      });
      const name = `concurrent-pairing-${decision.replaceAll(" ", "-")}`;
      const loaded = loadDeviceIdentity(name);
      if (decision === "unapproved metadata" || decision === "different client identity") {
        await pairOperator(
          name,
          CONTROL_UI_CLIENT,
          decision === "unapproved metadata" ? scopes : ["operator.read"],
          decision === "unapproved metadata" ? "previous-platform" : CONTROL_UI_CLIENT.platform,
        );
      }
      const ws = await openTrackedWs(started.port, { origin });
      const recoveryRead = vi.spyOn(devicePairing, "listDevicePairing");
      const authorityRead = vi
        .spyOn(devicePairing, "getPairedDevice")
        .mockImplementationOnce(readPaired)
        .mockImplementationOnce(async (deviceId, baseDir) => {
          const pendingSnapshot = await readPairing();
          if (decision === "inline approval revoked") {
            expect(await readPaired(loaded.identity.deviceId)).not.toBeNull();
            await devicePairing.removePairedDevice(loaded.identity.deviceId);
            return readPaired(deviceId, baseDir);
          }
          const pending = pendingSnapshot.pending.find(
            (entry) => entry.deviceId === loaded.identity.deviceId,
          );
          if (!pending) {
            throw new Error(`expected a pending request for ${decision}`);
          }
          const decide = async (method: string, params: Record<string, string>) => {
            const response = await rpcReq(started.ws, method, params);
            expect(response.ok, JSON.stringify(response)).toBe(true);
          };
          if (decision === "unapproved metadata") {
            return readPaired(deviceId, baseDir);
          }
          if (decision === "rejected") {
            await decide("device.pair.reject", { requestId: pending.requestId });
          } else {
            let requestId = pending.requestId;
            const replacement =
              decision === "different key"
                ? { publicKey: loadDeviceIdentity("concurrent-pairing-other-key").publicKey }
                : decision === "different role"
                  ? { role: "node", roles: ["node"], scopes: [] }
                  : decision === "narrower scopes"
                    ? { scopes: ["operator.read"] }
                    : decision === "different client identity"
                      ? { clientId: NAMES.BROWSER_COPILOT }
                      : undefined;
            if (replacement) {
              await decide("device.pair.reject", { requestId });
              const replaced = await devicePairing.requestDevicePairing({
                ...pending,
                role: "operator",
                roles: ["operator"],
                scopes,
                ...replacement,
              });
              requestId = replaced.request.requestId;
            }
            await decide("device.pair.approve", { requestId });
            if (decision === "revoked") {
              await decide("device.pair.remove", { deviceId: loaded.identity.deviceId });
            }
          }
          return readPaired(deviceId, baseDir);
        });
      try {
        const response = await connectReq(ws, {
          client: CONTROL_UI_CLIENT,
          token: auth.token,
          scopes,
          deviceIdentityPath: loaded.identityPath,
          prePairDevice: false,
        });
        if (decision === "approved") {
          expect(recoveryRead).not.toHaveBeenCalled();
          expect.soft(response, decision).toMatchObject({
            ok: true,
            payload: { type: "hello-ok", auth: { role: "operator", scopes } },
          });
        } else if (decision === "different client identity") {
          expect.soft(response, decision).toMatchObject({
            ok: false,
            error: { message: "browser copilot requires a dedicated paired device identity" },
          });
        } else {
          expect.soft(response, decision).toMatchObject({
            ok: false,
            error: { code: "NOT_PAIRED", details: { code: "PAIRING_REQUIRED" } },
          });
        }
      } finally {
        authorityRead.mockRestore();
        recoveryRead.mockRestore();
        ws.close();
      }
    }
  });

  test("keeps a merged owner unidentified until Doctor repairs it before reconnect", async () => {
    const origin = "https://localhost";
    const auth = { mode: "token", token: "merged-owner-secret" } as const;
    const config = await configureGateway(auth, origin, { roles: operatorRoles() });
    const started = await startControlUi(auth, origin);
    let reconnect: Awaited<ReturnType<typeof openTrackedWs>> | undefined;
    const selfHandler = vi.spyOn(usersHandlers, "users.self");
    const listPreparation = vi.spyOn(sessionReadHandlers["sessions.list"]!, "prepareRead");
    const personalSpies: { mockRestore: () => void }[] = [];
    const connectOptions = {
      token: auth.token,
      scopes: ["operator.admin"],
      client: CONTROL_UI_CLIENT,
      deviceIdentityPath: loadDeviceIdentity("merged-gateway-owner").identityPath,
    };
    cleanups.push(() => {
      for (const spy of personalSpies) {
        spy.mockRestore();
      }
      selfHandler.mockRestore();
      listPreparation.mockRestore();
      setLoggerOverride({ level: "silent", consoleLevel: "silent" });
      reconnect?.close();
    });
    expect((await connectReq(started.ws, connectOptions)).ok).toBe(true);
    const person = ensureProfileForEmail("person@example.test");
    setUserProfileRole(person.id, "guest");
    const personSessionKey = "agent:main:merged-owner-person";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: personSessionKey },
      {
        sessionId: "merged-owner-person-session",
        updatedAt: 1,
        createdVia: "operator",
        createdActor: { type: "human", source: "profile", id: person.id },
        visibility: "draft",
      },
    );
    const personalConnection = updateUserGitHubConnection(
      person.id,
      () => ({
        ...disconnectedUserGitHubConnection(),
        selection: {
          kind: "connected",
          profileId: "ghp_00000000000000000000000000000001",
          accountId: 101,
          login: "personal-person",
          refreshToken: "synthetic-refresh",
          accessExpiresAtMs: Date.now() + 60_000,
          refreshExpiresAtMs: Date.now() + 120_000,
          scopes: ["repo"],
        },
      }),
      () => {},
    );
    const stateDb = openOpenClawStateDatabase();
    const db = stateDb.db;
    // The old merge writer moved identities to the person and left the owner tombstone.
    runOpenClawStateWriteTransaction(() => {
      db.prepare(
        "UPDATE user_profiles SET merged_into = ?, updated_at = 1 WHERE id = 'gateway-owner'",
      ).run(person.id);
      db.prepare(
        "UPDATE user_profile_identities SET profile_id = ? WHERE provider = 'gateway.local' AND subject = 'owner'",
      ).run(person.id);
      publishUserProfilesChange(db, "gateway-owner", person.id);
    });

    started.ws.close();
    const logPath = path.join(path.dirname(stateDb.path), "owner-repair.log");
    setLoggerOverride({ level: "warn", consoleLevel: "silent", file: logPath });
    reconnect = await openTrackedWs(started.port, { origin });
    const connected = await connectReq(reconnect, {
      ...connectOptions,
      client: { ...CONTROL_UI_CLIENT, instanceId: "before-owner-repair" },
    });
    expect(connected.ok).toBe(true);
    const hello = connected.payload as HelloOk;
    await expectRpcError(
      reconnect,
      "users.self",
      "FORBIDDEN",
      "users.self requires an authenticated user",
    );
    expect(selfHandler.mock.lastCall?.[0].client).not.toHaveProperty("authenticatedUserProfile");
    const personal = selfHandler.mock.lastCall?.[0].context.githubOAuthService?.personal;
    if (!personal) {
      throw new Error("expected the Gateway's personal GitHub service");
    }
    const personalStatus = vi.spyOn(personal, "status");
    const personalAuthorize = vi.spyOn(personal, "startAuthorization");
    personalSpies.push(personalStatus, personalAuthorize);
    for (const method of ["users.github.status", "users.github.authorize.start"]) {
      await expectRpcError(
        reconnect,
        method,
        "FORBIDDEN",
        "My GitHub requires a current authenticated human Gateway connection.",
      );
    }
    expect(personalStatus).not.toHaveBeenCalled();
    expect(personalAuthorize).not.toHaveBeenCalled();
    expect(await readUserGitHubConnectionAsync(person.id)).toEqual(personalConnection);
    const sessions = await rpcReq<SessionsListResult>(reconnect, "sessions.list", {});
    expect(sessions.ok).toBe(true);
    expect(
      sessions.payload?.sessions.find((session) => session.key === personSessionKey),
    ).toMatchObject({
      createdActor: { type: "human", id: person.id },
      visibility: "draft",
      sharingRole: "admin",
    });
    const listRequest = listPreparation.mock.lastCall?.[0];
    if (!listRequest?.client) {
      throw new Error("expected the sessions.list RPC client");
    }
    const actor = resolveGatewayOperatorRoleActor(listRequest.client);
    expect(actor).toEqual({ kind: "system" });
    expect(sharingIdentity(listRequest.client, actor)).toBeUndefined();
    expect(listRequest.client).not.toHaveProperty("authenticatedUserProfile");
    const visibility = resolveSessionCatalogVisibility(
      listRequest.client,
      listRequest.context.getRuntimeConfig(),
    );
    expect(visibility.kind).toBe("unrestricted");
    expect(JSON.parse(visibility.cacheKey)).toEqual({
      admin: true,
      multipleIdentities: false,
      profileId: null,
      profileAliases: [],
      others: null,
    });
    await expectRpcError(
      reconnect,
      "users.setRole",
      "INVALID_REQUEST",
      "the shared owner profile is not governed by operator roles",
      { profileId: "gateway-owner", role: null },
    );
    await expectRpcError(
      reconnect,
      "users.linkEmail",
      "INVALID_REQUEST",
      "the shared owner profile cannot be merged; sign in with a personal identity instead",
      {
        email: "new@example.test",
        targetProfileId: "gateway-owner",
      },
    );
    await expectPersonalProfile(reconnect, person.id);
    const presence = hello.snapshot.presence.find(
      (entry) => entry.instanceId === "before-owner-repair",
    );
    expect(presence).toBeDefined();
    expect(presence).not.toHaveProperty("user");
    await loggerTest.flushFileLogQueueForTests();
    const log = await fs.readFile(logPath, "utf8");
    expect(log).toContain("user profile resolution failed");
    expect(log).toContain("openclaw doctor --fix");
    expect(
      db
        .prepare("SELECT merged_into, updated_at FROM user_profiles WHERE id = 'gateway-owner'")
        .get(),
    ).toMatchObject({ merged_into: person.id, updated_at: 1 });

    expect(repairMergedGatewayOwnerProfile({ shouldRepair: true }).repaired).toBe(true);
    reconnect.close();
    reconnect = await openTrackedWs(started.port, { origin });
    const repaired = await connectReq(reconnect, {
      ...connectOptions,
      client: { ...CONTROL_UI_CLIENT, instanceId: "after-owner-repair" },
    });
    expect(repaired.ok).toBe(true);
    const self = await rpcReq<UsersSelfResult>(reconnect, "users.self", {});
    const profileId = self.payload?.profile.id;
    expect(selfHandler.mock.lastCall?.[0].client?.authenticatedUserProfile).toMatchObject({
      profileId: "gateway-owner",
    });
    const repairedHello = repaired.payload as HelloOk;
    expect(
      repairedHello.snapshot.presence.find((entry) => entry.instanceId === "after-owner-repair")
        ?.user,
    ).toMatchObject({ id: "gateway-owner" });
    expect(self.ok).toBe(true);
    expect(profileId).toBe("gateway-owner");
    expect(resolveOperatorRolePolicyForProfile(profileId, config)).toBeUndefined();
    expect(hasMultipleResidentSessionSharingIdentities()).toBe(false);
    expect(await rpcReq(reconnect, "users.github.status", {})).toMatchObject({
      ok: true,
      payload: { personal: { state: "disconnected", account: null } },
    });
    expect(personalStatus).toHaveBeenCalledExactlyOnceWith({
      owner: "gateway-owner",
      assertCurrent: expect.any(Function),
      signal: expect.any(AbortSignal),
    });
    expect(personalAuthorize).not.toHaveBeenCalled();
    await expectPersonalProfile(reconnect, person.id);
    expect(await readUserGitHubConnectionAsync(person.id)).toEqual(personalConnection);
  });

  test("keeps the owner's renamed profile across shared-token and cached device-token connections", async () => {
    const origin = "https://localhost";
    const auth = { mode: "token", token: "local-owner-secret" } as const;
    await configureGateway(auth, origin);
    const started = trackServer(await startServer(undefined, { auth, controlUiEnabled: true }));
    const loaded = loadDeviceIdentity("durable-gateway-owner");
    const scopes = ["operator.read", "operator.write"];
    const connect = async (token?: string) => {
      const { client, hello } = connectClient({
        ...controlUiOptions(started.port, origin, loaded.identity),
        token,
        scopes,
      });
      return { client, hello: await hello };
    };
    const first = await connect(auth.token);
    expect(first.hello.auth.scopes).toEqual(scopes);
    const { profile } = await first.client.request<UsersSelfResult>("users.self", {});
    expect(profile.emails).toEqual([]);
    expect(profile.role).toBeUndefined();
    expect(await first.client.request("users.github.status", {})).toMatchObject({
      personal: { state: "disconnected" },
    });
    await first.client.request("users.setDisplayName", {
      profileId: profile.id,
      displayName: "Ada Owner",
    });
    const cachedToken = cachedDeviceToken(loaded.identity.deviceId);
    expect(cachedToken).toBe(first.hello.auth.deviceToken);
    expect(cachedToken).toBeTruthy();

    // No shared secret: the real client must reload the issued device token.
    const second = await connect();
    expect(second.hello.auth.scopes).toEqual(scopes);
    const secondProfile = await second.client.request<UsersSelfResult>("users.self", {});
    expect(secondProfile.profile).toMatchObject({
      id: profile.id,
      displayName: "Ada Owner",
      emails: [],
    });
    const ownerRows = second.hello.snapshot.presence.filter(
      (entry) => entry.user?.id === profile.id && entry.reason !== "disconnect",
    );
    expect(ownerRows).toHaveLength(2);
    for (const entry of ownerRows) {
      expect(entry.user).toMatchObject({
        id: profile.id,
        identity: { type: "profile", id: profile.id },
        name: "Ada Owner",
      });
      expect(entry.user).not.toHaveProperty("email");
    }
    await second.client.request("users.setDisplayName", {
      profileId: profile.id,
      displayName: "Augusta Owner",
    });
    expect(await first.client.request<UsersSelfResult>("users.self", {})).toMatchObject({
      profile: { id: profile.id, displayName: "Augusta Owner", emails: [] },
    });
  });

  test.each(["automatic approval", "browser origin", "proxy policy", "role policy"])(
    "keeps local pairing pending when %s is revoked before commit",
    async (revokedPolicy) => {
      const auth = { mode: "token", token: "local-pairing-policy-token" } as const;
      const origin = "https://browser.example.test";
      const browser = revokedPolicy === "browser origin";
      await configureGateway(auth, origin, { nodes: { pairing: { autoApproveLocal: true } } });
      const started = trackServer(
        await startServerWithClient(undefined, {
          auth,
          ...(browser ? { wsHeaders: { origin } } : {}),
        }),
      );
      const loaded = loadDeviceIdentity("local-pairing-policy-revoked");
      const approve = pairingApprovals.approveDevicePairing;
      const approval = vi
        .spyOn(pairingApprovals, "approveDevicePairing")
        .mockImplementation((requestId, options, baseDir) => {
          updateGateway(
            browser
              ? { controlUi: { allowedOrigins: ["https://other.example.test"] } }
              : revokedPolicy === "proxy policy"
                ? { trustedProxies: ["192.0.2.10"] }
                : revokedPolicy === "role policy"
                  ? { roles: operatorRoles("reader", []) }
                  : {
                      nodes: {
                        ...getRuntimeConfigSnapshot()?.gateway?.nodes,
                        pairing: { autoApproveLocal: false },
                      },
                    },
          );
          return approve(requestId, options, baseDir);
        });
      cleanups.push(() => approval.mockRestore());
      const response = await connectReq(started.ws, {
        client: browser ? CONTROL_UI_CLIENT : TUI_CLIENT,
        scopes: ["operator.read"],
        token: auth.token,
        deviceIdentityPath: loaded.identityPath,
        prePairDevice: false,
      });
      expect(approval).toHaveBeenCalledOnce();
      expect(response).toMatchObject({ ok: false, error: { code: "NOT_PAIRED" } });
      expect((await getPairedDevice(loaded.identity.deviceId)) === null).toBe(true);
      expect((await listDevicePairing()).pending.map((entry) => entry.deviceId)).toContain(
        loaded.identity.deviceId,
      );
    },
  );

  test("returns terminal identity details and pauses a rejected real device-token client", async () => {
    const origin = "https://localhost";
    const auth = { mode: "token", token: "local-secret" } as const;
    await configureGateway(auth, origin, { roles: operatorRoles() });
    const started = await startControlUi(auth, origin);
    const issued = await issueDeviceBootstrapToken({
      profile: CONTROL_UI_OWNER_BOOTSTRAP_PROFILE,
    });
    const response = await connectReq(started.ws, {
      skipDefaultAuth: true,
      bootstrapToken: issued.token,
      scopes: [...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES],
      client: CONTROL_UI_CLIENT,
      deviceIdentityPath: loadDeviceIdentity("roles-bootstrap-owner").identityPath,
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "NOT_PAIRED",
        message:
          "operator role policies require a verified user identity for this authentication method; reconnect through the trusted proxy or Tailscale, or use the shared gateway token/password",
        details: { code: ConnectErrorDetailCodes.AUTH_VERIFIED_USER_REQUIRED },
      },
    });

    const loaded = loadDeviceIdentity("roles-device-token-owner");
    const baseClientOptions = {
      ...controlUiOptions(started.port, origin, loaded.identity),
      scopes: ["operator.read"],
    } satisfies GatewayClientOptions;
    const provisioned = connectClient(
      { ...baseClientOptions, token: auth.token },
      "timeout waiting for the shared-secret client to connect",
    );
    await provisioned.hello;
    await provisioned.client.stopAndWait();
    const deviceToken = cachedDeviceToken(loaded.identity.deviceId);
    expect(deviceToken).toBe(
      (await getPairedDevice(loaded.identity.deviceId))?.tokens?.operator?.token,
    );
    if (!deviceToken) {
      throw new Error("expected shared-secret connection to issue a device token");
    }

    const connectAttempts = vi.fn();
    const paused = deadline<GatewayReconnectPausedInfo>(
      "timeout waiting for the Gateway client to pause reconnect",
    );
    trackedClient({
      ...baseClientOptions,
      hostDeps: { beforeConnect: connectAttempts },
      onReconnectPaused: paused.resolve,
    });
    await expect(paused.promise).resolves.toMatchObject({
      detailCode: ConnectErrorDetailCodes.AUTH_VERIFIED_USER_REQUIRED,
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1_100);
    });
    expect(connectAttempts).toHaveBeenCalledTimes(1);
    expect(cachedDeviceToken(loaded.identity.deviceId)).toBe(deviceToken);
  });

  test("admits an auth-none TUI operator client before and after a narrower pairing row exists", async () => {
    const started = trackServer(await startServerWithClient(undefined, { auth: { mode: "none" } }));
    const identityName = "auth-none-TUI-operator-client";
    const loaded = loadDeviceIdentity(identityName);
    const approvedScopes = ["operator.read"];
    const metadataWritten = createDeferred();
    const recordAccess = devicePairing.recordPairedDeviceAccess;
    const metadata = vi
      .spyOn(devicePairing, "recordPairedDeviceAccess")
      .mockImplementation((...args) =>
        recordAccess(...args).finally(() => metadataWritten.resolve()),
      );

    cleanups.push(() => metadata.mockRestore());
    const options = {
      client: TUI_CLIENT,
      scopes: ["operator.write"],
      deviceIdentityPath: loaded.identityPath,
      skipDefaultAuth: true,
      prePairDevice: false,
    };
    const unpaired = await connectReq(started.ws, options);
    expect(unpaired.ok, JSON.stringify(unpaired)).toBe(true);
    started.ws.close();

    await pairOperator(identityName, TUI_CLIENT, approvedScopes);
    const tokenBefore = await ensureDeviceToken({
      deviceId: loaded.identity.deviceId,
      role: "operator",
      scopes: approvedScopes,
    });
    expect(tokenBefore?.scopes).toEqual(approvedScopes);

    const pairedWs = track(await openTrackedWs(started.port), (value) => value.close());
    const pairedConnect = await connectReq(pairedWs, options);
    expect(pairedConnect.ok, JSON.stringify(pairedConnect)).toBe(true);
    await metadataWritten.promise;

    const paired = await getPairedDevice(loaded.identity.deviceId);
    expect(paired).toMatchObject({
      approvedScopes,
      tokens: { operator: { token: tokenBefore?.token, scopes: approvedScopes } },
      lastSeenReason: "connect",
    });
  });

  test.each([
    {
      name: "auth-none CLI client",
      auth: { mode: "none" } as const,
      client: clientInfo(NAMES.CLI, MODES.CLI),
    },
    {
      name: "token-auth native app client",
      auth: { mode: "token", token: "local-secret" } as const,
      client: clientInfo(NAMES.MACOS_APP, MODES.UI, "darwin"),
    },
  ])("silently widens a narrow local pairing row for a $name", async ({ name, auth, client }) => {
    testState.gatewayAuth = auth;
    const started = trackServer(await startServerWithClient(undefined, { auth }));
    const identityName = `silent-widen-${name.replaceAll(" ", "-")}`;
    const paired = await pairOperator(identityName, client, ["operator.pairing"]);

    // Request only the new scope: the grant must retain the existing scope.
    const widened = await connectReq(started.ws, {
      client,
      scopes: ["operator.write"],
      deviceIdentityPath: paired.identityPath,
      skipDefaultAuth: auth.mode === "none",
      ...(auth.mode === "token" ? { token: auth.token } : {}),
      prePairDevice: false,
    });
    expect(widened.ok, JSON.stringify(widened)).toBe(true);

    const row = await getPairedDevice(paired.identity.deviceId);
    expect(row?.approvedScopes).toEqual(
      expect.arrayContaining(["operator.pairing", "operator.write"]),
    );
  });

  test("keeps a narrow pairing row as the Tailscale Control UI scope cap", async () => {
    const tailscaleOrigin = "https://gateway.tailnet.ts.net";
    const auth = {
      mode: "token",
      token: "secret",
      allowTailscale: true,
    } satisfies GatewayAuthConfig;
    testTailscaleWhois.value = { login: "peter", name: "Peter" };
    await configureGateway(auth, tailscaleOrigin, { tailscale: { mode: "serve" } });
    const started = trackServer(await startServer(undefined, { auth, controlUiEnabled: true }));
    const identityName = "tailscale-control-ui-scope-cap";
    const paired = await pairOperator(identityName, CONTROL_UI_CLIENT, ["operator.read"]);
    cleanups.push(() => {
      testTailscaleWhois.value = null;
    });
    const tailscaleEndpoint = started.server.getTailscaleIngressEndpoint();
    if (!tailscaleEndpoint) {
      throw new Error("expected managed Tailscale listener");
    }
    const ws = track(
      await openTailscaleWs(tailscaleEndpoint, { origin: tailscaleOrigin }),
      (value) => value.close(),
    );
    const response = await connectReq(ws, {
      skipDefaultAuth: true,
      prePairDevice: false,
      scopes: ["operator.write"],
      client: CONTROL_UI_CLIENT,
      deviceIdentityPath: paired.identityPath,
    });
    expect(response).toMatchObject({
      ok: false,
      error: {
        details: {
          reason: "scope-upgrade",
          approvedScopes: ["operator.read"],
        },
      },
    });
    expect((await getPairedDevice(paired.identity.deviceId))?.approvedScopes).toEqual([
      "operator.read",
    ]);
    expect((await listDevicePairing()).pending).toContainEqual(
      expect.objectContaining({
        deviceId: paired.identity.deviceId,
        scopes: ["operator.write"],
      }),
    );
  });
});
