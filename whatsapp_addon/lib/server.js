const dns = require("dns").promises;
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { ManagerError } = require("./manager");

// The Supervisor's ingress proxy connects from this fixed address of the
// internal hassio network. Only these peers may use the management UI/API.
const DEFAULT_ADMIN_IPS = ["172.30.32.2"];

const normalizeIp = (ip = "") => ip.replace(/^::ffff:/, "");

// Addresses of the Supervisor as seen from inside the add-on network. The
// hostname is resolved in addition to the well-known default, so the panel
// keeps working if the internal network ever uses another address.
const resolveSupervisorIps = async ({
  hostname = "supervisor",
  lookup = (name) => dns.lookup(name, { all: true }),
} = {}) => {
  try {
    const found = await lookup(hostname);
    return found.map((entry) => normalizeIp(entry.address));
  } catch (error) {
    return [];
  }
};

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const createApp = ({
  manager,
  logger = console,
  adminIps = DEFAULT_ADMIN_IPS,
  publicDir = path.join(__dirname, "..", "public"),
  info = {},
}) => {
  const app = express();
  const startedAt = info.startedAt || Date.now();
  const allowed = new Set(adminIps.map(normalizeIp));

  // Exposed so the resolved Supervisor addresses can be added at runtime.
  app.adminIps = allowed;

  app.disable("x-powered-by");
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(bodyParser.json());

  // ---- Service API (used by the Home Assistant custom component) ----
  // Paths, request bodies and the OK/KO answers are unchanged. A failure now
  // carries a proper status code and the reason in the X-Whatsapp-Error header.

  const serviceRoute = (name, required, action) => {
    app.post(`/${name}`, cors(), (req, res) => {
      const body = req.body || {};

      if (!own(body, "clientId")) {
        logger.error(`Error in ${name}. Please specify client ID.`);
        return res.status(400).send("KO");
      }
      if (!manager.exists(body.clientId)) {
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
        .then(() => action(body))
        .then((result) => {
          logger.debug(`${name} successful.`);
          if (result && result.json) return res.json(result.json);
          res.send("OK");
        })
        .catch((error) => {
          logger.error(`${name} failed: ${error.message}`);
          res
            .status(error.status || 500)
            .set("X-Whatsapp-Error", encodeURIComponent(String(error.message)))
            .send("KO");
        });
    });
  };

  serviceRoute("sendMessage", ["to", "body"], (b) =>
    manager.sendMessage(b.clientId, b.to, b.body, b.options)
  );
  serviceRoute("setStatus", ["status"], (b) =>
    manager.setStatus(b.clientId, b.status)
  );
  serviceRoute("presenceSubscribe", [], (b) => {
    const target = b.to !== undefined ? b.to : b.userId;
    if (target === undefined || target === null) {
      throw new Error("Missing field: to");
    }
    return manager.presenceSubscribe(b.clientId, target);
  });
  serviceRoute("sendPresenceUpdate", ["type"], (b) =>
    manager.sendPresenceUpdate(b.clientId, b.type, b.to)
  );
  serviceRoute("sendInfinityPresenceUpdate", ["type"], (b) =>
    manager.sendInfinityPresenceUpdate(b.clientId, b.type, b.to)
  );
  serviceRoute("getGroups", [], async (b) => ({
    json: { groups: await manager.getGroups(b.clientId, { refresh: b.refresh === true }) },
  }));

  // ---- Management UI and API (only reachable through ingress) -------

  app.use((req, res, next) => {
    if (!allowed.has(normalizeIp(req.socket.remoteAddress))) {
      return res.status(403).send("Forbidden");
    }
    next();
  });

  // Mutating requests need a custom header, which browsers do not send
  // cross-site without a CORS preflight.
  const mutating = (req, res, next) => {
    if (req.get("X-Requested-With") !== "whatsapp-admin") {
      return res.status(400).json({ error: "Missing X-Requested-With header." });
    }
    next();
  };

  const api = express.Router();
  api.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.method !== "GET") return mutating(req, res, next);
    next();
  });

  const wrap = (fn) => (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((error) => {
        const status = error instanceof ManagerError ? error.status : 500;
        if (status >= 500) logger.error(`Admin API error: ${error.message}`);
        res.status(status).json({ error: error.message });
      });
  };

  api.get("/state", wrap((req, res) => {
    res.json({
      clients: manager.list(),
      totals: manager.totals(),
      settings: manager.settings,
      service: {
        version: info.version || null,
        startedAt,
        now: Date.now(),
      },
    });
  }));

  api.post("/clients", wrap(async (req, res) => {
    const body = req.body || {};
    res.status(201).json(await manager.add({ id: body.id, label: body.label }));
  }));

  api.get("/clients/:id", wrap((req, res) => {
    res.json(manager.detail(req.params.id));
  }));

  api.patch("/clients/:id", wrap(async (req, res) => {
    const body = req.body || {};
    let result = manager.detail(req.params.id);
    if (own(body, "label")) result = await manager.rename(req.params.id, body.label);
    if (own(body, "enabled")) result = await manager.setEnabled(req.params.id, body.enabled === true);
    res.json(result);
  }));

  api.post("/clients/:id/connect", wrap((req, res) => {
    res.json(manager.connect(req.params.id));
  }));

  api.post("/clients/:id/disconnect", wrap((req, res) => {
    res.json(manager.disconnect(req.params.id));
  }));

  api.post("/clients/:id/reauth", wrap(async (req, res) => {
    res.json(await manager.reauth(req.params.id));
  }));

  api.delete("/clients/:id", wrap(async (req, res) => {
    const confirm = (req.body && req.body.confirm) || req.query.confirm;
    if (confirm !== req.params.id) {
      throw new ManagerError("Confirmation does not match the client ID.", 400);
    }
    await manager.remove(req.params.id);
    res.json({ ok: true });
  }));

  api.get("/clients/:id/qr", wrap((req, res) => {
    const png = manager.qrPng(req.params.id);
    if (!png) return res.status(404).json({ error: "No QR code available." });
    res.type("png").send(png);
  }));

  api.get("/clients/:id/groups", wrap(async (req, res) => {
    const groups = await manager.getGroups(req.params.id, {
      refresh: req.query.refresh === "1",
    });
    res.json({ groups });
  }));

  api.put("/settings", wrap(async (req, res) => {
    res.json(await manager.updateSettings(req.body || {}));
  }));

  app.use("/admin/api", api);
  app.use(express.static(publicDir, { index: "index.html" }));

  return app;
};

module.exports = { createApp, resolveSupervisorIps, DEFAULT_ADMIN_IPS };
