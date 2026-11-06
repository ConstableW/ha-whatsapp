const fs = require("fs");
const path = require("path");

const COUNTERS = ["incoming", "sent", "failed", "disconnects", "reconnects"];
const DAILY = ["incoming", "sent"];

const localDate = (ms) => {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const emptyRecord = () => ({
  incoming: 0,
  sent: 0,
  failed: 0,
  disconnects: 0,
  reconnects: 0,
  today: { date: null, incoming: 0, sent: 0 },
  lastActivity: null,
  lastConnected: null,
  authInvalid: false,
  events: [],
});

// Persistent per-client counters and a small event log. Only counters and
// timestamps are stored, never message content. Writes are batched.
class StatsStore {
  #file;
  #flushMs;
  #maxEvents;
  #now;
  #data = {};
  #dirty = false;
  #timer = null;

  constructor({
    file,
    flushMs = 30000,
    maxEvents = 100,
    now = Date.now,
  } = {}) {
    this.#file = file;
    this.#flushMs = flushMs;
    this.#maxEvents = maxEvents;
    this.#now = now;
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#file, "utf8"));
      this.#data = parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      this.#data = {};
    }
  }

  start() {
    if (this.#timer || !this.#file) return;
    this.#timer = setInterval(() => this.flush(), this.#flushMs);
    this.#timer.unref();
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = null;
    this.flush();
  }

  flush() {
    if (!this.#dirty || !this.#file) return;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.#data));
      fs.renameSync(tmp, this.#file);
      this.#dirty = false;
    } catch (e) {
      // keep the data in memory and try again on the next flush
    }
  }

  #record(id) {
    if (!this.#data[id]) this.#data[id] = emptyRecord();
    const rec = this.#data[id];

    // Records written by older versions may miss fields.
    const base = emptyRecord();
    for (const key of Object.keys(base)) {
      if (rec[key] === undefined) rec[key] = base[key];
    }

    const date = localDate(this.#now());
    if (rec.today.date !== date) rec.today = { date, incoming: 0, sent: 0 };
    return rec;
  }

  // Returns a copy that is safe to hand out.
  get(id) {
    const rec = this.#record(id);
    return { ...rec, today: { ...rec.today }, events: [...rec.events] };
  }

  inc(id, field, n = 1) {
    if (!COUNTERS.includes(field)) throw new Error(`Unknown counter ${field}`);
    const rec = this.#record(id);
    rec[field] += n;
    if (DAILY.includes(field)) rec.today[field] += n;
    this.#dirty = true;
  }

  set(id, patch) {
    Object.assign(this.#record(id), patch);
    this.#dirty = true;
  }

  addEvent(id, type, message = "") {
    const rec = this.#record(id);
    rec.events.push({ ts: this.#now(), type, message: String(message) });
    if (rec.events.length > this.#maxEvents) {
      rec.events.splice(0, rec.events.length - this.#maxEvents);
    }
    this.#dirty = true;
  }

  remove(id) {
    delete this.#data[id];
    this.#dirty = true;
    this.flush();
  }
}

module.exports = { StatsStore, localDate };
