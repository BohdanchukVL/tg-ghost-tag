/* @tg-ghost-tag/core — minimal TS library for Telegram invisible mentions
   Requires Node 18+ (global fetch). */

export type UserId = number;
export type ChatId = number | string;

export interface MessageEntityTextMention {
  type: "text_mention";
  offset: number; // UTF-16 code units
  length: number; // always 1 (for INV char)
  user: { id: UserId };
}
export type MessageEntity = MessageEntityTextMention;

export interface GhostTemplate {
  before?: string;
  after?: string;
  char?: string; // INV character (fallback)
  message?: string;
  charCandidates?: string[];
  punctuationRegex?: RegExp;
  preferEndIfNoPunctuation?: boolean;
}

export interface GhostPayload {
  chat_id: ChatId;
  text: string;
  entities: MessageEntity[];
}

export interface BuildOptions {
  maxPerMessage?: number; // default 5
}

const DEFAULT_INV_CANDIDATES = [
  "\u200B",
  "\u2063",
  "\u2060",
  "\u200C",
  "\u200D"
];
const DEFAULT_PUNCT_RE = /[.!?…]/;

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
    if (!avoidIn.some((s) => s?.includes?.(c))) return c;
  }
  return candidates[0];
}

/** Build text and offsets for N mentions: before + INV.repeat(N) + after */
export function buildInvisibleText(
  count: number,
  template: GhostTemplate = {}
): { text: string; offsets: number[]; invChar: string } {
  // OLD path (explicit before/after)
  const charList = template.charCandidates ?? DEFAULT_INV_CANDIDATES;
  const inv =
    template.char ?? pickInvChar(charList, template.before, template.after);
  const before = toNFC(template.before ?? "");
  const after = toNFC(template.after ?? "");

  assertNoExistingInv(before, inv);
  assertNoExistingInv(after, inv);

  if (count <= 0)
    return { text: `${before}${after}`, offsets: [], invChar: inv };

  // JS string .length is already in UTF-16 code units, which Bot API expects
  const prefixLen = before.length;
  const text = `${before}${inv.repeat(count)}${after}`;
  const offsets = Array.from({ length: count }, (_, i) => prefixLen + i);
  return { text, offsets, invChar: inv };
}

/** Build MessageEntity[] from offsets and userIds */
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

/** Split userIds into chunks of size maxPerMessage */
export function chunkUserIds(userIds: UserId[], maxPerMessage = 5): UserId[][] {
  const out: UserId[][] = [];
  for (let i = 0; i < userIds.length; i += maxPerMessage) {
    out.push(userIds.slice(i, i + maxPerMessage));
  }
  return out;
}

function insertInvIntoMessage(
  message: string,
  count: number,
  inv: string,
  punctuationRe: RegExp,
  preferEndIfNoPunct: boolean
): { text: string; offsets: number[] } {
  const src = toNFC(message);
  if (count <= 0) return { text: src, offsets: [] };

  let last = -1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (punctuationRe.test(ch)) last = i;
  }
  const insertAt =
    last >= 0 ? last + 1 : preferEndIfNoPunct ? src.length : src.length;
  const left = src.slice(0, insertAt);
  const right = src.slice(insertAt);

  const text = `${left}${inv.repeat(count)}${right}`;
  const base = insertAt;
  const offsets = Array.from({ length: count }, (_, i) => base + i);
  return { text, offsets };
}

/** Create payloads for sendMessage (without sending) */
export function buildGhostPayloads(
  chatId: ChatId,
  userIds: UserId[],
  template: GhostTemplate = {},
  opts: BuildOptions = {}
): GhostPayload[] {
  const { maxPerMessage = 5 } = opts;
  const chunks = chunkUserIds(userIds, maxPerMessage);

  const useSmart =
    template.message &&
    template.before === undefined &&
    template.after === undefined;

  if (useSmart) {
    const msg = template.message!;
    const punctRe = template.punctuationRegex ?? DEFAULT_PUNCT_RE;
    const inv = pickInvChar(
      template.charCandidates ?? DEFAULT_INV_CANDIDATES,
      msg
    );

    return chunks.map((chunk) => {
      const { text, offsets } = insertInvIntoMessage(
        msg,
        chunk.length,
        inv,
        punctRe,
        template.preferEndIfNoPunctuation ?? true
      );
      const entities = buildEntities(offsets, chunk);
      return { chat_id: chatId, text, entities };
    });
  }

  return chunks.map((chunk) => {
    const { text, offsets } = buildInvisibleText(chunk.length, template);
    const entities = buildEntities(offsets, chunk);
    return { chat_id: chatId, text, entities };
  });
}

// --- Optional: send via Bot API ---
export interface SendOptions extends BuildOptions {
  token: string; // Bot token
  delayBetween?: number; // ms between sendMessage calls (default 0)
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
    throw new Error(
      "No fetch implementation available in this runtime (Node 18+ required)"
    );
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

/** Send one or more payloads to Telegram */
export async function sendGhostMentions(
  chatId: ChatId,
  userIds: UserId[],
  template: GhostTemplate,
  options: SendOptions
): Promise<SendResult> {
  const { token, maxPerMessage = 5, delayBetween = 0, fetchImpl } = options;
  const payloads = buildGhostPayloads(chatId, userIds, template, {
    maxPerMessage
  });

  const messageIds: number[] = [];
  const errors: { index: number; error: unknown }[] = [];

  for (let i = 0; i < payloads.length; i++) {
    const p = payloads[i];
    try {
      const result = await callBotApi<any>(token, "sendMessage", p, fetchImpl);
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
  // initial send
  const first = buildGhostPayloads(chatId, [userIds[0]], template, {
    maxPerMessage: 1
  })[0];
  const initial = await callBotApi<any>(token, "sendMessage", first, fetchImpl);
  const messageId = initial.message_id as number;
  // sequential edits
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

// quick self-check (no side effects)
(function _selfTest() {
  const { text, offsets } = buildInvisibleText(3, { before: "A", after: "B" });
  if (
    !(
      text.length === "A".length + 3 + "B".length &&
      offsets[0] === 1 &&
      offsets[2] === 3
    )
  ) {
    console.warn("tg-ghost self-test failed (offsets) — check environment");
  }
})();
