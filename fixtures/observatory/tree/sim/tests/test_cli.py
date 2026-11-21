import io

from observatory.ephemeris.cli import build_parser, main, print_table


def test_refuses_an_unknown_body(capsys):
    assert main(["table", "Pluto"]) == 2
    assert "unknown body 'Pluto'" in capsys.readouterr().err


def test_prints_one_row_a_day(service):
    out = io.StringIO()
    print_table(service, "Mars", 3, out)
    lines = out.getvalue().splitlines()
    assert lines[0].startswith("date")
    assert len(lines) == 4


def test_serve_takes_a_port():
    args = build_parser().parse_args(["serve", "--port", "9000"])
    assert (args.command, args.port) == ("serve", 9000)
