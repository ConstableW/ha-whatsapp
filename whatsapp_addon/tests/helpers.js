const EventEmitter = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { OptionsStore } = require("../lib/options-store");
const { StatsStore } = require("../lib/stats-store");
const { ClientManager } = require("../lib/manager");

// Stand-in for WhatsappClient. Tests drive its lifecycle by emitting events.
class FakeClient extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.started = false;
    this.stopped = false;
    this.loggedOut = false;
    this.sent = [];
    this.failNext = null;
    this.receiveStatus = opts.receiveStatus;
    this.groups = [{ id: "1@g.us", subject: "Family", participants: 3 }];
  }
  start() {
    this.started = true;
    this.stopped = false;
  }
  stop() {
    this.stopped = true;
    this.emit("stopped");
  }
  async logout() {
    this.loggedOut = true;
    this.stop();
  }
  getAccount() {
    return null;
  }
  setReceiveStatus(v) {
    this.receiveStatus = v;
  }
  async sendMessage(to, body, options) {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    this.sent.push({ to, body, options });
    return { ok: true };
  }
  async getGroups() {
    return this.groups;
  }
  async updateProfileStatus() {}
  async presenceSubscribe() {}
  async sendPresenceUpdate() {}
  setSendPresenceUpdateInterval() {}
}

const silentLogger = { error() {}, info() {}, debug() {}, warn() {} };

const fakeNotifier = () => {
  const calls = [];
  const rec =
    (name) =>
    (...args) =>
      calls.push([name, ...args]);
  return {
    calls,
    qr: rec("qr"),
    dismissQr: rec("dismissQr"),
    authInvalid: rec("authInvalid"),
    dismissAuth: rec("dismissAuth"),
    fireEvent: rec("fireEvent"),
  };
};

// Builds a manager on a temp dir. Calling `restart()` simulates an add-on
// restart: new stores and a new manager read the persisted files again.
const setup = ({ options, now } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-test-"));
  const optionsFile = path.join(dir, "options.json");
  fs.writeFileSync(
    optionsFile,
    JSON.stringify(options || { clients: ["default"] }),
  );
  const statsFile = path.join(dir, "stats.json");

  const env = {
    dir,
    optionsFile,
    statsFile,
    clients: [],
    notifier: fakeNotifier(),
  };

  const build = () => {
    const optionsStore = new OptionsStore({ file: optionsFile, token: "" });
    optionsStore.load();
    const statsStore = new StatsStore({ file: statsFile, now });
    statsStore.load();
    const manager = new ClientManager({
      optionsStore,
      statsStore,
      notifier: env.notifier,
      createClient: (opts) => {
        const c = new FakeClient(opts);
        env.clients.push(c);
        return c;
      },
      dataDir: dir,
      logger: silentLogger,
      now,
    });
    manager.init();
    Object.assign(env, { optionsStore, statsStore, manager });
  };

  env.restart = () => {
    env.statsStore.flush();
    env.clients = [];
    build();
  };
  env.client = (id) =>
    [...env.clients].reverse().find((c) => c.opts.path.endsWith(path.sep + id));
  env.cleanup = () => fs.rmSync(dir, { recursive: true, force: true });

  build();
  return env;
};

module.exports = { FakeClient, setup, silentLogger };
