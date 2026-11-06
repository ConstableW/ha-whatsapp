const EventEmitter = require("eventemitter2");
const fs = require("fs");
const path = require("path");

const {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const MessageType = {
  text: "conversation",
  location: "locationMessage",
  liveLocation: "liveLocationMessage",
  image: "imageMessage",
  video: "videoMessage",
  document: "documentMessage",
  contact: "contactMessage",
};

const STATUS_JID = "status@broadcast";

// Message types that carry no user content and must never trigger automations.
const IGNORED_MESSAGE_TYPES = new Set([
  "messageContextInfo",
  "protocolMessage",
  "senderKeyDistributionMessage",
]);

// Decides whether an incoming Baileys message is forwarded as `new_whatsapp_message`.
const shouldForward = (msg, { receiveStatus = false } = {}) => {
  if (!msg || !msg.message || !msg.key || msg.key.fromMe) return false;
  if (!receiveStatus && msg.key.remoteJid === STATUS_JID) return false;
  return Object.keys(msg.message).some((k) => !IGNORED_MESSAGE_TYPES.has(k));
};

// Human readable name of a Baileys disconnect status code.
const reasonName = (code) => {
  const entry = Object.entries(DisconnectReason).find(([, v]) => v === code);
  return entry ? entry[0] : code === undefined ? "unknown" : String(code);
};

// Reads the paired account (phone number / name) from stored credentials.
const readAccount = (dir) => {
  try {
    const creds = JSON.parse(
      fs.readFileSync(path.join(dir, "creds.json"), "utf8")
    );
    if (!creds.me || !creds.me.id) return null;
    return {
      phone: creds.me.id.split(":")[0].split("@")[0],
      name: creds.me.name || null,
    };
  } catch (e) {
    return null;
  }
};

const GROUP_CACHE_MS = 10 * 60 * 1000;
const GROUP_LOOKUP_TIMEOUT_MS = 5000;

class WhatsappClient extends EventEmitter {
  #conn;
  #path;
  #refreshInterval;
  #sendPresenceUpdateInterval;
  #reconnectTimer;
  #timeout;
  #attempts;
  #offline;
  #refreshMs;
  #receiveStatus;
  #stopped = false;
  #connecting = false;
  #planned = false;
  #groupNames = new Map(); // jid -> { subject, at }
  #groupList = null; // { at, list }

  #status = {
    attempt: 0,
    connected: false,
    disconnected: false,
    reconnecting: false,
  };

  #toMilliseconds = (hrs, min, sec) => (hrs * 60 * 60 + min * 60 + sec) * 1000;

  constructor({
    path,
    timeout = 1e3,
    attempts = Infinity,
    offline = true,
    refreshMs,
    receiveStatus = false,
    autoStart = true,
  }) {
    super();
    this.#path = path;
    this.#timeout = timeout;
    this.#attempts = attempts;
    this.#offline = offline;
    this.#refreshMs = refreshMs || this.#toMilliseconds(6, 0, 0);
    this.#receiveStatus = !!receiveStatus;
    if (autoStart) this.start();
  }

  setReceiveStatus = (value) => {
    this.#receiveStatus = !!value;
  };

  get connected() {
    return this.#status.connected;
  }

  get stopped() {
    return this.#stopped;
  }

  getAccount = () => {
    const me = this.#conn?.authState?.creds?.me;
    if (me && me.id) {
      return {
        phone: me.id.split(":")[0].split("@")[0],
        name: me.name || null,
      };
    }
    return readAccount(this.#path);
  };

  start = () => {
    this.#stopped = false;
    this.#status.disconnected = false;
    this.#status.attempt = 0;
    return this.connect().catch((err) => this.emit("error", err));
  };

  connect = async () => {
    if (this.#status.connected || this.#connecting || this.#stopped) return;
    this.#connecting = true;

    try {
      this.emit("connecting");

      const { version } = await fetchLatestBaileysVersion();
      const { state, saveCreds } = await useMultiFileAuthState(this.#path);
      if (this.#stopped) return;

      const conn = makeWASocket({
        version,
        auth: state,
        syncFullHistory: false,
        markOnlineOnConnect: !this.#offline,
        logger: require("pino")({ level: "silent" }),
        generateHighQualityLinkPreview: true,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        defaultQueryTimeoutMs: undefined,
      });
      this.#conn = conn;

      // Events of an old socket must never influence the current one.
      const current = (fn) => (...args) => {
        if (conn === this.#conn) fn(...args);
      };

      conn.ev.on(
        "creds.update",
        current((update) => {
          if (update && update.me) {
            this.emit("pair", {
              phone: update.me.id.split(":")[0].split("@")[0],
              name: update.me.name,
            });
          }
          saveCreds();
        })
      );

      conn.ev.on("connection.update", current(this.#onConnectionUpdate));
    } finally {
      this.#connecting = false;
    }
  };

  // Permanently closes the connection without reconnecting (until start()).
  stop = () => {
    this.#stopped = true;
    this.#status.connected = false;
    this.#status.disconnected = true;
    this.#status.reconnecting = false;

    clearInterval(this.#refreshInterval);
    clearTimeout(this.#reconnectTimer);
    this.setSendPresenceUpdateInterval();

    const conn = this.#conn;
    this.#conn = undefined;
    try {
      conn?.end(undefined);
    } catch (e) {
      // socket already closed
    }
    this.emit("stopped");
  };

  // Unlinks this device from WhatsApp (best effort) and stops the client.
  logout = async () => {
    const conn = this.#conn;
    this.#stopped = true;
    try {
      if (conn && this.#status.connected) await conn.logout();
    } catch (e) {
      // not connected / already logged out
    }
    this.stop();
  };

  disconnect = (reconnect) => {
    if (this.#status.disconnected) return;

    this.#status.connected = false;
    this.#status.disconnected = !reconnect;
    this.#status.reconnecting = !!reconnect;

    return this.#conn?.end(undefined);
  };

  restart = () => {
    this.#planned = true;
    this.emit("restart");
    return this.disconnect(true);
  };

  #toId = (phone) => {
    phone = phone.toString();
    if (!phone) throw new Error("Invalid phone");

    return `${phone.replace("+", "")}${
      !phone.endsWith("@s.whatsapp.net") &&
      !phone.endsWith("@g.us") &&
      !phone.endsWith("@broadcast")
        ? "@s.whatsapp.net"
        : ""
    }`;
  };

  #reconnect = () => {
    if (this.#stopped) return;
    if (this.#status.attempt++ > this.#attempts || this.#status.disconnected) {
      this.#status.reconnecting = false;
      this.#status.disconnected = true;
      return;
    }

    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => {
      if (this.#stopped) return;
      this.emit("reconnecting", this.#status.attempt);
      this.connect().catch((err) => {
        this.emit("error", err);
        this.#reconnect();
      });
    }, this.#timeout);
  };

  #onConnectionUpdate = (event) => {
    if (event.qr) this.#onQr(event.qr);
    if (event.connection === "open") this.#onConnected(event);
    else if (event.connection === "close") this.#onDisconnected(event);
  };

  #onQr = (qr) => {
    this.emit("qr", qr);
  };

  #onConnected = (event) => {
    this.#status.attempt = 0;
    this.#status.connected = true;
    this.#status.disconnected = false;
    this.#status.reconnecting = false;
    this.#planned = false;

    clearInterval(this.#refreshInterval);
    this.#refreshInterval = setInterval(() => this.restart(), this.#refreshMs);
    if (this.#offline) this.setSendPresenceUpdateInterval("unavailable");

    const conn = this.#conn;

    conn.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages) {
        if (shouldForward(msg, { receiveStatus: this.#receiveStatus })) {
          delete msg.message.messageContextInfo;
          const messageType = Object.keys(msg.message)[0];
          const payload = { type: messageType, ...msg };

          const jid = msg.key.remoteJid;
          if (typeof jid === "string" && jid.endsWith("@g.us")) {
            const groupName = await this.#groupName(jid);
            if (groupName) payload.groupName = groupName;
          }

          this.emit("msg", payload);
        }
      }
    });

    conn.ev.on("presence.update", (presence) => {
      this.emit("presence_update", presence);
    });

    conn.ev.on("groups.upsert", (groups) => {
      for (const g of groups || []) this.#rememberGroup(g.id, g.subject);
    });

    conn.ev.on("groups.update", (updates) => {
      for (const g of updates || []) {
        if (g.id && g.subject) this.#rememberGroup(g.id, g.subject);
      }
    });

    this.emit("ready");
  };

  #onDisconnected = ({ lastDisconnect }) => {
    this.#status.connected = false;

    clearInterval(this.#refreshInterval);
    this.setSendPresenceUpdateInterval();

    if (this.#stopped) return;

    const statusCode = lastDisconnect?.error?.output?.statusCode;

    if (statusCode === DisconnectReason.loggedOut) {
      this.#status.reconnecting = false;
      this.#status.disconnected = true;

      this.emit("logout");
      return;
    }

    // The scheduled refresh restart and the restart WhatsApp requires right
    // after pairing are not connection losses.
    if (this.#planned || statusCode === DisconnectReason.restartRequired) {
      this.#planned = false;
    } else {
      this.emit("disconnected", {
        code: statusCode,
        reason: reasonName(statusCode),
        message: lastDisconnect?.error?.message,
      });
    }

    this.#reconnect();
  };

  setSendPresenceUpdateInterval = (status, id) => {
    clearInterval(this.#sendPresenceUpdateInterval);

    if (status) {
      const send = () =>
        this.sendPresenceUpdate(status, id).catch(() => {
          clearInterval(this.#sendPresenceUpdateInterval);
        });

      send();
      this.#sendPresenceUpdateInterval = setInterval(send, 10000);
    }
  };

  #rememberGroup = (jid, subject) => {
    if (jid && subject) this.#groupNames.set(jid, { subject, at: Date.now() });
  };

  #groupName = async (jid) => {
    const cached = this.#groupNames.get(jid);
    if (cached && Date.now() - cached.at < GROUP_CACHE_MS) {
      return cached.subject;
    }

    try {
      const meta = await Promise.race([
        this.#conn.groupMetadata(jid),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("group lookup timed out")),
            GROUP_LOOKUP_TIMEOUT_MS
          ).unref()
        ),
      ]);
      this.#rememberGroup(jid, meta?.subject);
      return meta?.subject;
    } catch (err) {
      return cached ? cached.subject : undefined;
    }
  };

  #assertConnected = () => {
    if (this.#status.disconnected || !this.#status.connected) {
      throw new WhatsappDisconnectedError();
    }
  };

  // All groups this account participates in (cached for a minute).
  getGroups = async ({ refresh = false } = {}) => {
    this.#assertConnected();

    if (!refresh && this.#groupList && Date.now() - this.#groupList.at < 60000) {
      return this.#groupList.list;
    }

    let all;
    try {
      all = await this.#conn.groupFetchAllParticipating();
    } catch (err) {
      throw toWhatsappError(err);
    }

    const list = Object.values(all || {})
      .map((g) => {
        this.#rememberGroup(g.id, g.subject);
        return {
          id: g.id,
          subject: g.subject || "",
          participants: Array.isArray(g.participants)
            ? g.participants.length
            : g.size || 0,
        };
      })
      .sort((a, b) => a.subject.localeCompare(b.subject));

    this.#groupList = { at: Date.now(), list };
    return list;
  };

  sendMessage = async (phone, msg, options) => {
    phone = phone.toString();
    this.#assertConnected();

    // A plain string is shorthand for a text message.
    if (typeof msg === "string") msg = { text: msg };

    const id = this.#toId(phone);

    const [result] = await this.#conn.onWhatsApp(id);

    if (
      result ||
      phone.endsWith("@s.whatsapp.net") ||
      phone.endsWith("@g.us") ||
      phone.endsWith("@broadcast")
    ) {
      try {
        return await this.#conn.sendMessage(id, msg, options);
      } catch (err) {
        throw toWhatsappError(err);
      }
    }

    throw new WhatsappNumberNotFoundError(phone);
  };

  waitForMessage(from, callback) {
    this.once("msg", (msg) => {
      if (msg.key.remoteJid === this.#toId(from)) callback(msg);
    });
  }

  sendPresenceUpdate = async (type, id) => {
    this.#assertConnected();

    try {
      await this.#conn.sendPresenceUpdate(type, id);
    } catch (err) {
      throw toWhatsappError(err);
    }
  };

  presenceSubscribe = async (phone) => {
    this.#assertConnected();

    const id = this.#toId(phone);

    const [result] = await this.#conn.onWhatsApp(id);

    if (result) {
      try {
        await this.#conn.presenceSubscribe(id);
      } catch (err) {
        throw toWhatsappError(err);
      }
    } else {
      throw new WhatsappNumberNotFoundError(phone);
    }
  };

  updateProfileStatus = async (status) => {
    this.#assertConnected();

    try {
      await this.#conn.updateProfileStatus(status);
    } catch (err) {
      throw toWhatsappError(err);
    }
  };
}

const toWhatsappError = (err) => {
  if (err instanceof WhatsappError) return err;
  const code = err?.output?.payload?.statusCode;
  if (code !== undefined) return new WhatsappError(code);
  return err instanceof Error ? err : new Error(String(err));
};

class WhatsappNumberNotFoundError extends Error {
  constructor(phone = "", ...args) {
    super(phone, ...args);
    this.name = "WhatsappNumberNotFoundError";
    this.message = `Send message failed. Number ${phone} is not on Whatsapp.`;
    this.code = 404;
  }
}

class WhatsappDisconnectedError extends Error {
  constructor(message = "", ...args) {
    super(message, ...args);
    this.name = "WhatsappDisconnectedError";
    this.code = 401;
    this.message = `Send message failed. Whatsapp disconnected error.`;
  }
}

class WhatsappError extends Error {
  #errors = {
    428: "Connection Closed",
    408: "Connection Lost / Timed Out",
    440: "Connection Replaced",
    401: "Logged Out",
    500: "Bad Session",
    515: "Restart Required",
    411: "Multidevice Mismatch",
  };

  constructor(message = "", ...args) {
    super(message, ...args);
    this.name = "WhatsappError";
    this.code = Number(this.message);
    this.message = `Send message failed. Whatsapp error ${this.message}: ${
      this.#errors[this.code]
    }`;
  }
}

module.exports = {
  WhatsappClient,
  MessageType,
  shouldForward,
  readAccount,
  reasonName,
};
