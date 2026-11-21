"""The service's settings, read from the environment."""

import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_PORT = 8080
DEFAULT_CACHE_DIR = "/var/cache/observatory"
DEFAULT_UPSTREAM_URL = "https://ephemeris.example.org/v1"


@dataclass(frozen=True)
class Settings:
    port: int
    cache_dir: Path
    upstream_url: str


def load_settings(environ=None):
    """The settings in environ, os.environ by default, with a default for each one unset."""
    env = os.environ if environ is None else environ
    return Settings(
        port=int(env.get("EPHEMERIS_PORT", DEFAULT_PORT)),
        cache_dir=Path(env.get("EPHEMERIS_CACHE_DIR", DEFAULT_CACHE_DIR)),
        upstream_url=env.get("EPHEMERIS_UPSTREAM_URL", DEFAULT_UPSTREAM_URL),
    )
