"""Small offline tests for results extraction and matching."""

from bs4 import BeautifulSoup

from results_scraper import ResultsScraper, calculate_pace, format_results_summary, match_results


HTML = """
<html><head><title>City Marathon Results</title></head><body>
<h1>City Marathon Results</h1><p>Distance: 10K</p>
<table><tr><th>Place</th><th>Bib</th><th>Name</th><th>Gender Place</th><th>Time</th><th>Status</th></tr>
<tr><td>1</td><td>42</td><td>Ada Lovelace</td><td>1</td><td>00:42:00</td><td>Finished</td></tr>
<tr><td>2</td><td>43</td><td>Grace Hopper</td><td>1</td><td>DNF</td><td>DNF</td></tr></table>
</body></html>
"""


def test_extract_and_calculate():
    scraper = ResultsScraper()
    data = scraper._extract_table_rows(BeautifulSoup(HTML, "html.parser"))
    assert len(data) == 2
    assert data[0].runner_name == "Ada Lovelace"
    assert data[0].finish_time == "00:42:00"
    assert data[1].status == "dnf"
    assert calculate_pace("00:42:00", "10K") == "4:12/km"


def test_match_is_conservative():
    data = {"race_name": "City Marathon Results", "results": [{"runner_name": "Ada Lovelace"}, {"runner_name": "Unknown Runner"}]}
    match_results(data, [{"id": "race-1", "name": "City Marathon Results"}], [{"id": "runner-1", "name": "Ada Lovelace"}])
    assert data["marathon_id"] == "race-1"
    assert data["results"][0]["runner_id"] == "runner-1"
    assert data["results"][1]["runner_id"] is None
    assert "Unknown Runner" in " ".join(data["matching_notes"])


def test_summary_is_readable():
    output = format_results_summary({"race_name": "Test", "source_url": "https://example.test", "results": []})
    assert "SCRAPED RACE RESULTS SUMMARY" in output
    assert "Results found: 0" in output
