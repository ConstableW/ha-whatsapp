# Home Assistant Add-on: Whatsapp add-on

**Forked from [giuseppecastaldo/ha-addons](https://github.com/giuseppecastaldo/ha-addons/tree/main/whatsapp_addon)  
Maintained by [ConstableW/ha-whatsapp](https://github.com/ConstableW/ha-whatsapp/tree/main/whatsapp_addon)**

## How to use

### **How to add other Whatsapp sessions**

Go to configuration page in clients input box digit the desired clientId. This one represents an identifier for the session.

### **How to get a User ID**

The user id is made from three parts:

- Country code (Example 39 (Italy))
- User's number
- And a static part: @s.whatsapp.net (for users) @g.us (for groups)

For example for Italian number _3456789010_ the user id is the following _393456789010@s.whatsapp.net_

### **Send a simple text message**

```yaml
service: whatsapp.send_message
data:
clientId: default
to: 391234567890@s.whatsapp.net
body: Hi, it's a simple text message
```

### **How to send an image**

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

### **How to send audio message**

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

### **How to send a location**

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

### **How to subscribe to presence update**

```yaml
service: whatsapp.presence_subscribe
data:
clientId: default
userId: 391234567890@s.whatsapp.net
```

---

## Events

| Event type               | Description                           |
| ------------------------ | ------------------------------------- |
| new_whatsapp_message     | The message that was received         |
| whatsapp_presence_update | Presence of contact in a chat updated |

---

## **Sample automations**

## Ping Pong

```yaml
alias: Ping Pong
description: ""
trigger:

platform: event
event_type: new_whatsapp_message
condition:

condition: template
value_template: "{{ trigger.event.data.message.conversation == '!ping' }}"
action:

service: whatsapp.send_message
data:
clientId: default
to: "{{ trigger.event.data.key.remoteJid }}"
body: pong
mode: single
```

## Arrive at home

```yaml
alias: Arrive at home
description: ""
trigger:

platform: device
domain: device_tracker
entity_id: device_tracker.iphone_13_pro
type: enter
zone: zone.home
condition: []
action:

service: whatsapp.send_message
data:
clientId: default
to: 391234567890@s.whatsapp.net
body: Hi, I'm at home
mode: single
```

## Driving mode

```yaml
alias: Driving mode
description: ""
trigger:

platform: event
event_type: new_whatsapp_message
condition: []
action:

service: whatsapp.send_message
data:
clientId: "{{ trigger.event.data.clientId }}"
to: "{{ trigger.event.data.key.remoteJid }}"
body: Sorry, I'm driving, I will contact you soon
options:
quoted: "{{ trigger.event.data }}" # Quote message
mode: single
```

## Message reaction

```yaml
alias: React to message
description: ""
trigger:

platform: event
event_type: new_whatsapp_message
condition: []
action:

service: whatsapp.send_message
data:
clientId: "{{ trigger.event.data.clientId }}"
to: "{{ trigger.event.data.key.remoteJid }}"
body:
react:
text: "👍🏻" # Use an empty string to remove the reaction
key: "{{ trigger.event.data.key }}"
mode: single
```

## Presence notify (SUBSCRIBE FIRST!)

```yaml
alias: Presence notify
description: ""
trigger:

platform: event
event_type: whatsapp_presence_update
event_data: {}
condition:

condition: template
value_template:
"{{ trigger.event.data.presences['391234567890@s.whatsapp.net'].lastKnownPresence == 'available' }}"
action:

service: persistent_notification.create
data:
message: Contact is online!
mode: single
```
## Support & Issues

For support, feature requests or bug reports, please visit the [GitHub repository](https://github.com/ConstableW/ha-whatsapp/tree/main/whatsapp_addon).

---

**Thank you for using this add-on!**  
If you have any questions or suggestions, feel free to open an issue on GitHub.
