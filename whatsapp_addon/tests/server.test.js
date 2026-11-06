const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, silentLogger } = require("./helpers");
const { createApp, resolveSupervisorIps } = require("../lib/server");
const { shouldForward } = require("../whatsapp");

const start = async ({ adminIps = ["127.0.0.1"], options } = {}) => {
  const env = setup({ options });
  const app = createApp({ manager: env.manager, logger: silentLogger, adminIps });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = (method, url, body, headers = {}) =>
    fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const admin = (method, url, body) =>
    call(method, "/admin/api" + url, body, { "X-Requested-With": "whatsapp-admin" });

  const stop = () => {
    server.close();
    env.cleanup();
  };
  return { env, app, call, admin, stop };
};

test("management UI and API are refused for other peers", async () => {
  const t = await start({ adminIps: ["172.30.32.2"] });
  for (const url of ["/", "/admin/api/state", "/app.js"]) {
    const res = await t.call("GET", url);
    assert.equal(res.status, 403, url);
  }
  const res = await t.call("POST", "/admin/api/clients", { id: "x" }, { "X-Requested-With": "whatsapp-admin" });
  assert.equal(res.status, 403);
  assert.equal(t.env.manager.exists("x"), false);
  t.stop();
});

test("service endpoints stay open for Home Assistant and keep OK/KO", async () => {
  const t = await start({ adminIps: ["172.30.32.2"] });
  const c = t.env.client("default");
  c.emit("ready");

  let res = await t.call("POST", "/sendMessage", {
    clientId: "default",
    to: "1@s.whatsapp.net",
    body: { text: "hi" },
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "OK");
  assert.equal(c.sent.length, 1);

  res = await t.call("POST", "/sendMessage", { clientId: "nope", to: "1", body: "x" });
  assert.equal(res.status, 404);
  assert.equal(await res.text(), "KO");

  res = await t.call("POST", "/sendMessage", { clientId: "default" });
  assert.equal(res.status, 400);

  c.failNext = new Error("Number 1 is not on Whatsapp.");
  res = await t.call("POST", "/sendMessage", { clientId: "default", to: "1", body: "x" });
  assert.equal(res.status, 500);
  assert.equal(await res.text(), "KO");
  assert.match(decodeURIComponent(res.headers.get("x-whatsapp-error")), /not on Whatsapp/);

  for (const [url, body] of [
    ["/setStatus", { clientId: "default", status: "hi" }],
    ["/presenceSubscribe", { clientId: "default", userId: "1" }],
    ["/presenceSubscribe", { clientId: "default", to: "1" }],
    ["/sendPresenceUpdate", { clientId: "default", type: "composing" }],
    ["/sendInfinityPresenceUpdate", { clientId: "default", type: "composing" }],
  ]) {
    res = await t.call("POST", url, body);
    assert.equal(await res.text(), "OK", url);
  }

  res = await t.call("POST", "/getGroups", { clientId: "default" });
  assert.deepEqual((await res.json()).groups[0].subject, "Family");
  t.stop();
});

test("admin API: add, rename, disable, remove with confirmation", async () => {
  const t = await start();

  let res = await t.call("POST", "/admin/api/clients", { id: "x" });
  assert.equal(res.status, 400, "mutating calls need the custom header");

  res = await t.admin("POST", "/clients", { id: "work", label: "Work" });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).state, "connecting");

  res = await t.admin("POST", "/clients", { id: "work" });
  assert.equal(res.status, 409);
  res = await t.admin("POST", "/clients", { id: "../x" });
  assert.equal(res.status, 400);

  res = await t.admin("PATCH", "/clients/work", { label: "Office", enabled: false });
  const patched = await res.json();
  assert.equal(patched.label, "Office");
  assert.equal(patched.state, "disabled");

  res = await t.admin("GET", "/state");
  const state = await res.json();
  assert.equal(state.totals.clients, 2);
  assert.ok(state.service.startedAt <= state.service.now);

  res = await t.admin("DELETE", "/clients/work", { confirm: "wrong" });
  assert.equal(res.status, 400);
  assert.ok(t.env.manager.exists("work"));
  res = await t.admin("DELETE", "/clients/work", { confirm: "work" });
  assert.equal(res.status, 200);
  assert.equal(t.env.manager.exists("work"), false);

  res = await t.admin("GET", "/clients/work");
  assert.equal(res.status, 404);
  t.stop();
});

test("admin API: QR image, groups, reauth and settings", async () => {
  const t = await start();
  const c = t.env.client("default");

  let res = await t.admin("GET", "/clients/default/qr");
  assert.equal(res.status, 404);
  c.emit("qr", "QR");
  res = await t.admin("GET", "/clients/default/qr");
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await res.arrayBuffer()).subarray(1, 4).toString(), "PNG");

  res = await t.admin("GET", "/clients/default/groups");
  assert.equal((await res.json()).groups.length, 1);

  res = await t.admin("POST", "/clients/default/reauth");
  assert.equal(res.status, 200);
  assert.ok(c.loggedOut);

  res = await t.admin("PUT", "/settings", { receive_status: true });
  assert.equal((await res.json()).receive_status, true);
  res = await t.admin("PUT", "/settings", { inactivity_warning_days: -1 });
  assert.equal(res.status, 400);
  t.stop();
});

test("the UI is served and uses relative URLs only", async () => {
  const t = await start();
  const page = await (await t.call("GET", "/")).text();
  assert.match(page, /<title>WhatsApp<\/title>/);
  assert.doesNotMatch(page, /(src|href)="\//);
  const js = await (await t.call("GET", "/app.js")).text();
  assert.doesNotMatch(js, /fetch\("\//);
  t.stop();
});

test("status updates and protocol messages are not forwarded", () => {
  const msg = (jid, message, fromMe) => ({ key: { remoteJid: jid, fromMe }, message });
  assert.equal(shouldForward(msg("1@s.whatsapp.net", { conversation: "hi" })), true);
  assert.equal(shouldForward(msg("status@broadcast", { conversation: "s" })), false);
  assert.equal(shouldForward(msg("status@broadcast", { conversation: "s" }), { receiveStatus: true }), true);
  assert.equal(shouldForward(msg("1@s.whatsapp.net", { protocolMessage: {} })), false);
  assert.equal(shouldForward(msg("1@s.whatsapp.net", { conversation: "x" }, true)), false);
  assert.equal(shouldForward(msg("1@s.whatsapp.net", null)), false);
});

test("the resolved Supervisor address is accepted in addition to the default", async () => {
  assert.deepEqual(
    await resolveSupervisorIps({
      lookup: async () => [{ address: "::ffff:10.1.2.3" }, { address: "10.1.2.4" }],
    }),
    ["10.1.2.3", "10.1.2.4"]
  );
  assert.deepEqual(
    await resolveSupervisorIps({
      lookup: async () => {
        throw new Error("ENOTFOUND");
      },
    }),
    [],
    "a failed lookup must not break anything"
  );

  const t = await start({ adminIps: ["172.30.32.2"] });
  assert.equal((await t.call("GET", "/admin/api/state")).status, 403);
  t.app.adminIps.add("127.0.0.1"); // as index.js does with the resolved address
  assert.equal((await t.call("GET", "/admin/api/state")).status, 200);
  t.stop();
});
