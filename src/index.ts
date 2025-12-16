/* @tg-ghost-tag/core — TS lib for Telegram invisible mentions (Node 18+) */

export type UserId = number;
export type ChatId = number | string;

export interface MessageEntityTextMention {
  type: "text_mention";
  offset: number; // UTF-16 code units
  length: number; // 1 (INV char)
  user: { id: UserId };
}
export type MessageEntity = MessageEntityTextMention;

export interface GhostTemplate {
  // classic mode
  before?: string;
  after?: string;
  char?: string; // INV fallback

  // smart mode
  message?: string;

  // INV picking
  charCandidates?: string[];

  // smart placement
  replaceTargets?: string[]; // example: ['.', '!']
  replacePosition?: "start" | "end" | number; // number → insert after this index (UTF-16)
  fallbackPosition?: "start" | "end"; // where to insert if anchor not found

  // legacy heuristic (if replaceTargets/replacePosition:number not specified)
  punctuationRegex?: RegExp;
  preferEndIfNoPunctuation?: boolean;

  // formatting
  separateLineForMentions?: boolean; // true → add '\n' before INV
  trailingNewline?: boolean; // true → add '\n' after INV
}

export interface GhostPayload {
  chat_id: ChatId;
  text: string;
  entities: MessageEntity[];
}

export interface BuildOptions {
  maxPerMessage?: number; // default 5
  maxTextLength?: number; // default 4096
  onOverflow?: "split" | "error"; // default 'split': split; 'error': throw error
}

const DEFAULT_INV_CANDIDATES = [
  "\u200B",
  "\u2063",
  "\u2060",
  "\u200C",
  "\u200D"
];
const DEFAULT_PUNCT_RE = /[.!?…]/;
const DEFAULT_MAX_TEXT = 4096;

const toNFC = (s: string) => (s as any).normalize?.("NFC") ?? s;

function assertNoExistingInv(s: string, inv: string) {
  if (s.includes(inv)) {
    const hex = inv.codePointAt(0)!.toString(16);
    throw new Error(`Template must not already contain INV char (\\u${hex})`);
  }
}

function pickInvChar(
  candidates: string[],
  ...avoidIn: Array<string | undefined>
): string {
  for (const c of candidates) {
    if (c.length !== 1) continue; // гарантуємо 1 code unit
    if (!avoidIn.some((s) => s?.includes?.(c))) return c;
  }
  return candidates[0] ?? "\u200B";
}

/** classic: before + INV.repeat(N) + after */
export function buildInvisibleText(
  count: number,
  template: GhostTemplate = {}
): { text: string; offsets: number[]; invChar: string } {
  const charList = template.charCandidates ?? DEFAULT_INV_CANDIDATES;
  const inv =
    template.char ?? pickInvChar(charList, template.before, template.after);
  const before = toNFC(template.before ?? "");
  const after = toNFC(template.after ?? "");

  assertNoExistingInv(before, inv);
  assertNoExistingInv(after, inv);

  if (count <= 0)
    return { text: `${before}${after}`, offsets: [], invChar: inv };

  const prefixLen = before.length; // UTF-16 units (Bot API format)
  const text = `${before}${inv.repeat(count)}${after}`;
  const offsets = Array.from({ length: count }, (_, i) => prefixLen + i);
  return { text, offsets, invChar: inv };
}

export function buildEntities(
  offsets: number[],
  userIds: UserId[]
): MessageEntity[] {
  if (offsets.length !== userIds.length) {
    throw new Error(
      `offsets.length (${offsets.length}) !== userIds.length (${userIds.length})`
    );
  }
  return userIds.map((id, i) => ({
    type: "text_mention",
    offset: offsets[i],
    length: 1,
    user: { id }
  }));
}

