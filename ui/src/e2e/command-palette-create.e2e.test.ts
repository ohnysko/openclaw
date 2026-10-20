import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { BrowserContextOptions, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  expectPaletteProjectGrouping,
  expectPaletteSettingsAlignment,
} from "./command-palette-settings.test-support.ts";
import {
  appearanceKey,
  button,
  isFocused,
  option,
  foregroundKey,
  foregroundDraft,
  scenario,
  openMockPalette,
  expectForegroundUnchanged,
} from "./command-palette.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  controlUiSessionPath,
  controlUiSessionUrl,
  installMockGateway,
  pollCount,
  pollEnabled,
  pollText,
  pollAttribute,
} from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "command palette background creation",
  browserLaunchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
});
type PaletteFixture = Awaited<ReturnType<typeof openMockPalette>> & { page: Page };
function withPalette(
  run: (fixture: PaletteFixture) => Promise<void>,
  fixture = scenario(),
  options: BrowserContextOptions = createControlUiE2eContextOptions(),
) {
  return suite.withPage(options, async ({ page }) =>
    run({ page, ...(await openMockPalette(page, suite.server.baseUrl, fixture)) }),
  );
}

async function changePicker(
  picker: Locator,
  eventType: "overlay-after-show" | "overlay-after-hide",
  action: () => Promise<void>,
) {
  await Promise.all([
    picker.evaluate(
      (element, type) =>
        new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(() => {
            element.removeEventListener(type, settled);
            reject(new Error(`Missing ${type} from ${element.className}`));
          }, 10_000);
          const settled = (event: Event) => {
            if (event.target !== element) {
              return;
            }
            window.clearTimeout(timer);
            element.removeEventListener(type, settled);
            resolve();
          };
          element.addEventListener(type, settled);
        }),
      eventType,
    ),
    action(),
  ]);
}

