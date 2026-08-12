// PacePack race scraper — deploy THIS file (not the Hello World template)
// Dashboard: Edge Functions → scrape-race → replace all code → Deploy
// CLI: supabase functions deploy scrape-race --project-ref pzpsjifvlrpmxojyfkyh

import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts"

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, prefer",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

/** Parse JSON body without throwing on empty / non-JSON requests */
async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text()
  if (!text || !text.trim()) {
    return {}
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    throw new Error("Invalid JSON body")
  }
}

Deno.serve(async (req) => {
  // CORS preflight — never read body here
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed. Use POST." }, 405)
  }

  try {
    let payload: Record<string, unknown>
    try {
      payload = await readJsonBody(req)
    } catch (e) {
      return jsonResponse(
        { error: e instanceof Error ? e.message : "Invalid JSON body" },
        400,
      )
    }

    const url = typeof payload.url === "string" ? payload.url.trim() : ""

    if (!url) {
      return jsonResponse(
        {
          error: "URL is required",
          details: 'POST JSON body: { "url": "https://example.com/race" }',
        },
        400,
      )
    }

    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return jsonResponse(
        { error: "Invalid URL. Must start with http:// or https://" },
        400,
      )
    }

    // Basic SSRF guard
    try {
      const parsed = new URL(url)
      const host = parsed.hostname.toLowerCase()
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "0.0.0.0" ||
        host === "::1" ||
        host.endsWith(".local") ||
        host.startsWith("10.") ||
        host.startsWith("192.168.") ||
        host.startsWith("169.254.") ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
      ) {
        return jsonResponse({ error: "URL host is not allowed" }, 400)
      }
    } catch {
      return jsonResponse({ error: "Invalid URL format" }, 400)
    }

    const raceData = await scrapeRaceData(url)
    return jsonResponse({ success: true, data: raceData })
  } catch (error) {
    console.error("Scraping error:", error)
    const message =
      error instanceof Error ? error.message : "Failed to scrape race data"
    return jsonResponse(
      {
        error: message,
        details:
          "Make sure the URL is publicly accessible and contains race information",
      },
      500,
    )
  }
})

async function scrapeRaceData(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: new URL(url).origin + "/",
    },
    redirect: "follow",
  })

  if (!response.ok) {
    throw new Error(
      `Could not load page (HTTP ${response.status}: ${response.statusText})`,
    )
  }

  const contentType = response.headers.get("content-type") || ""
  if (
    contentType &&
    !contentType.includes("text/html") &&
    !contentType.includes("application/xhtml") &&
    !contentType.includes("text/plain")
  ) {
    throw new Error(
      `URL did not return HTML (got ${contentType}). Paste a race registration page URL.`,
    )
  }

  const html = await response.text()
  if (!html || html.length < 50) {
    throw new Error("Page returned empty content")
  }

  const doc = new DOMParser().parseFromString(html, "text/html")
  if (!doc) {
    throw new Error("Failed to parse HTML from the page")
  }

  return {
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
}

type Doc = NonNullable<ReturnType<DOMParser["parseFromString"]>>

function metaContent(doc: Doc, selector: string): string | null {
  const el = doc.querySelector(selector)
  const content = el?.getAttribute("content")
  return content ? cleanText(content) : null
}

function extractName(doc: Doc): string | null {
  const og = metaContent(doc, 'meta[property="og:title"]')
  if (og) return og

  const title = doc.querySelector("title")?.textContent
  if (title) return cleanText(title)

  const h1 = doc.querySelector("h1")?.textContent
  if (h1) return cleanText(h1)

  return null
}

function extractDate(doc: Doc): string | null {
  const eventTime =
    metaContent(doc, 'meta[property="event:start_time"]') ||
    metaContent(doc, 'meta[itemprop="startDate"]')
  if (eventTime) {
    const d = new Date(eventTime)
    if (!isNaN(d.getTime())) return d.toISOString().split("T")[0]
  }

  const text = doc.body?.textContent || ""
  const patterns = [
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i,
    /(\d{1,2})\/(\d{1,2})\/(\d{4})/,
    /(\d{4})-(\d{2})-(\d{2})/,
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) {
      const date = new Date(match[0])
      if (!isNaN(date.getTime())) {
        return date.toISOString().split("T")[0]
      }
    }
  }

  return null
}

