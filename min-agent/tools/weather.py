"""Weather lookup. Mock unless WEATHER_API_KEY is set; failures fall back to mock.

The key is read from the environment only. Exception text is not returned: urllib
errors can include the request URL, and that URL contains the key.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from tools.registry import Tool, object_schema

_OPENWEATHER_URL = "https://api.openweathermap.org/data/2.5/weather"
_TIMEOUT_SECONDS = 5


def weather(city: str) -> dict[str, Any]:
    if not isinstance(city, str) or not city.strip():
        raise ValueError("city is required")
    city = city.strip()
    api_key = os.environ.get("WEATHER_API_KEY", "").strip()
    if not api_key:
        return _mock(city, "WEATHER_API_KEY is unset")
    try:
        return _fetch_openweather(city, api_key)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, KeyError, ValueError):
        return _mock(city, "weather request failed")


def _fetch_openweather(city: str, api_key: str) -> dict[str, Any]:
    query = urllib.parse.urlencode({"q": city, "appid": api_key, "units": "metric"})
    request = urllib.request.Request(
        f"{_OPENWEATHER_URL}?{query}",
        headers={"User-Agent": "min-agent"},
    )
    with urllib.request.urlopen(request, timeout=_TIMEOUT_SECONDS) as response:
        payload = json.loads(response.read().decode("utf-8"))
    description = payload["weather"][0]["description"]
    temp = payload["main"]["temp"]
    name = str(payload.get("name") or city)
    return {
        "city": name,
        "source": "openweathermap",
        "temp_c": temp,
        "summary": f"{name}: {temp}°C, {description}.",
    }


def _mock(city: str, note: str) -> dict[str, Any]:
    return {
        "city": city,
        "source": "mock",
        "temp_c": 18,
        "summary": f"Mock weather for {city}: 18°C, partly cloudy.",
        "note": note,
    }


WEATHER = Tool(
    name="weather",
    description=(
        "Current weather for a city. Calls OpenWeatherMap when WEATHER_API_KEY is set. "
        "Returns a mock forecast when the key is missing or the request fails."
    ),
    parameters=object_schema(
        {
            "city": {"type": "string", "description": "City name, such as Lisbon."},
        },
        ["city"],
    ),
    handler=weather,
)
