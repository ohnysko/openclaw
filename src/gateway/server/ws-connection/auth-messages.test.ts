import { describe, expect, it } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { truncateCloseReason } from "../close-reason.js";
import { formatGatewayAuthFailureMessage } from "./auth-messages.js";

type MessageParams = Parameters<typeof formatGatewayAuthFailureMessage>[0];
const cli = { id: GATEWAY_CLIENT_IDS.CLI, mode: GATEWAY_CLIENT_MODES.CLI };
const node = { id: GATEWAY_CLIENT_IDS.NODE_HOST, mode: GATEWAY_CLIENT_MODES.NODE };
function expectMessage(params: Partial<MessageParams>, expected: string, checkCloseLimit = false) {
  const message = formatGatewayAuthFailureMessage({
    authMode: "token",
    authProvided: "token",
    ...params,
  });
  expect(message).toBe(expected);
  if (checkCloseLimit) {
    expect(truncateCloseReason(message)).toBe(message);
  }
  return message;
}

describe("formatGatewayAuthFailureMessage", () => {
  it.each(["token_redacted_config", "password_redacted_config"])(
    "names redaction corruption and its remedy for %s within the close limit",
    (reason) => {
      const message = formatGatewayAuthFailureMessage({
        authMode: "token",
        authProvided: "token",
        reason,
      });
      expect(message).toContain("redaction sentinel");
      expect(message).toContain("openclaw doctor --fix");
      expect(truncateCloseReason(message)).toBe(message);
    },
  );

  it.each(["bootstrap_token_invalid", undefined])(
    "warns that a rejected setup code may already be used for reason %s",
    (reason) => {
      expectMessage(
        { authProvided: "bootstrap-token", reason },
        "unauthorized: setup code invalid, expired, revoked, or already used (create a new code; review `openclaw devices list`)",
        true,
      );
    },
  );

  it("keeps device-token scope mismatches distinct from token mismatches", () => {
    expectMessage(
      { authProvided: "device-token", reason: "scope_mismatch" },
      "unauthorized: device token scope mismatch (re-pair or approve scope upgrade)",
    );
  });

  it("makes a missing Control UI token actionable within the WebSocket close limit", () => {
    expectMessage(
      {
        authProvided: "none",
        reason: "token_missing",
        client: { id: GATEWAY_CLIENT_IDS.CONTROL_UI, mode: GATEWAY_CLIENT_MODES.WEBCHAT },
      },
      "unauthorized: gateway token missing (paste in Control UI settings or openclaw doctor --generate-gateway-token; restart)",
      true,
    );
  });

  it("points local CLI token mismatches at gateway.auth.token, not gateway.remote", () => {
    const message = expectMessage(
      { reason: "token_mismatch", client: cli, isLocalClient: true },
      "unauthorized: gateway token mismatch (use this gateway's gateway.auth.token or pair the device)",
      true,
    );
    expect(message).not.toContain("gateway.remote");
  });

  it("keeps the gateway.remote.token hint for remote CLI token mismatches", () => {
    expectMessage(
      { reason: "token_mismatch", client: cli, isLocalClient: false },
      "unauthorized: gateway token mismatch (set gateway.remote.token to match gateway.auth.token)",
    );
  });

  it("points local CLI password mismatches at gateway.auth.password", () => {
    expectMessage(
      {
        authMode: "password",
        authProvided: "password",
        reason: "password_mismatch",
        client: cli,
        isLocalClient: true,
      },
      "unauthorized: gateway password mismatch (use this gateway's gateway.auth.password)",
    );
  });

  it("tells rejected node hosts how to diagnose identity-header auth", () => {
    expectMessage(
      {
        authMode: "trusted-proxy",
        authProvided: "none",
        reason: "trusted_proxy_missing_header_cf-access-jwt-assertion",
        client: node,
      },
      "gateway rejected this node: trusted-proxy identity-header authentication is required and no usable machine credential was accepted; run `openclaw doctor` on the Gateway",
    );
  });

  it("does not describe other trusted-proxy rejection causes as missing identity headers", () => {
    expectMessage(
      {
        authMode: "trusted-proxy",
        authProvided: "none",
        reason: "trusted_proxy_local_interface_check_failed",
        client: node,
      },
      "unauthorized",
    );
  });
});
