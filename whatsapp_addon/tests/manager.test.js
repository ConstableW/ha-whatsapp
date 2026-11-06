const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { setup } = require("./helpers");

const mkCreds = (env, id) => {
  const dir = path.join(env.dir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "creds.json"), "{}");
  return dir;
};

test("init starts enabled clients only", () => {
  const env = setup({
    options: { clients: ["a", "b"], disabled_clients: ["b"] },
  });
  assert.ok(env.client("a").started);
  assert.equal(env.client("b"), undefined);
  assert.equal(env.manager.summary("b").state, "disabled");
  env.cleanup();
});

test("states follow the connection events and counters are kept", () => {
  const env = setup();
  const c = env.client("default");
  const state = () => env.manager.summary("default").state;

  c.emit("connecting");
  assert.equal(state(), "connecting");
  c.emit("qr", "QR-DATA");
  assert.equal(state(), "qr_required");
  assert.ok(env.manager.summary("default").hasQr);
  assert.ok(env.manager.qrPng("default").length > 50);

  c.emit("ready");
  assert.equal(state(), "connected");
  assert.equal(env.manager.qrPng("default"), null);

  c.emit("disconnected", { code: 408, reason: "timedOut" });
  assert.equal(state(), "disconnected_temp");
  c.emit("reconnecting", 1);
  assert.equal(state(), "reconnecting");
  c.emit("connecting");
  assert.equal(state(), "reconnecting", "a drop is not shown as a fresh connect");
  c.emit("ready");
  assert.equal(state(), "connected");

  const k = env.manager.summary("default").counters;
  assert.equal(k.disconnects, 1);
  assert.equal(k.reconnects, 1);
  assert.ok(env.statsStore.get("default").events.some((e) => e.type === "disconnected"));
  env.cleanup();
});

test("incoming messages are counted and forwarded as events", () => {
  const env = setup();
  const c = env.client("default");
  c.emit("msg", { key: { remoteJid: "x@g.us" }, groupName: "Family" });
  const k = env.manager.summary("default").counters;
  assert.equal(k.incoming, 1);
  assert.equal(k.todayIncoming, 1);
  const fired = env.notifier.calls.find((x) => x[0] === "fireEvent");
  assert.equal(fired[1], "new_whatsapp_message");
  assert.equal(fired[2].clientId, "default");
  assert.equal(fired[2].groupName, "Family");
  env.cleanup();
});

test("a logout is not repaired automatically and survives a restart", () => {
  const env = setup();
  env.client("default").emit("logout");
  assert.equal(env.manager.summary("default").state, "auth_invalid");
  assert.equal(env.clients.length, 1, "no new client was created");
  assert.ok(env.notifier.calls.some((x) => x[0] === "authInvalid"));

  env.restart();
  assert.equal(env.clients.length, 0, "not started again after a restart");
  assert.equal(env.manager.summary("default").state, "auth_invalid");
  assert.throws(() => env.manager.connect("default"), /Re-authenticate/);
  env.cleanup();
});

test("reauth replaces only the chosen client and wipes its session", async () => {
  const env = setup({ options: { clients: ["a", "b"] } });
  const a1 = env.client("a");
  const b1 = env.client("b");
  b1.emit("ready");
  const aDir = mkCreds(env, "a");
  const bDir = mkCreds(env, "b");
  a1.emit("logout");

  await env.manager.reauth("a");

  assert.ok(!fs.existsSync(aDir), "session of a was wiped");
  assert.ok(fs.existsSync(bDir), "session of b is untouched");
  assert.ok(a1.stopped);
  assert.ok(!b1.stopped, "b keeps running");
  assert.equal(env.manager.summary("b").state, "connected");

  const a2 = env.client("a");
  assert.notEqual(a2, a1);
  assert.ok(a2.started);
  assert.equal(env.manager.summary("a").state, "connecting");

  a1.emit("ready"); // late event of the old client must be ignored
  assert.equal(env.manager.summary("a").state, "connecting");
  env.cleanup();
});

test("a removed client does not come back after a restart", async () => {
  const env = setup({ options: { clients: ["a", "b"] } });
  const aDir = mkCreds(env, "a");
  env.statsStore.inc("a", "sent");

  await env.manager.remove("a");
  assert.ok(env.client("a").loggedOut);
  assert.ok(!fs.existsSync(aDir));

  env.restart();
  assert.deepEqual(env.manager.list().map((c) => c.id), ["b"]);
  assert.equal(env.statsStore.get("a").sent, 0);
  env.cleanup();
});

