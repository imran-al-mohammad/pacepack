import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Parse request body
    const { url } = await req.json()
    
    if (!url) {
      return new Response(
        JSON.stringify({ error: 'URL is required' }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    // Validate URL
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return new Response(
        JSON.stringify({ error: 'Invalid URL. Must start with http:// or https://' }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    // Scrape the race data using Python-like logic in TypeScript
    const raceData = await scrapeRaceData(url)
    
    return new Response(
      JSON.stringify({ success: true, data: raceData }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )

  } catch (error) {
    console.error('Scraping error:', error)
    return new Response(
      JSON.stringify({ 
        error: error.message || 'Failed to scrape race data',
        details: 'Make sure the URL is accessible and contains race information'
      }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )
  }
})

/**
 * Scrape race data from a URL
 * This is a TypeScript implementation of the Python scraper
 */
async function scrapeRaceData(url: string): Promise<any> {
  try {
    // Fetch the page
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    })
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    
    const html = await response.text()
    
    // Parse HTML
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')
    
    // Extract data
    const data = {
      name: extractName(doc),
      date: extractDate(doc),
      start_time: extractTime(doc),
      location: extractLocation(doc),
      distances: extractDistances(doc),
      registration_url: url,
      registration_deadline: extractDeadline(doc),
      organizer: extractOrganizer(doc),
      description: extractDescription(doc),
      entry_fee: extractEntryFee(doc),
      source_url: url,
    }
    
    return data
  } catch (error) {
    console.error('Scraping failed:', error)
    throw error
  }
}

function extractName(doc: Document): string | null {
  // Try Open Graph
  const ogTitle = doc.querySelector('meta[property="og:title"]')
  if (ogTitle?.getAttribute('content')) {
    return cleanText(ogTitle.getAttribute('content')!)
  }
  
  // Try title tag
  const title = doc.querySelector('title')
  if (title?.textContent) {
    return cleanText(title.textContent)
  }
  
  // Try h1
  const h1 = doc.querySelector('h1')
  if (h1?.textContent) {
    return cleanText(h1.textContent)
  }
  
  return null
}

function extractDate(doc: Document): string | null {
  // Look for date patterns in text
  const text = doc.body?.textContent || ''
  
  // Common date patterns
  const patterns = [
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i,
    /(\d{1,2})\/(\d{1,2})\/(\d{4})/,
    /(\d{4})-(\d{2})-(\d{2})/,
  ]
  
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) {
      try {
        const date = new Date(match[0])
        if (!isNaN(date.getTime())) {
          return date.toISOString().split('T')[0] // YYYY-MM-DD
        }
      } catch {}
    }
  }
  
  return null
}

function extractTime(doc: Document): string | null {
  const text = doc.body?.textContent || ''
  
  // Look for time patterns
  const timePatterns = [
    /(\d{1,2}):(\d{2})\s*(AM|PM)?/i,
    /(\d{1,2}):(\d{2})/,
  ]
  
  for (const pattern of timePatterns) {
    const match = text.match(pattern)
    if (match) {
      let hours = parseInt(match[1])
      const minutes = match[2]
      const meridiem = match[3]?.toUpperCase()
      
      if (meridiem === 'PM' && hours < 12) hours += 12
      if (meridiem === 'AM' && hours === 12) hours = 0
      
      return `${String(hours).padStart(2, '0')}:${minutes}`
    }
  }
  
  return null
}

function extractLocation(doc: Document): string | null {
  // Look for location patterns
  const text = doc.body?.textContent || ''
  
  // Common location patterns
  const locationPatterns = [
    /Location[:\s]+([^\n]+)/i,
    /Venue[:\s]+([^\n]+)/i,
    /Address[:\s]+([^\n]+)/i,
  ]
  
  for (const pattern of locationPatterns) {
    const match = text.match(pattern)
    if (match?.[1]) {
      return cleanText(match[1])
    }
  }
  
  return null
}

function extractDistances(doc: Document): string[] | null {
  const text = doc.body?.textContent || ''
  const distances: string[] = []
  
  const patterns = [
    { regex: /ultra[\s-]?marathon/i, label: 'Ultra Marathon' },
    { regex: /half[\s-]?marathon/i, label: 'Half Marathon' },
    { regex: /\bmarathon\b/i, label: 'Marathon' },
    { regex: /\b10[\s-]?k\b/i, label: '10K' },
    { regex: /\b5[\s-]?k\b/i, label: '5K' },
    { regex: /42\.\s?195\s?km/i, label: 'Marathon' },
    { regex: /21\.\s?0975\s?km/i, label: 'Half Marathon' },
  ]
  
  for (const pattern of patterns) {
    if (pattern.regex.test(text) && !distances.includes(pattern.label)) {
      distances.push(pattern.label)
    }
  }
  
  return distances.length > 0 ? distances : null
}

function extractDeadline(doc: Document): string | null {
  const text = doc.body?.textContent || ''
  
  const deadlinePatterns = [
    /deadline[:\s]+([^\n]+)/i,
    /closes[:\s]+([^\n]+)/i,
    /register by[:\s]+([^\n]+)/i,
  ]
  
  for (const pattern of deadlinePatterns) {
    const match = text.match(pattern)
    if (match?.[1]) {
      const date = new Date(match[1])
      if (!isNaN(date.getTime())) {
        return date.toISOString().split('T')[0]
      }
    }
  }
  
  return null
}

function extractOrganizer(doc: Document): string | null {
  const text = doc.body?.textContent || ''
  
  const organizerPatterns = [
    /organized by[:\s]+([^\n\.]+)/i,
    /presented by[:\s]+([^\n\.]+)/i,
    /hosted by[:\s]+([^\n\.]+)/i,
  ]
  
  for (const pattern of organizerPatterns) {
    const match = text.match(pattern)
    if (match?.[1]) {
      return cleanText(match[1])
    }
  }
  
  return null
}

function extractDescription(doc: Document): string | null {
  // Try meta description
  const metaDesc = doc.querySelector('meta[name="description"]')
  if (metaDesc?.getAttribute('content')) {
    return cleanText(metaDesc.getAttribute('content')!)
  }
  
  // Try first paragraph
  const firstP = doc.querySelector('p')
  if (firstP?.textContent) {
    const text = cleanText(firstP.textContent)
    return text && text.length > 20 ? text.slice(0, 500) : null
  }
  
  return null
}

function extractEntryFee(doc: Document): string | null {
  const text = doc.body?.textContent || ''
  
  const feePatterns = [
    /(?:entry|registration|signup)\s+fee[:\s]+([^\n]+)/i,
    /\$\s*(\d+(?:\.\d{2})?)/,
    /([A-Z]{3}\s+\d+(?:,\d{3})*(?:\.\d{2})?)/,
  ]
  
  for (const pattern of feePatterns) {
    const match = text.match(pattern)
    if (match?.[1]) {
      return cleanText(match[1])
    }
  }
  
  return null
}

function cleanText(text: string): string | null {
  if (!text) return null
  const cleaned = text.trim().replace(/\s+/g, ' ')
  return cleaned || null
}