suite.define(() => {
  it("preserves manual prompt scrolling when background destination discovery finishes", async () => {
    await withPalette(
      async ({ page, gateway, composer, url, palette, input }) => {
        await gateway.waitForRequest("environments.list");
        const hints = palette.locator(".cmd-palette__hint");
        await pollCount(hints).toBe(3);
        const alignment = await hints.evaluateAll((rows) =>
          rows.map((row) => {
            const key = row.querySelector("kbd");
            const label = row.querySelector(":scope > span");
            if (!key || !label) {
              throw new Error("Shortcut hint is missing its keycap or label");
            }
            const keyBox = key.getBoundingClientRect();
            const labelBox = label.getBoundingClientRect();
            return keyBox.y + keyBox.height / 2 - labelBox.y - labelBox.height / 2;
          }),
        );
        for (const delta of alignment) {
          expect(Math.abs(delta)).toBeLessThan(0.1);
        }
        const prompt = Array.from(
          { length: 8 },
          (_, index) => `Task line ${index + 1}: Review the complete task before starting.`,
        ).join("\n");
        await input.fill(prompt);
        const search = palette.locator(".cmd-palette__search");
        await expect
          .poll(() => search.evaluate((element: HTMLElement) => element.inert))
          .toBe(true);
        expect(await gateway.getRequests("sessions.search")).toEqual([]);
        await expect.poll(() => input.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await input.hover();
        await page.mouse.wheel(0, -2000);
        await expect.poll(() => input.evaluate((element) => element.scrollTop)).toBe(0);
        expect(await input.evaluate((element: HTMLTextAreaElement) => element.selectionEnd)).toBe(
          prompt.length,
        );

        // Prompt mode pauses search, but destination discovery still updates the
        // real draft controller and rerenders its input without an edit.
        await gateway.resolveDeferred("environments.list");
        // Let the render's layout frame and ResizeObserver delivery finish.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );

        expect(await input.evaluate((element) => element.scrollTop)).toBe(0);
        expect(await input.inputValue()).toBe(prompt);
        expect(await composer.inputValue()).toBe(foregroundDraft);
        expect(page.url()).toBe(url);
        expect(await gateway.getRequests("sessions.create")).toEqual([]);

        await input.pressSequentially(" Continue.");
        await expect
          .poll(() =>
            input.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
        expect(await input.inputValue()).toBe(prompt + " Continue.");
      },
      {
        ...scenario(),
        deferredMethods: ["environments.list"],
      },
    );
  });

  it.each([
    { width: 1280, colorScheme: "dark", reducedMotion: "no-preference" },
    { width: 390, colorScheme: "light", reducedMotion: "reduce" },
  ] as const)(
    "collapses prompt searches in place and restores them at $width px",
    async (options) => {
      await withPalette(
        async ({ page, gateway, palette, input, composer, url }) => {
          await input.fill("appearance");
          await palette.getByRole("option", { name: /^Appearance audit/ }).waitFor();
          await pollAttribute(palette.locator(".cmd-palette__results"), "aria-busy").toBe("false");
          expect(await palette.locator(".cmd-palette__source-error").count()).toBe(0);
          const search = palette.locator(".cmd-palette__search");
          const original = (await palette.locator(".cmd-palette").boundingBox())!;
          const inputTop = (await input.boundingBox())!.y;
          const initialHeight = (await search.boundingBox())!.height;
          const requestCount = (await gateway.getRequests("sessions.search")).length;
          const prompt = "Help me plan the next steps for this small project this week";
          const samples = await input.evaluateHandle((element: HTMLTextAreaElement, value) => {
            const frames: Array<{
              x: number;
              y: number;
              width: number;
              inputY: number;
              searchHeight: number;
            }> = [];
            const start = performance.now();
            const sample = () => {
              const bounds = element.closest(".cmd-palette")!.getBoundingClientRect();
              frames.push({
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                inputY: element.getBoundingClientRect().y,
                searchHeight: element
                  .closest(".cmd-palette")!
                  .querySelector(".cmd-palette__search")!
                  .getBoundingClientRect().height,
              });
              if (performance.now() - start < 400) {
                requestAnimationFrame(sample);
              }
            };
            requestAnimationFrame(sample);
            element.value = value;
            element.dispatchEvent(new Event("input", { bubbles: true }));
            return frames;
          }, prompt);
          await expect
            .poll(() => search.evaluate((element: HTMLElement) => element.inert))
            .toBe(true);
          await expect.poll(async () => (await search.boundingBox())?.height).toBe(0);
          await page.waitForTimeout(450);
          const frames = await samples.jsonValue();
          await samples.dispose();
          expect(frames.length).toBeGreaterThan(1);
          for (const frame of frames) {
            expect(frame.x).toBeCloseTo(original.x, 1);
            expect(frame.y).toBeCloseTo(original.y, 1);
            expect(frame.width).toBeCloseTo(original.width, 1);
            expect(frame.inputY).toBeCloseTo(inputTop, 1);
          }
          if (options.reducedMotion === "no-preference") {
            expect(
              frames.some(
                (frame) => frame.searchHeight > 0 && frame.searchHeight < initialHeight - 1,
              ),
            ).toBe(true);
          } else {
            expect(
              await search.evaluate((element) =>
                Number.parseFloat(getComputedStyle(element).transitionDuration),
              ),
            ).toBeLessThanOrEqual(0.00001);
          }
          expect(await palette.getByRole("group", { name: "Filter search results" }).count()).toBe(
            0,
          );
          expect(await palette.locator(".cmd-palette__search").getByRole("status").count()).toBe(0);
          expect(await palette.getByRole("option").count()).toBe(0);
          expect(await input.getAttribute("aria-controls")).toBeNull();
          expect(await input.getAttribute("aria-activedescendant")).toBeNull();
          expect(await isFocused(input)).toBe(true);
          await input.press("ArrowDown");
          await input.press("Enter");
          expect(await input.inputValue()).toBe(prompt);
          expect(page.url()).toBe(url);
          expect(await composer.inputValue()).toBe(foregroundDraft);
          expect(await gateway.getRequests("sessions.create")).toEqual([]);
          expect(await gateway.getRequests("sessions.search")).toHaveLength(requestCount);
          expect(
            (await gateway.getRequests("sessions.list")).some(
              (request) => isRecord(request.params) && request.params.search === prompt,
            ),
          ).toBe(false);
          await input.fill(prompt.slice(0, 55));
          await page.waitForTimeout(100);
          expect(await search.evaluate((element: HTMLElement) => element.inert)).toBe(true);
          expect(await gateway.getRequests("sessions.search")).toHaveLength(requestCount);
          for (const [index, length] of [50, 59].entries()) {
            const query = prompt.slice(0, length);
            await input.fill(query);
            await pollAttribute(input, "aria-controls").toBe("cmd-palette-listbox");
            expect(await search.evaluate((element: HTMLElement) => element.inert)).toBe(false);
            await expect
              .poll(async () => (await gateway.getRequests("sessions.search")).length)
              .toBe(requestCount + index + 1);
            expect((await gateway.getRequests("sessions.search")).at(-1)?.params).toMatchObject({
              query,
            });
          }
          await input.fill(prompt);
          await expect
            .poll(() => search.evaluate((element: HTMLElement) => element.inert))
            .toBe(true);
          await page.waitForTimeout(100);
          expect(await gateway.getRequests("sessions.search")).toHaveLength(requestCount + 2);
          await input.fill("");
          await expect
            .poll(() => search.evaluate((element: HTMLElement) => element.inert))
            .toBe(false);
          await option(palette, "New session").waitFor();
          await input.fill("appearance");
          await palette.getByRole("option", { name: /^Appearance audit/ }).waitFor();
          expect(await gateway.getRequests("sessions.search")).toHaveLength(requestCount + 3);
          expect((await palette.locator(".cmd-palette").boundingBox())!.y).toBe(original.y);
        },
        scenario({ "models.list": { models: [], refreshFailed: true } }),
        {
          colorScheme: options.colorScheme,
          reducedMotion: options.reducedMotion,
          viewport: { width: options.width, height: 900 },
        },
      );
    },
  );

  it.each([
    { mode: "dark", width: 1280 },
    { mode: "dark", width: 390 },
    { mode: "light", width: 390 },
  ] as const)(
    "aligns settings and preserves keyboard focus in $mode at $width",
    async ({ mode, width }) => {
      await withPalette(
        async ({ page, palette }) => {
          const popup = palette.locator(".oc-popover.palette-session-settings");
          await changePicker(popup, "overlay-after-show", () =>
            button(palette, "New session settings").click(),
          );

          await expectPaletteSettingsAlignment(popup);
          const remember = popup.getByRole("checkbox", { name: /Remember settings for/ });
          expect(await remember.isVisible()).toBe(true);
          const workspaceButton = popup.locator(".palette-session-settings__workspace");
          const search = popup.getByRole("searchbox", { name: "Search", exact: true });
          await workspaceButton.click();
          await search.waitFor({ state: "visible" });

          await expectPaletteProjectGrouping(popup);
          expect.soft(await remember.count()).toBe(0);
          expect
            .soft(await search.evaluate((element) => getComputedStyle(element).outlineStyle))
            .toBe("none");
          // Pointer entry keeps focus inside the nested view without summoning a
          // text caret (or a touch keyboard). Tab still reaches its search field.
          await page.keyboard.press("Tab");
          expect.soft(await isFocused(search)).toBe(true);
          await search.press("Escape");
          expect(await remember.isVisible()).toBe(true);
          expect(await isFocused(workspaceButton)).toBe(true);
          await workspaceButton.press("Enter");
          await search.waitFor({ state: "visible" });
          expect(await isFocused(search)).toBe(true);
          expect(await search.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
            "solid",
          );

          await search.fill("no-such-workspace");
          expect(await popup.locator("[data-machine]").count()).toBe(0);
          await button(popup, "Back").click();
          expect(await remember.isVisible()).toBe(true);
          await workspaceButton.press("Enter");
          expect(await search.inputValue()).toBe("");
          await popup.locator('[data-machine="local"][data-project=""]').click();
          expect(await remember.isVisible()).toBe(true);
        },
        scenario(),
        {
          ...createControlUiE2eContextOptions(),
          colorScheme: mode,
          viewport: { width, height: 900 },
          deviceScaleFactor: 2,
        },
      );
    },
  );

  it("remembers only palette settings and restores defaults when unchecked", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), colorScheme: "light" },
      async ({ page }) => {
        const base = scenario({
          "users.prefs.get": { status: "ok", entries: { "new-session.migration.v1": true } },
          "users.prefs.set": { status: "ok" },
        });
        const { gateway, composer, url, palette, input } = await openMockPalette(
          page,
          suite.server.baseUrl,
          {
            ...base,
            featureMethods: [...(base.featureMethods ?? []), "users.prefs.get", "users.prefs.set"],
            presenceUsers: [{ self: true, id: "palette-user", name: "Example User" }],
          },
        );
        const prompt = "Keep this prompt and its caret while changing preferences.";
        await input.fill(prompt);
        const popup = palette.locator(".oc-popover.palette-session-settings");
        const trigger = button(palette, "New session settings");
        const openSettings = () => changePicker(popup, "overlay-after-show", () => trigger.click());
        await openSettings();
        const remember = popup.getByRole("checkbox", { name: /Remember settings for/ });
        await pollEnabled(remember).toBe(true);
        expect(await remember.isChecked()).toBe(false);

        const agent = popup.locator("openclaw-agent-select");
        await changePicker(agent.locator(".agent-select__menu"), "overlay-after-show", () =>
          agent.getByRole("button", { name: /^Agent:/ }).click(),
        );
        await changePicker(agent.locator(".agent-select__menu"), "overlay-after-hide", () =>
          agent.getByRole("menuitemradio", { name: "Reviewer", exact: true }).press("Escape"),
        );
        expect(await trigger.getAttribute("aria-expanded")).toBe("true");
        expect(
          await popup.getByRole("checkbox", { name: /Remember settings for/ }).isVisible(),
        ).toBe(true);
        await changePicker(agent.locator(".agent-select__menu"), "overlay-after-show", () =>
          agent.getByRole("button", { name: /^Agent:/ }).click(),
        );
        await agent.getByRole("menuitemradio", { name: "Reviewer", exact: true }).click();
        const paletteWrites = async () =>
          (await gateway.getRequests("users.prefs.set")).filter(
            (request) =>
              isRecord(request.params) &&
              isRecord(request.params.entries) &&
              Object.hasOwn(request.params.entries, "new-session.palette.v1"),
          );
        expect(await paletteWrites()).toHaveLength(0);
        await remember.check();
        await expect.poll(async () => (await paletteWrites()).length).toBe(1);
        const saved = (await paletteWrites())[0]!;
        expect(saved.params).toMatchObject({
          entries: { "new-session.palette.v1": { agentId: "reviewer" } },
        });
        if (!isRecord(saved.params) || !isRecord(saved.params.entries)) {
          throw new Error("Missing preference entries");
        }
        expect(Object.keys(saved.params.entries)).toEqual(["new-session.palette.v1"]);
        expect(await popup.getByRole("button", { name: "Use my defaults" }).count()).toBe(0);
        await changePicker(popup, "overlay-after-hide", () =>
          popup.locator(".palette-session-settings__workspace").press("Escape"),
        );
        await input.press("Escape");
        await input.waitFor({ state: "hidden" });
        await page.keyboard.press("ControlOrMeta+K");
        await input.waitFor({ state: "visible" });
        await input.fill(prompt);
        // Establish the editor selection before opening settings. Chromium 151
        // restores its last focused range after a range is injected while blurred.
        await input.evaluate((element: HTMLTextAreaElement) => {
          element.focus();
          element.setSelectionRange(5, 11);
        });
        await openSettings();
        await pollText(agent.getByRole("button", { name: /^Agent:/ })).toContain("Reviewer");
        expect(await remember.isChecked()).toBe(true);

        await remember.uncheck();
        await expect.poll(async () => (await paletteWrites()).length).toBe(2);
        expect((await paletteWrites())[1]!.params).toMatchObject({
          entries: { "new-session.palette.v1": null },
        });
        await pollText(agent.getByRole("button", { name: /^Agent:/ })).toContain("Main");

        expect(await input.inputValue()).toBe(prompt);
        expect(
          await input.evaluate((element: HTMLTextAreaElement) => [
            element.selectionStart,
            element.selectionEnd,
          ]),
        ).toEqual([5, 11]);
        expect(await composer.inputValue()).toBe(foregroundDraft);
        expect(page.url()).toBe(url);
        expect(await gateway.getRequests("sessions.create")).toEqual([]);
      },
    );
  });

  it.each([false, true])(
    "settles a cold create shortcut exactly once (cancelled: %s)",
    async (cancelled) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const createdKey = "agent:main:dashboard:cold-created";
        const gateway = await installMockGateway(
          page,
          scenario({
            "sessions.create": { key: createdKey, runStarted: true, runId: "cold-run" },
          }),
        );
        const module = await holdModuleResponse(
          page,
          controlUiE2eBuiltModuleRequest("ui/src/components/command-palette.tsx"),
        );
        try {
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, foregroundKey));
          const composer = page.locator(".agent-chat__composer-combobox textarea:visible");
          await composer.fill(foregroundDraft);
          const url = page.url();
          await page.keyboard.press("ControlOrMeta+K");
          await module.request;
          const input = page.locator(".cmd-palette__input");
          await input.fill("Start exactly this cold task");
          await input.press("ControlOrMeta+Enter");
          await expect
            .poll(() => input.evaluate((element: HTMLTextAreaElement) => element.readOnly))
            .toBe(true);
          expect(await gateway.getRequests("sessions.create")).toEqual([]);
          if (cancelled) {
            await page.keyboard.press("ControlOrMeta+K");
            await input.waitFor({ state: "hidden" });
          }
          module.release();
          await page.waitForFunction(() => customElements.get("openclaw-command-palette"));
          if (cancelled) {
            await page.keyboard.press("ControlOrMeta+K");
            await input.waitFor({ state: "visible" });
            expect(await input.inputValue()).toBe("");
            expect(await gateway.getRequests("sessions.create")).toEqual([]);
          } else {
            await expect
              .poll(async () => (await gateway.getRequests("sessions.create")).length)
              .toBe(1);
            expect((await gateway.getRequests("sessions.create"))[0]!.params).toMatchObject({
              message: "Start exactly this cold task",
            });
            await input.waitFor({ state: "hidden" });
          }
          expect(page.url()).toBe(url);
          expect(await composer.inputValue()).toBe(foregroundDraft);
        } finally {
          module.release();
        }
      });
    },
  );

  it("keeps settings and session results as launcher actions instead of sending the query", async () => {
    await withPalette(async ({ page, gateway, palette, input }) => {
      await input.fill("appearance");
      const results = palette.locator(".cmd-palette__results");
      await pollAttribute(results, "aria-busy").toBe("false");
      await palette.getByRole("option", { name: /^Appearance audit/ }).waitFor();
      await option(palette, "Appearance Theme and UI settings.").waitFor();

      await input.press("Enter");
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(controlUiSessionPath(appearanceKey));
      await input.waitFor({ state: "hidden" });

      await page.keyboard.press("ControlOrMeta+K");
      await input.fill("appearance");
      await palette.getByRole("option", { name: /^Appearance audit/ }).waitFor();
      await pollAttribute(results, "aria-busy").toBe("false");
      await input.press("ArrowDown");
      await pollText(palette.locator('[aria-selected="true"]')).toContain("Theme and UI settings.");
      await input.press("Enter");
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/appearance");
      expect(await gateway.getRequests("sessions.create")).toEqual([]);
      expect(await gateway.getRequests("chat.send")).toEqual([]);
    }, scenario());
  });

  it.each([
    { destination: "local", width: 1280 },
    { destination: "device", width: 390 },
  ] as const)(
    "starts one $destination task without replacing the foreground draft at $width px",
    async ({ destination, width }) => {
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport: { width, height: 900 } },
        async ({ page }) => {
          const sessionKey = "agent:reviewer:dashboard:palette-created-" + destination;
          const { gateway, composer, url, palette, input } = await openMockPalette(
            page,
            suite.server.baseUrl,
            scenario({
              "sessions.create": {
                key: sessionKey,
                ...(destination === "local"
                  ? { runStarted: true, runId: "palette-local-run" }
                  : {}),
              },
              "sessions.dispatch": {
                ok: true,
                key: sessionKey,
                sessionId: "session:" + sessionKey,
                placement: { state: "active", generation: 1 },
              },
              "sessions.send": { runId: "palette-device-run", status: "started" },
            }),
          );

          const singleLineHeight = (await input.boundingBox())!.height;
          const prompt = "Investigate missing worker error messages.\n".repeat(6).trim();
          const finalLine = "Keep the changes focused.";
          const emptySearch = { ts: 1, path: "", defaults: {}, count: 0, sessions: [] };
          await gateway.setMethodResponse("sessions.list", {
            cases: [
              { match: { search: prompt }, response: emptySearch },
              { match: { search: prompt + "\n" + finalLine }, response: emptySearch },
            ],
          });
          await input.fill(prompt);
          const searchPanel = palette.locator(".cmd-palette__search");
          await expect
            .poll(() => searchPanel.evaluate((element: HTMLElement) => element.inert))
            .toBe(true);
          await expect.poll(async () => (await searchPanel.boundingBox())?.height).toBe(0);
          expect(await palette.getByRole("option").count()).toBe(0);
          expect((await input.boundingBox())!.height).toBeGreaterThan(singleLineHeight);
          const lineHeight = await input.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).lineHeight),
          );
          expect((await input.boundingBox())!.height).toBeLessThanOrEqual(lineHeight * 3 + 2);
          await input.press("Enter");
          expect(await input.inputValue()).toBe(prompt);
          expect(await gateway.getRequests("sessions.create")).toEqual([]);
          await input.press("Shift+Enter");
          await input.pressSequentially(finalLine);
          const submittedPrompt = prompt + "\n" + finalLine;
          expect(await input.inputValue()).toBe(submittedPrompt);
          expect(await input.getAttribute("aria-controls")).toBeNull();
          expect(
            (await gateway.getRequests("sessions.search")).filter(
              (request) => isRecord(request.params) && request.params.query === submittedPrompt,
            ),
          ).toEqual([]);

          const settings = palette.locator(".oc-popover.palette-session-settings");
          await changePicker(settings, "overlay-after-show", () =>
            button(palette, "New session settings").click(),
          );
          const agent = palette.locator("openclaw-agent-select");
          await changePicker(agent.locator(".agent-select__menu"), "overlay-after-show", () =>
            agent.getByRole("button", { name: /^Agent:/ }).click(),
          );
          const reviewer = agent.getByRole("menuitemradio", { name: "Reviewer", exact: true });
          await reviewer.waitFor();
          await reviewer.focus();
          await reviewer.press("Enter");
          await pollText(agent.getByRole("button", { name: /^Agent:/ })).toContain("Reviewer");
          expect(await input.isVisible()).toBe(true);
          expect(page.url()).toBe(url);

          if (destination === "local") {
            const worktree = settings.getByRole("switch", { name: "New worktree", exact: true });
            if ((await worktree.getAttribute("aria-checked")) !== "true") {
              await worktree.click();
            }
          }
          if (destination === "device") {
            await gateway.waitForRequest("environments.list");
            const workspaceChoice = settings.locator(".palette-session-settings__workspace");
            await workspaceChoice.click();
            const search = settings.getByRole("searchbox");
            await search.fill("Palette runner");
            await search.press("Escape");
            await workspaceChoice.waitFor({ state: "visible" });
            expect(await input.isVisible()).toBe(true);
            await workspaceChoice.press("Enter");
            const runner = settings.locator(
              '[data-machine="device:palette-runner"][data-project=""]',
            );
            await runner.waitFor();
            await runner.focus();
            await runner.press("Enter");
            await pollText(workspaceChoice).toContain("Palette runner");
          }

          await changePicker(settings, "overlay-after-hide", () =>
            settings.locator(".palette-session-settings__workspace").press("Escape"),
          );
          const start = button(palette, "Start new session in background");
          await pollEnabled(start).toBe(true);
          expect(await palette.locator(".agent-chat__composer-shell").count()).toBe(0);
          expect(await palette.locator(".chat-composer-model-control").count()).toBe(0);
          expect(await palette.locator(".new-session-page__visibility").count()).toBe(0);
          const bounds = (await palette.locator(".cmd-palette").boundingBox())!;
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(900);
          await input.focus();

          await gateway.deferNext("sessions.create");
          await gateway.deferNext("agent.wait");
          await input.press("ControlOrMeta+Enter");
          const create = await gateway.waitForRequest("sessions.create");
          expect(create.params).toMatchObject({
            agentId: "reviewer",
            message: destination === "device" ? "" : submittedPrompt,
            worktree: true,
            ...(destination === "device" ? { worktreeSource: "empty" } : {}),
          });
          expect(create.params).not.toHaveProperty("execNode");
          expect(create.params).not.toHaveProperty("parentSessionKey");
          await pollEnabled(start).toBe(false);
          // A second physical chord while admission is pending must not start a second session.
          await page.keyboard.press("ControlOrMeta+Enter");
          expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
          expect(page.url()).toBe(url);
          await gateway.resolveDeferred("sessions.create");
          await input.waitFor({ state: "hidden" });
          await expectForegroundUnchanged(page, composer, url);
          if (destination === "device") {
            expect((await gateway.waitForRequest("sessions.dispatch")).params).toEqual({
              key: sessionKey,
              agentId: "reviewer",
              deviceId: "palette-runner",
            });
            expect((await gateway.waitForRequest("sessions.send")).params).toMatchObject({
              key: sessionKey,
              message: submittedPrompt,
            });
          }
          expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
          expect(await gateway.getRequests("chat.send")).toEqual([]);
          await page
            .locator(".app-toast")
            .getByRole("button", { name: "Open session", exact: true })
            .waitFor();
        },
      );
    },
  );

  it("opens persistent rejected-turn recovery with the keyboard after dismissing its toast", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const key = "agent:main:dashboard:palette-rejected-turn";
      const { gateway, composer, url, palette, input } = await openMockPalette(
        page,
        suite.server.baseUrl,
        scenario({
          "sessions.create": {
            key,
            runError: { code: "INVALID_REQUEST", message: "Initial turn rejected" },
          },
        }),
      );
      const prompt = "Keep this accepted session recoverable.\nDo not send the same request twice.";
      await input.fill(prompt);
      const start = button(palette, "Start new session in background");
      await pollEnabled(start).toBe(true);
      await input.press("ControlOrMeta+Enter");
      await gateway.waitForRequest("sessions.create");
      await pollText(palette.getByRole("alert")).toContain("Initial turn rejected");
      const toast = page.locator(".app-toast");
      await button(toast, "Dismiss").click();
      await toast.waitFor({ state: "hidden" });
      expect(await input.inputValue()).toBe(prompt);
      expect(page.url()).toBe(url);
      expect(await composer.inputValue()).toBe(foregroundDraft);
      await input.press("ControlOrMeta+Enter");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      const recovery = button(palette, "Open session");
      await recovery.waitFor({ state: "visible" });
      await input.focus();
      for (let step = 0; step < 10; step += 1) {
        await page.keyboard.press("Tab");
        if (await isFocused(recovery)) {
          break;
        }
      }
      expect(await isFocused(recovery)).toBe(true);
      await page.keyboard.press("Enter");
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(key));
      await input.waitFor({ state: "hidden" });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      expect(await gateway.getRequests("chat.send")).toEqual([]);
    });
  });

  it("keeps a rejected creation visible and retries the same prompt without touching chat", async () => {
    await withPalette(
      async ({ page, gateway, composer, url, palette, input }) => {
        const prompt = "Preserve this task when creation is denied.\nRetry only after I ask.";
        await input.fill(prompt);
        const start = button(palette, "Start new session in background");
        await pollEnabled(start).toBe(true);
        await gateway.deferNext("sessions.create");
        await input.press("ControlOrMeta+Enter");
        await gateway.waitForRequest("sessions.create");
        await gateway.rejectDeferred("sessions.create", {
          code: "INVALID_REQUEST",
          message: "Fixture denied creation; correct the request and retry.",
        });
        const error = palette.getByRole("alert");
        await pollText(error).toContain("Fixture denied creation");
        expect(await input.inputValue()).toBe(prompt);
        expect(page.url()).toBe(url);
        expect(await composer.inputValue()).toBe(foregroundDraft);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(1);

        await pollEnabled(start).toBe(true);
        await input.press("ControlOrMeta+Enter");
        const retry = await gateway.waitForRequest("sessions.create", { after: 1 });
        expect(retry.params).toMatchObject({ agentId: "main", message: prompt });
        await input.waitFor({ state: "hidden" });
        await expectForegroundUnchanged(page, composer, url);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(2);
        expect(await gateway.getRequests("chat.send")).toEqual([]);
      },
      scenario({
        "sessions.create": { key: "agent:main:dashboard:palette-retried", runStarted: true },
      }),
    );
  });
});
