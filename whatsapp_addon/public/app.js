(function () {
  "use strict";

  const lang = /^de/i.test(navigator.language || "") ? "de" : "en";
  const dict = window.I18N[lang];
  const t = (key, vars) =>
    (dict[key] || window.I18N.en[key] || key).replace(/\{(\w+)\}/g, (_, k) =>
      vars && vars[k] !== undefined ? vars[k] : ""
    );
  document.documentElement.lang = lang;

  // ---- helpers -----------------------------------------------------

  const h = (tag, attrs, ...children) => {
    const el = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v === null || v === undefined || v === false) return;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    });
    children.flat().forEach((c) => {
      if (c === null || c === undefined || c === false) return;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    });
    return el;
  };

  const api = async (method, url, body) => {
    const res = await fetch("admin/api/" + url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "whatsapp-admin",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = (await res.json()).error || msg;
      } catch (e) {}
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  };

  const dateFmt = new Intl.DateTimeFormat(lang, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const fmtDate = (ts) => (ts ? dateFmt.format(new Date(ts)) : t("never"));

  const duration = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400);
    const hr = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return `${d} d ${hr} h`;
    if (hr) return `${hr} h ${m} min`;
    if (m) return `${m} min`;
    return `${s} s`;
  };

  const fmtAgo = (ts, now) => {
    if (!ts) return t("never");
    const diff = now - ts;
    if (diff < 60000) return t("justNow");
    return t("ago", { t: duration(diff) });
  };

  const stateClass = (state) =>
    ({
      connected: "ok",
      connecting: "info",
      disconnected_temp: "warn",
      reconnecting: "warn",
      qr_required: "warn",
      auth_invalid: "err",
    }[state] || "");

  const chip = (state) =>
    h("span", { class: "chip " + stateClass(state), text: t("state." + state) });

  const name = (c) => c.label || c.id;

  const toast = (msg, isError) => {
    const box = document.getElementById("toasts");
    const el = h("div", { class: "toast" + (isError ? " err" : ""), text: msg });
    box.append(el);
    setTimeout(() => el.remove(), isError ? 6000 : 2500);
  };

  const run = async (fn, okMsg) => {
    try {
      const result = await fn();
      if (okMsg) toast(okMsg);
      await refresh();
      return result;
    } catch (e) {
      toast(t("failed", { msg: e.message }), true);
      return undefined;
    }
  };

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = h("textarea", {});
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    toast(t("copied"));
  };

  // ---- state -------------------------------------------------------

  let state = null;
  let filter = "";
  let openMenu = null;
  let detail = null; // { id, tab, refreshOverview, refreshEvents }
  let qrDlg = null; // { id, update }

  const find = (id) => state && state.clients.find((c) => c.id === id);

  // ---- dialogs -----------------------------------------------------

  const dialog = (title, body, foot) => {
    const dlg = h("dialog", {});
    const closeBtn = h("button", {
      class: "btn icon",
      "aria-label": t("close"),
      text: "✕",
      onclick: () => dlg.close(),
    });
    dlg.append(
      h("div", { class: "dlg-head" }, h("h2", { text: title }), closeBtn),
      h("div", { class: "dlg-body" }, body)
    );
    if (foot) dlg.append(h("div", { class: "dlg-foot" }, foot));
    dlg.addEventListener("close", () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
    return dlg;
  };

  const confirmDialog = ({ title, text, label, danger, typeId }) =>
    new Promise((resolve) => {
      let input = null;
      const ok = h("button", {
        class: "btn " + (danger ? "danger solid" : "primary"),
        text: label || t("confirm"),
        disabled: !!typeId,
      });
      const cancel = h("button", { class: "btn", text: t("cancel") });
      const body = [h("p", { text })];
      if (typeId) {
        input = h("input", {
          type: "text",
          "aria-label": t("fieldId"),
          autocomplete: "off",
          oninput: () => (ok.disabled = input.value !== typeId),
        });
        body.push(input);
      }
      const dlg = dialog(title, body, [cancel, ok]);
      let result = false;
      ok.onclick = () => {
        result = true;
        dlg.close();
      };
      cancel.onclick = () => dlg.close();
      dlg.addEventListener("close", () => resolve(result));
    });

  // ---- actions -----------------------------------------------------

  const doReauth = async (c) => {
    const ok = await confirmDialog({
      title: t("reauthTitle", { name: name(c) }),
      text: t("reauthText"),
    });
    if (!ok) return;
    await run(() => api("POST", `clients/${encodeURIComponent(c.id)}/reauth`));
    showQr(c.id);
  };

  const doRemove = async (c) => {
    const ok = await confirmDialog({
      title: t("removeTitle", { name: name(c) }),
      text: t("removeText"),
      label: t("remove"),
      danger: true,
      typeId: c.id,
    });
    if (!ok) return false;
    const done = await run(() =>
      api("DELETE", `clients/${encodeURIComponent(c.id)}`, { confirm: c.id })
    );
    return done !== undefined;
  };

  const post = (c, action) =>
    run(() => api("POST", `clients/${encodeURIComponent(c.id)}/${action}`));

  const setEnabled = (c, enabled) =>
    run(() => api("PATCH", `clients/${encodeURIComponent(c.id)}`, { enabled }));

  const reconnect = async (c) => {
    await post(c, "disconnect");
    await post(c, "connect");
  };

  // ---- QR dialog ---------------------------------------------------

  const showQr = (id) => {
    if (qrDlg) return;
    const img = h("img", { alt: "QR code", hidden: true });
    const wait = h("p", { class: "muted", text: t("qrWaiting") });
    const box = h("div", { class: "qr" }, h("div", {}, img, wait));
    const c0 = find(id);
    const dlg = dialog(
      t("qrTitle", { name: c0 ? name(c0) : id }),
      [h("p", { class: "muted", text: t("qrHelp") }), box]
    );

    const update = () => {
      const c = find(id);
      if (!c) return dlg.close();
      if (c.state === "connected") {
        toast(t("qrDone", { name: name(c) }));
        return dlg.close();
      }
      if (c.hasQr) {
        img.src = `admin/api/clients/${encodeURIComponent(id)}/qr?ts=${Date.now()}`;
        img.hidden = false;
        wait.hidden = true;
      } else {
        img.hidden = true;
        wait.hidden = false;
      }
    };

    qrDlg = { id, update };
    dlg.addEventListener("close", () => (qrDlg = null));
    update();
  };

  // ---- add dialog --------------------------------------------------

  const showAdd = () => {
    const id = h("input", {
      type: "text",
      maxlength: "32",
      pattern: "[A-Za-z0-9_\\-]{1,32}",
      autocomplete: "off",
      id: "add-id",
    });
    const label = h("input", { type: "text", maxlength: "64", id: "add-label" });
    const ok = h("button", { class: "btn primary", text: t("create") });
    const cancel = h("button", { class: "btn", text: t("cancel") });
    const dlg = dialog(
      t("addTitle"),
      [
        h("div", { class: "field" },
          h("label", { for: "add-id", text: t("fieldId") }),
          id,
          h("span", { class: "muted", text: t("fieldIdHint") })),
        h("div", { class: "field" },
          h("label", { for: "add-label", text: t("fieldLabel") }),
          label),
      ],
      [cancel, ok]
    );
    cancel.onclick = () => dlg.close();
    ok.onclick = async () => {
      const created = await run(() =>
        api("POST", "clients", { id: id.value.trim(), label: label.value })
      );
      if (created) {
        dlg.close();
        showQr(created.id);
      }
    };
    id.focus();
  };

  // ---- detail dialog -----------------------------------------------

  const kv = (rows) =>
    h("div", { class: "kv" }, rows.flatMap(([k, v]) => [h("div", { text: k }), h("div", {}, v)]));

  const counter = (label, value) =>
    h("div", { class: "counter" }, h("b", { text: value }), h("span", { class: "muted", text: label }));

  const overviewBody = (c, now) => {
    const k = c.counters;
    const out = [
      kv([
        [t("kvStatus"), chip(c.state)],
        [t("kvId"), c.id],
        [t("kvPhone"), c.phone ? "+" + c.phone : "–"],
        [t("kvAccount"), c.name || "–"],
        [t("kvSince"), c.connectedSince ? `${fmtDate(c.connectedSince)} (${duration(now - c.connectedSince)})` : "–"],
        [t("kvLastConnected"), fmtDate(c.lastConnected)],
        [t("kvLastActivity"), c.lastActivity ? fmtAgo(c.lastActivity, now) : t("never")],
        c.lastError ? [t("kvLastError"), c.lastError] : null,
      ].filter(Boolean)),
      h("div", { class: "counters" },
        counter(t("cToday"), `${k.todaySent} / ${k.todayIncoming}`),
        counter(t("cSent"), k.sent),
        counter(t("cIncoming"), k.incoming),
        counter(t("cFailed"), k.failed),
        counter(t("cDisconnects"), k.disconnects),
        counter(t("cReconnects"), k.reconnects)),
    ];
    if (c.inactivityWarning) {
      out.push(h("div", { class: "notice", text: t("inactive", { n: state.settings.inactivity_warning_days }) }));
    }
    const row = h("div", { class: "row" });
    if (c.state === "qr_required") {
      row.append(h("button", { class: "btn primary", text: t("showQr"), onclick: () => showQr(c.id) }));
    }
    if (c.enabled) {
      row.append(h("button", { class: "btn", text: t("reauth"), onclick: () => doReauth(c) }));
      if (c.state === "stopped") {
        row.append(h("button", { class: "btn", text: t("connect"), onclick: () => post(c, "connect") }));
      } else if (c.state !== "auth_invalid") {
        row.append(h("button", { class: "btn", text: t("disconnect"), onclick: () => post(c, "disconnect") }));
        row.append(h("button", { class: "btn", text: t("reconnect"), onclick: () => reconnect(c) }));
      }
    }
    out.push(row);
    return out;
  };

  const eventsBody = (events, now) =>
    events.length
      ? h("ul", { class: "list" },
          [...events].reverse().map((e) =>
            h("li", {},
              h("div", { class: "grow" },
                h("div", { text: `${e.type}${e.message ? " – " + e.message : ""}` }),
                h("div", { class: "mono", text: fmtDate(e.ts) })))))
      : h("p", { class: "muted", text: t("eventsNone") });

  const showDetail = async (id) => {
    if (detail) return;
    const c = find(id);
    if (!c) return;

    const panel = h("div", {});
    const tabs = h("div", { class: "tabs", role: "tablist" });
    const overview = h("div", {});
    const groupsBox = h("div", { hidden: true });
    const eventsBox = h("div", { hidden: true });
    const settingsBox = h("div", { hidden: true });
    const sections = { overview, groups: groupsBox, events: eventsBox, settings: settingsBox };
    const tabLabels = {
      overview: t("tabOverview"),
      groups: t("tabGroups"),
      events: t("tabEvents"),
      settings: t("tabSettings"),
    };
    const tabButtons = {};
    let groupsLoaded = false;

    const select = (tab) => {
      Object.entries(sections).forEach(([k, el]) => (el.hidden = k !== tab));
      Object.entries(tabButtons).forEach(([k, b]) => {
        b.classList.toggle("active", k === tab);
        b.setAttribute("aria-selected", String(k === tab));
      });
      if (tab === "groups" && !groupsLoaded) {
        groupsLoaded = true;
        loadGroups(false);
      }
    };
    Object.keys(sections).forEach((k) => {
      tabButtons[k] = h("button", { class: "tab", role: "tab", text: tabLabels[k], onclick: () => select(k) });
      tabs.append(tabButtons[k]);
    });

    // groups tab
    let groups = [];
    const groupSearch = h("input", {
      type: "search",
      placeholder: t("groupsSearch"),
      "aria-label": t("groupsSearch"),
      oninput: () => renderGroups(),
    });
    const groupList = h("div", {});
    const groupRefresh = h("button", { class: "btn", text: t("refresh"), onclick: () => loadGroups(true) });
    groupsBox.append(
      h("p", { class: "muted", text: t("groupsHint") }),
      h("div", { class: "row" }, groupSearch, groupRefresh),
      groupList
    );

    const renderGroups = () => {
      const q = groupSearch.value.trim().toLowerCase();
      const shown = groups.filter((g) => !q || g.subject.toLowerCase().includes(q) || g.id.includes(q));
      groupList.replaceChildren(
        shown.length
          ? h("ul", { class: "list" },
              shown.map((g) =>
                h("li", {},
                  h("div", { class: "grow" },
                    h("div", { text: g.subject || g.id }),
                    h("div", { class: "mono", text: `${g.id} · ${t("members", { n: g.participants })}` })),
                  h("button", { class: "btn", text: t("copy"), onclick: () => copyText(g.id) }))))
          : h("p", { class: "muted", text: t("groupsNone") })
      );
    };

    const loadGroups = async (refreshFlag) => {
      const cur = find(id);
      if (!cur || cur.state !== "connected") {
        groupList.replaceChildren(h("p", { class: "muted", text: t("groupsOffline") }));
        groupsLoaded = false;
        return;
      }
      groupList.replaceChildren(h("p", { class: "muted", text: "…" }));
      try {
        const res = await api("GET", `clients/${encodeURIComponent(id)}/groups${refreshFlag ? "?refresh=1" : ""}`);
        groups = res.groups;
        renderGroups();
      } catch (e) {
        groupsLoaded = false;
        groupList.replaceChildren(h("p", { class: "muted", text: t("failed", { msg: e.message }) }));
      }
    };

    // settings tab
    const labelInput = h("input", { type: "text", maxlength: "64", id: "set-label", value: c.label || "" });
    const enabledBox = h("input", {
      type: "checkbox",
      id: "set-enabled",
      checked: c.enabled,
      onchange: () => setEnabled(find(id), enabledBox.checked),
    });
    settingsBox.append(
      h("div", { class: "field" },
        h("label", { for: "set-label", text: t("settingsLabel") }),
        h("div", { class: "row" },
          labelInput,
          h("button", {
            class: "btn",
            text: t("save"),
            onclick: () =>
              run(() => api("PATCH", `clients/${encodeURIComponent(id)}`, { label: labelInput.value }), t("saved")),
          }))),
      h("div", { class: "switch-row" },
        enabledBox,
        h("label", { for: "set-enabled" },
          h("div", { text: t("settingsEnabled") }),
          h("div", { class: "muted", text: t("settingsEnabledHint") }))),
      h("h3", { text: t("dangerZone") }),
      h("div", { class: "row" },
        h("button", {
          class: "btn danger",
          text: t("remove"),
          onclick: async () => {
            if (await doRemove(find(id) || c)) dlg.close();
          },
        }))
    );

    panel.append(tabs, overview, groupsBox, eventsBox, settingsBox);
    const dlg = dialog(name(c), panel);
    select("overview");

    let busy = false;
    const update = async () => {
      if (busy) return;
      busy = true;
      try {
        const d = await api("GET", `clients/${encodeURIComponent(id)}`);
        const now = state ? state.service.now : Date.now();
        overview.replaceChildren(...overviewBody(d, now));
        eventsBox.replaceChildren(eventsBody(d.events, now));
        enabledBox.checked = d.enabled;
      } catch (e) {
        if (e.status === 404) dlg.close();
      } finally {
        busy = false;
      }
    };

    detail = { id, update };
    dlg.addEventListener("close", () => (detail = null));
    update();
  };

  // ---- main view ---------------------------------------------------

  const tile = (cls, num, label, extra) =>
    h("div", { class: "tile " + cls },
      h("div", { class: "num", text: num }),
      h("div", { class: "label", text: label }),
      extra ? h("div", { class: "extra muted", text: extra }) : null);

  const clientRow = (c, now) => {
    const primary =
      c.state === "qr_required"
        ? h("button", { class: "btn primary", text: t("showQr"), onclick: () => showQr(c.id) })
        : c.state === "auth_invalid"
        ? h("button", { class: "btn primary", text: t("reauth"), onclick: () => doReauth(c) })
        : null;

    const menuItems = [];
    if (c.enabled) {
      if (c.state === "stopped") menuItems.push([t("connect"), () => post(c, "connect")]);
      else if (c.state !== "auth_invalid") {
        menuItems.push([t("disconnect"), () => post(c, "disconnect")]);
        menuItems.push([t("reconnect"), () => reconnect(c)]);
      }
      menuItems.push([t("reauth"), () => doReauth(c)]);
    }
    menuItems.push([c.enabled ? t("disable") : t("enable"), () => setEnabled(c, !c.enabled)]);
    menuItems.push([t("remove"), () => doRemove(c), true]);

    const menuBtn = h("button", {
      class: "btn icon",
      "aria-label": "…",
      "aria-haspopup": "menu",
      text: "⋮",
    });
    const wrapper = h("div", { class: "actions" }, primary,
      h("button", { class: "btn", text: t("details"), onclick: () => showDetail(c.id) }), menuBtn);

    menuBtn.onclick = (ev) => {
      ev.stopPropagation();
      const had = openMenu && openMenu.owner === c.id;
      closeMenu();
      if (had) return;
      const menu = h("div", { class: "menu", role: "menu" },
        menuItems.map(([label, fn, danger]) =>
          h("button", {
            role: "menuitem",
            class: danger ? "danger" : "",
            text: label,
            onclick: () => {
              closeMenu();
              fn();
            },
          })));
      wrapper.append(menu);
      openMenu = { owner: c.id, el: menu };
    };

    const cell = (label, ...content) =>
      h("div", {}, h("div", { class: "cell-label", text: label }), ...content);

    return h("div", { class: "client", "data-id": c.id },
      cell(t("colName"),
        h("div", { class: "name", text: name(c) }),
        c.label ? h("div", { class: "muted", text: c.id }) : null),
      cell(t("colStatus"), chip(c.state),
        c.inactivityWarning ? h("div", { class: "muted", text: "⚠ " + t("inactive", { n: state.settings.inactivity_warning_days }) }) : null),
      cell(t("colPhone"), c.phone ? "+" + c.phone : "–"),
      cell(t("colActivity"), c.lastActivity ? fmtAgo(c.lastActivity, now) : "–"),
      cell(t("colMessages"), `↑ ${c.counters.todaySent}  ↓ ${c.counters.todayIncoming}`),
      wrapper);
  };

  const closeMenu = () => {
    if (openMenu) openMenu.el.remove();
    openMenu = null;
  };
  document.addEventListener("click", closeMenu);

  let searchInput = null;

  const render = () => {
    const app = document.getElementById("app");
    const s = state;
    const now = s.service.now;
    const tt = s.totals;

    // keep focus/value of the search field across re-renders
    const hadFocus = searchInput && document.activeElement === searchInput;

    searchInput = h("input", {
      type: "search",
      placeholder: t("searchClient"),
      "aria-label": t("searchClient"),
      value: filter,
      oninput: (e) => {
        filter = e.target.value;
        renderList();
      },
    });

    const list = h("div", { id: "client-list" });

    const renderList = () => {
      closeMenu();
      const q = filter.trim().toLowerCase();
      const shown = s.clients.filter((c) => !q || c.id.toLowerCase().includes(q) || (c.label || "").toLowerCase().includes(q) || (c.phone || "").includes(q));
      list.replaceChildren(
        ...(shown.length
          ? shown.map((c) => clientRow(c, now))
          : [h("p", { class: "muted", text: s.clients.length ? t("noMatch") : t("noClients") })])
      );
    };

    const statusBox = h("label", { class: "switch-row" },
      h("input", {
        type: "checkbox",
        checked: s.settings.receive_status,
        onchange: (e) => run(() => api("PUT", "settings", { receive_status: e.target.checked }), t("saved")),
      }),
      h("span", {}, h("div", { text: t("optStatus") }), h("div", { class: "muted", text: t("optStatusHint") })));

    const days = h("input", {
      type: "number",
      min: "0",
      max: "365",
      value: String(s.settings.inactivity_warning_days),
      "aria-label": t("optInactivity"),
      style: "width: 90px",
      onchange: (e) => run(() => api("PUT", "settings", { inactivity_warning_days: parseInt(e.target.value, 10) }), t("saved")),
    });

    const problemsCard = tt.problems.length
      ? h("section", { class: "card problems" },
          h("h2", { text: t("problemsTitle") }),
          tt.problems.map((p) => {
            const c = find(p.id);
            return h("div", { class: "problem" },
              h("div", {}, h("b", { text: p.label || p.id }), " ",
                p.state !== "connected" ? chip(p.state) : null,
                p.inactivityWarning ? h("span", { class: "muted", text: " ⚠ " + t("inactive", { n: s.settings.inactivity_warning_days }) }) : null,
                p.lastError ? h("span", { class: "muted", text: " · " + p.lastError }) : null),
              c && c.state === "qr_required"
                ? h("button", { class: "btn primary", text: t("showQr"), onclick: () => showQr(c.id) })
                : c && c.state === "auth_invalid"
                ? h("button", { class: "btn primary", text: t("reauth"), onclick: () => doReauth(c) })
                : null);
          }))
      : null;

    app.replaceChildren(...[
      h("div", { class: "header" },
        h("div", {}, h("h1", { text: t("title") }), h("div", { class: "sub", text: t("subtitle") })),
        h("div", { class: "chip-service" },
          h("b", { text: t("serviceRunning") }),
          h("span", { class: "muted", text: `${tt.clients === 1 ? t("clientsOne") : t("clientsN", { n: tt.clients })} · ${t("upFor", { t: duration(now - s.service.startedAt) })}` }))),
      h("div", { class: "tiles" },
        tile("", tt.clients, t("tileClients"), t("tileConnected", { n: tt.connected })),
        tile(tt.needsAuth ? "warn" : "", tt.needsAuth, t("tileNeedsAuth")),
        tile("", `↑ ${tt.todaySent}  ↓ ${tt.todayIncoming}`, t("tileToday"), `${t("sent")} / ${t("received")}`),
        tile("", `↑ ${tt.sent}  ↓ ${tt.incoming}`, t("tileTotal"), tt.failed ? t("tileFailed", { n: tt.failed }) : `${t("sent")} / ${t("received")}`),
        tile(tt.problems.length ? "err" : "", tt.problems.length, t("tileProblems"))),
      problemsCard,
      h("section", { class: "card" },
        h("div", { class: "toolbar" },
          h("h2", { text: t("clients") }),
          h("div", { class: "right" }, searchInput,
            h("button", { class: "btn primary", text: "+ " + t("addClient"), onclick: showAdd }))),
        h("div", { class: "clients-head" },
          h("div", { text: t("colName") }), h("div", { text: t("colStatus") }), h("div", { text: t("colPhone") }),
          h("div", { text: t("colActivity") }), h("div", { text: t("colMessages") }), h("div")),
        list),
      h("section", { class: "card" },
        h("h2", { text: t("globalSettings") }),
        statusBox,
        h("div", { class: "field" },
          h("label", { text: t("optInactivity") }),
          days,
          h("span", { class: "muted", text: t("optInactivityHint") })))
    ].filter(Boolean));
    renderList();
    if (hadFocus) searchInput.focus();
  };

  // ---- polling -----------------------------------------------------

  let loading = false;
  let lastSig = "";
  let lastRender = 0;
  const refresh = async () => {
    if (loading) return;
    loading = true;
    try {
      state = await api("GET", "state");
      // Rebuild the page only when something changed (or the relative times
      // need a refresh), never while a dialog or menu is open, so clicks are
      // not lost to a re-render.
      const sig = JSON.stringify([state.clients, state.totals, state.settings]);
      const stale = Date.now() - lastRender > 30000;
      const busy = document.querySelector("dialog[open]") || openMenu;
      if (!document.getElementById("client-list") || (!busy && (sig !== lastSig || stale))) {
        lastSig = sig;
        lastRender = Date.now();
        render();
      }
      if (qrDlg) qrDlg.update();
      if (detail) detail.update();
    } catch (e) {
      if (!state) {
        document.getElementById("app").replaceChildren(
          h("p", { class: "muted", text: t("loadError", { msg: e.message }) })
        );
      }
    } finally {
      loading = false;
    }
  };

  document.body.append(h("div", { id: "toasts" }));
  refresh();
  setInterval(() => {
    if (!document.hidden) refresh();
  }, 3000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
})();
