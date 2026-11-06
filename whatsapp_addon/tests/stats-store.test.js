const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { StatsStore } = require("../lib/stats-store");

const tmp = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wa-stats-")), "stats.json");

test("counters accumulate and survive a restart", () => {
  const file = tmp();
  const a = new StatsStore({ file });
  a.inc("c", "incoming");
  a.inc("c", "incoming");
  a.inc("c", "sent");
  a.inc("c", "failed");
  a.flush();

  const b = new StatsStore({ file });
  b.load();
  const rec = b.get("c");
  assert.equal(rec.incoming, 2);
  assert.equal(rec.sent, 1);
  assert.equal(rec.failed, 1);
  assert.equal(rec.today.incoming, 2);
});

test("daily counters roll over at midnight, totals stay", () => {
  let now = new Date(2026, 0, 1, 12).getTime();
  const s = new StatsStore({ file: tmp(), now: () => now });
  s.inc("c", "sent");
  now = new Date(2026, 0, 2, 9).getTime();
  const rec = s.get("c");
  assert.equal(rec.sent, 1);
  assert.equal(rec.today.sent, 0);
});

test("event log is capped", () => {
  const s = new StatsStore({ file: tmp(), maxEvents: 3 });
  for (let i = 0; i < 5; i++) s.addEvent("c", "e", `n${i}`);
  const ev = s.get("c").events;
  assert.deepEqual(ev.map((e) => e.message), ["n2", "n3", "n4"]);
});

test("unknown counters are rejected", () => {
  const s = new StatsStore({ file: tmp() });
  assert.throws(() => s.inc("c", "bogus"));
});

test("remove deletes the record from disk", () => {
  const file = tmp();
  const a = new StatsStore({ file });
  a.inc("c", "sent");
  a.flush();
  a.remove("c");
  const b = new StatsStore({ file });
  b.load();
  assert.equal(b.get("c").sent, 0);
});

test("a corrupt file starts with empty statistics", () => {
  const file = tmp();
  fs.writeFileSync(file, "{not json");
  const s = new StatsStore({ file });
  s.load();
  assert.equal(s.get("x").incoming, 0);
});
