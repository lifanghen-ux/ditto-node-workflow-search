import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { AutomationBridge, OfficialAutomationSession, automationAdapter, automationScope } from "./automation.js";

const native = Boolean(process.env.DITTO_AUTOMATION_PYTHON && process.env.DITTO_AUTOMATION_ROOT && process.env.DITTO_AUTOMATION_DATA);

test("argument mistakes remain observations while broken environment state invalidates the session", async () => {
  const broken = new OfficialAutomationSession({ assertHealthy() {}, async request() { throw new Error("offline broken bridge"); } } as unknown as AutomationBridge, "fixture", "fixture", "a".repeat(64), []);
  const result = await broken.call("api_fetch", { method: 7 });
  assert.match(result.content, /INVALID_TOOL_ARGUMENTS/);
  broken.assertHealthy();
  assert.equal(broken.trace.length, 1);
  await assert.rejects(broken.call("base64_encode", { text: "hello" }), /offline broken bridge/);
  assert.throws(() => broken.assertHealthy(), /offline broken bridge/);
  await assert.rejects(broken.grade({ contract: "a".repeat(64), world: undefined } as never), /saved world/);
});

test("JSON-null query strings are repairable tool observations without swallowing bridge faults", async () => {
  const calls: Record<string, unknown>[] = [];
  const session = new OfficialAutomationSession({ assertHealthy() {}, async request(value: Record<string, unknown>) { calls.push(value); return { content: "official response" }; } } as unknown as AutomationBridge, "fixture", "fixture", "a".repeat(64), []);
  for (const params of ["null", "[]", "3", "true"]) {
    const response = await session.call("api_fetch", { method: "GET", url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/msg_3005", params, body: null });
    assert.match(response.content, /INVALID_TOOL_ARGUMENTS/);
    session.assertHealthy();
  }
  assert.equal(calls.length, 0, "non-object JSON query params never reach the official router's **params");
  for (const params of [null, "{}", '{"format":"full"}', {}, ""]) {
    const response = await session.call("api_fetch", { method: "GET", url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/msg_3005", params, body: null });
    assert.equal(response.content, "official response");
  }
  assert.equal(calls.length, 5);
  assert.equal(session.trace.filter((entry) => entry.argumentError).length, 4);
});

test("the observed Gmail params mistake can be corrected in the same official world", { skip: !native }, async () => {
  const bridge = await AutomationBridge.open();
  try {
    const session = await bridge.start("simple.email_sf_contact_account_update");
    try {
      const args = { method: "GET", url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/msg_3005", body: null };
      assert.match((await session.call("api_fetch", { ...args, params: "null" })).content, /INVALID_TOOL_ARGUMENTS/);
      session.assertHealthy();
      const corrected = await session.call("api_fetch", { ...args, params: null });
      assert.equal(typeof corrected.content, "string");
      assert.doesNotMatch(corrected.content, /argument after \*\*/);
      session.assertHealthy();
    } finally { await session.close(); }
  } finally { await bridge.close(); }
});

test("duplicate query/body fields yield observations while corrected calls still surface real bridge faults", async () => {
  let calls = 0;
  const session = new OfficialAutomationSession({ assertHealthy() {}, async request() { calls++; throw new Error("offline genuine environment fault"); } } as unknown as AutomationBridge, "fixture", "fixture", "a".repeat(64), []);
  const args = { method: "POST", url: "https://api.trello.com/1/cards/card/idLabels", params: '{"value":"label_urgent"}', body: '{"value":"label_urgent"}' };
  const result = await session.call("api_fetch", args);
  assert.match(result.content, /INVALID_TOOL_ARGUMENTS/);
  assert.match(result.content, /both params and body: value/);
  session.assertHealthy();
  assert.equal(calls, 0);
  assert.deepEqual(session.trace[0]?.arguments, args, "retain the original duplicate fields rather than silently choosing one");
  await assert.rejects(session.call("api_fetch", { ...args, body: null }), /genuine environment fault/);
  assert.equal(calls, 1);
  assert.throws(() => session.assertHealthy(), /genuine environment fault/);
});

test("the observed Trello duplicate field mistake can be corrected in the same official world", { skip: !native }, async () => {
  const bridge = await AutomationBridge.open();
  try {
    const session = await bridge.start("simple.trello_urgent_support_card");
    try {
      const created = JSON.parse((await session.call("api_fetch", { method: "POST", url: "https://api.trello.com/1/cards", params: null,
        body: JSON.stringify({ idList: "lst_support_todo", idBoard: "brd_support", name: "Offline parameter regression fixture" }) })).content) as { id: string };
      assert.equal(typeof created.id, "string");
      const args = { method: "POST", url: `https://api.trello.com/1/cards/${created.id}/idLabels`, params: '{"value":"label_urgent"}', body: '{"value":"label_urgent"}' };
      const before = await session.snapshot();
      assert.match((await session.call("api_fetch", args)).content, /INVALID_TOOL_ARGUMENTS/);
      session.assertHealthy();
      assert.deepEqual((await session.snapshot()).world, before.world, "invalid arguments perform no state mutation");
      const corrected = JSON.parse((await session.call("api_fetch", { ...args, body: null })).content) as unknown[];
      assert.ok(Array.isArray(corrected) && corrected.length > 0);
      session.assertHealthy();
      assert.notDeepEqual((await session.snapshot()).world, before.world, "the corrected official call records the label mutation");
    } finally { await session.close(); }
  } finally { await bridge.close(); }
});

test("official task worlds isolate mutations and replay saved contract snapshots", { skip: !native }, async () => {
  const bridge = await AutomationBridge.open();
  try {
    const [changed, untouched] = await Promise.all([bridge.start("simple.email_sf_contact_phone_update"), bridge.start("simple.email_sf_contact_phone_update")]);
    try {
      assert.deepEqual(changed.tools.map((tool) => tool.name).sort(), ["api_fetch", "api_search", "base64_encode"]);
      const search = await changed.call("api_search", { query: "salesforce contacts update", top_k: 1 });
      assert.match(search.content, /salesforce/);
      await changed.call("api_fetch", { method: "PATCH", url: "https://yourinstance.salesforce.com/services/data/v61.0/sobjects/Contact/003001", params: null, body: JSON.stringify({ Phone: "+1-555-0101" }) });
      const [changedWorld, untouchedWorld] = await Promise.all([changed.snapshot(), untouched.snapshot()]);
      assert.notDeepEqual(changedWorld.world, untouchedWorld.world);
      assert.equal((await changed.grade(changedWorld)).score, 1);
      assert.equal((await untouched.grade(untouchedWorld)).score, 0);
      const regrade = await bridge.start("simple.email_sf_contact_phone_update");
      try {
        const grade = await regrade.grade(JSON.parse(JSON.stringify(changedWorld)) as typeof changedWorld);
        assert.equal(grade.score, 1);
        assert.equal(grade.partialCredit, 1);
        await assert.rejects(regrade.grade({ ...changedWorld, contract: "0".repeat(64) }), /matching task contract/);
      } finally { await regrade.close(); }
    } finally { await changed.close(); await untouched.close(); }
  } finally { await bridge.close(); }
});

test("adapter uses unchanged evaluator and fresh official scopes for each runner attempt", { skip: !native }, async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), "ditto-automation-test-"));
  try {
    const benchmark = await automationAdapter.load({ dataDir: process.env.DITTO_AUTOMATION_DATA!, split: "validate", limit: 1, seed: 42, artifactDir });
    assert.equal(benchmark.tasks.length, 1);
    assert.equal("reference" in benchmark.tasks[0]!, false);
    assert.equal("world" in benchmark.tasks[0]!, false);
    let priorScope: unknown;
    let attempts = 0;
    const summary = await benchmark.evaluate(async () => {
      const session = automationScope.getStore();
      assert.ok(session);
      assert.notEqual(priorScope, session);
      priorScope = session;
      assert.equal(session.tools.length, 3);
      if (++attempts === 1) throw new Error("Model provider returned HTTP 503 (offline retry fixture)");
      return { answer: "A textual claim without any action.", executedNodeIds: [], executedGraphIds: [], inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    }, { repeats: 2, concurrency: 1 });
    assert.equal(summary.valid, true);
    assert.equal(summary.results.length, 2);
    assert.ok(summary.results.every((result) => result.score === 0), "textual completion claims leave these official worlds unfinished");
    assert.equal(attempts, 3, "the failed attempt gets a fresh world on retry");
    assert.ok(summary.results.every((result) => result.method === "automationbench-official-assertions-v1"));
    const artifacts = await readdir(join(artifactDir, "automation-worlds"));
    assert.equal(artifacts.length, 3, "failed and successful attempts both retain their private snapshots");
    const one = JSON.parse(await readFile(join(artifactDir, "automation-worlds", artifacts[0]!), "utf8")) as { snapshot: { world: object; contract: string } };
    assert.equal(typeof one.snapshot.world, "object");
    assert.match(one.snapshot.contract, /^[a-f0-9]{64}$/);
    assert.equal(automationScope.getStore(), undefined);
  } finally {
    assert.ok(resolve(artifactDir).startsWith(resolve(tmpdir()) + sep) && basename(artifactDir).startsWith("ditto-automation-test-"));
    await rm(artifactDir, { recursive: true, force: true });
  }
});
