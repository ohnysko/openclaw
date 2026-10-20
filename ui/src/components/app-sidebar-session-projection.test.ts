import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runningRow as makeRunningRow } from "../test-helpers/app-sidebar-session-narration.ts";
import { SidebarSessionProjection } from "./app-sidebar-session-projection.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

type ProjectionInput = Parameters<SidebarSessionProjection["project"]>[0];

const connectionIdentity = {};
const listSource = {};

let projection: SidebarSessionProjection;
beforeEach(() => {
  projection = new SidebarSessionProjection();
});
afterEach(() => vi.restoreAllMocks());
const project = (rows: SidebarRecentSession[], overrides: Partial<ProjectionInput> = {}) =>
  projection.project(projectionInput(rows, overrides));

function sessionRow(
  key: string,
  overrides: Partial<SidebarRecentSession> = {},
): SidebarRecentSession {
  const { updatedAt: _updatedAt, startedAt: _startedAt, ...row } = makeRunningRow(key);
  return {
    ...row,
    label: key,
    hasActiveRun: false,
    ...overrides,
  };
}

function projectionInput(
  rows: SidebarRecentSession[],
  overrides: Partial<ProjectionInput> = {},
): ProjectionInput {
  return {
    rows,
    grouping: "category",
    knownGroups: [],
    collapsedSections: new Set(),
    emptyGroupsMode: "filtering",
    ownerFiltered: false,
    visibleSessionLimits: new Map(),
    sortMode: "created",
    statusFilter: "active",
    agentId: "main",
    connectionIdentity,
    listSource,
    listLoaded: true,
    subtitle: {
      sidebarLiveActivity: true,
      showPreview: true,
      narrationLines: new Map(),
      observerDigests: new Map(),
    },
    ...overrides,
  };
}

function narrationInput(session: SidebarRecentSession, line: string): ProjectionInput {
  return projectionInput([session], {
    subtitle: {
      sidebarLiveActivity: true,
      showPreview: true,
      narrationLines: new Map([[session.key, line]]),
      observerDigests: new Map(),
    },
  });
}

function subtitleParams(
  session: SidebarRecentSession,
  overrides: Partial<Parameters<SidebarSessionProjection["resolveSubtitle"]>[0]> = {},
) {
  return {
    session,
    hasDisplay: false,
    sidebarLiveActivity: true,
    showPreview: true,
    narrationLine: undefined,
    ...overrides,
  };
}

describe("SidebarSessionProjection created order", () => {
  it("prunes only absent rows when the bounded registry exceeds its cap", () => {
    const original = Array.from({ length: 1_000 }, (_, index) => ({ key: `original-${index}` }));
    projection.observeRows([{ sessions: original }]);

    projection.observeRows([{ sessions: [{ key: "replacement" }, original[999]!] }]);

    expect(projection.createdOrder.size).toBe(1_000);
    expect(projection.createdOrder.has("original-0")).toBe(false);
    expect(projection.createdOrder.get("original-999")).toBe(999);
    expect(projection.createdOrder.get("replacement")).toBe(1_000);
  });

  it("promotes newly created sessions without losing the order of existing peers", () => {
    projection.observeRows([{ sessions: [{ key: "first" }, { key: "second" }] }]);

    expect(projection.promoteCreatedSession("newest")).toBe(true);
    expect(projection.promoteCreatedSession("newest")).toBe(false);
    expect([...projection.createdOrder]).toEqual([
      ["first", 1],
      ["second", 2],
      ["newest", 0],
    ]);
  });
});

