#!/usr/bin/env python3
"""Analytics read routing for the BigQuery migration.

When BigQuery is configured, raw_rows / qs_history reads go to BigQuery while
clients / uploads / term_relevance stay in Postgres. RouterEngine wraps both and
dispatches each query by the table it touches, so build_bundle and the ~30 section
builders keep using a single `engine` unchanged.

Both underlying engines are real SQLAlchemy engines (BigQuery via the
sqlalchemy-bigquery dialect), so query Results behave identically — no result-shape
mimicry. When BigQuery isn't configured, callers get the plain Postgres engine back
and there is zero routing (RouterEngine is never even constructed).
"""
from . import bq

# The two tables that live in BigQuery; every other table stays in Postgres.
ANALYTICS_TABLES = ("raw_rows", "qs_history")


def analytics_engine():
    """SQLAlchemy engine over the BigQuery dataset, or None if BigQuery isn't configured.
    Reuses the SAME bigquery.Client the rest of the warehouse builds (SA key or ADC) via
    connect_args, so auth is identical everywhere — this sidesteps sqlalchemy-bigquery's
    own default-auth path, which mishandles Cloud Shell / metadata-server credentials
    ('service account info is missing email field'). Imports the dialect lazily."""
    if not bq.bq_config():
        return None
    from sqlalchemy import create_engine
    cfg = bq.bq_config()
    url = f"bigquery://{cfg['project']}/{cfg['dataset']}"
    return create_engine(url, connect_args={"client": bq.get_client()})


def _targets_analytics(statement):
    """True if a statement reads an analytics table. Only raw text() queries touch
    raw_rows/qs_history; Core select()s in this codebase are for clients/uploads (PG)."""
    sql = getattr(statement, "text", None)
    if not isinstance(sql, str):
        return False
    low = sql.lower()
    return any(t in low for t in ANALYTICS_TABLES)


class RouterConnection:
    """A connection facade that opens the Postgres and/or BigQuery connection lazily and
    routes each execute() to the right one by the table the statement touches."""
    def __init__(self, engines):
        self._engines = engines          # {"pg": Engine, "an": Engine}
        self._conns = {}

    def _conn(self, key):
        if key not in self._conns:
            self._conns[key] = self._engines[key].connect()
        return self._conns[key]

    def execute(self, statement, parameters=None):
        key = "an" if _targets_analytics(statement) else "pg"
        conn = self._conn(key)
        return conn.execute(statement, parameters) if parameters is not None else conn.execute(statement)

    def execution_options(self, **kw):
        return self                       # reads don't need streaming opts; stay chainable

    def close(self):
        for c in self._conns.values():
            c.close()
        self._conns.clear()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


class RouterEngine:
    """Engine facade whose .connect() routes analytics reads to BigQuery and everything
    else to Postgres. Writes/transactions (.begin()) go to Postgres — analytics writes
    are handled by the load-job path, not row DML."""
    def __init__(self, pg_engine, an_engine):
        self._engines = {"pg": pg_engine, "an": an_engine}
        self.dialect = pg_engine.dialect          # some callers read engine.dialect.name
        self.pg_engine = pg_engine                # DDL/schema ops (init_db) unwrap to this

    def connect(self):
        return RouterConnection(self._engines)

    def begin(self):
        return self._engines["pg"].begin()


def read_engine(pg_engine):
    """Wrap a Postgres engine with analytics routing when BigQuery is configured;
    otherwise return it unchanged (no routing, no behavioural change)."""
    an = analytics_engine()
    return RouterEngine(pg_engine, an) if an is not None else pg_engine
