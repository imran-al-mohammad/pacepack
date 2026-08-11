"""
Example: Using the Race Scraper with Supabase

This example demonstrates how to:
1. Scrape race data from a URL
2. Insert it into your Supabase marathons table

Setup:
    1. Install dependencies: pip install -r requirements.txt
    2. Set up environment variables (see .env.example)
    3. Run: python example_usage.py <url>
"""

from __future__ import annotations

import os
import sys
from typing import Optional

from dotenv import load_dotenv
from supabase import create_client, Client

# Import the scraper
from race_scraper import scrape_race


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
    # Map scraped fields to database columns
    # Note: distances is a list in scraped data but single field in DB
    # You may want to store it in notes or create a separate table
    
    distances_str = ", ".join(race_data.get("distances") or []) if race_data.get("distances") else None
    
    return {
        "group_id": group_id,
        "name": race_data.get("name"),
        "race_date": race_data.get("date"),  # Already in YYYY-MM-DD format
        "race_time": race_data.get("start_time"),  # Already in HH:MM format
        "location": race_data.get("location"),
        "distance": distances_str,  # Store as comma-separated string
        "notes": race_data.get("description"),
        "reg_open_date": None,  # Not typically available from signup pages
        "reg_close_date": race_data.get("registration_deadline"),  # Already in YYYY-MM-DD
        "reg_link": race_data.get("registration_url"),
        "image_url": None,  # Not scraped in basic version
    }


# ─── Supabase Operations ──────────────────────────────────────────────────────

def insert_race_to_supabase(supabase: Client, race_data: dict, group_id: str) -> Optional[dict]:
    """
    Insert scraped race data into Supabase marathons table.
    
    Args:
        supabase: Supabase client instance
        race_data: Dictionary from scrape_race()
        group_id: UUID of the group to assign the race to
        
    Returns:
        Inserted record with ID, or None if failed
    """
    try:
        # Transform data to match table schema
        db_record = transform_to_marathons_table(race_data, group_id)
        
        # Insert into database
        result = supabase.table("marathons").insert(db_record).execute()
        
        if result.data:
            print(f"✅ Successfully inserted race: {race_data.get('name')}")
            print(f"   Database ID: {result.data[0]['id']}")
            return result.data[0]
        else:
            print("❌ Insert failed - no data returned")
            return None
            
    except Exception as e:
        print(f"❌ Error inserting to Supabase: {e}")
        return None


def check_if_race_exists(supabase: Client, race_name: str, group_id: str) -> Optional[dict]:
    """
    Check if a race already exists in the database.
    
    Args:
        supabase: Supabase client instance
        race_name: Name of the race to check
        group_id: UUID of the group
        
    Returns:
        Existing race record or None
    """
    try:
        result = supabase.table("marathons")\
            .select("*")\
            .eq("group_id", group_id)\
            .eq("name", race_name)\
            .execute()
        
        if result.data:
            return result.data[0]
        return None
        
    except Exception as e:
        print(f"⚠️  Error checking existing race: {e}")
        return None


# ─── Main Example ─────────────────────────────────────────────────────────────

