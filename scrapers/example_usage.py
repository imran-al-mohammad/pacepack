"""
Example: Using the Race Scraper with Supabase

Flow:
    1. Scrape race data from a URL
    2. Display a readable summary (no DB write yet)
    3. Ask for confirmation (y/n)
    4. Insert into Supabase only if the user confirms

Setup:
    1. Install dependencies: pip install -r requirements.txt
    2. Set up environment variables (see .env.example)
    3. Run: python example_usage.py <url> [group_id]
"""

from __future__ import annotations

import json
import os
import sys
from typing import Optional

from dotenv import load_dotenv
from supabase import create_client, Client

# Scraper + confirmation helpers
from race_scraper import (
    scrape_race,
    print_race_summary,
    confirm_save,
)


# ─── Supabase Configuration ────────────────────────────────────────────────────

def get_supabase_client() -> Optional[Client]:
    """
    Initialize Supabase client from environment variables.

    Required environment variables:
        SUPABASE_URL: Your Supabase project URL
        SUPABASE_KEY: Your Supabase anon/public key

    Returns:
        Supabase client instance or None if not configured
    """
    load_dotenv()

    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_KEY")

    if not url or not key:
        print("⚠️  Supabase credentials not found in environment variables.")
        print("   Please set SUPABASE_URL and SUPABASE_KEY in .env file")
        return None

    try:
        client = create_client(url, key)
        return client
    except Exception as e:
        print(f"❌ Error connecting to Supabase: {e}")
        return None


# ─── Data Transformation ──────────────────────────────────────────────────────

def transform_to_marathons_table(race_data: dict, group_id: str) -> dict:
    """
    Transform scraped race data to match the marathons table schema.

    Args:
        race_data: Dictionary from scrape_race()
        group_id: UUID of the group to assign the race to

    Returns:
        Dictionary ready for insertion into marathons table
    """
    distances_str = (
        ", ".join(race_data.get("distances") or [])
        if race_data.get("distances")
        else None
    )

    return {
        "group_id": group_id,
        "name": race_data.get("name"),
        "race_date": race_data.get("date"),
        "race_time": race_data.get("start_time"),
        "location": race_data.get("location"),
        "distance": distances_str,
        "notes": race_data.get("description"),
        "reg_open_date": None,
        "reg_close_date": race_data.get("registration_deadline"),
        "reg_link": race_data.get("registration_url"),
        "image_url": None,
    }


# ─── Supabase Operations ──────────────────────────────────────────────────────

def insert_race_to_supabase(
    supabase: Client, race_data: dict, group_id: str
) -> Optional[dict]:
    """
    Insert scraped race data into Supabase marathons table.

    Call this only AFTER the user has confirmed via confirm_save().

    Args:
        supabase: Supabase client instance
        race_data: Dictionary from scrape_race()
        group_id: UUID of the group to assign the race to

    Returns:
        Inserted record with ID, or None if failed
    """
    try:
        db_record = transform_to_marathons_table(race_data, group_id)
        result = supabase.table("marathons").insert(db_record).execute()

        if result.data:
            print(f"✅ Successfully inserted race: {race_data.get('name')}")
            print(f"   Database ID: {result.data[0]['id']}")
            return result.data[0]

        print("❌ Insert failed - no data returned")
        return None

    except Exception as e:
        print(f"❌ Error inserting to Supabase: {e}")
        return None


def update_race_in_supabase(
    supabase: Client, race_id: str, race_data: dict, group_id: str
) -> Optional[dict]:
    """Update an existing marathon row after user confirmation."""
    try:
        db_record = transform_to_marathons_table(race_data, group_id)
        result = (
            supabase.table("marathons")
            .update(db_record)
            .eq("id", race_id)
            .execute()
        )
        if result.data:
            print(f"✅ Updated race: {race_data.get('name')}")
            return result.data[0]
        print("❌ Update failed - no data returned")
        return None
    except Exception as e:
        print(f"❌ Error updating Supabase: {e}")
        return None


def check_if_race_exists(
    supabase: Client, race_name: Optional[str], group_id: str
) -> Optional[dict]:
    """
    Check if a race already exists in the database (by name + group).

    Returns:
        Existing race record or None
    """
    if not race_name:
        return None

    try:
        result = (
            supabase.table("marathons")
            .select("*")
            .eq("group_id", group_id)
            .eq("name", race_name)
            .execute()
        )
        if result.data:
            return result.data[0]
        return None
    except Exception as e:
        print(f"⚠️  Error checking existing race: {e}")
        return None


def save_local_json(race_data: dict, output_file: str = "scraped_race.json") -> None:
    """Write scraped payload to a local JSON file (also gated by confirmation)."""
    try:
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(race_data, f, indent=2, ensure_ascii=False)
        print(f"✅ Scraped data also saved to: {output_file}")
    except OSError as e:
        print(f"⚠️  Could not write {output_file}: {e}")


# ─── Main Example ─────────────────────────────────────────────────────────────

