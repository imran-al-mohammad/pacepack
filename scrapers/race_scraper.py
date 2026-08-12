"""
Race/Event Scraper for PacePack
Extracts marathon and race event data from registration pages.

Usage:
    from scrapers.race_scraper import scrape_race
    data = scrape_race("https://example.com/race-signup")
    print(data)
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, asdict
from datetime import datetime
from typing import Optional, List, Dict, Any
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from dateutil import parser as date_parser


# ─── Data Structure ────────────────────────────────────────────────────────────

@dataclass
class RaceData:
    """Structured race event data matching the marathons table schema."""
    name: Optional[str] = None
    date: Optional[str] = None  # ISO format: YYYY-MM-DD
    start_time: Optional[str] = None  # HH:MM format
    location: Optional[str] = None
    distances: Optional[List[str]] = None
    registration_url: Optional[str] = None
    registration_deadline: Optional[str] = None  # ISO format: YYYY-MM-DD
    organizer: Optional[str] = None
    description: Optional[str] = None
    entry_fee: Optional[str] = None
    source_url: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary, replacing None with null for JSON compatibility."""
        return asdict(self)

    def to_json(self, indent: int = 2) -> str:
        """Convert to JSON string."""
        return json.dumps(self.to_dict(), indent=indent, ensure_ascii=False)


# ─── Helper Functions ──────────────────────────────────────────────────────────

def normalize_date(date_str: str) -> Optional[str]:
    """
    Normalize various date formats to ISO format (YYYY-MM-DD).
    
    Handles formats like:
    - December 15, 2026
    - 12/15/2026
    - 2026-12-15
    - 15th Dec 2026
    """
    if not date_str:
        return None
    
    try:
        # Clean the string
        cleaned = date_str.strip()
        
        # Try parsing with dateutil (handles most formats)
        parsed = date_parser.parse(cleaned, fuzzy=True)
        return parsed.strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        # Try regex patterns for common formats
        patterns = [
            r'(\d{4})-(\d{2})-(\d{2})',  # YYYY-MM-DD
            r'(\d{2})/(\d{2})/(\d{4})',  # MM/DD/YYYY or DD/MM/YYYY
            r'(\d{1,2})(?:st|nd|rd|th)?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})',
        ]
        
        for pattern in patterns:
            match = re.search(pattern, cleaned, re.IGNORECASE)
            if match:
                try:
                    return date_parser.parse(match.group(0), fuzzy=True).strftime("%Y-%m-%d")
                except:
                    pass
        
        return None


def normalize_time(time_str: str) -> Optional[str]:
    """
    Normalize time to HH:MM format (24-hour).
    
    Handles formats like:
    - 06:00
    - 6:00 AM
    - 6:00 PM
    - 18:00
    """
    if not time_str:
        return None
    
    try:
        cleaned = time_str.strip()
        parsed = date_parser.parse(cleaned, fuzzy=True)
        return parsed.strftime("%H:%M")
    except (ValueError, TypeError):
        # Try regex for HH:MM format
        match = re.search(r'(\d{1,2}):(\d{2})', cleaned)
        if match:
            hour, minute = int(match.group(1)), int(match.group(2))
            
            # Check for AM/PM
            if re.search(r'PM', cleaned, re.IGNORECASE) and hour < 12:
                hour += 12
            elif re.search(r'AM', cleaned, re.IGNORECASE) and hour == 12:
                hour = 0
            
            return f"{hour:02d}:{minute:02d}"
        
        return None


def extract_distances(text: str) -> List[str]:
    """
    Extract race distances from text.
    
    Returns list like: ["5K", "10K", "Half Marathon", "Marathon"]
    """
    if not text:
        return []
    
    distances = []
    
    # Common distance patterns - order matters! Check more specific patterns first
    patterns = [
        (r'\bultra[\s-]?marathon\b', 'Ultra Marathon'),
        (r'\bhalf[\s-]?marathon\b', 'Half Marathon'),
        (r'\bmarathon\b', 'Marathon'),
        (r'\b10[\s-]?k\b', '10K'),
        (r'\b5[\s-]?k\b', '5K'),
        (r'\b21\.\s?0975\s?km\b', 'Half Marathon'),
        (r'\b42\.\s?195\s?km\b', 'Marathon'),
        (r'\b10\s?km\b', '10K'),
        (r'\b5\s?km\b', '5K'),
        (r'\b21\s?km\b', 'Half Marathon'),
        (r'\b42\s?km\b', 'Marathon'),
        (r'\b15[\s-]?k\b', '15K'),
        (r'\b20[\s-]?k\b', '20K'),
    ]
    
    text_lower = text.lower()
    found = set()
    
    for pattern, distance in patterns:
        if re.search(pattern, text_lower) and distance not in found:
            distances.append(distance)
            found.add(distance)
    
    return distances if distances else None


