const path = require("path");
const log4js = require("log4js");

const { WhatsappClient, readAccount } = require("./whatsapp");
const { OptionsStore } = require("./lib/options-store");
const { StatsStore } = require("./lib/stats-store");
const { Notifier } = require("./lib/notifier");
const { ClientManager } = require("./lib/manager");
const { createApp, DEFAULT_ADMIN_IPS } = require("./lib/server");
const pkg = require("./package.json");

const logger = log4js.getLogger();
logger.level = process.env.LOG_LEVEL || "info";

const port = Number(process.env.PORT) || 3000;
const dataDir = process.env.DATA_DIR || "/data";
const optionsFile = process.env.OPTIONS_FILE || "data/options.json";

// Reachable peers for the management UI. Defaults to the Supervisor's ingress
// proxy; the override exists for local development only.
const adminIps = process.env.ADMIN_ALLOWED_IPS
  ? process.env.ADMIN_ALLOWED_IPS.split(",").map((s) => s.trim())
  : DEFAULT_ADMIN_IPS;

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

const app = createApp({ manager, logger, adminIps, info: { version: pkg.version } });
app.listen(port, () => logger.info(`Whatsapp Addon started.`));

const shutdown = () => {
  manager.shutdown();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

process.on("unhandledRejection", (reason) => {
  logger.error(
    `Unhandled rejection: ${reason && reason.message ? reason.message : reason}`
  );
});
