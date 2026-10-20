import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import { serializeGatewayFrame } from "../../serialized-json.js";
import type { GatewayRequestHandler } from "../../server-methods/types.js";
import { captureSessionRowGeneration } from "../../session-row-identity.js";
import { shareSidebarSessionRows } from "../../session-row-presentation.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";

beforeEach(() => resetDiagnosticEventsForTest());
afterEach(() => resetDiagnosticEventsForTest());

const revision = "private-revision";
const unchanged = { rowsUnchanged: true };
const delta = { rowsDelta: { baseRevision: revision } };
const full = { sessions: [] };
function sessionCase(
  rowMode: string,
  ifRowsRevision: string | undefined,
  payload: unknown,
  rowsOutcome: string,
) {
  const params = { rowMode, ...(ifRowsRevision !== undefined ? { ifRowsRevision } : {}) };
  return { params, payload, rowsOutcome };
}

async function dispatch(
  method: string,
  params: Record<string, unknown>,
  payload: unknown,
  delivery: "wire" | "shared" | "internal" | "error" | "unavailable" | "serialization" = "wire",
) {
  const events: Extract<DiagnosticEventPayload, { type: "gateway.rpc"; phase: "response" }>[] = [];
  onTestFinished(
    onInternalDiagnosticEvent(
      (event) => {
        if (event.type === "gateway.rpc" && event.phase === "response") {
          events.push(event);
        }
      },
      { include: ["gateway.rpc"] },
    ),
  );
  const handler = vi.fn<GatewayRequestHandler>(({ respond }) =>
    respond(delivery !== "error", payload),
  );
  const harness = createDispatchTestHarness({ extraHandlers: { [method]: handler } });
  harness.send.mockReturnValue(
    delivery === "unavailable" ? { kind: "unavailable" } : { kind: "sent", bytes: 1234 },
  );
  if (delivery === "serialization") {
    harness.send.mockReturnValueOnce({ kind: "serialization", error: new Error("synthetic") });
  }
  const client = createOperatorWsClient({
    clientInfo: { id: "openclaw-control-ui", mode: "webchat" },
  });
  if (delivery === "shared") {
    client.authenticatedUserProfile = {
      profileId: "private-profile",
      displayName: "Test operator",
      hasAvatar: false,
      avatarRevision: "0",
      updatedAt: 0,
    };
  }
  const request = { type: "req", id: "private-request", method, params };
  await harness.dispatcher.dispatch(
    request,
    client,
    undefined,
    delivery === "internal" ? (frame) => harness.send(frame) : undefined,
  );
  if (delivery === "shared") {
    await harness.dispatcher.dispatch({ ...request, id: "private-follower" }, client);
    expect(handler).toHaveBeenCalledOnce();
    for (const [frame] of harness.send.mock.calls) {
      expect(JSON.parse(serializeGatewayFrame(frame).toString()).payload).toEqual(payload);
    }
  }
  await waitForDiagnosticEventsDrained();
  return events;
}

it.each(["wire", "shared", "internal"] as const)(
  "attributes base misses out-of-band through %s responses",
  async (delivery) => {
    const row = { key: "one", kind: "direct", updatedAt: 1 } as const;
    const previous = [row];
    const base = shareSidebarSessionRows(previous);
    const changed = [{ ...row, updatedAt: 2 }];
    for (const [token, reason] of [
      [`delta:${base.rowsRevision}`, "all-rows-changed"],
      ["delta:unknown", "unknown-base"],
    ] as const) {
      const payload = shareSidebarSessionRows(changed, token, [
        captureSessionRowGeneration(previous),
      ]);
      expect(Object.keys(payload).toSorted()).toEqual(["rowsRevision", "sessions", "sharedFacts"]);
      const events = await dispatch(
        "sessions.list",
        { rowMode: "sidebar", ifRowsRevision: token },
        payload,
        delivery,
      );
      expect(events).toHaveLength(delivery === "shared" ? 2 : 1);
      for (const event of events) {
        expect(event.sessionsList).toMatchObject({
          rowsOutcome: "full-with-base",
          baseMissReason: reason,
        });
      }
    }
    const noBase = shareSidebarSessionRows(changed);
    const events = await dispatch("sessions.list", { rowMode: "sidebar" }, noBase, delivery);
    expect(events[0]?.sessionsList).not.toHaveProperty("baseMissReason");
  },
);

