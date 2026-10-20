import type { Locator } from "playwright";
import { expect, it } from "vitest";
import {
  button,
  paletteAnchors,
  expectForegroundUnchanged,
  openMockPalette,
  scenario,
} from "./command-palette.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  ONE_PIXEL_PNG_B64,
  pastePng,
  pollCount,
  pollEnabled,
  pollText,
} from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "command palette pasted images" });

async function pasteImages(input: Locator, count = 1) {
  await pastePng(input, count);
  return Array.from({ length: count }, (_, index) => ({
    type: "image",
    mimeType: "image/png",
    content: ONE_PIXEL_PNG_B64,
    fileName: count === 1 ? "pixel.png" : `pixel-${index + 1}.png`,
  }));
}

suite.define(() => {
  it.each([1280, 390])(
    "keeps the input and actions anchored through paste and removal at %s px",
    async (width) => {
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport: { width, height: 900 } },
        async ({ page }) => {
          const { palette, input } = await openMockPalette(page, suite.server.baseUrl);
          await page.evaluate(() => document.fonts.ready);
          const images = palette.locator(".chat-attachment-thumb img");
          const start = button(palette, "Start new session in background");
          const remove = palette.getByRole("button", { name: /^Remove pixel-/ });
          for (const message of [
            "",
            "Compare these images",
            "First line\nSecond line\nThird line\nFourth line",
          ]) {
            await input.fill(message);
            await pollEnabled(start).toBe(Boolean(message));
            const initial = await paletteAnchors(palette);
            await pasteImages(input, 2);
            await pollCount(images).toBe(2);
            expect(await paletteAnchors(palette)).toEqual(initial);
            await pasteImages(input, 10);
            await pollCount(images).toBe(12);
            expect(await paletteAnchors(palette)).toEqual(initial);
            expect(
              await palette
                .locator(".chat-attachments-preview")
                .evaluate((element) => element.scrollWidth > element.clientWidth),
            ).toBe(true);
            await remove.first().click();
            await pollCount(images).toBe(11);
            expect(await paletteAnchors(palette)).toEqual(initial);
            for (let index = 0; index < 11; index += 1) {
              await remove.first().click();
            }
            await pollCount(images).toBe(0);
            expect(await start.isEnabled()).toBe(Boolean(message));
            expect(await paletteAnchors(palette)).toEqual(initial);
          }
        },
      );
    },
  );

  it("submits an image-only prompt once and retries the same images after creation fails", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { gateway, palette, input, composer, url } = await openMockPalette(
        page,
        suite.server.baseUrl,
        scenario({
          "sessions.create": {
            key: "agent:main:dashboard:palette-image-created",
            runStarted: true,
          },
        }),
      );
      const attachments = await pasteImages(input, 2);
      const images = palette.locator(".chat-attachment-thumb img");
      const start = button(palette, "Start new session in background");
      await pollEnabled(start).toBe(true);
      await gateway.deferNext("sessions.create");
      await input.press("ControlOrMeta+Enter");
      expect((await gateway.waitForRequest("sessions.create")).params).toMatchObject({
        message: "",
        attachments,
      });
      expect(await input.isDisabled()).toBe(true);
      await page.keyboard.press("ControlOrMeta+Enter");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      await gateway.rejectDeferred("sessions.create", {
        code: "INVALID_REQUEST",
        message: "Could not create session",
      });
      await pollText(palette.getByRole("alert")).toContain("Could not create session");
      expect(await images.count()).toBe(2);
      await input.press("Escape");
      await input.waitFor({ state: "hidden" });
      await page.keyboard.press("ControlOrMeta+K");
      await input.waitFor({ state: "visible" });
      expect(await images.count()).toBe(2);
      await pollEnabled(start).toBe(true);
      await input.press("ControlOrMeta+Enter");
      expect((await gateway.waitForRequest("sessions.create", { after: 1 })).params).toMatchObject({
        message: "",
        attachments,
      });
      await input.waitFor({ state: "hidden" });
      await expectForegroundUnchanged(page, composer, url);
      expect(await gateway.getRequests("chat.send")).toEqual([]);
    });
  });
});