export function chunkUserIds(
  userIds: UserId[],
  maxPerMessage = 100
): UserId[][] {
  const out: UserId[][] = [];
  for (let i = 0; i < userIds.length; i += maxPerMessage)
    out.push(userIds.slice(i, i + maxPerMessage));
  return out;
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function findAnchorIndex(
  src: string,
  opts: {
    replaceTargets?: string[];
    replacePosition?: "start" | "end" | number;
    punctuationRegex?: RegExp;
    fallbackPosition: "start" | "end";
  }
): number {
  if (
    typeof opts.replacePosition === "number" &&
    Number.isFinite(opts.replacePosition)
  ) {
    return clamp(Math.trunc(opts.replacePosition) + 1, 0, src.length);
  }

  if (opts.replaceTargets && opts.replaceTargets.length) {
    const set = new Set(opts.replaceTargets);
    for (let i = src.length - 1; i >= 0; i--) {
      if (set.has(src[i])) return opts.replacePosition === "start" ? i : i + 1;
    }
  }

  if (opts.punctuationRegex) {
    const r = new RegExp(
      opts.punctuationRegex.source,
      opts.punctuationRegex.flags.replace(/g/g, "")
    );
    for (let i = src.length - 1; i >= 0; i--) {
      if (r.test(src[i])) return opts.replacePosition === "start" ? i : i + 1;
    }
  }

  return opts.fallbackPosition === "start" ? 0 : src.length;
}

function buildSmartBaseText(
  message: string,
  inv: string,
  count: number,
  anchorAt: number,
  separateLine: boolean,
  trailingNewline: boolean
): {
  text: string;
  baseLen: number;
  insertAt: number;
  newlineOverhead: number;
} {
  const src = toNFC(message);
  const left = src.slice(0, anchorAt);
  const right = src.slice(anchorAt);
  const nlBefore = separateLine ? "\n" : "";
  const nlAfter = trailingNewline ? "\n" : "";
  const text = `${left}${nlBefore}${inv.repeat(count)}${nlAfter}${right}`;
  const baseLen = left.length + nlBefore.length + nlAfter.length + right.length;
  const insertAt = left.length + nlBefore.length; // позиція першого INV
  const newlineOverhead = nlBefore.length + nlAfter.length;
  return { text, baseLen, insertAt, newlineOverhead };
}

function capCountByLength(
  baseLen: number,
  desiredCount: number,
  maxTextLength: number
): number {
  const allowed = Math.max(0, maxTextLength - baseLen);
  return Math.max(0, Math.min(desiredCount, allowed));
}

/** Build payloads for sendMessage (without sending) */
export function buildGhostPayloads(
  chatId: ChatId,
  userIds: UserId[],
  template: GhostTemplate = {},
  opts: BuildOptions = {}
): GhostPayload[] {
  const maxPerMessage = Math.max(1, opts.maxPerMessage ?? 100);
  const maxTextLength = opts.maxTextLength ?? DEFAULT_MAX_TEXT;
  const onOverflow: "split" | "error" = opts.onOverflow ?? "split";

  if (!Array.isArray(userIds) || userIds.length === 0) return [];

  const smartMode =
    template.message &&
    template.before === undefined &&
    template.after === undefined;
  const payloads: GhostPayload[] = [];

  if (smartMode) {
    const msg = template.message!;
    const inv =
      template.char ??
      pickInvChar(template.charCandidates ?? DEFAULT_INV_CANDIDATES, msg);
    const fallbackPosition =
      template.fallbackPosition ??
      (template.preferEndIfNoPunctuation ?? true ? "end" : "start");
    const punctuationRegex = template.punctuationRegex ?? DEFAULT_PUNCT_RE;
    const separateLine = !!template.separateLineForMentions;
    const trailingNewline = !!template.trailingNewline;

    let cursor = 0;
    while (cursor < userIds.length) {
      let desired = Math.min(maxPerMessage, userIds.length - cursor);

      const anchorAt = findAnchorIndex(msg, {
        replaceTargets: template.replaceTargets,
        replacePosition: template.replacePosition ?? "end",
        punctuationRegex,
        fallbackPosition
      });

      const { baseLen } = buildSmartBaseText(
        msg,
        inv,
        0,
        anchorAt,
        separateLine,
        trailingNewline
      );
      const allowed = capCountByLength(baseLen, desired, maxTextLength);

      if (allowed === 0) {
        throw new Error(
          `Base message too long to insert mentions (length=${msg.length}).`
        );
      }
      if (onOverflow === "error" && allowed < desired) {
        throw new Error(
          `Text overflow: need ${desired} mentions but only ${allowed} fit under ${maxTextLength}.`
        );
      }

      const take = allowed;
      const batch = userIds.slice(cursor, cursor + take);
      const { text, insertAt } = buildSmartBaseText(
        msg,
        inv,
        batch.length,
        anchorAt,
        separateLine,
        trailingNewline
      );
      if (text.length > maxTextLength) {
        throw new Error(
          `Resulting text exceeds ${maxTextLength} chars (smart mode).`
        );
      }
      const offsets = Array.from(
        { length: batch.length },
        (_, i) => insertAt + i
      );
      const entities = buildEntities(offsets, batch);
      payloads.push({ chat_id: chatId, text, entities });

      cursor += take;
    }
    return payloads;
  }

  // classic mode (before/after)
  const chunks = chunkUserIds(userIds, maxPerMessage);
  const charList = template.charCandidates ?? DEFAULT_INV_CANDIDATES;
  const inv =
    template.char ?? pickInvChar(charList, template.before, template.after);
  const before = toNFC(template.before ?? "");
  const after = toNFC(template.after ?? "");
  assertNoExistingInv(before, inv);
  assertNoExistingInv(after, inv);

  const baseLen = before.length + after.length;
  const capacity = Math.max(0, maxTextLength - baseLen);
  if (capacity <= 0) {
    throw new Error(
      `Classic mode: base too long (before+after=${baseLen}) to insert any mentions under ${maxTextLength}.`
    );
  }

  for (const chunk of chunks) {
    if (onOverflow === "error" && chunk.length > capacity) {
      throw new Error(
        `Classic mode overflow: need ${chunk.length} mentions, capacity ${capacity} at ${maxTextLength}.`
      );
    }
    let remaining = chunk.slice();
    while (remaining.length > 0) {
      const take = Math.min(remaining.length, capacity);
      const part = remaining.slice(0, take);
      const { text, offsets } = buildInvisibleText(part.length, {
        ...template,
        char: inv
      });
      if (text.length > maxTextLength) {
        throw new Error(
          `Classic mode: resulting text exceeds ${maxTextLength} chars.`
        );
      }
      const entities = buildEntities(offsets, part);
      payloads.push({ chat_id: chatId, text, entities });
      remaining = remaining.slice(take);
      if (onOverflow === "error" && remaining.length > 0) {
        throw new Error(
          `Classic mode overflow while splitting: leftover ${remaining.length}.`
        );
      }
    }
  }

  return payloads;
}

// --- Optional: send via Bot API ---
export interface SendOptions extends BuildOptions {
  token: string; // Bot token
  delayBetween?: number; // ms
  fetchImpl?: typeof fetch;
}

export interface SendResult {
  ok: boolean;
  messageIds: number[];
  errors?: { index: number; error: unknown }[];
}

async function callBotApi<T>(
  token: string,
  method: string,
  body: unknown,
  fetchImpl?: typeof fetch
): Promise<T> {
  const f = fetchImpl ?? (globalThis as any).fetch;
  if (!f)
    throw new Error("No fetch implementation available (Node 18+ required)");
  const res = await f(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!json.ok)
    throw new Error(
      `Telegram API error: ${json.description ?? res.statusText}`
    );
  return json.result as T;
}

export async function sendGhostMentions(
  chatId: ChatId,
  userIds: UserId[],
  template: GhostTemplate,
  options: SendOptions
): Promise<SendResult> {
  const {
    token,
    maxPerMessage = 5,
    delayBetween = 0,
    fetchImpl,
    maxTextLength = DEFAULT_MAX_TEXT,
    onOverflow = "split"
  } = options;

  const payloads = buildGhostPayloads(chatId, userIds, template, {
    maxPerMessage,
    maxTextLength,
    onOverflow
  });

  // safety check
  for (const p of payloads) {
    if (p.text.length > maxTextLength) {
      throw new Error(
        `Payload text exceeds ${maxTextLength} chars; chat_id=${p.chat_id}`
      );
    }
  }

  const messageIds: number[] = [];
  const errors: { index: number; error: unknown }[] = [];

  for (let i = 0; i < payloads.length; i++) {
    try {
      const result = await callBotApi<any>(
        token,
        "sendMessage",
        payloads[i],
        fetchImpl
      );
      messageIds.push(result.message_id);
    } catch (err) {
      errors.push({ index: i, error: err });
    }
    if (delayBetween > 0 && i < payloads.length - 1) {
      await new Promise((r) => setTimeout(r, delayBetween));
    }
  }
  return {
    ok: errors.length === 0,
    messageIds,
    errors: errors.length ? errors : undefined
  };
}

// --- Optional: cascade edit trick ---
export interface EditCascadeOptions {
  token: string;
  delayMs?: number; // default 1000ms
  fetchImpl?: typeof fetch;
}

export async function editCascade(
  chatId: ChatId,
  userIds: UserId[],
  template: GhostTemplate,
  { token, delayMs = 1000, fetchImpl }: EditCascadeOptions
): Promise<number> {
  if (userIds.length === 0) throw new Error("No userIds provided");
  const first = buildGhostPayloads(chatId, [userIds[0]], template, {
    maxPerMessage: 1
  })[0];
  const initial = await callBotApi<any>(token, "sendMessage", first, fetchImpl);
  const messageId = initial.message_id as number;

  for (let i = 1; i < userIds.length; i++) {
    const batched = buildGhostPayloads(chatId, [userIds[i]], template, {
      maxPerMessage: 1
    })[0];
    const body = {
      chat_id: chatId,
      message_id: messageId,
      text: batched.text,
      entities: batched.entities
    };
    await new Promise((r) => setTimeout(r, delayMs));
    await callBotApi<any>(token, "editMessageText", body, fetchImpl);
  }
  return messageId;
}

/* self-check */
(function _selfTest() {
  const { text, offsets } = buildInvisibleText(3, { before: "A", after: "B" });
  if (
    !(
      text.length === "A".length + 3 + "B".length &&
      offsets[0] === 1 &&
      offsets[2] === 3
    )
  ) {
    console.warn("tg-ghost self-test failed (offsets)");
  }
})();
