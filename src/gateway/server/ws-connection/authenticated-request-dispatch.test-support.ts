import { vi } from "vitest";
import type { ResponseFrame } from "../../../../packages/gateway-protocol/src/schema/frames.js";
import { createDeferredCore, type Deferred } from "../../../shared/deferred.js";
import { GatewayClientRegistry } from "../client-registry.js";
import type { GatewayWsClient } from "../ws-types.js";
import { createGatewayAuthenticatedRequestDispatcher } from "./authenticated-request-dispatch.js";
import type { GatewayWsMessageHandlerParams as Handler } from "./message-handler-types.js";

export function createOperatorWsClient(
  overrides: {
    connId?: string;
    socket?: unknown;
    clientInfo?: { id: string; mode: string };
    scopes?: string[];
  } = {},
): GatewayWsClient {
  return {
    socket: overrides.socket ?? {},
    connId: overrides.connId ?? "dispatch-test-connection",
    usesSharedGatewayAuth: false,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: overrides.clientInfo?.id ?? "gateway-client",
        version: "dev",
        platform: "test",
        mode: overrides.clientInfo?.mode ?? "backend",
      },
      role: "operator",
      scopes: overrides.scopes ?? ["operator.admin"],
    },
  } as GatewayWsClient;
}

export function createDispatchTestHarness(
  options: {
    connId?: string;
    extraHandlers?: Handler["extraHandlers"];
    buildRequestContext?: () => unknown;
    isClosed?: () => boolean;
    getRequiredSharedGatewaySessionGeneration?: () => string | undefined;
  } = {},
) {
  const clients = new GatewayClientRegistry();
  const responses = new Map<string, Deferred<ResponseFrame>>();
  const responseFor = (id: string) => {
    const response = responses.get(id) ?? createDeferredCore<ResponseFrame>();
    responses.set(id, response);
    return response;
  };
  const send = vi.fn<Handler["send"]>(() => ({ kind: "sent" }));
  // Record before the replaceable spy; one promise per id retains its first response.
  const sendForDispatcher = (frame: unknown) => {
    const response = frame as ResponseFrame;
    if (response?.type === "res") {
      responseFor(response.id).resolve(response);
    }
    return send(frame) ?? ({ kind: "sent" } as const);
  };
  const effects = {
    close: vi.fn(),
    setCloseCause: vi.fn(),
    logGateway: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const config = {};
  const context = { broadcast: vi.fn(), getRuntimeConfig: () => config };
  const dispatcher = createGatewayAuthenticatedRequestDispatcher({
    handler: {
      socket: { acceptsDeflatedSegments: false },
      clients,
      connId: options.connId ?? "dispatch-test-connection",
      extraHandlers: options.extraHandlers ?? {},
      buildRequestContext: () => (options.buildRequestContext?.() ?? context) as never,
      send: sendForDispatcher,
      ...effects,
      isClosed: options.isClosed ?? (() => false),
      getRequiredSharedGatewaySessionGeneration: options.getRequiredSharedGatewaySessionGeneration,
    } as unknown as Handler,
    isWebchatConnect: () => false,
  });
  return {
    clients,
    awaitResponseFrame: (id: string) => responseFor(id).promise,
    ...effects,
    dispatcher: {
      dispatch: (
        frame: unknown,
        client: GatewayWsClient,
        ...delivery: [admission?: "continuation", sendResponse?: Handler["send"]]
      ) =>
        dispatcher.dispatch(frame, client, Buffer.byteLength(JSON.stringify(frame)), ...delivery),
    },
    send,
  };
}