def main():
    """
    Main CLI flow:

        scrape → summary → confirm → (optional) Supabase insert/update
                                 ↘ cancel: no DB write
    """
    if len(sys.argv) < 2:
        print("Usage: python example_usage.py <race_url> [group_id]")
        print("\nExample:")
        print("  python example_usage.py https://example.com/marathon-signup")
        print(
            "  python example_usage.py https://example.com/marathon-signup your-group-uuid"
        )
        sys.exit(1)

    url = sys.argv[1]
    group_id = sys.argv[2] if len(sys.argv) > 2 else os.getenv("DEFAULT_GROUP_ID")

    # ── Step 1: Scrape only (never writes to DB) ─────────────────────────────
    print("=" * 70)
    print("STEP 1: Scraping Race Data")
    print("=" * 70)
    print(f"URL: {url}\n")

    try:
        race_data = scrape_race(url)
        print("✅ Scraping successful!")
    except Exception as e:
        print(f"❌ Scraping failed: {e}")
        sys.exit(1)

    # ── Step 2: Show summary (still no insert) ───────────────────────────────
    print("\n" + "=" * 70)
    print("STEP 2: Review Scraped Summary")
    print("=" * 70)
    print_race_summary(race_data)

    # ── Step 3: Confirmation gate ────────────────────────────────────────────
    print("=" * 70)
    print("STEP 3: Confirmation")
    print("=" * 70)

    if not confirm_save("Do you want to save this race? (y/n): "):
        print("\n🚫 Cancelled. Data was not saved to the database.")
        sys.exit(0)

    print("\n✅ Confirmed. Proceeding to save…\n")

    # ── Step 4: Connect to Supabase ──────────────────────────────────────────
    print("=" * 70)
    print("STEP 4: Connecting to Supabase")
    print("=" * 70)

    supabase = get_supabase_client()
    if not supabase:
        print("\n⚠️  Supabase not configured — saving local JSON only.")
        save_local_json(race_data)
        print("   To enable Supabase:")
        print("   1. Create a .env with SUPABASE_URL and SUPABASE_KEY")
        print("   2. Pass group_id or set DEFAULT_GROUP_ID")
        sys.exit(0)

    if not group_id:
        print("❌ Error: group_id is required after confirmation to insert.")
        print("   Pass as argument or set DEFAULT_GROUP_ID in .env")
        # User already said yes — still offer local save
        save_local_json(race_data)
        sys.exit(1)

    print("✅ Connected to Supabase\n")

    # ── Step 5: Duplicate check + insert/update ──────────────────────────────
    print("=" * 70)
    print("STEP 5: Saving to Database")
    print("=" * 70)

    existing = check_if_race_exists(supabase, race_data.get("name"), group_id)

    if existing:
        print("⚠️  A race with this name already exists:")
        print(f"   Name: {existing.get('name')}")
        print(f"   Date: {existing.get('race_date')}")
        print(f"   ID:   {existing.get('id')}")

        # Second confirmation only for overwrite
        if not confirm_save("Do you want to UPDATE the existing race? (y/n): "):
            print("\n🚫 Cancelled. Existing race was not modified.")
            sys.exit(0)

        updated = update_race_in_supabase(
            supabase, existing["id"], race_data, group_id
        )
        if not updated:
            sys.exit(1)
        print("\n" + "=" * 70)
        print("SUCCESS! Race updated in database.")
        print("=" * 70)
    else:
        inserted = insert_race_to_supabase(supabase, race_data, group_id)
        if not inserted:
            print("\n❌ Failed to insert race")
            sys.exit(1)

        print("\n" + "=" * 70)
        print("SUCCESS! Race added to database.")
        print("=" * 70)
        print(f"Race ID:  {inserted.get('id')}")
        print(f"Name:     {inserted.get('name')}")
        print(f"Date:     {inserted.get('race_date')}")
        print(f"Location: {inserted.get('location')}")

    # Optional local backup (user already confirmed save)
    print("\n" + "=" * 70)
    print("STEP 6: Local Backup")
    print("=" * 70)
    save_local_json(race_data)


# ─── Batch Processing Example ─────────────────────────────────────────────────

def scrape_multiple_races(
    urls: list[str],
    group_id: str,
    supabase: Optional[Client] = None,
    *,
    ask_each: bool = True,
):
    """
    Scrape multiple race URLs. Optionally insert to Supabase.

    For each URL:
      scrape → print summary → confirm (if ask_each) → insert

    Args:
        urls: List of race registration URLs
        group_id: Group ID for Supabase
        supabase: Optional Supabase client for auto-insert
        ask_each: If True, confirm each race before insert (recommended)
    """
    results = []

    for url in urls:
        print(f"\n{'=' * 70}")
        print(f"Processing: {url}")
        print("=" * 70)

        try:
            race_data = scrape_race(url)
            results.append(race_data)

            # Always show summary before any write
            print_race_summary(race_data)

            if not supabase:
                continue

            if ask_each and not confirm_save(
                f"Save «{race_data.get('name') or 'this race'}» to Supabase? (y/n): "
            ):
                print("🚫 Skipped — data was not saved.")
                continue

            insert_race_to_supabase(supabase, race_data, group_id)

        except Exception as e:
            print(f"❌ Failed: {e}")
            results.append({"url": url, "error": str(e)})

    return results


# ─── Run ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    main()
