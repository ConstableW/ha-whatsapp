## 1.6.0

 - Integrated Baileys library as an npm dependency and removed the local copy.
 - Messaging to WhatsApp groups (@g.us) works again.
 - Fix based on community insights from GitHub Issue #113 and tips by @ShaylenIT & @arormoser.

## 1.5.6

 - Updated event handling for new_whatsapp_message

## 1.5.5

 - Extended logging.

## 1.5.4

 - Corrected & Extended Readme.
 - Extended the docs.md.
   
## 1.5.3

 - Several code changes;
 
## 1.5.2

 - Updated local Baileys.

## 1.5.1

 - Updated config.yaml.
 - Updated index.js.
 - Fix based on community insights from GitHub Issue #113 and tips by @ShaylenIT & @arormoser.


## 1.5.0

- Updated whatsapp library
- Updated docker base image

## 1.4.1

- Bug QR-Code fixed

## 1.4.0

- Updated whatsapp library
- Changed session saving method
- Special functions such as sending buttons, sending lists, etc., are no longer available.

## 1.3.5

- Revert [(Pull request)](https://github.com/giuseppecastaldo/ha-addons/pull/33)

## 1.3.4

- Bug fixed [(Pull request)](https://github.com/giuseppecastaldo/ha-addons/pull/33)
- Bug fixed [(Pull request)](https://github.com/giuseppecastaldo/ha-addons/pull/55)

## 1.3.3

- Added donation button.

## 1.3.2

- Bug fixed.

## 1.3.0

- Bug fixed.

## 1.2.4

- Bug fixed.
- Added patch for receive button on iOS (Attention! iOS receive buttons only if app is open (it seems to be a iOS app bug))

## 1.2.2

- Added the ability to always be online or offline. This could lead to not receiving notifications on other devices. (**Restard required**)
- Bug fixed.

## 1.2.1

- Fixed bug that did not allow the reception of push notifications on other devices.
- Added event presence update.
- Added two more services like subscribe presence and send presence update.

## 1.2.0

- **Changed radically command and events. Please refer to doc and developer tools for change your automations.**
- **Performance boost! (Required re-authentication)**
- Bug fixed on send location.
- Bug fixed on send mulitple buttons.

## 1.1.2

- Bug fixed.
- Performance improvements.

## 1.1.1

- Migration from Home Assistant base image to Debian image

## 1.1.0

- Added the ability to manage multiple whatsapp sessions (re-authentication required)
- Buttons bug fixed (better visibility on android devices)
- Message options bug fixed
- Bug fixed.

**NOTE:** If you have problems with the custom components being updated, please follow this steps:

- Remove Whatsapp configuration in _configuration.yaml_
- Restart Home Assistant
- Add Whatsapp configuration in _configuration.yaml_
- Restart Home Assistant

## 1.0.2

- Addedd message revoke event.
- Added buttons message type (view documentation) (may not work properly on some devices)
- Added set status service (for sets the current user's status message)
- Bug fixed.

## 1.0.1

- Initial release
