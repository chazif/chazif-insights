#!/usr/bin/env python3
"""Generate a Google Ads API refresh token — run this ONCE, locally, on your own machine.

You approve access in your own browser with the Google account that manages your Ads
accounts; the refresh token prints here for you to paste into Railway as
GOOGLE_ADS_REFRESH_TOKEN. Nothing is written to disk, sent anywhere, or seen by anyone
else — your Client ID / Secret are typed in and used only for this one exchange.

Prereq (one-time):
    pip install google-auth-oauthlib
Run:
    python scripts/get_refresh_token.py

You need your OAuth "Desktop app" Client ID + Client Secret first (Google Cloud Console →
APIs & Services → Credentials). See docs/ADS_API_SETUP_GUIDE.docx, Step 2.
"""
import sys

# The single scope the Google Ads API needs. "offline" access + a forced consent prompt
# are what make Google hand back a durable refresh token (not just a short-lived one).
SCOPES = ["https://www.googleapis.com/auth/adwords"]


def main():
    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError:
        sys.exit("Missing dependency. First run:  pip install google-auth-oauthlib")

    print("Google Ads API — refresh token generator")
    print("-" * 48)
    print("Paste your OAuth 'Desktop app' credentials from Google Cloud Console.\n")
    client_id = input("Client ID:     ").strip()
    client_secret = input("Client Secret: ").strip()
    if not client_id or not client_secret:
        sys.exit("Both Client ID and Client Secret are required. Aborted.")

    client_config = {
        "installed": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": ["http://localhost"],
        }
    }

    flow = InstalledAppFlow.from_client_config(client_config, scopes=SCOPES)
    print("\nA browser window will open. Sign in with the Google account that MANAGES")
    print("your Ads accounts (the manager/MCC login) and click Allow.\n")
    # opens the browser and runs a throwaway local server to catch the redirect
    creds = flow.run_local_server(port=0, access_type="offline", prompt="consent")

    if not creds.refresh_token:
        sys.exit("No refresh token returned. Re-run and make sure you click 'Allow' "
                 "(and that this app wasn't already authorized without offline access).")

    print("\n" + "=" * 60)
    print("SUCCESS — paste this into Railway as GOOGLE_ADS_REFRESH_TOKEN:")
    print("=" * 60)
    print(creds.refresh_token)
    print("=" * 60)
    print("Keep it secret. It does not expire; it is the app's standing login.")


if __name__ == "__main__":
    main()
