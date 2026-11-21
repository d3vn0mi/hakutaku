"""Rebuilds every planet's ephemeris table and writes them all as JSON.

    python -m observatory.tools.rebuild --out /var/lib/observatory
"""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from observatory.ephemeris.service import EphemerisService
from observatory.ephemeris.timescale import from_julian_day, julian_day


def rebuild(out_dir, service=None, now=None):
    """Writes elements.json, each planet's table around now, into out_dir; returns its path."""
    service = service or EphemerisService()
    now = now or datetime.now(timezone.utc)
    jd = julian_day(now)
    tables = {}
    for body in service.bodies():
        table = service.table_for(body, jd)
        tables[body] = [
            {"at": from_julian_day(row.jd).isoformat(), "x": row.x, "y": row.y}
            for row in table.rows
        ]
    out = Path(out_dir) / "elements.json"
    document = {"built": now.isoformat(), "tables": tables}
    out.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description="Rebuild the ephemeris tables.")
    parser.add_argument("--out", type=Path, required=True, help="the data directory")
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    print(rebuild(args.out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
