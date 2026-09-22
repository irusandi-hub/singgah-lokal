import assert from "node:assert/strict";
import test from "node:test";
import { MIN_SIGN_UP_PASSWORD_LENGTH, validateSignUpInput } from "../lib/auth/sign-up";

const valid = { name: "Budi Santoso", email: "budi@example.com", password: "rahasia-ku", passwordConfirmation: "rahasia-ku" };

test("a complete, well-formed sign-up input passes", () => {
  assert.equal(validateSignUpInput(valid), null);
});

test("missing required fields are rejected", () => {
  assert.equal(validateSignUpInput({ ...valid, name: "   " }), "fields_required");
  assert.equal(validateSignUpInput({ ...valid, email: "" }), "fields_required");
  assert.equal(validateSignUpInput({ ...valid, password: "" }), "fields_required");
  assert.equal(validateSignUpInput({ ...valid, passwordConfirmation: "" }), "fields_required");
});

test("malformed email addresses are rejected", () => {
  assert.equal(validateSignUpInput({ ...valid, email: "budi(at)example.com" }), "email_invalid");
  assert.equal(validateSignUpInput({ ...valid, email: "budi@no-tld" }), "email_invalid");
  assert.equal(validateSignUpInput({ ...valid, email: "budi example.com" }), "email_invalid");
});

test("password confirmation must match exactly", () => {
  assert.equal(validateSignUpInput({ ...valid, passwordConfirmation: "rahasia-kuda" }), "password_mismatch");
});

test("passwords below the minimum length are rejected", () => {
  assert.equal(validateSignUpInput({ ...valid, password: "pendek", passwordConfirmation: "pendek" }), "password_too_short");
  assert.equal(MIN_SIGN_UP_PASSWORD_LENGTH, 8);
});
