# Home Assistant Add-on: Whatsapp add-on

**Forked from [giuseppecastaldo/ha-addons](https://github.com/giuseppecastaldo/ha-addons/tree/main/whatsapp_addon)
Maintained by [ConstableW/ha-whatsapp](https://github.com/ConstableW/ha-whatsapp/tree/main/whatsapp_addon)**

## How to use

### How to add other Whatsapp sessions

Go to the configuration page and add the desired `clientId` to the clients input box. It is the identifier of the session and is used in every service call and event.

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

Protocol and key-distribution messages (no user content) are never forwarded.

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