it.each([
  sessionCase("sidebar", revision, unchanged, "unchanged"),
  sessionCase("sidebar", `delta:${revision}`, delta, "delta"),
  sessionCase("sidebar", undefined, full, "full-no-base"),
  sessionCase("sidebar", `delta:${revision}`, full, "full-with-base"),
  sessionCase("sidebar", revision, full, "full-with-base"),
  sessionCase("compact", undefined, full, "not-sidebar"),
  sessionCase("compact", "", full, "full-no-base"),
  sessionCase("compact", revision, unchanged, "unchanged"),
  sessionCase("compact", `delta:${revision}`, delta, "delta"),
])(
  "attributes session response bytes as $rowsOutcome",
  async ({ params, payload, rowsOutcome }) => {
    for (const delivery of ["wire", "shared"] as const) {
      const events = await dispatch(
        "sessions.list",
        { ...params, source: "sidebar" },
        payload,
        delivery,
      );
      const expected = {
        responseBytes: 1234,
        sessionsList: {
          clientKind: "openclaw-control-ui",
          source: "wire",
          callerSource: "sidebar",
          rowMode: params.rowMode,
          filter: "general",
          rowsOutcome,
        },
      };
      expect(events).toMatchObject(delivery === "shared" ? [expected, expected] : [expected]);
      expect(JSON.stringify(events)).not.toContain("private-");
    }
  },
);

it.each([
  [{ cursor: "private-cursor", limit: 20 }, "delta", "cursor", "<=20"],
  [{ offset: 1, limit: 21 }, undefined, "older", "<=80"],
  [{ pendingBefore: 2, offset: 1, limit: 80 }, undefined, "pending", "<=80"],
  [
    { inputRunIds: ["private-run"], cursor: "private-cursor", pendingBefore: 2, limit: 81 },
    "reset",
    "receipt",
    "<=200",
  ],
  [{ offset: 0 }, undefined, "tail", "<=200"],
  [{ messageId: "private-anchor", sessionId: "private-archive" }, undefined, "anchor", "<=200"],
  [{ limit: 201 }, undefined, "tail", ">200"],
] as const)(
  "attributes validated history response shape (%j, %s, %s, %s)",
  async (params, kind, shape, limitBucket) => {
    const events = await dispatch(
      "chat.history",
      { sessionKey: "private-session", ...params },
      { kind },
    );
    expect(events).toMatchObject([
      {
        responseBytes: 1234,
        chatHistory: {
          clientKind: "openclaw-control-ui",
          source: "wire",
          shape,
          limitBucket,
          outcome: kind ?? "page",
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("private-");
  },
);

it("preserves internal history source and excludes failed responses and startup", async () => {
  const params = { sessionKey: "private-session", cursor: "private-cursor" };
  expect(await dispatch("chat.history", params, { kind: "delta" }, "internal")).toMatchObject([
    { responseBytes: 1234, chatHistory: { source: "internal", shape: "cursor", outcome: "delta" } },
  ]);
  for (const method of ["sessions.list", "chat.history", "chat.startup"]) {
    for (const delivery of ["error", "unavailable", "serialization"] as const) {
      const events = await dispatch(method, params, { kind: "delta" }, delivery);
      expect(events).toHaveLength(1);
      expect(events[0]).not.toHaveProperty("chatHistory");
      expect(events[0]).not.toHaveProperty("sessionsList");
    }
  }
  expect(await dispatch("chat.startup", params, { kind: "delta" })).toEqual([
    expect.not.objectContaining({ chatHistory: expect.anything() }),
  ]);
});
