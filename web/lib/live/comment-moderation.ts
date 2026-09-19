import "server-only";

/**
 * Comment moderation — profanity/spam gate (MASTER_LIVE_TECH §6, PO item 12).
 *
 * Runs server-side before broadcast; a rejected comment is never delivered.
 * The blocklist is TUNABLE configuration (not policy-locked) and may be
 * replaced by a service integration later without changing this boundary.
 * Fail-closed default: reject + count; nothing is ever persisted (comments
 * remain ephemeral).
 */

const PROFANITY_BLOCKLIST: readonly string[] = [
  // TUNABLE blocklist (tech §6): minimal Indonesian + English hard-blocking
  // terms; extended via server config, never via client input.
  "anjing", "bangsat", "bajingan", "babi", "brengsek", "jembut", "memek",
  "kontol", "pepek", "ngentot", "bencong", "bego", "goblok", "tai",
  "fuck", "shit", "bitch", "asshole", "cunt", "dick", "whore", "slut",
];

const SPAM_LINK_PATTERN = /(https?:\/\/|www\.)\S+/i;
const REPEATED_CHAR_PATTERN = /(.)\1{9,}/; // 10+ identical chars in a row
const REPEATED_WORD_PATTERN = /(\b\S+\b)(\s+\1){4,}/i; // same word 5+ times

export type CommentModerationVerdict = {
  allowed: boolean;
  reason: "profanity" | "spam_link" | "spam_repetition" | null;
};

function containsProfanity(normalized: string): boolean {
  return PROFANITY_BLOCKLIST.some((term) =>
    normalized.includes(term),
  );
}

/**
 * Screens a comment for profanity/spam (fail closed). Runs BEFORE the
 * Realtime broadcast — a rejected comment never reaches other viewers.
 */
export function moderateLiveComment(body: string): CommentModerationVerdict {
  // Normalization: case-fold + common leet/obfuscation digits so "b4b1" still
  // matches. Keeps the gate effective without persisting anything.
  const normalized = body
    .toLowerCase()
    .replace(/[4@]/g, "a")
    .replace(/[1!|]/g, "i")
    .replace(/[3]/g, "e")
    .replace(/[0]/g, "o")
    .replace(/[5$]/g, "s");

  if (containsProfanity(normalized)) {
    return { allowed: false, reason: "profanity" };
  }
  if (SPAM_LINK_PATTERN.test(body)) {
    return { allowed: false, reason: "spam_link" };
  }
  if (REPEATED_CHAR_PATTERN.test(body) || REPEATED_WORD_PATTERN.test(body)) {
    return { allowed: false, reason: "spam_repetition" };
  }

  return { allowed: true, reason: null };
}
