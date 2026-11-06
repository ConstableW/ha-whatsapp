import logging
from urllib.parse import unquote

import requests
from requests.exceptions import RequestException

from homeassistant.exceptions import HomeAssistantError

_LOGGER = logging.getLogger(__name__)

# {{HOSTNAME}} is replaced with the add-on hostname by run.sh at startup
HOST = 'http://{{HOSTNAME}}:3000/'


class WhatsappError(HomeAssistantError):
    """Raised when the WhatsApp add-on rejects or cannot execute a call."""


class Whatsapp:
    def _post(self, endpoint, data, want_json=False):
        url = f"{HOST.rstrip('/')}/{endpoint.lstrip('/')}"
        try:
            response = requests.post(url, json=dict(data), timeout=30)
        except RequestException as err:
            raise WhatsappError(
                f"WhatsApp add-on is not reachable ({endpoint}): {err}"
            ) from err

        if want_json and response.status_code < 400:
            try:
                return response.json()
            except ValueError as err:
                raise WhatsappError(f"WhatsApp {endpoint} returned invalid data") from err

        if response.status_code < 400 and response.text.strip() == 'OK':
            return True

        reason = unquote(response.headers.get('X-Whatsapp-Error', '')) or response.text.strip()
        _LOGGER.error("WhatsApp %s failed (HTTP %s): %s", endpoint, response.status_code, reason)
        raise WhatsappError(f"WhatsApp {endpoint} failed: {reason or 'unknown error'}")

    def send_message(self, data):
        return self._post('sendMessage', data)

    def set_status(self, data):
        return self._post('setStatus', data)

    def presence_subscribe(self, data):
        return self._post('presenceSubscribe', data)

    def send_presence_update(self, data):
        return self._post('sendPresenceUpdate', data)

    def send_infinity_presence_update(self, data):
        return self._post('sendInfinityPresenceUpdate', data)

    def get_groups(self, data):
        return self._post('getGroups', data, want_json=True)
