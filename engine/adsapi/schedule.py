"""Compute the next run time of a standard 5-field cron expression, so the UI can show a
countdown to the next automatic sync. The actual scheduling is done by Railway's cron; the app
only needs to MIRROR that schedule (set ADSAPI_CRON_SCHEDULE to the same expression) to display
the timer. Supports `*`, lists (`1,15`), ranges (`1-5`), steps (`*/2`, `0-30/10`) in the five
fields: minute hour day-of-month month day-of-week (cron dow: 0=Sun..6=Sat, 7=Sun too).
"""
import datetime


def _field_matches(field, value, lo, hi):
    if field == "*":
        return True
    for part in field.split(","):
        rng, step = (part.split("/", 1) + ["1"])[:2]
        step = int(step)
        if rng in ("*", ""):
            a, b = lo, hi
        elif "-" in rng:
            a, b = (int(x) for x in rng.split("-", 1))
        else:
            a = b = int(rng)
        if a <= value <= b and (value - a) % step == 0:
            return True
    return False


def _dow_matches(field, dt):
    # cron day-of-week: 0/7 = Sunday .. 6 = Saturday. Python weekday(): Mon=0..Sun=6.
    cron_dow = (dt.weekday() + 1) % 7
    field = ",".join("0" if p == "7" else p for p in field.split(","))
    return _field_matches(field, cron_dow, 0, 6)


def next_cron_run(expr, now):
    """Next datetime (>= now, minute precision) matching the cron expr, or None if malformed /
    nothing within a year. `now` and the result are naive-UTC (cron schedules run in UTC here)."""
    if not expr:
        return None
    parts = expr.split()
    if len(parts) != 5:
        return None
    minute, hour, dom, month, dow = parts
    t = now.replace(second=0, microsecond=0) + datetime.timedelta(minutes=1)
    for _ in range(366 * 24 * 60):
        # cron dom/dow OR-semantics: when BOTH are restricted, match if either matches.
        day_ok = (_field_matches(dom, t.day, 1, 31) if dow == "*"
                  else _dow_matches(dow, t) if dom == "*"
                  else _field_matches(dom, t.day, 1, 31) or _dow_matches(dow, t))
        if (_field_matches(minute, t.minute, 0, 59) and _field_matches(hour, t.hour, 0, 23)
                and _field_matches(month, t.month, 1, 12) and day_ok):
            return t
        t += datetime.timedelta(minutes=1)
    return None