def clean_text(text: Optional[str]) -> Optional[str]:
    """Clean and normalize text content."""
    if not text:
        return None
    
    # Remove extra whitespace
    cleaned = ' '.join(text.split())
    
    # Remove common unwanted patterns
    cleaned = re.sub(r'\s+', ' ', cleaned)
    cleaned = cleaned.strip()
    
    return cleaned if cleaned else None


# ─── Scraper Class ─────────────────────────────────────────────────────────────

class RaceScraper:
    """
    Scraper for race/event registration pages.
    
    Automatically detects if page needs JavaScript rendering.
    """
    
    def __init__(self, timeout: int = 10):
        """
        Initialize scraper.
        
        Args:
            timeout: Request timeout in seconds
        """
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        })
    
    def _is_javascript_heavy(self, html: str) -> bool:
        """
        Detect if page is heavily JavaScript-rendered.
        
        Checks for:
        - SPA frameworks (React, Vue, Angular)
        - Heavy script tags
        - Minimal initial HTML content
        """
        # Check for SPA frameworks
        spa_indicators = [
            'react', 'vue', 'angular', 'next.js', 'nuxt.js',
            'data-reactroot', 'ng-app', 'data-v-'
        ]
        html_lower = html.lower()
        
        for indicator in spa_indicators:
            if indicator in html_lower:
                return True
        
        # Check script-to-content ratio
        soup = BeautifulSoup(html, 'html.parser')
        
        # Remove scripts and styles for content check
        for script in soup(['script', 'style']):
            script.decompose()
        
        text_content = len(soup.get_text(strip=True))
        script_content = sum(len(str(s)) for s in soup.find_all('script'))
        
        # If scripts dominate, likely JS-heavy
        if text_content > 0 and script_content > text_content * 2:
            return True
        
        return False
    
    def _fetch_static(self, url: str) -> Optional[BeautifulSoup]:
        """
        Fetch page using requests (static HTML).
        
        Returns:
            BeautifulSoup object or None if failed
        """
        try:
            response = self.session.get(url, timeout=self.timeout)
            response.raise_for_status()
            return BeautifulSoup(response.text, 'html.parser')
        except requests.RequestException as e:
            print(f"Error fetching page: {e}")
            return None
    
    def _fetch_dynamic(self, url: str) -> Optional[BeautifulSoup]:
        """
        Fetch page using Playwright (JavaScript rendering).
        
        Returns:
            BeautifulSoup object or None if failed
        """
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            print("Playwright not installed. Install with: pip install playwright")
            return None
        
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                page = browser.new_page()
                page.goto(url, wait_until='networkidle', timeout=self.timeout * 1000)
                html = page.content()
                browser.close()
                return BeautifulSoup(html, 'html.parser')
        except Exception as e:
            print(f"Error with Playwright: {e}")
            return None
    
    def _extract_opengraph(self, soup: BeautifulSoup) -> Dict[str, Optional[str]]:
        """Extract data from Open Graph meta tags."""
        data = {}
        
        og_tags = {
            'og:title': 'name',
            'og:description': 'description',
            'og:url': 'registration_url',
            'og:image': None,
        }
        
        for prop, key in og_tags.items():
            tag = soup.find('meta', property=prop)
            if tag and tag.get('content'):
                data[key] = tag['content']
        
        return data
    
    def _extract_name(self, soup: BeautifulSoup) -> Optional[str]:
        """Extract event name from page."""
        # Try Open Graph first
        og_title = soup.find('meta', property='og:title')
        if og_title and og_title.get('content'):
            return clean_text(og_title['content'])
        
        # Try title tag
        title = soup.find('title')
        if title:
            return clean_text(title.get_text())
        
        # Try h1
        h1 = soup.find('h1')
        if h1:
            return clean_text(h1.get_text())
        
        return None
    
    def _extract_date(self, soup: BeautifulSoup) -> Optional[str]:
        """Extract event date from page."""
        # Common selectors for date
        date_selectors = [
            {'class': re.compile(r'date|when|event-date', re.I)},
            {'id': re.compile(r'date|when|event-date', re.I)},
        ]
        
        for selector in date_selectors:
            elements = soup.find_all(attrs=selector)
            for elem in elements:
                text = elem.get_text(strip=True)
                normalized = normalize_date(text)
                if normalized:
                    return normalized
        
        # Look for date patterns in text
        date_patterns = [
            r'\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b',
            r'\b\d{1,2}/\d{1,2}/\d{4}\b',
            r'\b\d{4}-\d{2}-\d{2}\b',
        ]
        
        for pattern in date_patterns:
            matches = re.findall(pattern, soup.get_text(), re.IGNORECASE)
            if matches:
                normalized = normalize_date(matches[0])
                if normalized:
                    return normalized
        
        return None
    
    def _extract_time(self, soup: BeautifulSoup) -> Optional[str]:
        """Extract start time from page."""
        time_patterns = [
            r'\b\d{1,2}:\d{2}\s*(?:AM|PM)?\b',
            r'\b\d{1,2}:\d{2}\b',
        ]
        
        text = soup.get_text()
        
        for pattern in time_patterns:
            matches = re.findall(pattern, text, re.IGNORECASE)
            for match in matches:
                normalized = normalize_time(match)
                if normalized:
                    return normalized
        
        return None
    
    def _extract_location(self, soup: BeautifulSoup) -> Optional[str]:
        """Extract event location from page."""
        # Common location selectors
        location_selectors = [
            {'class': re.compile(r'location|venue|address|place', re.I)},
            {'id': re.compile(r'location|venue|address|place', re.I)},
        ]
        
        for selector in location_selectors:
            elements = soup.find_all(attrs=selector)
            for elem in elements:
                text = clean_text(elem.get_text())
                if text and len(text) > 5:  # Avoid too short strings
                    return text
        
        # Look for address patterns
        address_patterns = [
            r'\d+\s+[\w\s]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way)',
            r'[\w\s]+,\s*[\w\s]+,\s*[A-Z]{2}\s+\d{5}',  # City, State, ZIP
        ]
        
        for pattern in address_patterns:
            matches = re.findall(pattern, soup.get_text())
            if matches:
                return clean_text(matches[0])
        
        return None
    
    def _extract_distances(self, soup: BeautifulSoup) -> Optional[List[str]]:
        """Extract available race distances."""
        # Get all text content
        text = soup.get_text()
        
        # Also check specific elements
        distance_elements = soup.find_all(
            attrs={'class': re.compile(r'distance|category|race-type', re.I)}
        )
        
        for elem in distance_elements:
            distances = extract_distances(elem.get_text())
            if distances:
                return distances
        
        # Try full page text
        distances = extract_distances(text)
        return distances if distances else None
    
    def _extract_registration_deadline(self, soup: BeautifulSoup) -> Optional[str]:
        """Extract registration deadline."""
        deadline_keywords = ['deadline', 'closes', 'close', 'until', 'register by']
        
        text = soup.get_text()
        
        for keyword in deadline_keywords:
            # Find keyword and extract nearby date (more flexible pattern)
            pattern = rf'{keyword}[:\s]+([^\n]+)'
            matches = re.findall(pattern, text, re.IGNORECASE)
            
            for match in matches:
                # Extract date from the matched text
                normalized = normalize_date(match)
                if normalized:
                    return normalized
        
        return None
    
    def _extract_organizer(self, soup: BeautifulSoup) -> Optional[str]:
        """Extract event organizer name."""
        organizer_keywords = ['organized by', 'presented by', 'hosted by', 'produced by']
        
        text = soup.get_text()
        
        for keyword in organizer_keywords:
            # More flexible pattern - capture until newline or period
            pattern = rf'{keyword}[:\s]+([^\n\.]+)'
            matches = re.findall(pattern, text, re.IGNORECASE)
            
            if matches:
                organizer = clean_text(matches[0])
                if organizer and len(organizer) > 2:
                    return organizer
        
        return None
    
    def _extract_description(self, soup: BeautifulSoup) -> Optional[str]:
        """Extract event description."""
        # Try meta description
        meta_desc = soup.find('meta', attrs={'name': 'description'})
        if meta_desc and meta_desc.get('content'):
            return clean_text(meta_desc['content'])
        
        # Try Open Graph description
        og_desc = soup.find('meta', property='og:description')
        if og_desc and og_desc.get('content'):
            return clean_text(og_desc['content'])
        
        # Try first paragraph
        first_p = soup.find('p')
        if first_p:
            text = clean_text(first_p.get_text())
            if text and len(text) > 20:  # Avoid too short paragraphs
                return text[:500]  # Limit length
        
        return None
    
    def _extract_entry_fee(self, soup: BeautifulSoup) -> Optional[str]:
        """Extract entry fee/price."""
        fee_patterns = [
            r'(?:entry|registration|signup)\s+fee[:\s]+([^\n]+?)(?:\n|$)',
            r'\$\s*(\d+(?:\.\d{2})?)',
            r'([A-Z]{3}\s+\d+(?:,\d{3})*(?:\.\d{2})?)',  # BDT 2500, USD 100, etc.
        ]
        
        text = soup.get_text()
        
        for pattern in fee_patterns:
            matches = re.findall(pattern, text, re.IGNORECASE)
            if matches:
                fee = clean_text(matches[0])
                if fee:
                    return fee
        
        return None
    
    def scrape_race(self, url: str) -> Dict[str, Any]:
        """
        Scrape race data from a registration page URL.
        
        Args:
            url: The race registration/signup page URL
            
        Returns:
            Dictionary with race data (keys may be None if not found)
            
        Example:
            >>> data = scrape_race("https://example.com/marathon-signup")
            >>> print(data['name'])
            'Dhaka Marathon 2026'
        """
        # Validate URL
        if not url or not url.startswith(('http://', 'https://')):
            raise ValueError(f"Invalid URL: {url}")
        
        # Fetch page
        soup = self._fetch_static(url)
        
        # Check if we need JavaScript rendering
        if soup and self._is_javascript_heavy(str(soup)):
            print("Page appears to be JavaScript-heavy, using Playwright...")
            soup = self._fetch_dynamic(url)
        
        if not soup:
            raise Exception(f"Failed to fetch page: {url}")
        
        # Extract data
        race_data = RaceData(
            name=self._extract_name(soup),
            date=self._extract_date(soup),
            start_time=self._extract_time(soup),
            location=self._extract_location(soup),
            distances=self._extract_distances(soup),
            registration_url=url,
            registration_deadline=self._extract_registration_deadline(soup),
            organizer=self._extract_organizer(soup),
            description=self._extract_description(soup),
            entry_fee=self._extract_entry_fee(soup),
            source_url=url,
        )
        
        return race_data.to_dict()


