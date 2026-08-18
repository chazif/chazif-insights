"""Google Ads API auto-pull.

Pulls each client's reports straight from the Google Ads API (GAQL), converts the
rows into the same slugged-dict shape the CSV parser emits, and ingests them through
the existing merge-by-window loader — so the API path and the manual-CSV path write
to identical warehouse tables and both survive a future BigQuery cutover unchanged.

Credentials live ONLY in environment variables (see client.CRED_ENV); they never
appear in code, logs, or the database. See docs/ADS_API_INTEGRATION_PLAN.docx.
"""
