import type { Locator, Page } from "playwright";
import type { ChatPaneElement } from "../pages/chat/chat-pane.tsx";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";

type DiagnosticChatPane = ChatPaneElement & { readonly state?: ChatPageHost };

export async function observeManagedMediaCapture(
  page: Page,
  bubble: Locator,
  intro: string,
  phase: "live" | "reloaded",
) {
  const liveNodes = await bubble.evaluateHandle((element) => {
    const pane = element.closest<DiagnosticChatPane>("openclaw-chat-pane");
    const readPresentation = (target: ChatPaneElement | null) => ({
      presented: target?.presented ?? null,
      visuallyPresented: target?.visuallyPresented ?? null,
      conversationPresented: target?.conversationPresented ?? null,
    });
    const policyValues = new Map<unknown, number>();
    const readPolicy = (target: DiagnosticChatPane | null) => {
      const state = target?.state;
      const row = state?.sessionsResult?.sessions.find((entry) => entry.key === state.sessionKey);
      // Opaque identities compare policy changes without exporting private paths or IDs.
      return {
        epoch: state?.mediaPolicyEpoch ?? 0,
        selectedRow: Boolean(row),
        ...Object.fromEntries(
          Object.entries({
            sessionId: row?.sessionId,
            permissionMode: row?.permissionMode,
            permissionModePending: row?.permissionModePending,
            execNode: row?.execNode,
            execCwd: row?.execCwd,
            sessionRoot: row?.sessionRoot,
            spawnedWorkspaceDir: row?.spawnedWorkspaceDir,
            spawnedCwd: row?.spawnedCwd,
            worktree: row?.worktree?.id,
          }).map(([key, value]) => {
            if (value == null) {
              return [key, null];
            }
            if (!policyValues.has(value)) {
              policyValues.set(value, policyValues.size + 1);
            }
            return [key, policyValues.get(value)];
          }),
        ),
      };
    };
    const nodes = (selector: string) => Array.from(element.querySelectorAll(selector));
    const events = { presentation: 0, lifecycle: 0, conversationPresentedFalse: 0 };
    const abort = new AbortController();
    for (const [name, kind] of [
      ["openclaw:presentation-changed", "presentation"],
      ["openclaw-chat-pane-lifecycle-changed", "lifecycle"],
    ] as const) {
      pane?.addEventListener(
        name,
        () => {
          events[kind]++;
          if (pane?.conversationPresented === false) {
            events.conversationPresentedFalse++;
          }
        },
        { signal: abort.signal },
      );
    }
    const records: Array<{ kind: string; added: number; removed: number }> = [];
    let dropped = 0;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (records.length === 128) {
          records.shift();
          dropped++;
        }
        records.push({
          kind: mutation.attributeName ?? mutation.type,
          added: mutation.addedNodes.length,
          removed: mutation.removedNodes.length,
        });
      }
    });
    observer.observe(element, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "class", "hidden", "aria-hidden", "aria-busy", "style"],
    });
    const galleries = nodes(".chat-message-images");
    return {
      bubble: element,
      row: element.closest("[data-chat-row-key]"),
      text: element.querySelector(".chat-text"),
      galleries,
      galleryParents: galleries.map((gallery) => gallery.parentElement),
      frames: nodes(".chat-image-frame"),
      images: nodes("img.chat-message-image"),
      pane,
      presentation: readPresentation(pane),
      policy: readPolicy(pane),
      readPresentation,
      readPolicy,
      events,
      trace: () => ({ records: [...records], dropped }),
      stop: () => {
        observer.disconnect();
        abort.abort();
        policyValues.clear();
      },
    };
  });
  return {
    async report() {
      if (page.isClosed()) {
        return;
      }
      const diagnostic = await liveNodes.evaluate((before, expectedIntro) => {
        const matches = Array.from(
          document.querySelectorAll(".chat-group.assistant .chat-bubble"),
        ).filter((element) => element.textContent?.includes(expectedIntro));
        const current = matches.length === 1 ? matches[0] : undefined;
        const pane = current?.closest<DiagnosticChatPane>("openclaw-chat-pane") ?? null;
        const nodes = (selector: string) => Array.from(current?.querySelectorAll(selector) ?? []);
        const galleries = nodes(".chat-message-images");
        const frames = nodes(".chat-image-frame");
        return {
          schemaVersion: 1,
          kind: "managed-image-order-after-capture",
          trace: before.trace(),
          policy: { before: before.policy, after: before.readPolicy(pane) },
          matchingBubbles: matches.length,
          originalBubbleConnected: before.bubble.isConnected,
          sameBubble: current === before.bubble,
          originalRowConnected: before.row?.isConnected ?? null,
          sameRow: before.row ? current?.closest("[data-chat-row-key]") === before.row : null,
          originalTextConnected: before.text?.isConnected ?? null,
          sameText: before.text ? current?.querySelector(".chat-text") === before.text : null,
          originalGalleries: before.galleries.map((gallery, index) => ({
            connected: gallery.isConnected,
            sameGallery: galleries[index] === gallery,
            originalParentConnected: before.galleryParents[index]?.isConnected ?? null,
            sameParent: galleries[index]?.parentElement === before.galleryParents[index],
          })),
          originalFrames: before.frames.map((frame, index) => ({
            connected: frame.isConnected,
            sameFrame: frames[index] === frame,
          })),
          samePane: pane === before.pane,
          presentation: {
            before: before.presentation,
            after: before.readPresentation(pane),
            events: before.events,
          },
          originalImages: before.images.map((image) => ({
            connected: image.isConnected,
            inOriginalBubble: before.bubble.contains(image),
            inCurrentBubble: current?.contains(image) ?? false,
          })),
          current: Object.fromEntries(
            Object.entries({
              images: "img.chat-message-image",
              allImages: "img",
              galleries: ".chat-message-images",
              frames: ".chat-image-frame",
              skeletons: ".chat-image-skeleton",
              unavailable: ".chat-image-frame--compact",
              busyFrames: '.chat-image-frame[aria-busy="true"]',
            }).map(([key, selector]) => [key, nodes(selector).length]),
          ),
        };
      }, intro);
      console.error(
        "[control-ui-e2e] managed image order failure",
        JSON.stringify({ ...diagnostic, phase }),
      );
    },
    async stop() {
      try {
        await liveNodes.evaluate((state) => state.stop()).catch(() => undefined);
      } finally {
        await liveNodes.dispose();
      }
    },
  };
}
