// PacePack results scraper. Deploy with: supabase functions deploy scrape-results
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts"

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" }
const clean = (v: string | null | undefined) => (v || "").replace(/\s+/g, " ").trim()
const key = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "")
const aliases: Record<string, string> = { name: "runner_name", runner: "runner_name", participant: "runner_name", fullname: "runner_name", time: "finish_time", finishtime: "finish_time", chiptime: "finish_time", guntime: "finish_time", pace: "pace", gender: "gender", sex: "gender", agegroup: "age_category", category: "age_category", place: "overall_place", overall: "overall_place", overallplace: "overall_place", rank: "overall_place", genderplace: "gender_place", sexplace: "gender_place", categoryplace: "category_place", agegroupplace: "category_place", bib: "bib", bibnumber: "bib", status: "status" }
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } }) }
function time(value: string) { const match = value.match(/(?:(\d{1,2})\s*[:h]\s*)?(\d{1,2})\s*[:m]\s*(\d{2})/i); return match ? `${String(match[1] || 0).padStart(2, "0")}:${match[2].padStart(2, "0")}:${match[3].padStart(2, "0")}` : null }
function status(value: string) { const v = value.toLowerCase(); return /dns|did not start/.test(v) ? "dns" : /dnf|did not finish|disqual/.test(v) ? "dnf" : "completed" }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
  try {
    const { url } = await req.json()
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return json({ error: "A valid results URL is required" }, 400)
    const response = await fetch(url, { headers: { "User-Agent": "PacePack results importer/1.0", Accept: "text/html" } })
    if (!response.ok) throw new Error(`Could not load page (HTTP ${response.status})`)
    const doc = new DOMParser().parseFromString(await response.text(), "text/html")
    if (!doc) throw new Error("Could not parse results page")
    const title = clean(doc.querySelector('meta[property="og:title"]')?.getAttribute("content") || doc.querySelector("h1")?.textContent || doc.querySelector("title")?.textContent)
    const pageText = clean(doc.body?.textContent || "")
    const distance = pageText.match(/(?:42\.195|21\.0975|42|21|10|5)\s*km|(?:half\s+)?marathon|(?:5|10|15|20|21|42)\s*k/i)?.[0] || null
    let best: any[] = []
    for (const table of Array.from(doc.querySelectorAll("table"))) {
      const trs = Array.from(table.querySelectorAll("tr")); const headers = Array.from(trs[0]?.querySelectorAll("th,td") || []).map((cell) => aliases[key(clean(cell.textContent))] || null)
      if (!headers.includes("runner_name")) continue
      const rows = trs.slice(1).map((tr) => { const cells = Array.from(tr.querySelectorAll("td,th")).map((cell) => clean(cell.textContent)); const row: any = {}; headers.forEach((header, i) => { if (header && cells[i]) row[header] = cells[i] }); if (!row.runner_name) return null; row.finish_time = time(row.finish_time || ""); row.status = status(row.status || row.finish_time || ""); return row }).filter(Boolean)
      if (rows.length > best.length) best = rows
    }
    return json({ success: true, data: { race_name: title || null, distance, source_url: url, results: best } })
  } catch (error) { return json({ error: error instanceof Error ? error.message : "Failed to scrape results" }, 500) }
})
