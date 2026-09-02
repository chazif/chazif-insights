"""Best-effort pull of a client's campaign geo-targeting for the Map overlay.

Design goal: SELF-ACTIVATING and SAFE. When the Google Ads API is reachable and the
client has a customer id, this returns the campaigns' proximity (radius) and location
targets. On ANY problem — credentials not set, no customer id, unreachable account, API
error, or simply no targets — it returns an empty list with available=False. The caller
(the /geo-targets route) and the map treat that as 'no overlay', so nothing breaks and the
feature lights up on its own the moment a live account is connected.

Nothing here is imported at app start beyond this module; the Google Ads client is built
lazily and every network step is wrapped, so a missing prod dependency can't affect the
rest of the app.
"""
from .client import GoogleAdsApiClient, credentials_configured

# Enabled campaigns' non-negative location + proximity criteria.
_QUERY = (
    "SELECT campaign.name, campaign_criterion.type, "
    "campaign_criterion.proximity.geo_point.latitude_in_micro_degrees, "
    "campaign_criterion.proximity.geo_point.longitude_in_micro_degrees, "
    "campaign_criterion.proximity.radius, campaign_criterion.proximity.radius_units, "
    "campaign_criterion.location.geo_target_constant "
    "FROM campaign_criterion "
    "WHERE campaign.status = 'ENABLED' AND campaign_criterion.negative = FALSE "
    "AND campaign_criterion.type IN ('PROXIMITY', 'LOCATION')"
)
_NAME_QUERY = (
    "SELECT geo_target_constant.resource_name, geo_target_constant.name, "
    "geo_target_constant.canonical_name FROM geo_target_constant "
    "WHERE geo_target_constant.resource_name IN ({names})"
)
_MILES_TO_M = 1609.34
_KM_TO_M = 1000.0


def pull_geo_targets(client, api=None):
    """Return {"targets": [...], "available": bool}. Never raises."""
    cid = (client or {}).get("google_customer_id")
    if not cid or not credentials_configured():
        return {"targets": [], "available": False}
    try:
        api = api or GoogleAdsApiClient.from_env()
    except Exception:
        return {"targets": [], "available": False}

    targets = []
    loc_needed = {}  # geo_target_constant resource -> set(campaign names)
    try:
        for r in api.stream(cid, _QUERY):
            camp = r.get("campaign.name")
            ctype = str(r.get("campaign_criterion.type") or "").upper()
            if ctype == "PROXIMITY":
                lat = r.get("campaign_criterion.proximity.geo_point.latitude_in_micro_degrees")
                lng = r.get("campaign_criterion.proximity.geo_point.longitude_in_micro_degrees")
                radius = r.get("campaign_criterion.proximity.radius")
                units = str(r.get("campaign_criterion.proximity.radius_units") or "").upper()
                if lat is None or lng is None or radius is None:
                    continue
                radius_m = float(radius) * (_MILES_TO_M if units.startswith("MILE") else _KM_TO_M)
                targets.append({"campaign": camp, "type": "radius",
                                "lat": lat / 1e6, "lng": lng / 1e6, "radius_m": round(radius_m)})
            elif ctype == "LOCATION":
                gtc = r.get("campaign_criterion.location.geo_target_constant")
                if gtc:
                    loc_needed.setdefault(gtc, set()).add(camp)
    except Exception:
        # Return whatever radii we already collected — partial success beats nothing.
        return {"targets": targets, "available": bool(targets)}

    # Resolve location-target names (best-effort; failure just omits location outlines).
    if loc_needed:
        try:
            names = _resolve_names(api, cid, list(loc_needed))
            for gtc, camps in loc_needed.items():
                nm = names.get(gtc)
                if not nm:
                    continue
                for camp in camps:
                    targets.append({"campaign": camp, "type": "location", "name": nm})
        except Exception:
            pass
    return {"targets": targets, "available": True}


def _resolve_names(api, cid, resources):
    """geo_target_constant resource names -> a plain place name (best match)."""
    quoted = ", ".join("'" + str(x).replace("'", "") + "'" for x in resources)
    out = {}
    for r in api.stream(cid, _NAME_QUERY.format(names=quoted)):
        res = r.get("geo_target_constant.resource_name")
        name = r.get("geo_target_constant.name") or r.get("geo_target_constant.canonical_name")
        if res and name:
            out[res] = name
    return out
