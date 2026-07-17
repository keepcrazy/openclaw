import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { createFeishuClient } from "./client.js";
import type { ResolvedFeishuAccount } from "./types.js";

export type FeishuPermissionError = {
  code: number;
  message: string;
  grantUrl?: string;
};

type SenderLookupResult = {
  name?: string;
  userId?: string;
  permissionError?: FeishuPermissionError;
};

type FeishuContactUserGetResponse = Awaited<
  ReturnType<ReturnType<typeof createFeishuClient>["contact"]["user"]["get"]>
>;

type FeishuLogger = {
  (...args: unknown[]): void;
};

const IGNORED_PERMISSION_SCOPE_TOKENS = ["contact:contact.base:readonly"];
const FEISHU_SCOPE_CORRECTIONS: Record<string, string> = {
  "contact:contact.base:readonly": "contact:user.base:readonly",
};
const SENDER_LOOKUP_TTL_MS = 10 * 60 * 1000;
const senderLookupCache = new Map<string, { name?: string; userId?: string; expireAt: number }>();

function correctFeishuScopeInUrl(url: string): string {
  let corrected = url;
  for (const [wrong, right] of Object.entries(FEISHU_SCOPE_CORRECTIONS)) {
    corrected = corrected.replaceAll(encodeURIComponent(wrong), encodeURIComponent(right));
    corrected = corrected.replaceAll(wrong, right);
  }
  return corrected;
}

function shouldSuppressPermissionErrorNotice(permissionError: FeishuPermissionError): boolean {
  const message = normalizeLowercaseStringOrEmpty(permissionError.message);
  return IGNORED_PERMISSION_SCOPE_TOKENS.some((token) => message.includes(token));
}

function extractPermissionError(err: unknown): FeishuPermissionError | null {
  if (!err || typeof err !== "object") {
    return null;
  }
  const axiosErr = err as { response?: { data?: unknown } };
  const data = axiosErr.response?.data;
  if (!data || typeof data !== "object") {
    return null;
  }
  const feishuErr = data as { code?: number; msg?: string };
  if (feishuErr.code !== 99991672) {
    return null;
  }
  const msg = feishuErr.msg ?? "";
  const urlMatch = msg.match(/https:\/\/[^\s,]+\/app\/[^\s,]+/);
  return {
    code: feishuErr.code,
    message: msg,
    grantUrl: urlMatch?.[0] ? correctFeishuScopeInUrl(urlMatch[0]) : undefined,
  };
}

function resolveSenderLookupIdType(senderId: string): "open_id" | "user_id" | "union_id" {
  const trimmed = senderId.trim();
  if (trimmed.startsWith("ou_")) {
    return "open_id";
  }
  if (trimmed.startsWith("on_")) {
    return "union_id";
  }
  return "user_id";
}

export async function resolveFeishuSenderIdentity(params: {
  account: ResolvedFeishuAccount;
  senderId: string;
  log: FeishuLogger;
}): Promise<SenderLookupResult> {
  const { account, senderId, log } = params;
  if (!account.configured) {
    return {};
  }

  const normalizedSenderId = senderId.trim();
  if (!normalizedSenderId) {
    return {};
  }

  const cached = senderLookupCache.get(normalizedSenderId);
  const now = Date.now();
  if (cached && cached.expireAt > now) {
    return { name: cached.name, userId: cached.userId };
  }

  try {
    const client = createFeishuClient(account);
    const userIdType = resolveSenderLookupIdType(normalizedSenderId);
    const res: FeishuContactUserGetResponse = await client.contact.user.get({
      path: { user_id: normalizedSenderId },
      params: { user_id_type: userIdType },
    });
    const user = res.data?.user;
    const name = user?.name ?? user?.nickname ?? user?.en_name;
    const userId = user?.user_id?.trim() || undefined;

    if (name || userId) {
      senderLookupCache.set(normalizedSenderId, {
        name,
        userId,
        expireAt: now + SENDER_LOOKUP_TTL_MS,
      });
      return { name, userId };
    }
    return {};
  } catch (err) {
    const permErr = extractPermissionError(err);
    if (permErr) {
      if (shouldSuppressPermissionErrorNotice(permErr)) {
        log(`feishu: ignoring stale permission scope error: ${permErr.message}`);
        return {};
      }
      log(`feishu: permission error resolving sender identity: code=${permErr.code}`);
      return { permissionError: permErr };
    }
    log(`feishu: failed to resolve sender identity for ${normalizedSenderId}: ${String(err)}`);
    return {};
  }
}
