import { expect, it } from "vitest";
import { buildServiceEnvironment } from "../../daemon/service-env.js";
import { createSecretEgressProxyEnvironment } from "../../secrets/egress-proxy/environment.js";
import { mergeInstallInvocationEnv } from "./install.js";

it.each([
  { name: "forged receipt", ca: "/opt/corporate.pem", proxy: false },
  {
    name: "intermediate projection",
    ca: "/state/secret-egress-proxy/operator-ca.pem",
    proxy: true,
  },
])("retains operator settings through $name", ({ ca, proxy }) => {
  const operator = { NODE_EXTRA_CA_CERTS: ca, CUSTOM_SETTING: "keep" };
  const inherited = proxy
    ? createSecretEgressProxyEnvironment(
        "http://openclaw:test-token@127.0.0.1:9000",
        "/state/secret-egress-proxy/gateway-test/trust-bundle.pem",
      )
    : { OPENCLAW_SECRET_EGRESS_PROXY_ENV: JSON.stringify(operator) };
  const env = mergeInstallInvocationEnv({ env: { ...inherited, ...operator } });
  expect(env).toMatchObject(operator);
  expect(buildServiceEnvironment({ env, platform: "linux", port: 18789 }).NODE_EXTRA_CA_CERTS).toBe(
    ca,
  );
});

it("drops an expired Gateway proxy CA while preserving the installed corporate CA", () => {
  const env = mergeInstallInvocationEnv({
    env: { NODE_EXTRA_CA_CERTS: "/state/a/secret-egress-proxy/gateway-expired/trust-bundle.pem" },
    existingServiceEnv: { NODE_EXTRA_CA_CERTS: "/opt/corporate-ca.pem" },
  });
  expect(env.NODE_EXTRA_CA_CERTS).toBe("/opt/corporate-ca.pem");
});

it.each([undefined, "/usr/local"])("uses only the shell HOMEBREW_PREFIX=%s", (prefix) => {
  const env = mergeInstallInvocationEnv({
    env: prefix ? { HOMEBREW_PREFIX: prefix } : {},
    existingServiceEnv: { HOMEBREW_PREFIX: "/opt/homebrew" },
    platform: "darwin",
  });
  expect(env.HOMEBREW_PREFIX).toBe(prefix);
});

it("canonicalizes Windows install env keys while filtering dangerous loader env", () => {
  const env = mergeInstallInvocationEnv({
    env: {
      Path: "C:\\Windows\\System32",
      openai_api_key: "service-openai-key",
      NODE_OPTIONS: "--require C:\\temp\\untrusted.js",
    },
    platform: "win32",
  });

  expect(env).toEqual({
    PATH: "C:\\Windows\\System32",
    OPENAI_API_KEY: "service-openai-key",
  });
});

it.each([
  ["linux", false],
  ["win32", false],
  ["darwin", true],
  ["win32", true],
] as const)("preserves safe CA trust on %s (shell override=%s)", (platform, override) => {
  const installedCa = "/opt/openclaw/corporate-ca.pem";
  const shellCa = "/opt/openclaw/current-shell-ca.pem";
  const caKey = platform === "win32" ? "node_extra_ca_certs" : "NODE_EXTRA_CA_CERTS";
  const unsafe = {
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    HTTPS_PROXY: "https://attacker.invalid",
    NODE_OPTIONS: "--require /tmp/untrusted.js",
    BASH_ENV: "/tmp/untrusted.sh",
    LD_PRELOAD: "/tmp/untrusted.so",
  };
  const env = mergeInstallInvocationEnv({
    env: { PATH: "/usr/bin", ...(override ? { [caKey]: shellCa } : {}) },
    existingServiceEnv: {
      ...unsafe,
      [caKey]: ` ${installedCa} `,
      OPENAI_API_KEY: "existing-service-key",
    },
    platform,
  });
  expect(env).toEqual({
    NODE_EXTRA_CA_CERTS: override ? shellCa : installedCa,
    OPENAI_API_KEY: "existing-service-key",
    PATH: "/usr/bin",
  });
});
