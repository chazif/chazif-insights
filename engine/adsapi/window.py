"""Rolling re-pull window for the nightly Google Ads API sync.

We re-pull a rolling window (not just "yesterday") because Google RESTATES recent days
as late conversions land — re-pulling keeps our numbers matching Google's. The window
starts at the FIRST DAY OF LAST MONTH and runs to today, so last month is always
finalized (its late conversions have landed) while the current month stays fresh. The
merge-by-window loader replaces exactly these dates and preserves older history.
"""
import datetime


def pull_window(today=None):
    """(start, end) for the nightly pull: first day of LAST month -> today.

    e.g. today = 2026-09-15 -> (2026-08-01, 2026-09-15)
         today = 2026-01-03 -> (2025-12-01, 2026-01-03)  (crosses the year boundary)
    """
    today = today or datetime.date.today()
    first_of_this_month = today.replace(day=1)
    start = (first_of_this_month - datetime.timedelta(days=1)).replace(day=1)
    return start, today