# ─── Convenience Function ──────────────────────────────────────────────────────

def scrape_race(url: str) -> dict:
    """
    Convenience function to scrape race data.
    
    Args:
        url: Race registration page URL
        
    Returns:
        Dictionary with race event data
        
    Example:
        >>> data = scrape_race("https://example.com/race")
        >>> print(data)
        {
            "name": "Dhaka Marathon 2026",
            "date": "2026-12-15",
            "start_time": "06:00",
            ...
        }
    """
    scraper = RaceScraper()
    return scraper.scrape_race(url)


# ─── Confirmation / Summary Helpers ────────────────────────────────────────────

def _display_value(value: Any, missing: str = "— not found —") -> str:
    """
    Format a single field for terminal display.
    Missing / empty values show a clear placeholder instead of crashing.
    """
    if value is None:
        return missing
    if isinstance(value, list):
        if not value:
            return missing
        return ", ".join(str(v) for v in value if v)
    text = str(value).strip()
    return text if text else missing


def format_race_summary(race_data: Dict[str, Any], max_description_len: int = 280) -> str:
    """
    Build a clean, human-readable summary of scraped race data.

    Includes (when present):
      name, date, start time, location, distances, registration URL,
      registration deadline, organizer, entry fee, short description.

    Args:
        race_data: Dict from scrape_race() / RaceData.to_dict()
        max_description_len: Truncate long descriptions for the terminal

    Returns:
        Multi-line string ready to print
    """
    data = race_data or {}

    description = data.get("description")
    if isinstance(description, str) and len(description) > max_description_len:
        description = description[: max_description_len - 1].rstrip() + "…"

    # Prefer registration_url, fall back to source_url
    reg_url = data.get("registration_url") or data.get("source_url")

    rows = [
        ("🏁 Race Name", data.get("name")),
        ("📅 Date", data.get("date")),
        ("⏰ Start Time", data.get("start_time")),
        ("📍 Location", data.get("location")),
        ("🏃 Distances", data.get("distances")),
        ("🔗 Registration URL", reg_url),
        ("📆 Registration Deadline", data.get("registration_deadline")),
        ("🏢 Organizer", data.get("organizer")),
        ("💰 Entry Fee", data.get("entry_fee")),
        ("📝 Description", description),
    ]

    width = 70
    lines = [
        "",
        "╔" + "═" * (width - 2) + "╗",
        "║" + " SCRAPED RACE SUMMARY ".center(width - 2) + "║",
        "╚" + "═" * (width - 2) + "╝",
        "",
    ]

    for label, value in rows:
        display = _display_value(value)
        # Put long descriptions on following indented lines
        if label.startswith("📝") and len(display) > 48:
            lines.append(f"  {label}:")
            chunk_size = width - 6
            for i in range(0, len(display), chunk_size):
                lines.append("    " + display[i : i + chunk_size])
        else:
            lines.append(f"  {label}: {display}")

    lines.append("")
    lines.append("─" * width)
    return "\n".join(lines)


