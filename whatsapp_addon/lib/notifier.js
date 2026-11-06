const axios = require("axios");
const qrimage = require("qr-image");

// Talks to Home Assistant through the Supervisor proxy: persistent
// notifications and events. Without a Supervisor token (development, tests)
// every call is a no-op.
class Notifier {
  #http;
  #token;
  #base;
  #logger;

  constructor({
    http = axios,
    token = process.env.SUPERVISOR_TOKEN,
    base = "http://supervisor/core/api",
    logger = console,
  } = {}) {
    this.#http = http;
    this.#token = token;
    this.#base = base;
    this.#logger = logger;
  }

  async #post(path, data) {
    if (!this.#token) return;
    try {
      await this.#http.post(`${this.#base}/${path}`, data, {
        headers: { Authorization: `Bearer ${this.#token}` },
      });
    } catch (error) {
      this.#logger.error(`Request to Home Assistant (${path}) failed: ${error.message}`);
    }
  }

  qr(id, label, qr) {
    const png = qrimage.imageSync(qr, { type: "png" }).toString("base64");
    return this.#post("services/persistent_notification/create", {
      title: `Whatsapp QRCode (${label || id})`,
      message: `Please scan the following QRCode for **${label || id}** client... ![QRCode](data:image/png;base64,${png})`,
      notification_id: `whatsapp_addon_qrcode_${id}`,
    });
  }

  dismissQr(id) {
    return this.#post("services/persistent_notification/dismiss", {
      notification_id: `whatsapp_addon_qrcode_${id}`,
    });
  }

  authInvalid(id, label) {
    return this.#post("services/persistent_notification/create", {
      title: `Whatsapp (${label || id}) logged out`,
      message: `The WhatsApp session **${label || id}** is no longer valid. Open the WhatsApp panel in the sidebar and use "Re-authenticate" to scan a new QR code.`,
      notification_id: `whatsapp_addon_auth_${id}`,
    });
  }

  dismissAuth(id) {
    return this.#post("services/persistent_notification/dismiss", {
      notification_id: `whatsapp_addon_auth_${id}`,
    });
  }

  fireEvent(name, data) {
    return this.#post(`events/${name}`, data);
  }
}

module.exports = { Notifier };
