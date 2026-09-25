import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const securityApi = readFileSync(new URL("../app/api/creator/security-settings/route.ts", import.meta.url), "utf8");
const securityLib = readFileSync(new URL("../lib/creator/security-settings.ts", import.meta.url), "utf8");
const securityManager = readFileSync(new URL("../app/developer/account-security-manager.tsx", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
}

function sliceBody(source: string, actionName: string): string {
  const start = source.indexOf(actionName);
  assert.ok(start >= 0, `${actionName} must exist`);
  const next = source.indexOf("\n    if (action ===", start + 1);
  return stripComments(source.slice(start, next === -1 ? undefined : next));
}

test("change-email requires the current password server-side and never the secret answer", () => {
  const body = sliceBody(securityApi, 'if (action === "change-email")');
  assert.match(body, /signInWithPassword/);
  assert.match(body, /invalid_current_password/);
  assert.doesNotMatch(body, /secretAnswer|checkCreatorSecretAnswer/);
});

test("change-password requires the current password server-side and never the secret answer", () => {
  const body = sliceBody(securityApi, 'if (action === "change-password")');
  assert.match(body, /signInWithPassword/);
  assert.match(body, /invalid_current_password/);
  assert.doesNotMatch(body, /secretAnswer|checkCreatorSecretAnswer/);
});

test("change-secret-question never uses the account password", () => {
  const body = sliceBody(securityApi, 'if (action === "change-secret-question")');
  assert.doesNotMatch(body, /signInWithPassword|currentPassword/);
  assert.match(body, /checkCreatorSecretAnswer/);
  assert.match(body, /invalid_secret_answer/);
});

test("change-secret-question requires the old answer only when a question is configured", () => {
  const body = sliceBody(securityApi, 'if (action === "change-secret-question")');
  // Verification is gated on the stored configured status, and a missing old
  // answer is rejected before any storage call.
  const configuredIdx = body.indexOf("status.configured");
  const oldAnswerIdx = body.indexOf("old_answer_required");
  const verifiedIdx = body.indexOf("checkCreatorSecretAnswer");
  const setIdx = body.indexOf("setCreatorSecretQuestion");
  assert.ok(configuredIdx >= 0, "old-answer enforcement must be gated on configured status");
  assert.ok(oldAnswerIdx >= 0 && configuredIdx < oldAnswerIdx, "missing old answer must be rejected when configured");
  assert.ok(verifiedIdx >= 0 && oldAnswerIdx < verifiedIdx, "old answer must be verified before storage");
  assert.ok(setIdx >= 0 && verifiedIdx < setIdx, "storage must follow server-side verification");
});

test("every security action verifies Creator authorization before any other work", () => {
  const code = stripComments(securityApi);
  const creatorIdx = code.indexOf("const creator = await requireCreator()");
  assert.ok(creatorIdx >= 0);
  for (const action of ["change-email", "change-password", "change-secret-question"]) {
    const actionIdx = code.indexOf(`action === "${action}"`);
    assert.ok(actionIdx >= 0 && creatorIdx < actionIdx, `${action} must run after requireCreator()`);
  }
  // The secret-question storage helpers re-verify Creator themselves too.
  for (const name of ["getCreatorSecretQuestion", "setCreatorSecretQuestion", "checkCreatorSecretAnswer"]) {
    const fn = securityLib.slice(securityLib.indexOf(`export async function ${name}`));
    const body = fn.slice(0, fn.indexOf("\n}"));
    assert.match(body, /await requireCreator\(\)/, `${name} must verify Creator first`);
  }
});

test("secret answers are stored as salted hashes and never returned to the client", () => {
  assert.match(securityLib, /randomBytes/);
  assert.match(securityLib, /scrypt/);
  assert.match(securityLib, /timingSafeEqual/);
  assert.match(securityLib, /answer_salt/);
  assert.match(securityLib, /answer_hash/);
  // Neither the API nor the UI may expose hash/salt material.
  for (const [label, source] of [["api", securityApi], ["ui", securityManager]] as const) {
    assert.doesNotMatch(stripComments(source), /answer_hash|answer_salt/, `${label} must not expose hash material`);
  }
});

test("the manager has three independent per-menu states", () => {
  const code = stripComments(securityManager);
  for (const name of ["emailState", "passwordState", "secretState"]) {
    assert.match(code, new RegExp(`const \\[${name}, set${name.charAt(0).toUpperCase()}${name.slice(1)}\\] = useState<MenuState>`), `${name} must exist`);
  }
  assert.match(code, /type MenuState =/);
  assert.match(code, /"idle"/);
  assert.match(code, /"loading"/);
  assert.match(code, /"success"/);
  assert.match(code, /"error"/);
});

test("no global feedback or shared pending flag remains in the manager", () => {
  const code = stripComments(securityManager);
  assert.doesNotMatch(code, /pendingAction|globalFeedback|setFeedback\(|setPending\(/);
});

test("submitting one menu touches only that menu's own state", () => {
  const setters = ["setEmailState", "setPasswordState", "setSecretState"] as const;
  for (const [handler, setter] of [
    ["onChangeEmail", "setEmailState"],
    ["onChangePassword", "setPasswordState"],
    ["onChangeSecretQuestion", "setSecretState"],
  ] as const) {
    const start = securityManager.indexOf(`async function ${handler}`);
    assert.ok(start >= 0, `${handler} must exist`);
    const end = securityManager.indexOf("\n  }", start);
    const body = stripComments(securityManager.slice(start, end));
    assert.match(body, new RegExp(setter), `${handler} must use ${setter}`);
    const banned = setters.filter((s) => s !== setter).join("|");
    assert.doesNotMatch(body, new RegExp(banned), `${handler} must not set another menu's state`);
  }
});

test("feedback and loading render directly above each menu's own form", () => {
  const code = securityManager;
  for (const state of ["emailState", "passwordState", "secretState"]) {
    const feedbackIdx = code.indexOf(`<Feedback state={${state}} />`);
    const loadingIdx = code.indexOf(`<LoadingLine state={${state}} />`);
    const formIdx = code.indexOf("<form", loadingIdx);
    assert.ok(feedbackIdx >= 0, `${state} feedback must render`);
    assert.ok(loadingIdx >= 0 && feedbackIdx < loadingIdx, `${state} feedback must precede its loading line`);
    assert.ok(formIdx >= 0 && loadingIdx < formIdx, `${state} loading line must render directly above its form`);
  }
});

test("each submit button is disabled only by its own menu's loading state", () => {
  const code = stripComments(securityManager);
  for (const state of ["emailState", "passwordState", "secretState"]) {
    const buttonIdx = code.indexOf(`disabled={${state}.status === "loading"}`);
    assert.ok(buttonIdx >= 0, `${state} button must be disabled only by ${state} loading`);
  }
  // No shared/combined disabled expression that spans menus.
  assert.doesNotMatch(code, /disabled=\{(?:emailState|passwordState|secretState)[^}]*status === "loading" [^}]*\|\|/);
});

test("the secret question form sends the old answer only when a question is configured", () => {
  const code = stripComments(securityManager);
  const idx = code.indexOf("const fields: Record<string, string> =");
  const sendIdx = code.indexOf("await submit(", idx);
  const body = code.slice(idx, sendIdx);
  assert.match(body, /questionStatus\?\.configured/);
  assert.match(body, /if \(questionStatus\?\.configured\) fields\.secretAnswer = oldSecretAnswer/);
});

test("initial secret-question creation is allowed without an old answer", () => {
  // The client-side "old answer required" check is gated on configured status.
  const handlerStart = securityManager.indexOf("async function onChangeSecretQuestion");
  const handlerEnd = securityManager.indexOf("\n  }", handlerStart);
  const handler = stripComments(securityManager.slice(handlerStart, handlerEnd));
  const gate = handler.indexOf("questionStatus?.configured && !oldSecretAnswer");
  assert.ok(gate >= 0, "old-answer client check must be gated on configured status");
  // The API rejects a missing old answer only inside the configured branch.
  const apiBody = sliceBody(securityApi, 'if (action === "change-secret-question")');
  const configuredGate = apiBody.indexOf("if (status.configured)");
  const oldAnswerGate = apiBody.indexOf("old_answer_required");
  assert.ok(configuredGate >= 0 && oldAnswerGate > configuredGate, "old-answer enforcement must live inside the configured branch");
});

test("success feedback is shown only after the backend confirms the change", () => {
  const submitStart = securityManager.indexOf("async function submit(");
  const submitEnd = securityManager.indexOf("\n  }", submitStart);
  const submit = stripComments(securityManager.slice(submitStart, submitEnd));
  const okIdx = submit.indexOf('status: "success"');
  const fetchIdx = submit.indexOf('await fetch("/api/creator/security-settings"');
  assert.ok(fetchIdx >= 0 && okIdx > fetchIdx, "success must follow the real server response");
  assert.match(submit, /response\.ok/);
});
