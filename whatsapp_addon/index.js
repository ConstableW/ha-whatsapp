const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs").promises;
const { WhatsappClient } = require("./whatsapp");
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

// Überprüfen, ob SUPERVISOR_TOKEN gesetzt ist
const supervisorToken = process.env.SUPERVISOR_TOKEN;
if (!supervisorToken) {
  logger.fatal("SUPERVISOR_TOKEN environment variable missing!");
  process.exit(1);
}

const axiosConfig = {
  headers: { Authorization: `Bearer ${supervisorToken}` }
};

const onReady = (key) => {
  logger.info(`${key} client is ready.`);
  axios.post(
    "http://supervisor/core/api/services/persistent_notification/dismiss",
    { notification_id: `whatsapp_addon_qrcode_${key}` },
    axiosConfig
  ).catch(err => logger.error(`Failed to dismiss notification for ${key}:`, err));
};

const onQr = (qr, key) => {
  logger.info(`${key} requires authentication over QRCode, please see your notifications...`);
  try {
    const imgBuffer = qrimage.imageSync(qr, { type: 'png' });
    const imgString = imgBuffer.toString('base64');
    axios.post(
      "http://supervisor/core/api/services/persistent_notification/create",
      {
        title: `Whatsapp QRCode (${key})`,
        message: `Please scan the following QRCode for **${key}** client... ![QRCode](data:image/png;base64,${imgString})`,
        notification_id: `whatsapp_addon_qrcode_${key}`
      },
      axiosConfig
    ).catch(err => logger.error(`Failed to create QR notification for ${key}:`, err));
  } catch (err) {
    logger.error("QR-Code generation failed:", err);
  }
};

const onMsg = (msg, key) => {
  const from = msg.key?.remoteJid || msg.from || null;
  const body = msg.message?.conversation || msg.body || msg.message?.extendedTextMessage?.text || null;
  const timestamp = msg.timestamp || Date.now();
  logger.debug("Event data:", { clientId: key, from, body, timestamp });
  axios.post(
    "http://supervisor/core/api/events/new_whatsapp_message",
    { clientId: key, from, body, timestamp },
    axiosConfig
  ).then(() => {
    logger.debug(`New message event fired from ${key}.`);
  }).catch(err => {
    logger.error(`Failed to send message event for ${key}:`, err);
  });
};

const onPresenceUpdate = (presence, key) => {
  const { type, to, isOnline } = presence; // Anpassen an Präsenzstruktur
  axios.post(
    "http://supervisor/core/api/events/whatsapp_presence_update",
    { clientId: key, type, to, isOnline },
    axiosConfig
  ).then(() => {
    logger.debug(`New presence event fired from ${key}.`);
  }).catch(err => {
    logger.error(`Failed to send presence event for ${key}:`, err);
  });
};

const onLogout = async (key) => {
  logger.info(`Client ${key} was logged out. Restarting...`);
  try {
    await fs.rm(`/data/${key}`, { recursive: true, force: true });
    init(key);
  } catch (err) {
    logger.error(`Failed to cleanup client ${key}:`, err);
  }
};

const init = (key) => {
  try {
    clients[key] = new WhatsappClient({ path: `/data/${key}` });
    clients[key].on("restart", () => logger.debug(`${key} client restarting...`));
    clients[key].on("qr", (qr) => onQr(qr, key));
    clients[key].once("ready", () => onReady(key));
    clients[key].on("msg", (msg) => onMsg(msg, key));
    clients[key].on("logout", () => onLogout(key));
    clients[key].on("presence_update", (presence) => onPresenceUpdate(presence, key));
    logger.info(`Initialized client ${key}`);
  } catch (err) {
    logger.error(`Failed to initialize client ${key}:`, err);
  }
};

const sendError = (res, code, message) => {
  logger.error(message);
  res.status(code).send(message);
};

app.post("/sendMessage", async (req, res) => {
  const { clientId, to, body, options } = req.body;
  if (!clientId || !to || !body) {
    return sendError(res, 400, "Missing required fields: clientId, to, or body");
  }
  if (!clients[clientId]) {
    return sendError(res, 404, `Client ID ${clientId} not found`);
  }
  try {
    await clients[clientId].sendMessage(to, { text: body }, options);
    logger.debug("Message successfully sent from addon.");
    res.send("OK");
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

app.post("/setStatus", async (req, res) => {
  const { clientId, status } = req.body;
  if (!clientId || !status) {
    return sendError(res, 400, "Missing required fields: clientId or status");
  }
  if (!clients[clientId]) {
    return sendError(res, 404, `Client ID ${clientId} not found`);
  }
  try {
    await clients[clientId].updateProfileStatus(status);
    res.send("OK");
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

app.post("/presenceSubscribe", async (req, res) => {
  const { clientId, userId } = req.body;
  if (!clientId || !userId) {
    return sendError(res, 400, "Missing required fields: clientId or userId");
  }
  if (!clients[clientId]) {
    return sendError(res, 404, `Client ID ${clientId} not found`);
  }
  try {
    await clients[clientId].presenceSubscribe(userId);
    res.send("OK");
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

app.post("/sendPresenceUpdate", async (req, res) => {
  const { clientId, type, to } = req.body;
  if (!clientId || !type) {
    return sendError(res, 400, "Missing required fields: clientId or type");
  }
  if (!clients[clientId]) {
    return sendError(res, 404, `Client ID ${clientId} not found`);
  }
  try {
    await clients[clientId].sendPresenceUpdate(type, to);
    res.send("OK");
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

app.post("/sendInfinityPresenceUpdate", async (req, res) => {
  const { clientId, type, to } = req.body;
  if (!clientId || !type) {
    return sendError(res, 400, "Missing required fields: clientId or type");
  }
  if (!clients[clientId]) {
    return sendError(res, 404, `Client ID ${clientId} not found`);
  }
  try {
    await clients[clientId].setSendPresenceUpdateInterval(type, to);
    res.send("OK");
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

async function startServer() {
  try {
    const options = JSON.parse(await fs.readFile("data/options.json", "utf-8"));
    options.clients.forEach(init);
    app.listen(port, () => logger.info(`Whatsapp Addon started on port ${port}`));
  } catch (err) {
    logger.fatal("Failed to start server:", err);
    process.exit(1);
  }
}

startServer();
