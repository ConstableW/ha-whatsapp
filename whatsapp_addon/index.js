const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const log4js = require("log4js");
const QRCode = require("qrcode");

const logger = log4js.getLogger();
logger.level = "info";

const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const clients = {};

const onReady = (key) => {
  logger.info(`[${key}] Client ist bereit.`);
  axios.post(
    "http://supervisor/core/api/services/persistent_notification/dismiss",
    { notification_id: `whatsapp_addon_qrcode_${key}` },
    { headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` } }
  );
};

const onQr = (qr, key) => {
  logger.info(`[${key}] QR-Code erforderlich, siehe Benachrichtigungen.`);

  const wwwDir = '/config/www';
  if (!fs.existsSync(wwwDir)) {
    try {
      fs.mkdirSync(wwwDir, { recursive: true });
      logger.info(`[System] Verzeichnis erstellt: ${wwwDir}`);
    } catch (err) {
      logger.error(`[Fehler] Verzeichnis ${wwwDir} konnte nicht erstellt werden:`, err);
      return;
    }
  }

  const fileName = `qrcode_${key}.png`;
  const filePath = path.join(wwwDir, fileName);
  const fileUrl = `/local/${fileName}`;

  QRCode.toFile(
    filePath,
    qr,
    { errorCorrectionLevel: 'M', margin: 2, scale: 10 },
    (err) => {
      if (err) {
        logger.error(`[${key}] QR-Code-Erstellung fehlgeschlagen:`, err);
        return;
      }
      logger.info(`[${key}] QR-Code gespeichert unter ${filePath}`);

      axios.post(
        "http://supervisor/core/api/services/persistent_notification/create",
        {
          title: `Whatsapp QRCode (${key})`,
          message: `**Scanne diesen QR-Code für ${key}:**\n\n![QRCode](${fileUrl}?v=${Date.now()})`,
          notification_id: `whatsapp_addon_qrcode_${key}`,
        },
        { headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` } }
      ).catch(err => {
        logger.error(`[${key}] Benachrichtigung fehlgeschlagen:`, err);
      });
    }
  );
};

const onMsg = (msg, key) => {
  const from = msg.key?.remoteJid || msg.from || null;
  const body = msg.message?.conversation
    || msg.message?.extendedTextMessage?.text
    || msg.message?.ephemeralMessage?.message?.conversation
    || null;
  const timestamp = msg.messageTimestamp || msg.timestamp || Date.now();

  logger.debug(`[${key}] Nachricht empfangen:`, { from, body, timestamp });

  axios.post(
    "http://supervisor/core/api/events/new_whatsapp_message",
    { clientId: key, from, body, timestamp },
    { headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` } }
  ).catch(err => {
    logger.error(`[${key}] Eventversand fehlgeschlagen:`, err);
  });
};

const onPresenceUpdate = (presence, key) => {
  axios.post(
    "http://supervisor/core/api/events/whatsapp_presence_update",
    { clientId: key, ...presence },
    { headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` } }
  );
  logger.debug(`[${key}] Präsenzupdate gesendet.`);
};

const onLogout = async (key) => {
  logger.info(`[${key}] Logout erkannt, starte neu...`);
  try {
    await fs.promises.rm(`/data/${key}/auth`, { recursive: true, force: true });
  } catch (error) {
    logger.error(`[${key}] Auth-Daten löschen fehlgeschlagen:`, error);
  }
  init(key);
};

const init = async (key) => {
  try {
    const authPath = `/data/${key}/auth`;
    await fs.promises.mkdir(authPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const sock = makeWASocket({ auth: state, printQRInTerminal: false });

    clients[key] = sock;

    sock.ev.on("connection.update", async (update) => {
      const { connection, qr } = update;
      if (qr) onQr(qr, key);
      logger.info(`[${key}] Verbindungsstatus: ${connection}`);

      if (connection === "open") {
        try {
          await saveCreds();
          const files = await fs.promises.readdir(authPath);
          logger.info(`[${key}] Auth-Daten gespeichert. Inhalt: ${files.join(", ")}`);
        } catch (err) {
          logger.error(`[${key}] Fehler beim Speichern der Auth-Daten:`, err);
        }
        onReady(key);
      }
      if (connection === "close") onLogout(key);
    });

    sock.ev.on("creds.update", async () => {
      try {
        await saveCreds();
        logger.info(`[${key}] Auth-Daten aktualisiert.`);
      } catch (err) {
        logger.error(`[${key}] Fehler bei Auth-Update:`, err);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
      if (messages && messages.length > 0) {
        onMsg(messages[0], key);
      }
    });

    sock.ev.on("presence.update", (presence) => onPresenceUpdate(presence, key));
  } catch (error) {
    logger.error(`[${key}] Initialisierung fehlgeschlagen:`, error);
    setTimeout(() => init(key), 30000);
  }
};

fs.readFile("data/options.json", async function (error, content) {
  if (error) {
    logger.error("Konnte options.json nicht lesen:", error);
    process.exit(1);
  }
  const options = JSON.parse(content);
  for (const key of options.clients) {
    await init(key);
  }

  app.listen(port, () => logger.info("Whatsapp Addon gestartet."));

  app.post("/sendMessage", async (req, res) => {
    const message = req.body;
    if (!message.clientId || !clients[message.clientId]) {
      logger.error("Client ID nicht gefunden.");
      return res.send("KO");
    }
    if (!message.to || !message.body) {
      logger.error("Zieladresse oder Nachricht fehlt.");
      return res.send("KO");
    }
    try {
      await clients[message.clientId].sendMessage(message.to, { text: message.body }, message.options || {});
      res.send("OK");
    } catch (error) {
      res.send("KO");
      logger.error("Fehler beim Senden:", error.message);
    }
  });

  app.post("/setStatus", async (req, res) => {
    const { clientId, status } = req.body;
    if (!clientId || !clients[clientId]) {
      logger.error("Client ID nicht gefunden.");
      return res.send("KO");
    }
    try {
      await clients[clientId].updateProfileStatus(status);
      res.send("OK");
    } catch (error) {
      res.send("KO");
      logger.error("Fehler beim Status-Update:", error.message);
    }
  });

  app.post("/presenceSubscribe", async (req, res) => {
    const { clientId, userId } = req.body;
    if (!clientId || !clients[clientId]) {
      logger.error("Client ID nicht gefunden.");
      return res.send("KO");
    }
    try {
      await clients[clientId].presenceSubscribe(userId);
      res.send("OK");
    } catch (error) {
      res.send("KO");
      logger.error("Fehler beim Präsenz-Abonnement:", error.message);
    }
  });

  app.post("/sendPresenceUpdate", async (req, res) => {
    const { clientId, type, to } = req.body;
    if (!clientId || !clients[clientId]) {
      logger.error("Client ID nicht gefunden.");
      return res.send("KO");
    }
    try {
      await clients[clientId].sendPresenceUpdate(type, to);
      res.send("OK");
    } catch (error) {
      res.send("KO");
      logger.error("Fehler beim Präsenz-Update:", error.message);
    }
  });
});
