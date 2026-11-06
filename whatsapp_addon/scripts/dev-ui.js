// Starts the management UI against fake clients so it can be tried without
// WhatsApp or Home Assistant:  node scripts/dev-ui.js   (http://localhost:3100)
const { silentLogger } = require("../tests/helpers");
const { createApp } = require("../lib/server");
const { createDemo } = require("./demo");

const env = createDemo();

const app = createApp({
  manager: env.manager,
  logger: silentLogger,
  adminIps: ["127.0.0.1", "::1"],
  info: { version: "dev" },
});
const port = Number(process.env.PORT) || 3100;
app.listen(port, () => console.log(`UI on http://localhost:${port}`));
