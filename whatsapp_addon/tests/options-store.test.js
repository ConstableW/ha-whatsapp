const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  OptionsStore,
  parseOptions,
  serializeOptions,
  isValidNewId,
  isSafeId,
} = require("../lib/options-store");

const tmpFile = (content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-opt-"));
  const file = path.join(dir, "options.json");
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
};

test("legacy options (only a list of IDs) are parsed with defaults", () => {
  const { clients, settings } = parseOptions({ clients: ["default", "work"] });
  assert.deepEqual(clients, [
    { id: "default", label: null, enabled: true },
    { id: "work", label: null, enabled: true },
  ]);
  assert.deepEqual(settings, { receive_status: false, inactivity_warning_days: 14 });
});

test("labels, disabled clients and settings round-trip", () => {
  const raw = {
    clients: ["a", "b"],
    disabled_clients: ["b"],
    client_labels: ["a=Home = Main"],
    receive_status: true,
    inactivity_warning_days: 30,
  };
  const parsed = parseOptions(raw);
  assert.equal(parsed.clients[0].label, "Home = Main");
  assert.equal(parsed.clients[1].enabled, false);
  assert.deepEqual(serializeOptions(parsed), raw);
});

test("unsafe or duplicate IDs are dropped", () => {
  const { clients, skipped } = parseOptions({
    clients: ["ok", "../etc", "a/b", "creds.json", "ok", "", ".hidden"],
  });
  assert.deepEqual(clients.map((c) => c.id), ["ok"]);
  assert.equal(skipped.length, 5);
});

test("ID rules", () => {
  assert.ok(isValidNewId("default"));
  assert.ok(!isValidNewId("with space"));
  assert.ok(!isValidNewId("a".repeat(33)));
  assert.ok(isSafeId("my client"));
  assert.ok(!isSafeId("..") && !isSafeId("x=y"));
});

test("file mode: update persists and keeps unknown keys", async () => {
  const file = tmpFile({ clients: ["default"], other: 1 });
  const store = new OptionsStore({ file, token: "" });
  store.load();
  await store.update((d) => d.clients.push({ id: "work", label: "Work", enabled: true }));
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(saved.clients, ["default", "work"]);
  assert.deepEqual(saved.client_labels, ["work=Work"]);
  assert.equal(saved.other, 1);
});

test("supervisor mode: merges with current options and posts them", async () => {
  const calls = [];
  const http = {
    get: async (url) => {
      calls.push(["get", url]);
      return { data: { data: { clients: ["default"], extra: "kept" } } };
    },
    post: async (url, body, cfg) => {
      calls.push(["post", url, body, cfg.headers.Authorization]);
    },
  };
  const file = tmpFile({ clients: ["default"] });
  const store = new OptionsStore({ file, token: "T", baseUrl: "http://sup", http });
  store.load();
  await store.update((d) => d.clients.push({ id: "x", label: null, enabled: false }));

  const post = calls.find((c) => c[0] === "post");
  assert.equal(post[1], "http://sup/addons/self/options");
  assert.equal(post[3], "Bearer T");
  assert.deepEqual(post[2].options.clients, ["default", "x"]);
  assert.deepEqual(post[2].options.disabled_clients, ["x"]);
  assert.equal(post[2].options.extra, "kept");
});

test("a failed save leaves the state unchanged", async () => {
  const http = {
    get: async () => ({ data: {} }),
    post: async () => {
      throw new Error("boom");
    },
  };
  const file = tmpFile({ clients: ["default"] });
  const store = new OptionsStore({ file, token: "T", http });
  store.load();
  await assert.rejects(() => store.update((d) => d.clients.pop()), /boom/);
  assert.equal(store.get().clients.length, 1);
});

test("concurrent updates are serialized and none is lost", async () => {
  const file = tmpFile({ clients: [] });
  const store = new OptionsStore({ file, token: "" });
  store.load();
  await Promise.all(
    ["a", "b", "c"].map((id) =>
      store.update((d) => d.clients.push({ id, label: null, enabled: true }))
    )
  );
  assert.deepEqual(store.get().clients.map((c) => c.id), ["a", "b", "c"]);
});
