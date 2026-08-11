"""
Test script for the Race Scraper

This script tests the scraper with sample HTML to verify it works correctly.
Run this to ensure the scraper is functioning properly.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from race_scraper import RaceScraper, scrape_race, normalize_date, normalize_time, extract_distances


# ─── Sample HTML for Testing ──────────────────────────────────────────────────

SAMPLE_HTML = """
<!DOCTYPE html>
<html>
<head>
    <title>Dhaka Marathon 2026 - Registration</title>
    <meta name="description" content="Join the annual Dhaka Marathon 2026. Choose from Marathon, Half Marathon, 10K, and 5K distances.">
    <meta property="og:title" content="Dhaka Marathon 2026">
    <meta property="og:description" content="Annual marathon event in Dhaka, Bangladesh">
    <meta property="og:url" content="https://dhakamarathon.com/signup">
</head>
<body>
    <h1>Dhaka Marathon 2026</h1>
    
    <div class="event-details">
        <div class="date">
            <strong>Date:</strong> December 15, 2026
        </div>
        <div class="time">
            <strong>Start Time:</strong> 6:00 AM
        </div>
        <div class="location">
            <strong>Location:</strong> Dhaka, Bangladesh
        </div>
    </div>
    
    <div class="distances">
        <h3>Available Distances</h3>
        <ul>
            <li>Marathon (42.195 km)</li>
            <li>Half Marathon (21.0975 km)</li>
            <li>10K Run</li>
            <li>5K Fun Run</li>
        </ul>
    </div>
    
    <div class="registration">
        <h3>Registration</h3>
        <p><strong>Entry Fee:</strong> BDT 2500</p>
        <p><strong>Deadline:</strong> November 30, 2026</p>
        <p><strong>Organized by:</strong> Bangladesh Athletics Federation</p>
    </div>
    
    <div class="description">
        <h3>About the Event</h3>
        <p>Join us for the annual Dhaka Marathon 2026! This premier running event attracts 
        thousands of runners from around the world. Experience the vibrant culture of Dhaka 
        while challenging yourself on our scenic course.</p>
    </div>
