#!/usr/bin/env python3
"""Address -> (lat, lng) via OpenStreetMap Nominatim (free, keyless).

Used once per client location when it's saved; results are cached in the
client_locations table, so we never re-geocode an unchanged address. Nominatim's
usage policy requires an identifying User-Agent and caps at ~1 request/second — both
trivially satisfied at our volume (a handful of static store addresses)."""
import json
import urllib.parse
import urllib.request

NOMINATIM = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "SearchNexInsights/1.0 (map geocoding; ci@chazif.com)"


def geocode(address: str):
    """Return (lat, lng) floats for the address, or None if it can't be resolved."""
    if not address or not address.strip():
        return None
    query = urllib.parse.urlencode({"q": address.strip(), "format": "json", "limit": 1})
    req = urllib.request.Request(f"{NOMINATIM}?{query}", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.load(resp)
    except Exception:
        return None
    if not data:
        return None
    try:
        return float(data[0]["lat"]), float(data[0]["lon"])
    except (KeyError, ValueError, TypeError, IndexError):
        return None
