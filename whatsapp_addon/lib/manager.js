const fs = require("fs");
const path = require("path");
const qrimage = require("qr-image");
const { isValidNewId, cleanLabel } = require("./options-store");

class ManagerError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ManagerError";
    this.status = status;
  }
}

// Real session states, derived from Baileys connection events.
const STATE = {
  CONNECTED: "connected",
  CONNECTING: "connecting",
  DISCONNECTED: "disconnected_temp",
  RECONNECTING: "reconnecting",
  QR: "qr_required",
  AUTH_INVALID: "auth_invalid",
  DISABLED: "disabled",
  STOPPED: "stopped",
};

const PROBLEM_STATES = [
  STATE.DISCONNECTED,
  STATE.RECONNECTING,
  STATE.QR,
  STATE.AUTH_INVALID,
];

const DAY_MS = 24 * 60 * 60 * 1000;
const LOGOUT_TIMEOUT_MS = 5000;

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((resolve) => setTimeout(resolve, ms).unref()),
  ]);

class ClientManager {
  #options;
  #stats;
  #notifier;
  #createClient;
  #dataDir;
  #logger;
  #now;
  #readAccount;
  #entries = new Map();

  constructor({
    optionsStore,
    statsStore,
    notifier,
    createClient,
    readAccount = () => null,
    dataDir = "/data",
    logger = console,
    now = Date.now,
  }) {
    this.#options = optionsStore;
    this.#stats = statsStore;
    this.#notifier = notifier;
    this.#createClient = createClient;
    this.#readAccount = readAccount;
    this.#dataDir = dataDir;
    this.#logger = logger;
    this.#now = now;
  }

  get settings() {
    return this.#options.get().settings;
  }

  #dir(id) {
    return path.join(this.#dataDir, id);
  }

  // Creates all configured clients and starts the enabled ones.
  init() {
    const { clients, skipped } = this.#options.get();
    skipped.forEach((id) =>
      this.#logger.error(`Ignoring client with unsafe ID: ${JSON.stringify(id)}`)
    );

    clients.forEach((c) => {
      const entry = this.#createEntry(c);
      if (!entry.enabled) return;
      if (this.#stats.get(entry.id).authInvalid) {
        entry.state = STATE.AUTH_INVALID;
        return;
      }
      this.#startClient(entry);
    });
  }

