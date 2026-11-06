const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const { WhatsappClient } = require("./whatsapp");

var logger = require("log4js").getLogger();
logger.level = "info";

var qrimage = require("qr-image");

const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const clients = {};

const supervisorPost = (path, data) =>
  axios
    .post(`http://supervisor/core/api/${path}`, data, {
      headers: {
        Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`,
      },
    })
    .catch((error) => {
      logger.error(`Request to supervisor (${path}) failed: ${error.message}`);
    });

const onReady = (key) => {
  logger.info(key, "client is ready.");
  supervisorPost("services/persistent_notification/dismiss", {
    notification_id: `whatsapp_addon_qrcode_${key}`,
  });
};

const onQr = (qr, key) => {
  logger.info(
    key,
    "require authentication over QRCode, please see your notifications..."
  );

  const chunks = [];
  const code = qrimage.image(qr, { type: "png" });

  code.on("data", (chunk) => chunks.push(chunk));
  code.on("end", () => {
    const img_string = Buffer.concat(chunks).toString("base64");
    supervisorPost("services/persistent_notification/create", {
      title: `Whatsapp QRCode (${key})`,
      message: `Please scan the following QRCode for **${key}** client... ![QRCode](data:image/png;base64,${img_string})`,
      notification_id: `whatsapp_addon_qrcode_${key}`,
    });
  });
};

const onMsg = (msg, key) => {
  supervisorPost("events/new_whatsapp_message", { clientId: key, ...msg });
  logger.debug(`New message event fired from ${key}.`);
};

const onPresenceUpdate = (presence, key) => {
  supervisorPost("events/whatsapp_presence_update", {
    clientId: key,
    ...presence,
  });
  logger.debug(`New presence event fired from ${key}.`);
};

const onLogout = (key) => {
  logger.info(`Client ${key} was logged out. Restarting...`);
  fs.rm(`/data/${key}`, { recursive: true, force: true }, (error) => {
    if (error) logger.error(`Could not remove session of ${key}: ${error.message}`);
    init(key);
  });
};

const init = (key) => {
  clients[key] = new WhatsappClient({ path: `/data/${key}` });

  clients[key].on("restart", () => logger.debug(`${key} client restarting...`));
  clients[key].on("qr", (qr) => onQr(qr, key));
  clients[key].once("ready", () => onReady(key));
  clients[key].on("msg", (msg) => onMsg(msg, key));
  clients[key].once("logout", () => onLogout(key));
  clients[key].on("presence_update", (presence) =>
    onPresenceUpdate(presence, key)
  );
  clients[key].on("error", (error) =>
    logger.error(`${key} client error: ${error.message}`)
  );
};

// Registers a POST route that resolves the client from the request body,
// validates the required fields and runs `action(wapp, body)`.
const route = (name, required, action) => {
  app.post(`/${name}`, (req, res) => {
    const body = req.body || {};

    if (!Object.prototype.hasOwnProperty.call(body, "clientId")) {
      logger.error(`Error in ${name}. Please specify client ID.`);
      return res.status(400).send("KO");
    }

    if (!Object.prototype.hasOwnProperty.call(clients, body.clientId)) {
      logger.error(`Error in ${name}. Client ID not found.`);
      return res.status(404).send("KO");
    }

    const missing = required.filter(
      (field) => body[field] === undefined || body[field] === null
    );
    if (missing.length) {
      logger.error(`Error in ${name}. Missing field(s): ${missing.join(", ")}.`);
      return res.status(400).send("KO");
    }

    Promise.resolve()
      .then(() => action(clients[body.clientId], body))
      .then(() => {
        res.send("OK");
        logger.debug(`${name} successful.`);
      })
      .catch((error) => {
        logger.error(`${name} failed: ${error.message}`);
        res.status(500).send("KO");
      });
  });
};

fs.readFile("data/options.json", function (error, content) {
  if (error) {
    logger.fatal(`Cannot read options.json: ${error.message}`);
    process.exit(1);
  }

  let options;
  try {
    options = JSON.parse(content);
  } catch (e) {
    logger.fatal(`Invalid options.json: ${e.message}`);
    process.exit(1);
  }

  (options.clients || []).forEach((key) => {
    init(key);
  });

  route("sendMessage", ["to", "body"], (wapp, b) =>
    wapp.sendMessage(b.to, b.body, b.options)
  );

  route("setStatus", ["status"], (wapp, b) => wapp.updateProfileStatus(b.status));

  route("presenceSubscribe", [], (wapp, b) => {
    const target = b.to !== undefined ? b.to : b.userId;
    if (target === undefined || target === null) {
      throw new Error("Missing field: to");
    }
    return wapp.presenceSubscribe(target);
  });

  route("sendPresenceUpdate", ["type"], (wapp, b) =>
    wapp.sendPresenceUpdate(b.type, b.to)
  );

  route("sendInfinityPresenceUpdate", ["type"], (wapp, b) =>
    wapp.setSendPresenceUpdateInterval(b.type, b.to)
  );

  app.listen(port, () => logger.info(`Whatsapp Addon started.`));
});

process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled rejection: ${reason && reason.message ? reason.message : reason}`);
});