def print_race_summary(race_data: Dict[str, Any]) -> None:
    """Print the scraped race summary to the terminal."""
    print(format_race_summary(race_data))


def confirm_save(
    prompt: str = "Do you want to save this race? (y/n): ",
    *,
    default_no: bool = True,
) -> bool:
    """
    Ask the user for yes/no confirmation before saving.

    Accepts: y, yes (case-insensitive) → True
             n, no, empty (if default_no) → False

    Args:
        prompt: Question shown in the terminal
        default_no: If True, empty input means cancel (safer for DB writes)

    Returns:
        True if the user confirmed save, False if cancelled
    """
    try:
        raw = input(prompt).strip().lower()
    except (EOFError, KeyboardInterrupt):
        # Non-interactive or Ctrl+C → treat as cancel
        print()
        return False

    if not raw:
        return not default_no

    if raw in ("y", "yes"):
        return True
    if raw in ("n", "no"):
        return False

    # Unclear answer — ask once more
    print("  Please answer with y/yes or n/no.")
    try:
        raw = input(prompt).strip().lower()
    except (EOFError, KeyboardInterrupt):
        print()
        return False

    return raw in ("y", "yes")


# ─── CLI Interface ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python race_scraper.py <url>")
        print("\nExample:")
        print("  python race_scraper.py https://example.com/race-signup")
        print("\nFlow: scrape → show summary → confirm → save JSON (only if yes)")
        sys.exit(1)

    url = sys.argv[1]

    try:
        # 1) Scrape (existing logic — no side effects)
        print(f"🔍 Scraping: {url}\n")
        data = scrape_race(url)
        print("✅ Scraping complete.")

        # 2) Show summary — do NOT save yet
        print_race_summary(data)

        # 3) Confirmation gate
        if not confirm_save("💾 Do you want to save this race to race_data.json? (y/n): "):
            print("\n🚫 Cancelled. Data was not saved.")
            sys.exit(0)

        # 4) Save only after explicit yes
        output_file = "race_data.json"
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

        print(f"\n✅ Data saved to: {output_file}")

    except Exception as e:
        print(f"❌ Error: {e}", file=sys.stderr)
        sys.exit(1)