describe("SidebarSessionProjection child expansion", () => {
  it("reveals newly added children while preserving a manual collapse through ordinary updates", () => {
    const parent = sessionRow("parent", { childSessionKeys: ["first", "second"] });
    project([sessionRow(parent.key)]);
    project([parent]);
    expect(projection.children.isExpanded(parent.key)).toBe(true);
    expect(projection.children.toggle(parent.key)).toEqual({ expanded: false });

    project([sessionRow(parent.key, { childSessionKeys: ["second", "first"] })]);
    expect(projection.children.isExpanded(parent.key)).toBe(false);

    // Compare identities, not counts: one child can replace another between snapshots.
    const replacement = sessionRow(parent.key, { childSessionKeys: ["second", "third"] });
    project([replacement]);
    expect(projection.children.isExpanded(parent.key)).toBe(true);

    projection.children.showMore(parent.key);
    project([sessionRow(parent.key, { childSessionKeys: ["second", "third", "fourth"] })]);
    expect(projection.children.isFullyShown(parent.key)).toBe(true);
  });

  it("keeps existing children collapsed when the list replaces a route placeholder", () => {
    project([sessionRow("parent")], { listLoaded: false });
    const parent = sessionRow("parent", { childSessionKeys: ["first", "second"] });
    project([parent]);
    expect(projection.children.isExpanded(parent.key)).toBe(false);

    project([sessionRow(parent.key, { childSessionKeys: ["first", "second", "third"] })]);
    expect(projection.children.isExpanded(parent.key)).toBe(true);
  });

  it("baselines restored collapsed children before revealing later additions", () => {
    const parent = sessionRow("parent", { childSessionKeys: ["first"] });
    projection.children.restore([{ key: parent.key, childrenDisplayMode: "collapsed-by-user" }]);
    project([parent]);
    expect(projection.children.isExpanded(parent.key)).toBe(false);

    project([sessionRow(parent.key, { childSessionKeys: ["first", "second"] })]);
    expect(projection.children.isExpanded(parent.key)).toBe(true);
  });

  it("preserves restored expansion through the live handoff but clears it on a later connection", () => {
    const rows = [
      sessionRow("expanded"),
      sessionRow("fully-shown"),
      sessionRow("collapsed", { containsActiveDescendant: true }),
      sessionRow("untouched", { containsActiveDescendant: true }),
    ];
    project([]);
    projection.children.restore([
      { key: "expanded", childrenDisplayMode: "expanded" },
      { key: "fully-shown", childrenDisplayMode: "expanded-fully" },
      { key: "collapsed", childrenDisplayMode: "collapsed-by-user" },
      { key: "untouched", childrenDisplayMode: projection.children.capture("untouched") },
    ]);
    expect(projection.children.isExpanded("expanded")).toBe(true);
    expect(projection.children.isFullyShown("fully-shown")).toBe(true);
    const liveConnection = {};
    project(rows, { connectionIdentity: liveConnection, listSource: {} });
    expect(projection.children.isExpanded("expanded")).toBe(true);
    expect(projection.children.isFullyShown("fully-shown")).toBe(true);
    expect(projection.children.isExpanded("collapsed")).toBe(false);
    expect(projection.children.isExpanded("untouched")).toBe(true);
    project(rows, { connectionIdentity: {} });
    expect(projection.children.isExpanded("expanded")).toBe(false);
    expect(projection.children.isFullyShown("fully-shown")).toBe(false);
    expect(projection.children.isExpanded("collapsed")).toBe(true);
  });

  it("keeps an explicitly collapsed parent closed when a later descendant becomes active", () => {
    const active = sessionRow("parent", { containsActiveDescendant: true });
    project([active]);
    expect(projection.children.toggle(active.key)).toEqual({ expanded: false });

    project([sessionRow("parent")]);
    project([active]);

    expect(projection.children.isExpanded("parent")).toBe(false);
  });

  it("forgets expansion when a session disappears before returning", () => {
    const parent = sessionRow("parent");
    project([parent]);
    projection.children.toggle(parent.key);

    project([]);
    project([parent]);

    expect(projection.children.isExpanded(parent.key)).toBe(false);
  });
});

describe("SidebarSessionProjection running subtitle hold", () => {
  it("holds the subtitle across a run-id rotation while the session stays running", () => {
    // Live repro: queued->running rotates activeRunIds; the row must not blank.
    const running = sessionRow("running", { hasActiveRun: true, activeRunIds: ["run-one"] });
    projection.project(narrationInput(running, "Pre-rotation activity"));
    const rotated = sessionRow(running.key, { hasActiveRun: true, activeRunIds: ["run-two"] });
    project([rotated]);

    expect(projection.resolveSubtitle(subtitleParams(rotated)).subtitle).toBe(
      "Pre-rotation activity",
    );
  });

  it("floors ambient subtitle replacement at the minimum display time", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const running = sessionRow("running", { hasActiveRun: true, activeRunIds: ["run-one"] });
    projection.project(narrationInput(running, "First activity"));

    clock.mockReturnValue(500);
    projection.project(narrationInput(running, "Second activity"));
    expect(projection.resolveSubtitle(subtitleParams(running)).subtitle).toBe("First activity");

    clock.mockReturnValue(2_500);
    projection.project(narrationInput(running, "Second activity"));
    expect(projection.resolveSubtitle(subtitleParams(running)).subtitle).toBe("Second activity");
  });

  it("lets operator-critical text replace a held subtitle immediately", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const running = sessionRow("running", { hasActiveRun: true, activeRunIds: ["run-one"] });
    projection.project(narrationInput(running, "Ambient activity"));

    clock.mockReturnValue(200);
    const needsInput = sessionRow(running.key, {
      hasActiveRun: true,
      activeRunIds: ["run-one"],
      agentStatusNote: "Blocked on operator input",
    });
    project([needsInput]);

    expect(projection.resolveSubtitle(subtitleParams(needsInput)).subtitle).toBe(
      "Blocked on operator input",
    );
  });

  it("clears held narration when the user disables live activity", () => {
    const running = sessionRow("running", { hasActiveRun: true, activeRunIds: ["run-one"] });
    projection.project(narrationInput(running, "Running checks"));

    project([running], {
      subtitle: {
        sidebarLiveActivity: false,
        showPreview: true,
        narrationLines: new Map(),
        observerDigests: new Map(),
      },
    });

    expect(
      projection.resolveSubtitle(subtitleParams(running, { sidebarLiveActivity: false })),
    ).toEqual({ subtitle: undefined, narration: undefined });
  });

  it("never leaks a held backing-work subtitle into a catalog display that omits one", () => {
    const running = sessionRow("running", {
      hasActiveRun: true,
      activeRunIds: ["run-one"],
      workSession: true,
      subtitle: "~/Projects/openclaw",
    });
    project([running]);

    expect(projection.resolveSubtitle(subtitleParams(running, { hasDisplay: true }))).toEqual({
      subtitle: undefined,
      narration: undefined,
    });
  });
});
