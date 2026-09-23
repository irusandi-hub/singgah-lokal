import "server-only";

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { requireCreator } from "@/lib/auth/creator";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

export const SECRET_QUESTION_MIN_LENGTH = 1;
export const SECRET_QUESTION_MAX_LENGTH = 200;
export const SECRET_ANSWER_MAX_LENGTH = 200;

/**
 * CREATOR ACCOUNT SECURITY (Authority Master §2).
 *
 * Every operation re-verifies Creator authorization server-side via
 * requireCreator() before touching data. The secret-question store is only
 * reachable through the service-role client: migration 0014 enables RLS with
 * no policies, so anon/authenticated roles can never read or write it. The
 * service key stays in the server runtime and is never serialized anywhere.
 *
 * Answers are never stored in plaintext and never hardcoded: each row keeps
 * a fresh random salt plus an scrypt hash. Verification uses timing-safe
 * comparison. API surfaces expose only the question text — never the answer,
 * its hash, or its salt.
 */

export type SecretQuestionStatus =
  | { configured: true; question: string; updatedAt: string }
  | { configured: false };

export class SecretQuestionValidationError extends Error {}

export function validateSecretQuestionInput(question: string, answer: string): string | null {
  const trimmedQuestion = question.trim();
  if (trimmedQuestion.length < SECRET_QUESTION_MIN_LENGTH || trimmedQuestion.length > SECRET_QUESTION_MAX_LENGTH) {
    return "Pertanyaan rahasia harus 1–200 karakter.";
  }
  const trimmedAnswer = answer.trim();
  if (trimmedAnswer.length < SECRET_ANSWER_MIN_LENGTH || trimmedAnswer.length > SECRET_ANSWER_MAX_LENGTH) {
    return "Jawaban harus 1–200 karakter.";
  }
  return null;
}

const SECRET_ANSWER_MIN_LENGTH = 1;

export async function hashSecretAnswer(answer: string): Promise<{ salt: string; hash: string }> {
  const salt = randomBytes(SALT_BYTES).toString("hex");
  const derived = await scrypt(answer, salt, SCRYPT_KEYLEN);
  return { salt, hash: derived.toString("hex") };
}

export async function verifySecretAnswer(
  answer: string,
  salt: string,
  expectedHash: string,
): Promise<boolean> {
  const derived = await scrypt(answer, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(expectedHash, "hex");
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

type SecretQuestionRow = {
  question: string;
  answer_salt: string;
  answer_hash: string;
  updated_at: string;
};

/** Reads the Creator's secret question (text only) — Creator verified server-side. */
export async function getCreatorSecretQuestion(userId: string): Promise<SecretQuestionStatus> {
  await requireCreator();
  const supabase = createSupabaseServiceClient();

  const { data, error } = await supabase
    .from("creator_secret_question")
    .select("question, answer_salt, answer_hash, updated_at")
    .eq("user_id", userId)
    .maybeSingle<SecretQuestionRow>();

  if (error) throw error;
  if (!data) return { configured: false };
  return { configured: true, question: data.question, updatedAt: data.updated_at };
}

/** Upserts the Creator's secret question — Creator verified server-side. */
export async function setCreatorSecretQuestion(
  userId: string,
  question: string,
  answer: string,
): Promise<void> {
  await requireCreator();
  const validationError = validateSecretQuestionInput(question, answer);
  if (validationError) throw new SecretQuestionValidationError(validationError);

  const supabase = createSupabaseServiceClient();
  const { salt, hash } = await hashSecretAnswer(answer.trim());

  const { error } = await supabase.from("creator_secret_question").upsert(
    {
      user_id: userId,
      question: question.trim(),
      answer_salt: salt,
      answer_hash: hash,
    },
    { onConflict: "user_id" },
  );

  if (error) throw error;
}

/**
 * Verifies a candidate answer against the stored hash — Creator verified
 * server-side. Returns false both when unset and when the answer is wrong,
 * so the endpoint cannot be used to probe whether a question exists.
 */
export async function checkCreatorSecretAnswer(userId: string, answer: string): Promise<boolean> {
  await requireCreator();
  const supabase = createSupabaseServiceClient();

  const { data, error } = await supabase
    .from("creator_secret_question")
    .select("answer_salt, answer_hash")
    .eq("user_id", userId)
    .maybeSingle<{ answer_salt: string; answer_hash: string }>();

  if (error) throw error;
  if (!data) return false;
  return verifySecretAnswer(answer, data.answer_salt, data.answer_hash);
}
