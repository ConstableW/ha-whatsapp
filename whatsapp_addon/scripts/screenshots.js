// Renders the management panel with the fake demo data and writes PNG
// screenshots to docs/images. Needs Chrome or Edge:
//   node scripts/screenshots.js [lang]      (lang: en | de, default en)
// No dependencies: it talks to the browser through the DevTools protocol.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { silentLogger } = require("../tests/helpers");
const { createApp } = require("../lib/server");
const { createDemo } = require("./demo");

const lang = process.argv[2] === "de" ? "de" : "en";
const outDir = path.join(
  __dirname,
  "..",
  "..",
  "docs",
  "images",
  lang === "de" ? "de" : "",
);
const BROWSERS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdp = async (wsUrl) => {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => ws.close() };
};

(async () => {
  const exe = BROWSERS.find((p) => fs.existsSync(p));
  if (!exe) throw new Error("No Chrome/Edge found");
  fs.mkdirSync(outDir, { recursive: true });

  const env = createDemo();
  const app = createApp({
    manager: env.manager,
    logger: silentLogger,
    adminIps: ["127.0.0.1", "::1"],
    info: {
      version: "demo",
      startedAt: Date.now() - (4 * 60 + 26) * 60 * 1000,
    },
  });
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const url = `http://127.0.0.1:${server.address().port}/`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "wa-shot-"));
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(
    exe,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--hide-scrollbars",
      `--lang=${lang === "de" ? "de-DE" : "en-US"}`,
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const cleanup = () => {
    try {
      chrome.kill();
    } catch (e) {}
    server.close();
    // Chrome may still hold files for a moment (Windows): best effort only.
    setTimeout(() => {
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
      } catch (e) {}
    }, 1500);
  };

  try {
    let targets;
    for (let i = 0; i < 50; i++) {
      try {
        targets = await (
          await fetch(`http://127.0.0.1:${port}/json/list`)
        ).json();
        if (targets.some((t) => t.type === "page")) break;
      } catch (e) {}
      await sleep(200);
    }
    const page = targets.find((t) => t.type === "page");
    const c = await cdp(page.webSocketDebuggerUrl);
    await c.send("Page.enable");

    const evaluate = async (expression) =>
      (
        await c.send("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        })
      ).result.value;
    const waitFor = async (expression, ms = 8000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await evaluate(expression)) return;
        await sleep(100);
      }
      throw new Error("Timeout waiting for: " + expression);
    };
    const viewport = (width, height, mobile = false) =>
      c.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: mobile ? 2 : 1.5,
        mobile,
      });
    const shot = async (name) => {
      const { data } = await c.send("Page.captureScreenshot", {
        format: "png",
      });
      fs.writeFileSync(path.join(outDir, name), Buffer.from(data, "base64"));
      console.log("wrote", path.join(outDir, name));
    };
    const fullPage = async (name, width, mobile = false) => {
      await viewport(width, 800, mobile);
      await sleep(300);
      const h = await evaluate("document.documentElement.scrollHeight");
      await viewport(width, h, mobile);
      await sleep(300);
      await shot(name);
    };
    const clickText = (selector, re) =>
      evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((e) => new RegExp(${JSON.stringify(re)}, "i").test(e.textContent));
        if (!el) return false; el.click(); return true; })()`);
    const closeDialog = () =>
      evaluate("document.querySelectorAll('dialog').forEach((d) => d.close())");

    await c.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    await c.send("Page.navigate", { url });
    await waitFor("!!document.querySelector('.client')");
    await sleep(500);

    // 1. overview (desktop)
    await fullPage("panel-overview.png", 1180);

    // 2. QR dialog of the pending client
    await viewport(1180, 760);
    const qrLabel = lang === "de" ? "QR anzeigen" : "Show QR code";
    await clickText("button", qrLabel);
    await waitFor(
      "(() => { const i = document.querySelector('dialog img'); return !!i && i.complete && i.naturalWidth > 0; })()",
    );
    await sleep(300);
    await shot("panel-qr.png");
    await closeDialog();

    // 3. details of the first client: overview, groups, events
    await clickText(
      ".client button",
      lang === "de" ? "^Details$" : "^Details$",
    );
    await waitFor("!!document.querySelector('dialog .kv')");
    await viewport(1180, 860);
    await sleep(300);
    await shot("panel-details.png");

    await clickText("dialog .tab", lang === "de" ? "Gruppen" : "Groups");
    await waitFor("!!document.querySelector('dialog .list li')");
    await sleep(300);
    await shot("panel-groups.png");

    await clickText("dialog .tab", lang === "de" ? "Ereignisse" : "Events");
    await sleep(500);
    await shot("panel-events.png");
    await closeDialog();

    // 4. add dialog
    await clickText(
      "button",
      lang === "de" ? "Client hinzufügen" : "Add client",
    );
    await waitFor("!!document.querySelector('dialog input')");
    await evaluate(
      "document.querySelector('#add-id').value = 'garage'; document.querySelector('#add-label').value = 'Garage';",
    );
    await viewport(1180, 560);
    await sleep(300);
    await shot("panel-add.png");
    await closeDialog();

    // 5. mobile overview
    await evaluate("window.scrollTo(0, 0)");
    await fullPage("panel-mobile.png", 390, true);

    c.close();
  } finally {
    cleanup();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