def main():
    """Main example function."""
    
    # Check for URL argument
    if len(sys.argv) < 2:
        print("Usage: python example_usage.py <race_url> [group_id]")
        print("\nExample:")
        print("  python example_usage.py https://example.com/marathon-signup")
        print("  python example_usage.py https://example.com/marathon-signup your-group-uuid")
        sys.exit(1)
    
    url = sys.argv[1]
    group_id = sys.argv[2] if len(sys.argv) > 2 else os.getenv("DEFAULT_GROUP_ID")
    
    if not group_id:
        print("❌ Error: group_id is required (pass as argument or set DEFAULT_GROUP_ID in .env)")
        sys.exit(1)
    
    # Step 1: Scrape the race data
    print("=" * 70)
    print("STEP 1: Scraping Race Data")
    print("=" * 70)
    print(f"URL: {url}\n")
    
    try:
        race_data = scrape_race(url)
        print("✅ Scraping successful!\n")
        print("Extracted data:")
        print("-" * 70)
        for key, value in race_data.items():
            print(f"  {key:20s}: {value}")
        print("-" * 70)
    except Exception as e:
        print(f"❌ Scraping failed: {e}")
        sys.exit(1)
    
    # Step 2: Connect to Supabase
    print("\n" + "=" * 70)
    print("STEP 2: Connecting to Supabase")
    print("=" * 70)
    
    supabase = get_supabase_client()
    if not supabase:
        print("\n⚠️  Skipping Supabase insertion (not configured)")
        print("   To enable Supabase integration:")
        print("   1. Create a .env file with SUPABASE_URL and SUPABASE_KEY")
        print("   2. Or set DEFAULT_GROUP_ID environment variable")
        sys.exit(0)
    
    print("✅ Connected to Supabase\n")
    
    # Step 3: Check if race already exists
    print("=" * 70)
    print("STEP 3: Checking for Duplicates")
    print("=" * 70)
    
    existing = check_if_race_exists(supabase, race_data.get("name"), group_id)
    
    if existing:
        print(f"⚠️  Race already exists in database:")
        print(f"   Name: {existing['name']}")
        print(f"   Date: {existing['race_date']}")
        print(f"   ID: {existing['id']}")
        
        response = input("\nDo you want to update it? (y/N): ").strip().lower()
        if response == 'y':
            # Update existing record
            try:
                db_record = transform_to_marathons_table(race_data, group_id)
                result = supabase.table("marathons")\
                    .update(db_record)\
                    .eq("id", existing['id'])\
                    .execute()
                print(f"✅ Updated race: {race_data.get('name')}")
            except Exception as e:
                print(f"❌ Error updating: {e}")
        else:
            print("Skipping insertion.")
    else:
        # Step 4: Insert new race
        print("✅ No duplicate found, inserting new race...\n")
        
        print("=" * 70)
        print("STEP 4: Inserting to Database")
        print("=" * 70)
        
        inserted = insert_race_to_supabase(supabase, race_data, group_id)
        
        if inserted:
            print("\n" + "=" * 70)
            print("SUCCESS! Race added to database.")
            print("=" * 70)
            print(f"Race ID: {inserted['id']}")
            print(f"Name: {inserted['name']}")
            print(f"Date: {inserted['race_date']}")
            print(f"Location: {inserted['location']}")
        else:
            print("\n❌ Failed to insert race")
            sys.exit(1)
    
    # Step 5: Save scraped data to JSON file
    print("\n" + "=" * 70)
    print("STEP 5: Saving Data")
    print("=" * 70)
    
    import json
    output_file = "scraped_race.json"
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(race_data, f, indent=2, ensure_ascii=False)
    
    print(f"✅ Scraped data saved to: {output_file}")


# ─── Batch Processing Example ─────────────────────────────────────────────────

def scrape_multiple_races(urls: list[str], group_id: str, supabase: Optional[Client] = None):
    """
    Scrape multiple race URLs and optionally insert to Supabase.
    
    Args:
        urls: List of race registration URLs
        group_id: Group ID for Supabase
        supabase: Optional Supabase client for auto-insert
    """
    results = []
    
    for url in urls:
        print(f"\n{'='*70}")
        print(f"Processing: {url}")
        print('='*70)
        
        try:
            # Scrape
            race_data = scrape_race(url)
            results.append(race_data)
            
            print(f"✅ {race_data.get('name', 'Unknown Race')}")
            print(f"   Date: {race_data.get('date', 'N/A')}")
            print(f"   Location: {race_data.get('location', 'N/A')}")
            
            # Insert to Supabase if client provided
            if supabase:
                insert_race_to_supabase(supabase, race_data, group_id)
                
        except Exception as e:
            print(f"❌ Failed: {e}")
            results.append({"url": url, "error": str(e)})
    
    return results


# ─── Run ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    main()