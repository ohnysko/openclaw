import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import { resolveDefaultTelegramAccountId } from "./accounts.js";
import {
  readTelegramChatId,
  readTelegramForumTopicIconColor,
  readTelegramThreadId,
} from "./action-params.js";
import {
  createForumTopicTelegram,
  deleteForumTopicTelegram,
  editForumTopicTelegram,
} from "./send.js";
import { updateTopicName } from "./topic-name-cache.js";

type TelegramForumTopicActionName = "createForumTopic" | "editForumTopic" | "deleteForumTopic";

function resolveActionTopicNameCacheScope(cfg: OpenClawConfig, accountId?: string | null): string {
  const resolvedAccountId = accountId ?? resolveDefaultTelegramAccountId(cfg);
  return resolveStorePath(cfg.session?.store, {
    agentId: resolveTelegramAccountOwnerAgentId({ cfg, accountId: resolvedAccountId }),
  });
}

export async function handleTelegramForumTopicAction(params: {
  action: TelegramForumTopicActionName;
  params: Record<string, unknown>;
  cfg: OpenClawConfig;
  accountId?: string | null;
  apiOptions: Omit<Parameters<typeof createForumTopicTelegram>[2], "token">;
  requireToken: () => string;
  isActionEnabled: (key: "createForumTopic" | "editForumTopic") => boolean;
}): Promise<AgentToolResult<unknown>> {
  const { action, params: input, cfg, accountId, apiOptions, requireToken } = params;
  // topic-delete shares the editForumTopic gate: it manages existing topics and adds no config key.
  const gateKey = action === "createForumTopic" ? "createForumTopic" : "editForumTopic";
  if (!params.isActionEnabled(gateKey)) {
    throw new Error(`Telegram ${action} is disabled.`);
  }
  const chatId = readTelegramChatId(input);
  if (action === "createForumTopic") {
    const name =
      readStringParam(input, "name") ??
      readStringParam(input, "threadName", { required: true, label: "name" });
    const iconColor = readTelegramForumTopicIconColor(input);
    const iconCustomEmojiId = readStringParam(input, "iconCustomEmojiId");
    const result = await createForumTopicTelegram(chatId ?? "", name, {
      ...apiOptions,
      token: requireToken(),
      iconColor,
      iconCustomEmojiId,
    });
    return jsonResult({
      ok: true,
      topicId: result.topicId,
      name: result.name,
      chatId: result.chatId,
    });
  }
  const messageThreadId = readTelegramThreadId(input);
  if (typeof messageThreadId !== "number") {
    throw new Error("messageThreadId or threadId is required.");
  }
  if (action === "deleteForumTopic") {
    return jsonResult(
      await deleteForumTopicTelegram(chatId ?? "", messageThreadId, {
        ...apiOptions,
        token: requireToken(),
      }),
    );
  }
  const name = readStringParam(input, "name") ?? readStringParam(input, "threadName");
  const iconCustomEmojiId = readStringParam(input, "iconCustomEmojiId");
  const result = await editForumTopicTelegram(chatId ?? "", messageThreadId, {
    ...apiOptions,
    token: requireToken(),
    name,
    iconCustomEmojiId,
  });
  if (result.chatId) {
    const patch = {
      ...(name ? { name } : {}),
      ...(iconCustomEmojiId ? { iconCustomEmojiId } : {}),
    };
    if (Object.keys(patch).length > 0) {
      await updateTopicName(
        result.chatId,
        result.messageThreadId,
        patch,
        resolveActionTopicNameCacheScope(cfg, accountId),
      ).catch(() => {});
    }
  }
  return jsonResult(result);
}
