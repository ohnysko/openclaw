import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import type { ControlUiMockGatewayScenario } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { controlUiSessionUrl, installMockGateway } from "./new-session-page.test-support.ts";

export const foregroundKey = "agent:main:dashboard:palette-foreground";
export const appearanceKey = "agent:main:dashboard:palette-appearance";
export const foregroundDraft = "Keep this unsent foreground draft exactly as it is.";
const caret = 10;
const workspace = "/workspace/palette-fixture";
const session = (key: string, label: string, age = 60_000) =>
  createControlUiSessionRow(key, label, Date.now() - age);

export const button = (scope: Page | Locator, name: string | RegExp) =>
  scope.getByRole("button", { name, exact: true });
export const option = (scope: Page | Locator, name: string | RegExp) =>
  scope.getByRole("option", { name, exact: true });
export const isFocused = (locator: Locator) =>
  locator.evaluate((element) => document.activeElement === element);

export function paletteAnchors(palette: Locator) {
  return palette.evaluate((element) =>
    [
      ".cmd-palette",
      ".cmd-palette__input",
      ".cmd-palette__create",
      'button[aria-label="New session settings"]',
    ].map((selector) => {
      const node = element.querySelector(selector);
      if (!node) {
        throw new Error("Missing anchor: " + selector);
      }
      const { x, y } = node.getBoundingClientRect();
      return { x, y };
    }),
  );
}

export function scenario(
  methodResponses: Record<string, unknown> = {},
): ControlUiMockGatewayScenario {
  return {
    sessionKey: foregroundKey,
    workspace,
    workspaceGit: true,
    operatorScopes: ["operator.read", "operator.write"],
    featureMethods: [
      "agent.wait",
      "chat.metadata",
      "chat.startup",
      "sessions.create",
      "sessions.dispatch",
      "sessions.search",
    ],
    sessions: [
      session(foregroundKey, "Foreground planning"),
      session(appearanceKey, "Appearance audit", 120_000),
    ],
    historyMessages: [
      { role: "assistant", content: [{ type: "text", text: "The foreground task stays here." }] },
    ],
    methodResponses: {
      "sessions.list": {
        cases: [
          {
            match: { search: "appearance" },
            response: {
              ts: 1,
              path: "",
              defaults: {},
              count: 1,
              sessions: [session(appearanceKey, "Appearance audit")],
            },
          },
        ],
      },
      "agents.list": {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: ["main", "reviewer"].map((id) => ({
          id,
          name: id === "main" ? "Main" : "Reviewer",
          workspace,
          workspaceGit: true,
          model: { primary: "openai/gpt-5.5" },
        })),
      },
      "agent.identity.get": {
        cases: [
          { match: { agentId: "main" }, response: { agentId: "main", name: "Main" } },
          { match: { agentId: "reviewer" }, response: { agentId: "reviewer", name: "Reviewer" } },
        ],
      },
      "environments.list": {
        environments: [
          {
            id: "node:palette-runner",
            type: "node",
            label: "Palette runner",
            status: "available",
            sessionHost: true,
            workerSlots: { total: 2, available: 1 },
          },
        ],
        profiles: [],
      },
      "worktrees.branches": {
        branches: [{ kind: "local", name: "main" }],
        defaultBranch: "main",
        repositoryStatus: "git",
      },
      ...methodResponses,
    },
  };
}

export async function openFromForeground(page: Page, baseUrl: string) {
  await page.goto(controlUiSessionUrl(baseUrl, foregroundKey));
  const composer = page.locator(".agent-chat__composer-combobox textarea:visible");
  await composer.fill(foregroundDraft);
  await composer.evaluate((element: HTMLTextAreaElement, offset) => {
    element.focus();
    element.setSelectionRange(offset, offset);
  }, caret);
  const url = page.url();
  await page.keyboard.press("ControlOrMeta+K");
  const palette = page.locator("openclaw-command-palette");
  const input = palette.locator(".cmd-palette__input");
  await input.waitFor({ state: "visible" });
  await expect
    .poll(() => input.evaluate((element) => document.activeElement === element))
    .toBe(true);
  return { composer, url, palette, input };
}

export async function openMockPalette(page: Page, baseUrl: string, fixture = scenario()) {
  const gateway = await installMockGateway(page, fixture);
  return { gateway, ...(await openFromForeground(page, baseUrl)) };
}

export async function expectForegroundUnchanged(page: Page, composer: Locator, url: string) {
  expect(page.url()).toBe(url);
  expect(await composer.inputValue()).toBe(foregroundDraft);
  await expect
    .poll(() =>
      composer.evaluate((element: HTMLTextAreaElement) => ({
        focused: document.activeElement === element,
        start: element.selectionStart,
        end: element.selectionEnd,
      })),
    )
    .toEqual({ focused: true, start: caret, end: caret });
}
