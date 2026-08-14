"""Wrapper around the existing scrapers package.

The HTML scrapers remain in /scrapers. This module is the FastAPI-era
entrypoint so operators do not need a second layout.
"""

from __future__ import annotations

import runpy
import sys
from pathlib import Path


def main() -> int:
    target = Path(__file__).resolve().parents[2] / "scrapers" / "results_scraper.py"
    if not target.exists():
        print("scrapers/results_scraper.py is not present", file=sys.stderr)
        return 1
    sys.argv = [str(target), *sys.argv[1:]]
    runpy.run_path(str(target), run_name="__main__")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
