import requests
from requests.exceptions import RequestException

HOST = 'http://1ffb9e7b-whatsapp-addon:3000/' 

class Whatsapp:
    def _post(self, endpoint, data):
        url = f"{HOST.rstrip('/')}/{endpoint.lstrip('/')}"
        try:
            response = requests.post(url, json=data)
            response.raise_for_status()  # wirft Exception bei Fehlercode >= 400
            return response.text.strip() == 'OK'
        except RequestException as e:
            print(f"Error calling {url}: {e}")
            return False

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
