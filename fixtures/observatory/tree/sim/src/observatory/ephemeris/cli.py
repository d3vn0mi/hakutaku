"""The ephemeris command line: a body's places, the Moon, tonight's sky, or the HTTP API."""

import argparse
import sys
from datetime import datetime, timedelta, timezone

from observatory.config import load_settings
from observatory.ephemeris import moon
from observatory.ephemeris.service import EphemerisService
from observatory.ephemeris.timescale import julian_day
from observatory.sky.tonight import tonight


def build_parser():
    parser = argparse.ArgumentParser(prog="ephemeris", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    table = commands.add_parser("table", help="print a body's places, one a day")
    table.add_argument("body")
    table.add_argument("--days", type=int, default=7)
    commands.add_parser("moon", help="print the Moon's phase now")
    sky = commands.add_parser("tonight", help="print how dark it is, and the bright stars up")
    sky.add_argument("--lat", type=float, required=True)
    sky.add_argument("--lon", type=float, required=True)
    sky.add_argument("--bortle", type=int, default=4)
    serve = commands.add_parser("serve", help="answer GET /where over HTTP")
    serve.add_argument("--port", type=int, default=None)
    return parser


def print_table(service, body, days, out):
    start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    out.write(f"{'date':<12}{'x (AU)':>12}{'y (AU)':>12}\n")
    for i in range(days):
        moment = start + timedelta(days=i)
        x, y, _ = service.where(body, moment)
        out.write(f"{moment:%Y-%m-%d}  {x:>10.5f}  {y:>10.5f}\n")


def print_tonight(report, out):
    out.write(f"sky: {report['phase']}\n")
    for name, altitude, azimuth in report["stars"]:
        out.write(f"{name:<12}{altitude:>7.1f}{azimuth:>8.1f}\n")


def main(argv=None):
    """The ephemeris console script. Returns the exit status."""
    args = build_parser().parse_args(argv)
    now = datetime.now(timezone.utc)
    if args.command == "moon":
        jd = julian_day(now)
        print(f"{moon.phase_name(jd)}, {moon.illumination(jd):.0%} lit")
        return 0
    if args.command == "tonight":
        print_tonight(tonight(args.lat, args.lon, now, args.bortle), sys.stdout)
        return 0
    service = EphemerisService()
    if args.command == "table":
        if args.body not in service.bodies():
            print(f"ephemeris: unknown body {args.body!r}", file=sys.stderr)
            return 2
        print_table(service, args.body, args.days, sys.stdout)
        return 0
    from observatory.ephemeris.server import serve

    serve(args.port or load_settings().port, service)
    return 0