test("add validates, persists and starts pairing", async () => {
  const env = setup();
  await assert.rejects(() => env.manager.add({ id: "bad id" }), /Invalid client ID/);
  await assert.rejects(() => env.manager.add({ id: "default" }), /already exists/);

  const created = await env.manager.add({ id: "work", label: "  Office  " });
  assert.equal(created.label, "Office");
  assert.ok(env.client("work").started);

  env.restart();
  const ids = env.manager.list().map((c) => c.id);
  assert.deepEqual(ids, ["default", "work"]);
  assert.equal(env.manager.summary("work").label, "Office");
  env.cleanup();
});

test("if the configuration cannot be saved nothing changes", async () => {
  const env = setup();
  env.optionsStore.update = async () => {
    throw new Error("supervisor down");
  };
  await assert.rejects(() => env.manager.add({ id: "x" }), /Could not save/);
  assert.ok(!env.manager.exists("x"));
  await assert.rejects(() => env.manager.remove("default"), /Could not save/);
  assert.ok(env.manager.exists("default"));
  assert.ok(!env.client("default").stopped);
  env.cleanup();
});

test("rename, disable and enable are persisted", async () => {
  const env = setup();
  await env.manager.rename("default", "Private");
  await env.manager.setEnabled("default", false);
  const c = env.client("default");
  assert.ok(c.stopped);
  assert.equal(env.manager.summary("default").state, "disabled");

  env.restart();
  assert.equal(env.manager.summary("default").label, "Private");
  assert.equal(env.manager.summary("default").state, "disabled");
  assert.equal(env.clients.length, 0);

  await env.manager.setEnabled("default", true);
  assert.ok(env.client("default").started);
  env.cleanup();
});

test("manual disconnect and connect leave other clients alone", () => {
  const env = setup({ options: { clients: ["a", "b"] } });
  env.client("a").emit("ready");
  env.client("b").emit("ready");
  env.manager.disconnect("a");
  assert.equal(env.manager.summary("a").state, "stopped");
  assert.equal(env.manager.summary("b").state, "connected");
  env.manager.connect("a");
  assert.equal(env.manager.summary("a").state, "connecting");
  env.cleanup();
});

test("send results are counted", async () => {
  const env = setup();
  const c = env.client("default");
  await env.manager.sendMessage("default", "1@s.whatsapp.net", { text: "hi" });
  c.failNext = new Error("number not on WhatsApp");
  await assert.rejects(() =>
    env.manager.sendMessage("default", "1@s.whatsapp.net", { text: "hi" })
  );
  const k = env.manager.summary("default").counters;
  assert.equal(k.sent, 1);
  assert.equal(k.failed, 1);
  assert.ok(env.statsStore.get("default").events.some((e) => e.type === "send_failed"));
  await assert.rejects(() => env.manager.sendMessage("nope", "1", {}), /not found/);
  env.manager.disconnect("default");
  await assert.rejects(() => env.manager.sendMessage("default", "1", {}), /not running/);
  env.cleanup();
});

test("statistics survive a restart", async () => {
  const env = setup();
  env.client("default").emit("msg", { key: {} });
  await env.manager.sendMessage("default", "1", "x");
  env.restart();
  const k = env.manager.summary("default").counters;
  assert.equal(k.incoming, 1);
  assert.equal(k.sent, 1);
  env.cleanup();
});

test("inactivity warning appears only after the configured days", () => {
  let now = 1_000_000_000_000;
  const env = setup({
    options: { clients: ["a"], inactivity_warning_days: 14 },
    now: () => now,
  });
  const c = env.client("a");
  c.emit("ready");
  c.emit("disconnected", { code: 408, reason: "timedOut" });
  now += 13 * 86400000;
  assert.equal(env.manager.summary("a").inactivityWarning, false);
  now += 2 * 86400000;
  assert.equal(env.manager.summary("a").inactivityWarning, true);
  assert.equal(env.manager.totals().problems[0].id, "a");
  env.cleanup();
});

test("settings are validated, saved and applied to running clients", async () => {
  const env = setup();
  await assert.rejects(() => env.manager.updateSettings({ receive_status: "yes" }));
  await assert.rejects(() => env.manager.updateSettings({ inactivity_warning_days: 999 }));
  await env.manager.updateSettings({ receive_status: true, inactivity_warning_days: 3 });
  assert.equal(env.client("default").receiveStatus, true);
  env.restart();
  assert.deepEqual(env.manager.settings, { receive_status: true, inactivity_warning_days: 3 });
  env.cleanup();
});