  #createEntry({ id, label, enabled }) {
    const entry = {
      id,
      label: label || null,
      enabled,
      client: null,
      state: enabled ? STATE.STOPPED : STATE.DISABLED,
      qr: null,
      wasDropped: false,
      connectedSince: null,
      lastError: null,
    };
    this.#entries.set(id, entry);
    return entry;
  }

  #entry(id) {
    const entry = this.#entries.get(id);
    if (!entry) throw new ManagerError("Client ID not found.", 404);
    return entry;
  }

  exists(id) {
    return this.#entries.has(id);
  }

  #log(entry, type, message) {
    this.#stats.addEvent(entry.id, type, message);
  }

  #touch(entry) {
    this.#stats.set(entry.id, { lastActivity: this.#now() });
  }

  // ---- lifecycle -----------------------------------------------------

  #startClient(entry) {
    if (entry.client) return;

    const client = this.#createClient({
      path: this.#dir(entry.id),
      receiveStatus: this.settings.receive_status,
      autoStart: false,
    });
    entry.client = client;
    entry.state = STATE.CONNECTING;
    this.#wire(entry, client);
    this.#log(entry, "started", "Client started");
    client.start();
  }

  // Detaches and stops the current client. Late events of it are ignored.
  #stopClient(entry) {
    const client = entry.client;
    entry.client = null;
    entry.qr = null;
    entry.connectedSince = null;
    if (client) client.stop();
  }

  async #unlinkClient(entry) {
    const client = entry.client;
    entry.client = null;
    entry.qr = null;
    entry.connectedSince = null;
    if (client) await withTimeout(client.logout(), LOGOUT_TIMEOUT_MS);
  }

  #wire(entry, client) {
    const on = (event, fn) =>
      client.on(event, (...args) => {
        if (entry.client === client) fn(...args);
      });

    on("connecting", () => {
      if (!entry.wasDropped && entry.state !== STATE.QR) {
        entry.state = STATE.CONNECTING;
      }
    });

    on("qr", (qr) => {
      if (entry.state !== STATE.QR) this.#log(entry, "qr", "QR code required");
      entry.state = STATE.QR;
      entry.qr = qr;
      this.#notifier.qr(entry.id, entry.label, qr);
    });

    on("ready", () => {
      entry.state = STATE.CONNECTED;
      entry.qr = null;
      entry.wasDropped = false;
      entry.lastError = null;
      entry.connectedSince = this.#now();
      this.#stats.set(entry.id, {
        lastConnected: entry.connectedSince,
        authInvalid: false,
      });
      this.#log(entry, "connected", "Connected");
      this.#notifier.dismissQr(entry.id);
      this.#notifier.dismissAuth(entry.id);
    });

    on("disconnected", ({ code, reason, message }) => {
      entry.state = STATE.DISCONNECTED;
      entry.wasDropped = true;
      entry.connectedSince = null;
      entry.lastError = `${reason}${code !== undefined ? ` (${code})` : ""}`;
      this.#stats.inc(entry.id, "disconnects");
      this.#log(
        entry,
        "disconnected",
        message ? `${entry.lastError}: ${message}` : entry.lastError
      );
    });

    on("reconnecting", (attempt) => {
      entry.state = STATE.RECONNECTING;
      this.#stats.inc(entry.id, "reconnects");
      if (attempt === 1 || attempt % 10 === 0) {
        this.#log(entry, "reconnecting", `Reconnect attempt ${attempt}`);
      }
    });

    on("logout", () => {
      entry.state = STATE.AUTH_INVALID;
      entry.qr = null;
      entry.connectedSince = null;
      entry.lastError = "Logged out";
      this.#stats.set(entry.id, { authInvalid: true });
      this.#log(entry, "logout", "Session was logged out by WhatsApp");
      this.#notifier.authInvalid(entry.id, entry.label);
    });

    on("error", (error) => {
      entry.lastError = error.message;
      this.#log(entry, "error", error.message);
    });

    on("msg", (msg) => {
      this.#stats.inc(entry.id, "incoming");
      this.#touch(entry);
      this.#notifier.fireEvent("new_whatsapp_message", {
        clientId: entry.id,
        ...msg,
      });
    });

    on("presence_update", (presence) => {
      this.#notifier.fireEvent("whatsapp_presence_update", {
        clientId: entry.id,
        ...presence,
      });
    });
  }

  // ---- management ----------------------------------------------------

  async add({ id, label }) {
    if (!isValidNewId(id)) {
      throw new ManagerError(
        "Invalid client ID. Use 1-32 letters, digits, '-' or '_'.",
        400
      );
    }
    if (this.#entries.has(id)) throw new ManagerError("Client ID already exists.", 409);

    const clean = cleanLabel(label);
    await this.#save((draft) =>
      draft.clients.push({ id, label: clean, enabled: true })
    );

    const entry = this.#createEntry({ id, label: clean, enabled: true });
    this.#log(entry, "added", "Client added");
    this.#startClient(entry);
    return this.summary(entry);
  }

  async rename(id, label) {
    const entry = this.#entry(id);
    const clean = cleanLabel(label);
    await this.#save((draft) => {
      draft.clients.find((c) => c.id === id).label = clean;
    });
    entry.label = clean;
    this.#log(entry, "renamed", clean || "(label removed)");
    return this.summary(entry);
  }

  async setEnabled(id, enabled) {
    const entry = this.#entry(id);
    enabled = !!enabled;
    if (entry.enabled === enabled) return this.summary(entry);

    await this.#save((draft) => {
      draft.clients.find((c) => c.id === id).enabled = enabled;
    });
    entry.enabled = enabled;

    if (!enabled) {
      this.#stopClient(entry);
      entry.state = STATE.DISABLED;
      this.#log(entry, "disabled", "Client disabled");
    } else {
      this.#log(entry, "enabled", "Client enabled");
      if (this.#stats.get(id).authInvalid) {
        entry.state = STATE.AUTH_INVALID;
      } else {
        entry.state = STATE.STOPPED;
        this.#startClient(entry);
      }
    }
    return this.summary(entry);
  }

  connect(id) {
    const entry = this.#entry(id);
    if (!entry.enabled) throw new ManagerError("Client is disabled.", 409);
    if (entry.state === STATE.AUTH_INVALID) {
      throw new ManagerError("Authentication is invalid. Re-authenticate first.", 409);
    }
    if (!entry.client) {
      entry.wasDropped = false;
      this.#startClient(entry);
    }
    return this.summary(entry);
  }

  disconnect(id) {
    const entry = this.#entry(id);
    if (!entry.enabled) throw new ManagerError("Client is disabled.", 409);
    if (entry.client) {
      this.#stopClient(entry);
      entry.state = STATE.STOPPED;
      entry.wasDropped = false;
      this.#log(entry, "stopped", "Disconnected manually");
    }
    return this.summary(entry);
  }

  // Discards the current session and starts a new pairing. Other clients keep running.
  async reauth(id) {
    const entry = this.#entry(id);
    if (!entry.enabled) throw new ManagerError("Client is disabled.", 409);

    await this.#unlinkClient(entry);
    await fs.promises.rm(this.#dir(id), { recursive: true, force: true });
    this.#stats.set(id, { authInvalid: false });
    this.#notifier.dismissAuth(id);
    entry.wasDropped = false;
    entry.lastError = null;
    this.#log(entry, "reauth", "Re-authentication started");
    this.#startClient(entry);
    return this.summary(entry);
  }

  async remove(id) {
    const entry = this.#entry(id);

    // Persist first: if this fails nothing was removed.
    await this.#save((draft) => {
      draft.clients = draft.clients.filter((c) => c.id !== id);
    });

    await this.#unlinkClient(entry);
    this.#entries.delete(id);
    await fs.promises.rm(this.#dir(id), { recursive: true, force: true });
    this.#stats.remove(id);
    this.#notifier.dismissQr(id);
    this.#notifier.dismissAuth(id);
  }

  async updateSettings(patch) {
    const next = { ...this.settings };

    if (patch.receive_status !== undefined) {
      if (typeof patch.receive_status !== "boolean") {
        throw new ManagerError("receive_status must be a boolean.");
      }
      next.receive_status = patch.receive_status;
    }
    if (patch.inactivity_warning_days !== undefined) {
      const d = patch.inactivity_warning_days;
      if (!Number.isInteger(d) || d < 0 || d > 365) {
        throw new ManagerError("inactivity_warning_days must be an integer between 0 and 365.");
      }
      next.inactivity_warning_days = d;
    }

    await this.#save((draft) => {
      draft.settings = next;
    });
    this.#entries.forEach((e) => e.client?.setReceiveStatus(next.receive_status));
    return next;
  }

  async #save(mutator) {
    try {
      await this.#options.update(mutator);
    } catch (error) {
      this.#logger.error(`Saving add-on options failed: ${error.message}`);
      throw new ManagerError(
        `Could not save the add-on configuration: ${error.message}`,
        502
      );
    }
  }

  // ---- service calls (used by the Home Assistant services) -----------

  #clientFor(id) {
    const entry = this.#entry(id);
    if (!entry.client) {
      throw new ManagerError(`Client ${id} is not running (${entry.state}).`, 409);
    }
    return { entry, client: entry.client };
  }

  async sendMessage(id, to, body, options) {
    const { entry, client } = this.#clientFor(id);
    try {
      const result = await client.sendMessage(to, body, options);
      this.#stats.inc(id, "sent");
      this.#touch(entry);
      return result;
    } catch (error) {
      this.#stats.inc(id, "failed");
      this.#log(entry, "send_failed", error.message);
      throw error;
    }
  }

  setStatus(id, status) {
    return this.#clientFor(id).client.updateProfileStatus(status);
  }

  presenceSubscribe(id, to) {
    return this.#clientFor(id).client.presenceSubscribe(to);
  }

  sendPresenceUpdate(id, type, to) {
    return this.#clientFor(id).client.sendPresenceUpdate(type, to);
  }

  sendInfinityPresenceUpdate(id, type, to) {
    return this.#clientFor(id).client.setSendPresenceUpdateInterval(type, to);
  }

  getGroups(id, opts) {
    return this.#clientFor(id).client.getGroups(opts);
  }

  // ---- read model for the UI ----------------------------------------

  summary(entry) {
    if (typeof entry === "string") entry = this.#entry(entry);
    const rec = this.#stats.get(entry.id);
    const days = this.settings.inactivity_warning_days;

    const account =
      (entry.client && entry.client.getAccount && entry.client.getAccount()) ||
      this.#readAccount(this.#dir(entry.id));

    const inactivityWarning =
      days > 0 &&
      !!rec.lastConnected &&
      entry.state !== STATE.CONNECTED &&
      entry.state !== STATE.DISABLED &&
      this.#now() - rec.lastConnected > days * DAY_MS;

    return {
      id: entry.id,
      label: entry.label,
      enabled: entry.enabled,
      state: entry.state,
      hasQr: !!entry.qr,
      phone: account ? account.phone : null,
      name: account ? account.name : null,
      connectedSince: entry.connectedSince,
      lastConnected: rec.lastConnected,
      lastActivity: rec.lastActivity,
      lastError: entry.lastError,
      inactivityWarning,
      counters: {
        incoming: rec.incoming,
        sent: rec.sent,
        failed: rec.failed,
        disconnects: rec.disconnects,
        reconnects: rec.reconnects,
        todayIncoming: rec.today.incoming,
        todaySent: rec.today.sent,
      },
    };
  }

  list() {
    return [...this.#entries.values()].map((e) => this.summary(e));
  }

  detail(id) {
    const entry = this.#entry(id);
    return { ...this.summary(entry), events: this.#stats.get(id).events };
  }

  totals() {
    const clients = this.list();
    const sum = (f) => clients.reduce((n, c) => n + f(c), 0);

    return {
      clients: clients.length,
      connected: clients.filter((c) => c.state === STATE.CONNECTED).length,
      needsAuth: clients.filter(
        (c) => c.state === STATE.QR || c.state === STATE.AUTH_INVALID
      ).length,
      incoming: sum((c) => c.counters.incoming),
      sent: sum((c) => c.counters.sent),
      failed: sum((c) => c.counters.failed),
      todayIncoming: sum((c) => c.counters.todayIncoming),
      todaySent: sum((c) => c.counters.todaySent),
      problems: clients
        .filter((c) => PROBLEM_STATES.includes(c.state) || c.inactivityWarning)
        .map((c) => ({
          id: c.id,
          label: c.label,
          state: c.state,
          lastError: c.lastError,
          inactivityWarning: c.inactivityWarning,
        })),
    };
  }

  qrPng(id) {
    const entry = this.#entry(id);
    if (!entry.qr) return null;
    return qrimage.imageSync(entry.qr, { type: "png", margin: 2, size: 8 });
  }

  // Stops all clients without logging them out and writes pending statistics.
  shutdown() {
    this.#entries.forEach((e) => {
      try {
        e.client?.stop();
      } catch (err) {
        // ignore
      }
      e.client = null;
    });
    this.#stats.stop();
  }
}

module.exports = { ClientManager, ManagerError, STATE };
