const path = require("path");
const log4js = require("log4js");

const { WhatsappClient, readAccount } = require("./whatsapp");
const { OptionsStore } = require("./lib/options-store");
const { StatsStore } = require("./lib/stats-store");
const { Notifier } = require("./lib/notifier");
const { ClientManager } = require("./lib/manager");
const {
  createApp,
  resolveSupervisorIps,
  DEFAULT_ADMIN_IPS,
} = require("./lib/server");
const pkg = require("./package.json");

const logger = log4js.getLogger();
logger.level = process.env.LOG_LEVEL || "info";

const port = Number(process.env.PORT) || 3000;
const dataDir = process.env.DATA_DIR || "/data";
const optionsFile = process.env.OPTIONS_FILE || "data/options.json";

// Peers allowed to use the management UI: the Supervisor's ingress proxy.
// ADMIN_ALLOWED_IPS replaces the list (local development only); otherwise the
// default address is extended with whatever the hostname "supervisor" resolves to.
const fixedAdminIps = process.env.ADMIN_ALLOWED_IPS
  ? process.env.ADMIN_ALLOWED_IPS.split(",").map((s) => s.trim())
  : null;
const adminIps = fixedAdminIps || DEFAULT_ADMIN_IPS;

const optionsStore = new OptionsStore({ file: optionsFile });
try {
  optionsStore.load();
} catch (error) {
  logger.fatal(`Cannot read ${optionsFile}: ${error.message}`);
  process.exit(1);
}

const statsStore = new StatsStore({ file: path.join(dataDir, "stats.json") });
statsStore.load();
statsStore.start();

const manager = new ClientManager({
  optionsStore,
  statsStore,
  notifier: new Notifier({ logger }),
  createClient: (opts) => new WhatsappClient(opts),
  readAccount,
  dataDir,
  logger,
});
manager.init();

const app = createApp({
  manager,
  logger,
  adminIps,
  info: { version: pkg.version },
});
app.listen(port, () => logger.info(`Whatsapp Addon started.`));

if (!fixedAdminIps) {
  const addSupervisorIps = async () => {
    const ips = await resolveSupervisorIps();
    ips.forEach((ip) => {
      if (!app.adminIps.has(ip)) {
        app.adminIps.add(ip);
        logger.info(`Management UI also accepts the Supervisor address ${ip}.`);
      }
    });
  };
  addSupervisorIps();
  setInterval(addSupervisorIps, 10 * 60 * 1000).unref();
}

const shutdown = () => {
  manager.shutdown();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

process.on("unhandledRejection", (reason) => {
  logger.error(
    `Unhandled rejection: ${reason && reason.message ? reason.message : reason}`,
  );
});
