const fs = require("fs");
const axios = require("axios");

// IDs of new clients are restricted; they become folder names below /data.
const NEW_ID = /^[A-Za-z0-9_-]{1,32}$/;
const isValidNewId = (id) => typeof id === "string" && NEW_ID.test(id);

// Existing installations may use IDs the strict rule would reject. They are
// still accepted as long as they cannot escape the data directory.
const isSafeId = (id) =>
  typeof id === "string" &&
  id.length > 0 &&
  id.length <= 64 &&
  !/[/\\=\0]/.test(id) &&
  !id.includes("..") &&
  !id.startsWith(".") &&
  !id.toLowerCase().endsWith(".json");

const MAX_LABEL = 64;

const cleanLabel = (label) => {
  if (typeof label !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const value = label.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return value ? value.slice(0, MAX_LABEL) : null;
};

const DEFAULT_SETTINGS = { receive_status: false, inactivity_warning_days: 14 };

// Turns the raw add-on options into the client list and settings.
const parseOptions = (raw = {}) => {
  const list = Array.isArray(raw.clients) ? raw.clients : [];
  const disabled = new Set(
    Array.isArray(raw.disabled_clients) ? raw.disabled_clients : [],
  );
  const labels = new Map();
  (Array.isArray(raw.client_labels) ? raw.client_labels : []).forEach(
    (entry) => {
      if (typeof entry !== "string") return;
      const at = entry.indexOf("=");
      if (at < 1) return;
      const label = cleanLabel(entry.slice(at + 1));
      if (label) labels.set(entry.slice(0, at), label);
    },
  );

  const seen = new Set();
  const clients = [];
  const skipped = [];
  list.forEach((id) => {
    if (!isSafeId(id)) return skipped.push(id);
    if (seen.has(id)) return;
    seen.add(id);
    clients.push({
      id,
      label: labels.get(id) || null,
      enabled: !disabled.has(id),
    });
  });

  const days = Number.isInteger(raw.inactivity_warning_days)
    ? raw.inactivity_warning_days
    : DEFAULT_SETTINGS.inactivity_warning_days;

  return {
    clients,
    skipped,
    settings: {
      receive_status: raw.receive_status === true,
      inactivity_warning_days: Math.min(Math.max(days, 0), 365),
    },
  };
};

// Inverse of parseOptions: the keys that are written back to the add-on options.
const serializeOptions = ({ clients, settings }) => ({
  clients: clients.map((c) => c.id),
  disabled_clients: clients.filter((c) => !c.enabled).map((c) => c.id),
  client_labels: clients
    .filter((c) => c.label)
    .map((c) => `${c.id}=${c.label}`),
  receive_status: settings.receive_status,
  inactivity_warning_days: settings.inactivity_warning_days,
});

// The add-on options are the single source of truth for the client list.
// Inside Home Assistant they are written through the Supervisor API, otherwise
// (local development, tests) directly to the options file.
class OptionsStore {
  #file;
  #token;
  #baseUrl;
  #http;
  #raw = {};
  #state = { clients: [], settings: { ...DEFAULT_SETTINGS }, skipped: [] };
  #queue = Promise.resolve();

  constructor({
    file = "data/options.json",
    token = process.env.SUPERVISOR_TOKEN,
    baseUrl = "http://supervisor",
    http = axios,
  } = {}) {
    this.#file = file;
    this.#token = token;
    this.#baseUrl = baseUrl;
    this.#http = http;
  }

  load() {
    this.#raw = JSON.parse(fs.readFileSync(this.#file, "utf8"));
    this.#state = parseOptions(this.#raw);
    return this.get();
  }

  get() {
    return {
      clients: this.#state.clients.map((c) => ({ ...c })),
      settings: { ...this.#state.settings },
      skipped: [...this.#state.skipped],
    };
  }

  // Applies `mutator` to a copy of the state, persists it and only then commits
  // it. If persisting fails the state stays unchanged. Calls are serialized.
  update(mutator) {
    const run = async () => {
      const draft = this.get();
      mutator(draft);
      const serialized = serializeOptions(draft);
      await this.#persist(serialized);
      this.#raw = { ...this.#raw, ...serialized };
      this.#state = { ...draft, skipped: this.#state.skipped };
      return this.get();
    };

    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #persist(serialized) {
    if (!this.#token) {
      fs.writeFileSync(
        this.#file,
        JSON.stringify({ ...this.#raw, ...serialized }, null, 2),
      );
      return;
    }

    const headers = { Authorization: `Bearer ${this.#token}` };

    // Start from the options currently stored by the Supervisor so that
    // options edited elsewhere are not lost. The POST replaces all options.
    let current = this.#raw;
    try {
      const res = await this.#http.get(
        `${this.#baseUrl}/addons/self/options/config`,
        { headers },
      );
      if (res.data && res.data.data) current = res.data.data;
    } catch (e) {
      // fall back to the options read at startup
    }

    await this.#http.post(
      `${this.#baseUrl}/addons/self/options`,
      { options: { ...current, ...serialized } },
      { headers },
    );
  }
}

module.exports = {
  OptionsStore,
  parseOptions,
  serializeOptions,
  isValidNewId,
  isSafeId,
  cleanLabel,
  DEFAULT_SETTINGS,
};
