# Home Assistant Add-on: Whatsapp add-on

**Forked from [giuseppecastaldo/ha-addons](https://github.com/giuseppecastaldo/ha-addons/tree/main/whatsapp_addon)
Maintained by [ConstableW/ha-whatsapp](https://github.com/ConstableW/ha-whatsapp/tree/main/whatsapp_addon)**

## How to use

### WhatsApp panel (client management)

The add-on adds a **WhatsApp** entry to the Home Assistant sidebar (Ingress, administrators only). There you can

- see all clients with their real connection state, phone number, last activity and message counters,
- add, rename, enable/disable, connect/disconnect and remove clients without restarting the add-on,
- pair a client with a QR code dialog and re-authenticate it while the other clients keep running,
- list the groups a client is a member of (with group ID to copy),
- read a small event log per client (connects, connection losses, logouts, failed sends),
- change the general settings (status updates, inactivity warning).

Client states: connected, connecting, temporarily disconnected, reconnecting, QR pairing required, authentication invalid, disabled, disconnected (manual).
They are derived from the actual WhatsApp connection events. The panel never shows a made-up session expiry.
If WhatsApp logs a session out (for example the device was removed on the phone or the phone was offline for too long) the client switches to _authentication invalid_ and stays there until you use **Re-authenticate**. A persistent notification is created as well.

Counters (received, sent, failed sends, connection losses, reconnect attempts) are stored persistently in `/data/stats.json`. Only numbers and timestamps are stored, never message contents. "Sent" counts messages sent through the add-on.

The client list is stored in the add-on configuration (`clients`, `disabled_clients`, `client_labels`). Changes in the panel are written there, so the configuration page always shows the same clients. Existing installations need no migration and do not have to pair again.

**Security:** the panel and its API (`/admin/...`) only accept connections coming from the Home Assistant Supervisor ingress proxy, i.e. after a Home Assistant login. The service endpoints used by the Home Assistant services stay reachable inside the internal add-on network as before.

### How to add other Whatsapp sessions

Use **Add client** in the WhatsApp panel (or add the ID to `clients` in the configuration). The `clientId` is used in every service call and event and cannot be changed later; the display name can.

### How to get a User ID

The user id is made from three parts:

- Country code (Example 39 (Italy))
- User's number
- And a static part: `@s.whatsapp.net` (for users) `@g.us` (for groups)

For example for Italian number _3456789010_ the user id is _393456789010@s.whatsapp.net_

### Options

| Option           | Description                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `clients`        | List of session IDs.                                                                                                              |
| `receive_status` | Default `false`. WhatsApp status updates (stories) are **not** forwarded as `new_whatsapp_message`. Set to `true` to receive them. |
| `disabled_clients`, `client_labels` | Managed by the WhatsApp panel (disabled clients, display names as `id=Name`). |
| `inactivity_warning_days` | Default `14`. The panel warns when a client had no connection for this many days. `0` turns it off. |

Protocol and key-distribution messages (no user content) are never forwarded.

### Group messages

For messages from a group the `new_whatsapp_message` event contains an additional field `groupName` with the name of the group (`trigger.event.data.groupName`). `key.remoteJid` is the group ID (`...@g.us`).

### List groups

```yaml
service: whatsapp.get_groups
data:
  clientId: default
response_variable: groups
# groups.groups -> [{ id: "1203...@g.us", subject: "Family", participants: 5 }]
```

### Errors

If the add-on cannot execute a service call (client not found, disconnected, number not on WhatsApp, ...), the Home Assistant service call **fails with an error message**. Use `continue_on_error: true` in automations or the error output in Node-RED to react to it.

### Send a simple text message

```yaml
service: whatsapp.send_message
data:
  clientId: default
  to: 391234567890@s.whatsapp.net
  body: Hi, it's a simple text message
```

`body` may also be an object, e.g. `body: { text: "Hi" }`. A plain string is shorthand for `{ text: ... }`.

### How to send an image

`caption` is a sibling of `image`, not part of it.

```yaml
service: whatsapp.send_message
data:
  clientId: default
  to: 391234567890@s.whatsapp.net
  body:
    image:
      url: "https://dummyimage.com/600x400/000/fff.png"
    caption: Simple text
```

The add-on downloads the image itself, so the URL must be reachable from the add-on container.
A local file below `/media` works as well, e.g. `url: /media/picture.jpg`.

### How to send audio message

```yaml
service: whatsapp.send_message
data:
  clientId: default
  to: 391234567890@s.whatsapp.net
  body:
    audio:
      url: "https://github.com/giuseppecastaldo/ha-addons/blob/main/whatsapp_addon/examples/hello_world.mp3?raw=true"
    ptt: true # Send audio as a voice
```

### How to send a location

```yaml
service: whatsapp.send_message
data:
  clientId: default
  to: 391234567890@s.whatsapp.net
  body:
    location:
      degreesLatitude: 24.121231
      degreesLongitude: 55.1121221
```

### How to subscribe to presence update

```yaml
service: whatsapp.presence_subscribe
data:
  clientId: default
  to: 391234567890@s.whatsapp.net
```

`userId` is still accepted instead of `to`.

---

## Events

| Event type               | Description                           |
| ------------------------ | ------------------------------------- |
| new_whatsapp_message     | The message that was received         |
| whatsapp_presence_update | Presence of contact in a chat updated |

---

## Sample automations

### Ping Pong

```yaml
alias: Ping Pong
description: ""
trigger:
  - platform: event
    event_type: new_whatsapp_message
condition:
  - condition: template
    value_template: "{{ trigger.event.data.message.conversation == '!ping' }}"
action:
  - service: whatsapp.send_message
    data:
      clientId: default
      to: "{{ trigger.event.data.key.remoteJid }}"
      body: pong
mode: single
```

### Driving mode

```yaml
alias: Driving mode
description: ""
trigger:
  - platform: event
    event_type: new_whatsapp_message
condition: []
action:
  - service: whatsapp.send_message
    data:
      clientId: "{{ trigger.event.data.clientId }}"
      to: "{{ trigger.event.data.key.remoteJid }}"
      body: Sorry, I'm driving, I will contact you soon
      options:
        quoted: "{{ trigger.event.data }}" # Quote message
mode: single
```

### Message reaction

```yaml
alias: React to message
description: ""
trigger:
  - platform: event
    event_type: new_whatsapp_message
condition: []
action:
  - service: whatsapp.send_message
    data:
      clientId: "{{ trigger.event.data.clientId }}"
      to: "{{ trigger.event.data.key.remoteJid }}"
      body:
        react:
          text: "👍🏻" # Use an empty string to remove the reaction
          key: "{{ trigger.event.data.key }}"
mode: single
```

### Presence notify (SUBSCRIBE FIRST!)

```yaml
alias: Presence notify
description: ""
trigger:
  - platform: event
    event_type: whatsapp_presence_update
    event_data: {}
condition:
  - condition: template
    value_template: "{{ trigger.event.data.presences['391234567890@s.whatsapp.net'].lastKnownPresence == 'available' }}"
action:
  - service: persistent_notification.create
    data:
      message: Contact is online!
mode: single
```

## Usage in Node-RED

Use a `call service` node (`whatsapp.send_message`) with a JSONata data field:

```json
{
  "clientId": "default",
  "to": $exists(to) ? to : $env("to"),
  "body": { "text": payload }
}
```

Image with caption:

```json
{
  "clientId": "default",
  "to": $env("to"),
  "body": {
    "image": { "url": $env("image") },
    "caption": $env("caption")
  }
}
```

## Support & Issues

For support, feature requests or bug reports, please visit the [GitHub repository](https://github.com/ConstableW/ha-whatsapp/tree/main/whatsapp_addon).

---

**Thank you for using this add-on!**
