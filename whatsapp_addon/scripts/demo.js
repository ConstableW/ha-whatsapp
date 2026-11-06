// Fake installation used by `dev-ui.js` and `screenshots.js`. All names, phone
// numbers and group IDs are made up.
const { setup } = require("../tests/helpers");

const H = 3600 * 1000;

const createDemo = () => {
  let frozen = Date.now() - 30 * H;
  let live = false;
  const now = () => (live ? Date.now() : frozen);

  const env = setup({
    options: {
      clients: ["default", "office", "guest"],
      client_labels: ["default=Private", "office=Office"],
      inactivity_warning_days: 14,
    },
    now,
  });
  const { statsStore } = env;
  const c = (id) => env.client(id);

  // Older traffic (yesterday): only adds to the totals.
  frozen = Date.now() - 26 * H;
  statsStore.inc("default", "sent", 700);
  statsStore.inc("default", "incoming", 520);
  statsStore.inc("office", "sent", 180);
  statsStore.inc("office", "incoming", 240);

  // default: a short connection loss a few hours ago, connected since.
  c("default").getAccount = () => ({ phone: "4915200000001", name: "Anna Example" });
  frozen = Date.now() - 5 * H;
  c("default").emit("ready");
  frozen = Date.now() - 3.2 * H;
  c("default").emit("disconnected", { code: 408, reason: "timedOut" });
  frozen = Date.now() - 3.2 * H + 2000;
  c("default").emit("reconnecting", 1);
  frozen = Date.now() - 3.2 * H + 6000;
  c("default").emit("ready");
  frozen = Date.now() - 2 * H;
  statsStore.inc("default", "failed", 1);
  statsStore.addEvent("default", "send_failed", "Number 4915200000099 is not on Whatsapp.");

  // office: connected for longer, less traffic.
  c("office").getAccount = () => ({ phone: "4915200000002", name: "Office Bot" });
  frozen = Date.now() - 8 * H;
  c("office").emit("ready");

  // guest: waiting for the QR code to be scanned.
  frozen = Date.now() - 1 * 60 * 1000;
  c("guest").emit("qr", "https://example.invalid/whatsapp-pairing-demo");

  // Today's traffic.
  frozen = Date.now() - 2 * 60 * 1000;
  statsStore.inc("default", "sent", 12);
  statsStore.inc("default", "incoming", 16);
  statsStore.set("default", { lastActivity: frozen });
  frozen = Date.now() - 17 * 60 * 1000;
  statsStore.inc("office", "sent", 4);
  statsStore.inc("office", "incoming", 3);
  statsStore.set("office", { lastActivity: frozen });

  c("default").groups = [
    { id: "120363000000000001@g.us", subject: "Family", participants: 6 },
    { id: "120363000000000002@g.us", subject: "Neighbours", participants: 14 },
    { id: "120363000000000003@g.us", subject: "Smart Home Club", participants: 9 },
    { id: "120363000000000004@g.us", subject: "Sunday Football", participants: 21 },
  ];
  c("office").groups = [
    { id: "120363000000000005@g.us", subject: "Facility Management", participants: 5 },
  ];

  live = true;
  return env;
};

module.exports = { createDemo };
