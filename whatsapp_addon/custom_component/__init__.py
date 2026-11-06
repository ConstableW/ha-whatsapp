from __future__ import annotations

import logging

import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from .whatsapp import Whatsapp

DOMAIN = "whatsapp"
_LOGGER = logging.getLogger(__name__)

# Unknown extra keys are allowed so existing automations keep working.
_BASE = {vol.Required("clientId"): cv.string}

SEND_MESSAGE_SCHEMA = vol.Schema(
    {
        **_BASE,
        vol.Required("to"): cv.string,
        vol.Required("body"): vol.Any(cv.string, dict),
        vol.Optional("options"): dict,
    },
    extra=vol.ALLOW_EXTRA,
)

SET_STATUS_SCHEMA = vol.Schema(
    {**_BASE, vol.Required("status"): cv.string},
    extra=vol.ALLOW_EXTRA,
)

# `userId` is the legacy name of `to` and is still accepted.
PRESENCE_SUBSCRIBE_SCHEMA = vol.All(
    vol.Schema(
        {
            **_BASE,
            vol.Exclusive("to", "target"): cv.string,
            vol.Exclusive("userId", "target"): cv.string,
        },
        extra=vol.ALLOW_EXTRA,
    ),
    cv.has_at_least_one_key("to", "userId"),
)

PRESENCE_UPDATE_SCHEMA = vol.Schema(
    {
        **_BASE,
        vol.Required("type"): vol.In(
            ["unavailable", "available", "composing", "recording", "paused"]
        ),
        vol.Optional("to"): cv.string,
    },
    extra=vol.ALLOW_EXTRA,
)


GET_GROUPS_SCHEMA = vol.Schema(
    {**_BASE, vol.Optional("refresh"): cv.boolean},
    extra=vol.ALLOW_EXTRA,
)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    whatsapp = Whatsapp()

    def _handler(method):
        async def handler(call: ServiceCall) -> None:
            # Raises WhatsappError (a HomeAssistantError) if the add-on reports a failure.
            await hass.async_add_executor_job(method, dict(call.data))

        return handler

    hass.services.async_register(
        DOMAIN, "send_message", _handler(whatsapp.send_message), schema=SEND_MESSAGE_SCHEMA
    )
    hass.services.async_register(
        DOMAIN, "set_status", _handler(whatsapp.set_status), schema=SET_STATUS_SCHEMA
    )
    hass.services.async_register(
        DOMAIN,
        "presence_subscribe",
        _handler(whatsapp.presence_subscribe),
        schema=PRESENCE_SUBSCRIBE_SCHEMA,
    )
    hass.services.async_register(
        DOMAIN,
        "send_presence_update",
        _handler(whatsapp.send_presence_update),
        schema=PRESENCE_UPDATE_SCHEMA,
    )
    hass.services.async_register(
        DOMAIN,
        "send_infinity_presence_update",
        _handler(whatsapp.send_infinity_presence_update),
        schema=PRESENCE_UPDATE_SCHEMA,
    )

    async def get_groups(call: ServiceCall) -> dict:
        return await hass.async_add_executor_job(whatsapp.get_groups, dict(call.data))

    hass.services.async_register(
        DOMAIN,
        "get_groups",
        get_groups,
        schema=GET_GROUPS_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )

    return True