function extractTime(doc: Doc): string | null {
  const text = doc.body?.textContent || ""
  const timePatterns = [
    /(\d{1,2}):(\d{2})\s*(AM|PM)/i,
    /(?:start(?:s|ing)?\s*(?:time)?|gun\s*time)[:\s]+(\d{1,2}):(\d{2})/i,
  ]

  for (const pattern of timePatterns) {
    const match = text.match(pattern)
    if (match) {
      let hours = parseInt(match[1], 10)
      const minutes = match[2]
      const meridiem = match[3]?.toUpperCase()

      if (meridiem === "PM" && hours < 12) hours += 12
      if (meridiem === "AM" && hours === 12) hours = 0

      return `${String(hours).padStart(2, "0")}:${minutes}`
    }
  }

  return null
}

function extractLocation(doc: Doc): string | null {
  const ogLoc = metaContent(doc, 'meta[property="og:locality"]')
  if (ogLoc) return ogLoc

  const text = doc.body?.textContent || ""
  const locationPatterns = [
    /Location[:\s]+([^\n|]+)/i,
    /Venue[:\s]+([^\n|]+)/i,
    /Address[:\s]+([^\n|]+)/i,
    /Where[:\s]+([^\n|]+)/i,
  ]

  for (const pattern of locationPatterns) {
    const match = text.match(pattern)
    if (match?.[1]) {
      const cleaned = cleanText(match[1])
      if (cleaned && cleaned.length < 200) return cleaned
    }
  }

  return null
}

function extractDistances(doc: Doc): string[] | null {
  const text = doc.body?.textContent || ""
  const distances: string[] = []

  const patterns = [
    { regex: /ultra[\s-]?marathon/i, label: "Ultra Marathon" },
    { regex: /half[\s-]?marathon/i, label: "Half Marathon" },
    { regex: /\bmarathon\b/i, label: "Marathon" },
    { regex: /\b10[\s-]?k\b/i, label: "10K" },
    { regex: /\b5[\s-]?k\b/i, label: "5K" },
    { regex: /42\.?\s?195\s?km/i, label: "Marathon" },
    { regex: /21\.?\s?0975?\s?km/i, label: "Half Marathon" },
  ]

  for (const pattern of patterns) {
    if (pattern.regex.test(text) && !distances.includes(pattern.label)) {
      distances.push(pattern.label)
    }
  }

  return distances.length > 0 ? distances : null
}

function extractDeadline(doc: Doc): string | null {
  const text = doc.body?.textContent || ""
  const deadlinePatterns = [
    /(?:registration\s+)?deadline[:\s]+([^\n]+)/i,
    /closes[:\s]+([^\n]+)/i,
    /register by[:\s]+([^\n]+)/i,
  ]

  for (const pattern of deadlinePatterns) {
    const match = text.match(pattern)
    if (match?.[1]) {
      const date = new Date(match[1].slice(0, 40))
      if (!isNaN(date.getTime())) {
        return date.toISOString().split("T")[0]
      }
    }
  }

  return null
}

function extractOrganizer(doc: Doc): string | null {
  const text = doc.body?.textContent || ""
  const organizerPatterns = [
    /organized by[:\s]+([^\n.]+)/i,
    /presented by[:\s]+([^\n.]+)/i,
    /hosted by[:\s]+([^\n.]+)/i,
  ]

  for (const pattern of organizerPatterns) {
    const match = text.match(pattern)
    if (match?.[1]) {
      return cleanText(match[1])
    }
  }

  return null
}

function extractDescription(doc: Doc): string | null {
  const metaDesc = metaContent(doc, 'meta[name="description"]')
  if (metaDesc) return metaDesc

  const ogDesc = metaContent(doc, 'meta[property="og:description"]')
  if (ogDesc) return ogDesc

  const firstP = doc.querySelector("p")?.textContent
  if (firstP) {
    const text = cleanText(firstP)
    return text && text.length > 20 ? text.slice(0, 500) : null
  }

  return null
}

function extractEntryFee(doc: Doc): string | null {
  const text = doc.body?.textContent || ""
  const feePatterns = [
    /(?:entry|registration|signup)\s+fee[:\s]+([^\n]+)/i,
    /\$\s*(\d+(?:\.\d{2})?)/,
    /\b([A-Z]{3}\s+\d+(?:,\d{3})*(?:\.\d{2})?)\b/,
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
  const cleaned = text.trim().replace(/\s+/g, " ")
  return cleaned || null
}
