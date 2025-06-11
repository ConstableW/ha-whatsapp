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

## Usage in Node-RED

To send WhatsApp messages from Node-RED, you can use the following flow as a template.  
Replace `1234567890-987654321@g.us` with your actual group or user ID.



```yaml

[
{
"id": "node1",
"type": "function",
"name": "Set WhatsApp Params",
"func": "msg.env = {\n to: "1234567890-987654321@g.us",\n text: "Hello from Node-RED!"\n};\nreturn msg;",
"outputs": 1,
"wires": [["node2"]]
},
{
"id": "node2",
"type": "api-call-service",
"name": "Send WhatsApp",
"server": "server1",
"data": "{"clientId": "default", "to": $env('to'), "body": $env('text')}",
"dataType": "jsonata",
"domain": "whatsapp",
"service": "send_message",
"wires": []
}
]


```


**How to use:**
1. **Import the flow** into Node-RED via the menu: *Import → Clipboard*.
2. **Replace** `1234567890-987654321@g.us` with your actual group or user ID.
3. **Adjust** the message text as needed.


Key Features:
Environment Variables:

to: Target group/user ID (e.g., 1234567890-123456789@g.us)

text: Message content

Usage:

```yaml

// In function node:
msg.env = {
    to: "1234567890-123456789@g.us", 
    text: "Sensor value: {{ states('sensor.temperature') }}"
};
return msg;

```
Setup Steps:
Import Flow:
Copy the JSON above and import via Node-RED Menu → Import → Clipboard.

Configure:

Replace all 1234567890-... IDs with your actual WhatsApp group/user IDs

Adapt environment variables as needed

Note: The flow uses JSONata expressions to reference environment variables directly in the service call.


## Support & Issues

For support, feature requests or bug reports, please visit the [GitHub repository](https://github.com/ConstableW/ha-whatsapp/tree/main/whatsapp_addon).

---

**Thank you for using this add-on!**  
If you have any questions or suggestions, feel free to open an issue on GitHub.
