# Testing the client management

Automated tests (no WhatsApp or Home Assistant needed):

```bash
cd whatsapp_addon
npm ci
npm test
```

They cover the option store (legacy options, labels, supervisor write), statistics, the client manager lifecycle with fake clients (pairing, logout, re-authentication of one client while others run, removal, restart recovery) and the HTTP layer (ingress protection, unchanged service endpoints, admin API).

`node scripts/dev-ui.js` starts the panel against fake clients on <http://localhost:3100>.

## What only a real installation can verify

Run these in Home Assistant after updating the add-on (and restarting Home Assistant Core, so the updated custom component is loaded).

1. **Migration without re-pairing** – Update an installation that already has a paired `default` client. The client must connect without a QR code and appear in the WhatsApp panel with its phone number.
2. **Several clients** – Add a second client in the panel, scan its QR code, then send a message through each client (`whatsapp.send_message` with the respective `clientId`).
3. **Re-authentication does not disturb others** – Re-authenticate the second client. The first client must stay connected and keep sending messages.
4. **Restart** – Restart the add-on. All clients reconnect without a QR code, and the counters and event log are still there.
5. **Removal sticks** – Remove the second client, restart the add-on: it must not come back, and the linked device must be gone from the phone's "Linked devices" list.
6. **Network interruption** – Disconnect the network (or stop the router) for a minute. The state changes to _temporarily disconnected / reconnecting_, the "connection losses" and "reconnect attempts" counters increase, and the client reconnects on its own. **Real logout:** remove the linked device on the phone. The client must switch to _authentication invalid_, create a notification and **not** start a new QR pairing by itself.
7. **Access only through the panel** – Open `http://<ha-host>:3000/` and `/admin/api/state` directly (if the port is reachable): both must answer 403. Services (`whatsapp.send_message`) must keep working.
8. **Configuration page** – After adding/renaming/disabling clients in the panel, open the add-on's *Configuration* tab: `clients`, `disabled_clients` and `client_labels` must match. If saving fails the panel shows an error and nothing changes.
9. **Status filter and groups** – Post a WhatsApp status from another phone: no `new_whatsapp_message` event. Send a message to a group: the event has `groupName`. `whatsapp.get_groups` returns the groups.
10. **Failed service call** – Call `whatsapp.send_message` with an unknown `clientId`: the call fails with an error in Home Assistant.
