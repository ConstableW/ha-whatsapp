const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const { makeWASocket, useSingleFileAuthState } = require("@whiskeysockets/baileys");
const log4js = require("log4js");
const qrimage = require("qr-image");

const logger = log4js.getLogger();
logger.level = "info";

const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const clients = {};

const onReady = (key) => {
  logger.info(key, "client is ready.");
  axios.post(
    "http://supervisor/core/api/services/persistent_notification/dismiss",
    { notification_id: `whatsapp_addon_qrcode_${key}` },
    { headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` } }
  );
};

const onQr = (qr, key) => {
  logger.info(key, "require authentication over QRCode, please see your notifications...");
  const code = qrimage.image(qr, { type: "png" });

  let img_string = "";
  code.on("data", chunk => { img_string += chunk.toString("base64"); });
  code.on("end", () => {
    axios.post(
      "http://supervisor/core/api/services/persistent_notification/create",
      {
        title: `Whatsapp QRCode (${key})`,
        message: `Please scan the following QRCode for **${key}** client... ![QRCode](data:image/png;base64,${img_string})`,
        notification_id: `whatsapp_addon_qrcode_${key}`,
      },
      { headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` } }
    );
  });
};

const onMsg = (msg, key) => {
  const from = msg.key?.remoteJid || msg.from || null;
  const body = msg.message?.conversation
    || msg.message?.extendedTextMessage?.text
    || msg.message?.ephemeralMessage?.message?.conversation
    || null;
  const timestamp = msg.messageTimestamp || msg.timestamp || Date.now();

  logger.debug("Event data:", { clientId: key, from, body, timestamp });

  axios.post(
    "http://supervisor/core/api/events/new_whatsapp_message",
    { clientId: key, from, body, timestamp },
    { headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` } }
  ).then(() => {
    logger.debug(`New message event fired from ${key}.`);
  }).catch(err => {
    logger.error(`Failed to send message event for ${key}:`, err);
  });
};

const onPresenceUpdate = (presence, key) => {
  axios.post(
    "http://supervisor/core/api/events/whatsapp_presence_update",
    { clientId: key, ...presence },
    { headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` } }
  );
  logger.debug(`New presence event fired from ${key}.`);
};

const onLogout = async (key) => {
  logger.info(`Client ${key} was logged out. Restarting...`);
  await fs.promises.rm(`/data/${key}`, { recursive: true, force: true });
  init(key);
};

const init = (key) => {
  // Authentifizierungsdaten pro Client
  const authPath = `/data/${key}/auth_info.json`;
  fs.mkdirSync(`/data/${key}`, { recursive: true });
  const { state, saveState } = useSingleFileAuthState(authPath);

  const sock = makeWASocket({ auth: state });

  clients[key] = sock;

  // QR-Code und Verbindungsstatus
  sock.ev.on("connection.update", (update) => {
    const { connection, qr } = update;
    if (qr) onQr(qr, key);
    if (connection === "open") onReady(key);
    if (connection === "close") onLogout(key);
  });

  // Auth-Daten speichern
  sock.ev.on("creds.update", saveState);

  // Nachrichtenempfang
  sock.ev.on("messages.upsert", async ({ messages }) => {
    if (messages && messages.length > 0) {
      onMsg(messages[0], key);
    }
  });

  // Präsenz-Updates (optional)
  sock.ev.on("presence.update", (presence) => onPresenceUpdate(presence, key));
};

// WICHTIG: Pfad zu /data/options.json
fs.readFile("/data/options.json", function (error, content) {
  if (error) {
    logger.error("Failed to read options.json:", error);
    process.exit(1);
  }
  const options = JSON.parse(content);

  options.clients.forEach((key) => {
    init(key);
  });

  app.listen(port, () => logger.info(`Whatsapp Addon started.`));

  // Senden von Nachrichten
  app.post("/sendMessage", async (req, res) => {
    const message = req.body;
    if (!message.clientId || !clients[message.clientId]) {
      logger.error("Error in sending message. Client ID not found.");
      return res.send("KO");
    }
    if (!message.to || !message.body) {
      logger.error("Error in sending message. 'to' or 'body' missing.");
      return res.send("KO");
    }
    try {
      await clients[message.clientId].sendMessage(message.to, { text: message.body }, message.options || {});
      res.send("OK");
      logger.debug("Message successfully sent from addon.");
    } catch (error) {
      res.send("KO");
      logger.error(error.message);
    }
  });

  // Status setzen
  app.post("/setStatus", async (req, res) => {
    const { clientId, status } = req.body;
    if (!clientId || !clients[clientId]) {
      logger.error("Error in set status. Client ID not found.");
      return res.send("KO");
    }
    try {
      await clients[clientId].updateProfileStatus(status);
      res.send("OK");
    } catch (error) {
      res.send("KO");
      logger.error(error.message);
    }
  });

  // Präsenz abonnieren
  app.post("/presenceSubscribe", async (req, res) => {
    const { clientId, userId } = req.body;
    if (!clientId || !clients[clientId]) {
      logger.error("Error in subscribe presence. Client ID not found.");
      return res.send("KO");
    }
    try {
      await clients[clientId].presenceSubscribe(userId);
      res.send("OK");
    } catch (error) {
      res.send("KO");
      logger.error(error.message);
    }
  });

  // Präsenz-Update senden
  app.post("/sendPresenceUpdate", async (req, res) => {
    const { clientId, type, to } = req.body;
    if (!clientId || !clients[clientId]) {
      logger.error("Error in presence update. Client ID not found.");
      return res.send("KO");
    }
    try {
      await clients[clientId].sendPresenceUpdate(type, to);
      res.send("OK");
    } catch (error) {
      res.send("KO");
      logger.error(error.message);
    }
  });
});
