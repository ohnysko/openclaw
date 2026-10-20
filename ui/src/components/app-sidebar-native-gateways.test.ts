/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { NativeGatewaysSnapshot } from "../app/native-gateways.runtime.ts";
import { nativeGatewaysCapability } from "../app/native-gateways.runtime.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import {
  createContext,
  createGatewayHarness,
  createSessions,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import {
  clearNativeGatewayTestState,
  setNativeGatewayTestState,
} from "../test-helpers/native-gateways.ts";
import "./app-sidebar.tsx";

setupSidebarTest();
afterEach(() => {
  clearNativeGatewayTestState();
  document.documentElement.classList.remove("openclaw-native-macos");
});

const query = (root: ParentNode, selector: string) => root.querySelector<HTMLElement>(selector);
const item = (root: ParentNode, value: string) => query(root, `[data-value="${value}"]`);
const shortcut = (root: ParentNode) =>
  query(root, ".oc-menu-item__details kbd")?.textContent?.replace(/\s+/gu, "").trim();

function publishSnapshot(snapshot: NativeGatewaysSnapshot | null) {
  Object.assign(window, { __OPENCLAW_NATIVE_GATEWAYS__: snapshot });
  window.dispatchEvent(new CustomEvent("openclaw:native-gateways-changed", { detail: snapshot }));
}

async function mountNative(key = "agent:main:main") {
  const gateway = createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient);
  const sessions = createSessions("main", [key]);
  const mounted = await mountSidebar(gateway.gateway, sessions);
  const { sidebar } = mounted;
  const click = async (element: HTMLElement) => {
    element.click();
    await sidebar.updateComplete;
  };
  const open = async () => {
    await click(query(sidebar, ".sidebar-identity-card")!);
    return query(sidebar, ".sidebar-identity-menu")!;
  };
  return { ...mounted, gateway, sessions, click, open };
}

it("closes the session menu on Gateway changes after moves and context replacement", async () => {
  setNativeGatewayTestState("remote");
  const { sidebar, provider, gateway, sessions } = await mountNative("agent:main:recent");
  for (const changeLifetime of [
    () => {},
    () => {
      sidebar.hostElement.remove();
      provider.append(sidebar.hostElement);
    },
    () => provider.setContext(createContext(gateway.gateway, sessions)),
  ]) {
    changeLifetime();
    await sidebar.updateComplete;
    const trigger = query(sidebar, "[data-sidebar-session-menu]")!;
    expect(trigger).not.toBeNull();
    trigger.click();
    await sidebar.updateComplete;
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    window.dispatchEvent(new CustomEvent("openclaw:native-gateways-changed"));
    await sidebar.updateComplete;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  }
});