</body>
</html>
"""


# ─── Unit Tests ───────────────────────────────────────────────────────────────

def test_normalize_date():
    """Test date normalization."""
    print("Testing date normalization...")
    
    test_cases = [
        ("December 15, 2026", "2026-12-15"),
        ("12/15/2026", "2026-12-15"),
        ("2026-12-15", "2026-12-15"),
        ("15th Dec 2026", "2026-12-15"),
        ("Jan 1, 2026", "2026-01-01"),
    ]
    
    passed = 0
    for input_date, expected in test_cases:
        result = normalize_date(input_date)
        if result == expected:
            passed += 1
            print(f"  [PASS] '{input_date}' -> '{result}'")
        else:
            print(f"  [FAIL] '{input_date}' -> '{result}' (expected '{expected}')")
    
    print(f"  Result: {passed}/{len(test_cases)} passed\n")
    return passed == len(test_cases)


def test_normalize_time():
    """Test time normalization."""
    print("Testing time normalization...")
    
    test_cases = [
        ("06:00", "06:00"),
        ("6:00 AM", "06:00"),
        ("6:00 PM", "18:00"),
        ("18:30", "18:30"),
        ("12:00 PM", "12:00"),
    ]
    
    passed = 0
    for input_time, expected in test_cases:
        result = normalize_time(input_time)
        if result == expected:
            passed += 1
            print(f"  [PASS] '{input_time}' -> '{result}'")
        else:
            print(f"  [FAIL] '{input_time}' -> '{result}' (expected '{expected}')")
    
    print(f"  Result: {passed}/{len(test_cases)} passed\n")
    return passed == len(test_cases)


def test_extract_distances():
    """Test distance extraction."""
    print("Testing distance extraction...")
    
    test_cases = [
        ("Marathon and Half Marathon", ["Marathon", "Half Marathon"]),
        ("5K, 10K, and 21K", ["5K", "10K"]),  # 21K doesn't automatically mean Half Marathon
        ("42.195 km", ["Marathon"]),
        ("Ultra Marathon 50K", ["Ultra Marathon"]),
    ]
    
    passed = 0
    for input_text, expected in test_cases:
        result = extract_distances(input_text)
        # Check if all expected distances are in result (order doesn't matter)
        if result and all(dist in result for dist in expected):
            passed += 1
            print(f"  [PASS] '{input_text}' -> {result}")
        else:
            print(f"  [FAIL] '{input_text}' -> {result} (expected to contain {expected})")
    
    print(f"  Result: {passed}/{len(test_cases)} passed\n")
    return passed == len(test_cases)


def test_full_scrape():
    """Test full scraping with sample HTML."""
    print("Testing full scrape with sample HTML...")
    
    from bs4 import BeautifulSoup
    
    scraper = RaceScraper()
    soup = BeautifulSoup(SAMPLE_HTML, 'html.parser')
    
    # Test each extraction method
    tests = {
        'name': ('Dhaka Marathon 2026', scraper._extract_name(soup)),
        'date': ('2026-12-15', scraper._extract_date(soup)),
        'time': ('06:00', scraper._extract_time(soup)),
        'location': ('Dhaka, Bangladesh', scraper._extract_location(soup)),
        'organizer': ('Bangladesh Athletics Federation', scraper._extract_organizer(soup)),
        'entry_fee': ('BDT 2500', scraper._extract_entry_fee(soup)),
        'deadline': ('2026-11-30', scraper._extract_registration_deadline(soup)),
    }
    
    passed = 0
    for field, (expected, actual) in tests.items():
        if expected and actual and expected.lower() in actual.lower():
            passed += 1
            print(f"  [PASS] {field}: '{actual}'")
        elif expected == actual:
            passed += 1
            print(f"  [PASS] {field}: '{actual}'")
        else:
            print(f"  [FAIL] {field}: '{actual}' (expected '{expected}')")
    
    # Test distances (list comparison)
    distances = scraper._extract_distances(soup)
    if distances and len(distances) >= 3:
        passed += 1
        print(f"  [PASS] distances: {distances}")
    else:
        print(f"  [FAIL] distances: {distances} (expected at least 3)")
    
    # Test description
    description = scraper._extract_description(soup)
    if description and len(description) > 20:
        passed += 1
        print(f"  [PASS] description: '{description[:50]}...'")
    else:
        print(f"  [FAIL] description: '{description}' (expected non-empty)")
    
    total = len(tests) + 2  # +2 for distances and description
    print(f"  Result: {passed}/{total} passed\n")
    
    return passed == total


def test_json_output():
    """Test JSON output format."""
    print("Testing JSON output format...")
    
    import json
    
    # We can't actually scrape, so just test the data structure
    from race_scraper import RaceData
    
    race = RaceData(
        name="Test Race",
        date="2026-12-15",
        start_time="06:00",
        location="Test City",
        distances=["Marathon", "Half Marathon"],
        registration_url="https://example.com",
        registration_deadline="2026-11-30",
        organizer="Test Organizer",
        description="Test description",
        entry_fee="$100",
        source_url="https://example.com",
    )
    
    # Test to_dict
    data_dict = race.to_dict()
    if data_dict['name'] == 'Test Race' and data_dict['date'] == '2026-12-15':
        print("  [PASS] to_dict() works correctly")
    else:
        print("  [FAIL] to_dict() failed")
        return False
    
    # Test to_json
    json_str = race.to_json()
    try:
        parsed = json.loads(json_str)
        if parsed['name'] == 'Test Race':
            print("  [PASS] to_json() works correctly")
        else:
            print("  [FAIL] to_json() failed")
            return False
    except json.JSONDecodeError:
        print("  [FAIL] to_json() produced invalid JSON")
        return False
    
    print("  Result: 2/2 passed\n")
    return True


# ─── Main Test Runner ─────────────────────────────────────────────────────────

def main():
    """Run all tests."""
    print("=" * 70)
    print("RACE SCRAPER TEST SUITE")
    print("=" * 70)
    print()
    
    results = []
    
    # Run tests
    results.append(("Date Normalization", test_normalize_date()))
    results.append(("Time Normalization", test_normalize_time()))
    results.append(("Distance Extraction", test_extract_distances()))
    results.append(("Full Scrape", test_full_scrape()))
    results.append(("JSON Output", test_json_output()))
    
    # Summary
    print("=" * 70)
    print("TEST SUMMARY")
    print("=" * 70)
    
    passed = sum(1 for _, result in results if result)
    total = len(results)
    
    for test_name, result in results:
        status = "[PASS]" if result else "[FAIL]"
        print(f"  {status:8s} {test_name}")
    
    print()
    print(f"Total: {passed}/{total} tests passed")
    
    if passed == total:
        print("\n[SUCCESS] All tests passed!")
        return 0
    else:
        print(f"\n[ERROR] {total - passed} test(s) failed")
        return 1


if __name__ == "__main__":
    sys.exit(main())