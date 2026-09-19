import assert from "node:assert/strict";
import test from "node:test";
import { moderateLiveCommentCore } from "../lib/live/comment-moderation-core";

test("Profanity blocklist rejects exact and leet-obfuscated terms", () => {
  assert.equal(moderateLiveCommentCore("ini kata anjing").allowed, false);
  assert.equal(moderateLiveCommentCore("b4b1").allowed, false);
  assert.equal(moderateLiveCommentCore("B4NGSAT sekali").allowed, false);
  const verdict = moderateLiveCommentCore("fuck you");
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "profanity");
});

test("Spam patterns reject links and floods", () => {
  const link = moderateLiveCommentCore("kunjungi https://spam.example gratis");
  assert.equal(link.allowed, false);
  assert.equal(link.reason, "spam_link");

  const chars = moderateLiveCommentCore("aaaaaaaaaaaaaaaaaaaa");
  assert.equal(chars.allowed, false);
  assert.equal(chars.reason, "spam_repetition");

  const words = moderateLiveCommentCore("beli sekarang beli sekarang beli sekarang beli sekarang beli sekarang");
  assert.equal(words.allowed, false);
  assert.equal(words.reason, "spam_repetition");
});

test("Normal comments pass the gate", () => {
  assert.deepEqual(moderateLiveCommentCore("Proses fermentasinya menarik sekali"), {
    allowed: true,
    reason: null,
  });
  assert.deepEqual(moderateLiveCommentCore("Berapa lama tahap pengeringan?"), {
    allowed: true,
    reason: null,
  });
});
