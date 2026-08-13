"""Race-results scraper for PacePack.

The module deliberately follows the race scraper's confirmation-first workflow:
scrape -> print review summary -> confirm -> optionally save to Supabase.
It is intentionally conservative when matching names: unmatched or ambiguous
rows are reported and never silently attached to another runner.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from dataclasses import asdict, dataclass, field
from difflib import SequenceMatcher
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlparse

from bs4 import BeautifulSoup

from race_scraper import RaceScraper, confirm_save


TIME_RE = re.compile(r"(?<!\d)(?:(\d{1,2})\s*[:h]\s*)?(\d{1,2})\s*[:m]\s*(\d{2})(?:\s*s)?(?!\d)", re.I)
DISTANCE_RE = re.compile(r"(?:42\.195|21\.0975|42|21|10|5)\s*km|\b(?:ultra|half\s+)?marathon\b|\b(?:5|10|15|20|21|42)\s*k\b", re.I)


@dataclass
class ResultRow:
    runner_name: Optional[str] = None
    finish_time: Optional[str] = None
    pace: Optional[str] = None
    gender: Optional[str] = None
    age_category: Optional[str] = None
    overall_place: Optional[str] = None
    gender_place: Optional[str] = None
    category_place: Optional[str] = None
    bib: Optional[str] = None
    status: str = "completed"
    runner_id: Optional[str] = None
    match_note: Optional[str] = None
    confidence: str = "medium"


@dataclass
class ResultsData:
    race_name: Optional[str]
    distance: Optional[str]
    source_url: str
    results: List[ResultRow] = field(default_factory=list)
    missing_fields: List[str] = field(default_factory=list)
    low_confidence_fields: List[str] = field(default_factory=list)
    matching_notes: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["results"] = [asdict(row) for row in self.results]
        return data


def clean(value: Any) -> Optional[str]:
    text = " ".join(str(value or "").split()).strip()
    return text or None


def normalize_name(value: str) -> str:
    value = re.sub(r"[^a-z0-9 ]", "", value.lower())
    return " ".join(sorted(value.split()))


def normalize_time(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    match = TIME_RE.search(value)
    if not match:
        return None
    hours = int(match.group(1) or 0)
    minutes = int(match.group(2))
    seconds = int(match.group(3))
    if minutes > 59 or seconds > 59:
        return None
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def time_seconds(value: Optional[str]) -> Optional[int]:
    normalized = normalize_time(value)
    if not normalized:
        return None
    h, m, s = (int(part) for part in normalized.split(":"))
    return h * 3600 + m * 60 + s


def calculate_pace(finish_time: Optional[str], distance: Optional[str]) -> Optional[str]:
    seconds = time_seconds(finish_time)
    if not seconds or not distance:
        return None
    match = re.search(r"(42\.195|21\.0975|42|21|20|15|10|5(?:\.0)?)", distance)
    if not match:
        return None
    km = float(match.group(1))
    per_km = round(seconds / km)
    return f"{per_km // 60}:{per_km % 60:02d}/km"


def _header_key(header: str) -> Optional[str]:
    key = re.sub(r"[^a-z0-9]", "", header.lower())
    aliases = {
        "name": "runner_name", "runner": "runner_name", "participant": "runner_name", "fullname": "runner_name",
        "time": "finish_time", "finishtime": "finish_time", "chiptime": "finish_time", "guntime": "finish_time",
        "pace": "pace", "gender": "gender", "sex": "gender", "agegroup": "age_category", "category": "age_category",
        "place": "overall_place", "overall": "overall_place", "overallplace": "overall_place", "rank": "overall_place",
        "genderplace": "gender_place", "sexplace": "gender_place", "categoryplace": "category_place", "agegroupplace": "category_place",
        "bib": "bib", "bibnumber": "bib", "status": "status",
    }
    return aliases.get(key)


def _status(value: Optional[str]) -> str:
    text = (value or "").lower()
    if re.search(r"\bdns\b|did not start|not started", text): return "dns"
    if re.search(r"\bdnf\b|did not finish|disqual", text): return "dnf"
    return "completed"


def _json_array_after_marker(value: str, marker: str) -> Optional[List[Dict[str, Any]]]:
    """Read a JSON array embedded in an Alpine x-data attribute."""
    start = re.search(rf"\b{re.escape(marker)}\s*:\s*\[", value)
    if not start:
        return None
    array_start = value.find("[", start.start())
    depth = 0
    in_string = False
    escaped = False
    for index in range(array_start, len(value)):
        char = value[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "[":
            depth += 1
        elif char == "]":
            depth -= 1
            if depth == 0:
                try:
                    parsed = json.loads(value[array_start:index + 1])
                except json.JSONDecodeError:
                    return None
                return parsed if isinstance(parsed, list) else None
    return None


class ResultsScraper:
    """Extract result tables from static pages, with the same JS fallback as RaceScraper."""

    def __init__(self, timeout: int = 10):
        self.fetcher = RaceScraper(timeout=timeout)

    def scrape_results(self, url: str) -> Dict[str, Any]:
        parsed = urlparse(url or "")
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError(f"Invalid URL: {url}")
        soup = self.fetcher._fetch_static(url)
        if soup and self.fetcher._is_javascript_heavy(str(soup)):
            print("Page appears to be JavaScript-heavy, using Playwright...")
            soup = self.fetcher._fetch_dynamic(url)
        if not soup:
            raise RuntimeError(f"Failed to fetch page: {url}")
        if soup.select_one("#login-form"):
            raise ValueError("This Feibot URL is the admin login/query page. Use a public /display-score/{event_id}/{token} results URL.")
        title = clean((soup.find("meta", property="og:title") or {}).get("content")) if soup.find("meta", property="og:title") else None
        title = title or clean(soup.find("h1").get_text(" ", strip=True) if soup.find("h1") else None) or clean(soup.title.get_text(" ", strip=True) if soup.title else None)
        page_text = soup.get_text(" ", strip=True)
        distance = clean(DISTANCE_RE.search(page_text).group(0)) if DISTANCE_RE.search(page_text) else None
        rows = self._extract_table_rows(soup)
        if not rows:
            rows, embedded_distance = self._extract_feibot_scores(soup)
            distance = distance or embedded_distance
        data = ResultsData(title, distance, url, rows)
        self._annotate_quality(data)
        return data.to_dict()

    def _extract_table_rows(self, soup: BeautifulSoup) -> List[ResultRow]:
        candidates: List[Tuple[int, List[ResultRow]]] = []
        for table in soup.find_all("table"):
            header_row = table.find("tr")
            headers = [clean(cell.get_text(" ", strip=True)) or "" for cell in header_row.find_all(["th", "td"])] if header_row else []
            mapping = [_header_key(header) for header in headers]
            score = sum(key is not None for key in mapping)
            if score < 2 or "runner_name" not in mapping:
                continue
            parsed_rows: List[ResultRow] = []
            for tr in table.find_all("tr")[1:]:
                cells = [clean(cell.get_text(" ", strip=True)) for cell in tr.find_all(["td", "th"])]
                if len(cells) < 2: continue
                values = {key: cells[i] for i, key in enumerate(mapping) if key and i < len(cells)}
                if not values.get("runner_name"): continue
                row = ResultRow(**{key: values.get(key) for key in ResultRow.__dataclass_fields__ if key in values})
                row.finish_time = normalize_time(row.finish_time)
                row.status = _status(values.get("status"))
                row.confidence = "high" if row.finish_time or row.status != "completed" else "medium"
                parsed_rows.append(row)
            candidates.append((score * 100 + len(parsed_rows), parsed_rows))
        return max(candidates, default=(0, []), key=lambda item: item[0])[1]

    def _extract_feibot_scores(self, soup: BeautifulSoup) -> Tuple[List[ResultRow], Optional[str]]:
        for element in soup.find_all(attrs={"x-data": True}):
            payload = _json_array_after_marker(html.unescape(element.get("x-data") or ""), "scores")
            if not payload:
                continue
            rows: List[ResultRow] = []
            distances: List[str] = []
            for score in payload:
                name = clean(score.get("name"))
                if not name:
                    continue
                item = score.get("item") if isinstance(score.get("item"), dict) else {}
                item_title = clean(item.get("title"))
                if item_title and item_title not in distances:
                    distances.append(item_title)
                finish_time = normalize_time(score.get("total_score"))
                invalid = clean(score.get("invalid"))
                status = _status(invalid or ("completed" if score.get("finisher") else "DNF"))
                rows.append(ResultRow(
                    runner_name=name,
                    finish_time=finish_time,
                    gender=clean(score.get("sex")),
                    age_category=clean(score.get("age_group")),
                    overall_place=clean(score.get("total_ranking")),
                    category_place=clean(score.get("age_total_ranking")),
                    bib=clean(score.get("bib")),
                    status=status,
                    confidence="high" if finish_time or status != "completed" else "medium",
                ))
            if rows:
                return rows, distances[0] if len(distances) == 1 else None
        return [], None

    def _annotate_quality(self, data: ResultsData) -> None:
        # Pace is calculated after the page-level distance is known.
        for row in data.results:
            row.pace = row.pace or calculate_pace(row.finish_time, data.distance)
        if not data.results: data.missing_fields.append("results table")
        for field_name, label in (("runner_name", "runner name"), ("finish_time", "finish time"), ("overall_place", "overall place")):
            if data.results and any(getattr(row, field_name) is None for row in data.results): data.missing_fields.append(label)
        if data.results and any(row.finish_time and not row.pace for row in data.results): data.low_confidence_fields.append("pace (calculated only when distance is recognized)")


def scrape_results(url: str) -> Dict[str, Any]:
    return ResultsScraper().scrape_results(url)


def match_results(data: Dict[str, Any], races: Iterable[Dict[str, Any]], runners: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """Attach only exact/very-safe unique matches; never invent IDs."""
    races, runners = list(races), list(runners)
    name = normalize_name(data.get("race_name") or "")
    race_matches = [race for race in races if normalize_name(race.get("name", "")) == name]
    data["marathon_id"] = race_matches[0].get("id") if len(race_matches) == 1 else None
    data["matching_notes"] = []
    if not race_matches: data["matching_notes"].append("No exact existing race match; nothing will be saved until marathon_id is supplied.")
    elif len(race_matches) > 1: data["matching_notes"].append("Multiple races have this name; race match is ambiguous.")
    by_name: Dict[str, List[Dict[str, Any]]] = {}
    for runner in runners: by_name.setdefault(normalize_name(runner.get("name", "")), []).append(runner)
    for row_dict in data.get("results", []):
        key = normalize_name(row_dict.get("runner_name") or "")
        exact = by_name.get(key, [])
        if len(exact) == 1:
            row_dict["runner_id"], row_dict["match_note"] = exact[0].get("id"), "Exact roster name match"
        else:
            close = [r for r in runners if SequenceMatcher(None, key, normalize_name(r.get("name", ""))).ratio() >= .94]
            if len(close) == 1:
                row_dict["runner_id"], row_dict["match_note"] = close[0].get("id"), "High-confidence name match; review spelling"
            else:
                row_dict["match_note"] = "Unmatched or ambiguous roster name"
                data["matching_notes"].append(f"Unmatched: {row_dict.get('runner_name')}")
    return data


def format_results_summary(data: Dict[str, Any], sample_size: int = 5) -> str:
    rows = data.get("results") or []
    lines = ["", "=" * 78, "SCRAPED RACE RESULTS SUMMARY", "=" * 78,
             f"Race/source: {data.get('race_name') or '—'}", f"Distance: {data.get('distance') or '—'}",
             f"Source URL: {data.get('source_url') or '—'}", f"Results found: {len(rows)}", "", "Sample rows:"]
    for i, row in enumerate(rows[:sample_size], 1):
        lines.append(f"  {i}. {row.get('runner_name') or '—'} | time {row.get('finish_time') or '—'} | place {row.get('overall_place') or '—'} | bib {row.get('bib') or '—'} | {row.get('match_note') or 'not matched'}")
    if data.get("missing_fields"): lines.append("Missing fields: " + ", ".join(data["missing_fields"]))
    if data.get("low_confidence_fields"): lines.append("Low-confidence fields: " + ", ".join(data["low_confidence_fields"]))
    if data.get("matching_notes"): lines.append("Matching notes: " + "; ".join(dict.fromkeys(data["matching_notes"])))
    lines += ["=" * 78, ""]
    return "\n".join(lines)


def print_results_summary(data: Dict[str, Any]) -> None:
    print(format_results_summary(data))


def save_results_to_supabase(supabase: Any, data: Dict[str, Any], group_id: str, marathon_id: Optional[str] = None) -> Dict[str, int]:
    """Upsert matched rows by the schema's marathon/runner uniqueness key."""
    marathon_id = marathon_id or data.get("marathon_id")
    if not marathon_id: raise ValueError("An unambiguous marathon_id is required to save results")
    saved = skipped = 0
    for row in data.get("results", []):
        if not row.get("runner_id"):
            skipped += 1; continue
        payload = {"group_id": group_id, "marathon_id": marathon_id, "runner_id": row["runner_id"], "status": row.get("status") or "completed", "bib": row.get("bib") or "", "chip_time": row.get("finish_time") or "", "gun_time": row.get("finish_time") or "", "place_overall": row.get("overall_place") or "", "place_gender": row.get("gender_place") or "", "place_age_group": row.get("category_place") or row.get("age_category") or "", "result_notes": f"Imported from {data.get('source_url')}"}
        existing = supabase.table("registrations").select("id").eq("marathon_id", marathon_id).eq("runner_id", row["runner_id"]).execute()
        if existing.data: supabase.table("registrations").update(payload).eq("id", existing.data[0]["id"]).execute()
        else: supabase.table("registrations").insert(payload).execute()
        saved += 1
    return {"saved": saved, "skipped_unmatched": skipped}


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Review and optionally import race results into PacePack")
    parser.add_argument("url", help="Results page URL")
    parser.add_argument("--group-id", default=None, help="PacePack group UUID (or DEFAULT_GROUP_ID)")
    parser.add_argument("--json", dest="json_file", help="Write the reviewed payload after confirmation")
    args = parser.parse_args(argv)
    try: data = scrape_results(args.url)
    except Exception as exc: print(f"Scraping failed: {exc}"); return 1
    import os
    group_id = args.group_id or os.getenv("DEFAULT_GROUP_ID")
    supabase = None
    if group_id:
        try:
            from dotenv import load_dotenv
            from supabase import create_client
            load_dotenv()
            supabase = create_client(os.getenv("SUPABASE_URL", ""), os.getenv("SUPABASE_KEY", ""))
            races = supabase.table("marathons").select("id,name").eq("group_id", group_id).execute().data or []
            runners = supabase.table("runners").select("id,name").eq("group_id", group_id).execute().data or []
            match_results(data, races, runners)
        except Exception as exc:
            print(f"Could not load matching context; continuing as preview: {exc}")
            supabase = None
    print_results_summary(data)
    if not confirm_save("Save these results? (y/n): "): print("Cancelled. No results were saved."); return 0
    if supabase and group_id:
        try:
            saved = save_results_to_supabase(supabase, data, group_id)
            print(f"Saved {saved['saved']} result(s); skipped {saved['skipped_unmatched']} unmatched row(s).")
        except Exception as exc:
            print(f"Save failed: {exc}")
            return 1
    else:
        print("Confirmed, but no database context was configured. Exporting the reviewed payload only.")
    if args.json_file:
        with open(args.json_file, "w", encoding="utf-8") as handle: json.dump(data, handle, indent=2, ensure_ascii=False)
        print(f"Reviewed payload saved to {args.json_file}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
