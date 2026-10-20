import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveChatSendReplyContext } from "./chat-send-reply-context.js";

const readSessionMessageByIdAsyncMock = vi.fn();

vi.mock("../session-transcript-readers.js", () => ({
  readSessionMessageByIdAsync: (...args: unknown[]) => readSessionMessageByIdAsyncMock(...args),
}));
const cfg: OpenClawConfig = {
  agents: { entries: { main: { identity: { name: "Molty" } } } },
};

function baseParams(overrides: Partial<Parameters<typeof resolveChatSendReplyContext>[0]> = {}) {
  return {
    replyToId: "msg-1",
    cfg,
    agentId: "main",
    sessionKey: "agent:main:webchat",
    sessionEntry: { sessionFile: "session.jsonl", sessionId: "session-1" },
    storePath: "/tmp/sessions.json",
    ...overrides,
  };
}

function resolveMessage(
  message: Record<string, unknown>,
  overrides: Parameters<typeof baseParams>[0] = {},
) {
  readSessionMessageByIdAsyncMock.mockResolvedValue({ found: true, message });
  return resolveChatSendReplyContext(baseParams(overrides));
}

describe("resolveChatSendReplyContext", () => {
  beforeEach(() => {
    readSessionMessageByIdAsyncMock.mockReset();
  });

  it("returns no fields without a reply id", async () => {
    expect(await resolveChatSendReplyContext(baseParams({ replyToId: undefined }))).toEqual({});
    expect(await resolveChatSendReplyContext(baseParams({ replyToId: "  " }))).toEqual({});
    expect(readSessionMessageByIdAsyncMock).not.toHaveBeenCalled();
  });

  it("keeps only the reply id when the target message is missing", async () => {
    readSessionMessageByIdAsyncMock.mockResolvedValue({ found: false });

    expect(await resolveChatSendReplyContext(baseParams())).toEqual({ ReplyToId: "msg-1" });
  });

  it("keeps only the reply id when no session exists yet", async () => {
    expect(await resolveChatSendReplyContext(baseParams({ sessionEntry: undefined }))).toEqual({
      ReplyToId: "msg-1",
    });
    expect(readSessionMessageByIdAsyncMock).not.toHaveBeenCalled();
  });

  it("tolerates read failures and reports them through warn", async () => {
    readSessionMessageByIdAsyncMock.mockRejectedValue(new Error("transcript unavailable"));
    const warn = vi.fn();

    expect(await resolveChatSendReplyContext(baseParams({ warn }))).toEqual({
      ReplyToId: "msg-1",
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("hydrates only display-visible content, not raw transcript payloads", async () => {
    const fields = await resolveMessage({
      role: "assistant",
      content: [
        { type: "text", text: "visible answer" },
        { type: "text", text: '<tool_call>{"name":"exec","arguments":{}}</tool_call>' },
      ],
      __openclaw: { id: "msg-1" },
    });

    expect(fields.ReplyToBody).toContain("visible answer");
    expect(fields.ReplyToBody).not.toContain("tool_call");
    expect(fields.ReplyToSender).toBe("Molty");
  });

  it("strips inbound envelope wrappers from user reply targets", async () => {
    expect(
      await resolveMessage(
        {
          role: "user",
          content: "[Sat 2026-07-18 11:31 MDT] Which stage runs the integration tests?",
        },
        { userSenderLabel: "Ada" },
      ),
    ).toMatchObject({
      ReplyToBody: "Which stage runs the integration tests?",
      ReplyToSender: "Ada",
    });
  });

  it("keeps only the reply id when the target is not display-visible", async () => {
    expect(
      await resolveMessage({
        role: "assistant",
        content: [{ type: "text", text: "NO_REPLY" }],
        __openclaw: { id: "msg-1" },
      }),
    ).toEqual({ ReplyToId: "msg-1" });
  });
});