it("lists native gateways and dispatches switching, window, primary, and settings actions", async () => {
  document.documentElement.classList.add("openclaw-native-macos");
  const postMessage = setNativeGatewayTestState("remote")!;
  const capability = nativeGatewaysCapability()!;
  const snapshot = {
    gateways: [
      capability.snapshot!.gateways[0]!,
      { ...capability.snapshot!.gateways[1]!, id: "profile:team", health: "error" as const },
      {
        ...capability.snapshot!.gateways[1]!,
        id: "unknown",
        name: "Unprobed Gateway",
        health: "unknown" as const,
      },
    ],
    currentId: "profile:team",
  };
  publishSnapshot(snapshot);
  const { sidebar, click, open: openIdentity } = await mountNative();
  const open = async () => {
    const menu = await openIdentity();
    await click(item(menu, "command:gateways")!);
    return menu;
  };
  const choose = async (value: string, modifiers?: MouseEventInit, eventType = "click") => {
    const menu = await open();
    const target = item(menu, value)!;
    expect(target).not.toBeNull();
    if (modifiers) {
      target.dispatchEvent(
        new MouseEvent(eventType, { bubbles: true, cancelable: true, ...modifiers }),
      );
    } else {
      target.click();
    }
    await sidebar.updateComplete;
    expect(query(sidebar, ".sidebar-identity-menu")).toBeNull();
  };
  const menu = await open();
  expect(query(menu, ".sidebar-customize-menu__title")?.textContent).toBe("Gateway");
  const current = item(menu, "command:gateways")!;
  expect(current.textContent).toContain("Remote Gateway");
  expect(query(current, ".sidebar-gateway-health")?.getAttribute("aria-label")).toBe("Unreachable");
  expect(item(menu, "command:apps")).toBeNull();
  const rows = snapshot.gateways.map((gateway) =>
    query(menu, `[data-value="gateway:${encodeURIComponent(gateway.id)}"]`)!,
  );
  expect(
    rows.map((row) => query(row, ".sidebar-customize-menu__text")?.textContent?.trim()),
  ).toEqual(["Local Gateway", "Remote Gateway", "Unprobed Gateway"]);
  expect(
    rows.map((row) => query(row, ".sidebar-gateway-health")?.getAttribute("aria-label")),
  ).toEqual(["Connected", "Unreachable", "Unknown status"]);
  expect(rows.map(shortcut)).toEqual(["⌘1", undefined, "⌘3"]);
  for (const keycap of menu.querySelectorAll("kbd")) {
    expect(keycap.getAttribute("aria-hidden")).toBe("true");
  }
  expect(query(rows[0]!, ".sidebar-gateway-primary")?.textContent).toBe("primary");
  expect(query(rows[1]!, ".sidebar-gateway-primary")).toBeNull();
  expect(query(rows[1]!, ".sidebar-gateway-check")).not.toBeNull();
  expect(query(rows[0]!, ".sidebar-gateway-check")).toBeNull();
  rows[1]!.click();
  await sidebar.updateComplete;
  expect(postMessage).not.toHaveBeenCalled();
  expect(query(sidebar, ".sidebar-identity-menu")).toBeNull();

  await choose("gateway:local");
  expect(postMessage).toHaveBeenLastCalledWith({ type: "select", id: "local" });
  for (const modifiers of [{ metaKey: true }, { ctrlKey: true }]) {
    await choose("gateway:profile%3Ateam", modifiers);
    expect(postMessage).toHaveBeenLastCalledWith({ type: "open-window", id: "profile:team" });
  }
  // macOS sends a contextmenu event for Control-click instead of click.
  await choose("gateway:profile%3Ateam", { ctrlKey: true }, "contextmenu");
  expect(postMessage).toHaveBeenLastCalledWith({ type: "open-window", id: "profile:team" });
  await choose("command:gateway-set-primary");
  expect(postMessage).toHaveBeenLastCalledWith({ type: "set-primary", id: "profile:team" });
  await choose("command:gateway-settings");
  expect(postMessage).toHaveBeenLastCalledWith({ type: "open-settings" });
  expect(postMessage).toHaveBeenCalledTimes(6);

  snapshot.gateways = [snapshot.gateways[0]!];
  snapshot.currentId = "local";
  publishSnapshot(snapshot);
  const singleMenu = await open();
  expect(item(singleMenu, "gateway:local")).not.toBeNull();
  expect(item(singleMenu, "command:gateway-set-primary")).toBeNull();
  expect(item(singleMenu, "command:gateway-settings")).not.toBeNull();

  snapshot.gateways = Array.from({ length: 10 }, (_, index) => ({
    ...snapshot.gateways[0]!,
    id: `gateway-${index + 1}`,
    name: `Gateway ${index + 1}`,
  }));
  snapshot.currentId = "gateway-1";
  publishSnapshot(snapshot);
  await sidebar.updateComplete;
  const manyRows = sidebar.querySelectorAll('[data-value^="gateway:"]');
  expect(manyRows).toHaveLength(10);
  expect(shortcut(manyRows[8]!)).toBe("⌘9");
  expect(query(manyRows[9]!, "kbd")).toBeNull();
});

it.each(["missing snapshot", "empty list", "unknown current"] as const)(
  "keeps settings and known gateways available with %s",
  async (state) => {
    setNativeGatewayTestState("local");
    const capability = nativeGatewaysCapability()!;
    const openSettings = vi.spyOn(capability, "openSettings");
    const initial = capability.snapshot!;
    const snapshot =
      state === "missing snapshot"
        ? null
        : {
            currentId: "missing",
            gateways: state === "empty list" ? [] : initial.gateways,
          };
    publishSnapshot(snapshot);
    const { sidebar, click, open } = await mountNative();
    const menu = await open();
    const switcher = item(menu, "command:gateways")!;
    expect(switcher.textContent).toContain("Gateway");
    expect(query(switcher, ".sidebar-gateway-health")).toBeNull();
    await click(switcher);
    expect(menu.querySelectorAll('[data-value^="gateway:"]')).toHaveLength(
      snapshot?.gateways.length ?? 0,
    );
    expect(query(menu, '[aria-checked="true"]')).toBeNull();
    expect(item(menu, "command:gateway-set-primary")).toBeNull();
    await click(item(menu, "command:gateway-settings")!);
    expect(openSettings).toHaveBeenCalledExactlyOnceWith();
    expect(query(sidebar, ".sidebar-identity-menu")).toBeNull();
  },
);
