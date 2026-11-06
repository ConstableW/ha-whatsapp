// Starts the management UI against fake clients so it can be tried without
// WhatsApp or Home Assistant:  node scripts/dev-ui.js   (http://localhost:3100)
const { setup, silentLogger } = require("../tests/helpers");
const { createApp } = require("../lib/server");

const env = setup({
  options: {
    clients: ["default", "work", "edfs"],
    client_labels: ["default=Privat", "work=Büro / Projekte"],
  },
});

const [defaultClient, workClient, edfsClient] = ["default", "work", "edfs"].map((id) => env.client(id));
defaultClient.getAccount = () => ({ phone: "491701234567", name: "Ben" });
defaultClient.emit("ready");
for (let i = 0; i < 12; i++) defaultClient.emit("msg", { key: {} });
env.statsStore.inc("default", "sent", 7);
env.statsStore.inc("default", "failed", 1);
workClient.emit("logout");
edfsClient.emit("qr", "https://example.invalid/pair");

const app = createApp({
  manager: env.manager,
  logger: silentLogger,
  adminIps: ["127.0.0.1", "::1"],
  info: { version: "dev" },
});
const port = Number(process.env.PORT) || 3100;
app.listen(port, () => console.log(`UI on http://localhost:${port}`));
