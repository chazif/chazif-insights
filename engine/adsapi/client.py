"""Thin Google Ads API client: builds a GoogleAdsClient from environment variables and
streams GAQL results as flattened {gaql_path: primitive} dicts (enums reduced to their
name), ready for reports.convert_row().

SECURITY: every credential is read ONLY from an environment variable (CRED_ENV). Nothing
here writes a secret to disk, the database, a log line, or a raised error message — an
error names the missing ENV VARIABLE, never a value. The `google-ads` package is imported
lazily inside from_env() so importing this module (and running the test suite) needs neither
the library nor any credentials.
"""
import os
import re

# credential key -> environment variable it is read from. These are set ONLY in Railway's
# environment for the API-sync service; they are never committed or logged.
CRED_ENV = {
    "developer_token": "GOOGLE_ADS_DEVELOPER_TOKEN",
    "client_id": "GOOGLE_ADS_CLIENT_ID",
    "client_secret": "GOOGLE_ADS_CLIENT_SECRET",
    "refresh_token": "GOOGLE_ADS_REFRESH_TOKEN",
    "login_customer_id": "GOOGLE_ADS_LOGIN_CUSTOMER_ID",   # the MCC / manager account id
}


def missing_credentials():
    """Environment-variable NAMES that are unset/empty (never returns any value)."""
    return [env for env in CRED_ENV.values() if not os.environ.get(env)]


def credentials_configured():
    return not missing_credentials()


def _digits(v):
    return re.sub(r"\D", "", str(v or ""))


def _coerce(v):
    """API field value -> JSON-ish primitive. Protobuf enums become their name (e.g. SEARCH)."""
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    name = getattr(v, "name", None)     # proto-plus enum
    return name if name is not None else str(v)


def _paths_from_query(query):
    m = re.search(r"select\s+(.*?)\s+from\s", query, re.I | re.S)
    return [p.strip() for p in m.group(1).split(",")] if m else []


def _flatten(row, paths):
    out = {}
    for p in paths:
        obj = row
        for part in p.split("."):
            obj = getattr(obj, part, None)
            if obj is None:
                break
        out[p] = _coerce(obj)
    return out


class GoogleAdsApiClient:
    """Wraps a GoogleAdsClient. Inject a fake in tests; use from_env() in production."""

    def __init__(self, client):
        self._client = client

    @classmethod
    def from_env(cls):
        missing = missing_credentials()
        if missing:
            raise RuntimeError("Google Ads API not configured; set env vars: " + ", ".join(missing))
        cfg = {
            "developer_token": os.environ[CRED_ENV["developer_token"]],
            "client_id": os.environ[CRED_ENV["client_id"]],
            "client_secret": os.environ[CRED_ENV["client_secret"]],
            "refresh_token": os.environ[CRED_ENV["refresh_token"]],
            "login_customer_id": _digits(os.environ[CRED_ENV["login_customer_id"]]),
            "use_proto_plus": True,
        }
        from google.ads.googleads.client import GoogleAdsClient   # lazy: prod-only dependency
        return cls(GoogleAdsClient.load_from_dict(cfg))

    def stream(self, customer_id, query):
        """Yield flattened row dicts for one GAQL query against one customer id."""
        paths = _paths_from_query(query)
        service = self._client.get_service("GoogleAdsService")
        for batch in service.search_stream(customer_id=_digits(customer_id), query=query):
            for row in batch.results:
                yield _flatten(row, paths)

    def list_accessible_customers(self):
        """Customer ids the authenticated OAuth user can reach directly (usually the
        manager accounts). A diagnostic for permission issues — needs no login-customer-id."""
        svc = self._client.get_service("CustomerService")
        resp = svc.list_accessible_customers()
        return [rn.split("/")[-1] for rn in resp.resource_names]

    def login_customer_id(self):
        """The login-customer-id (MCC) currently configured on the client, or None."""
        return getattr(self._client, "login_customer_id", None)
