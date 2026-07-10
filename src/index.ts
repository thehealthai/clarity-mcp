// clarity-mcp — Model Context Protocol server for the Clarity ingredient DB.
//
// Transport: MCP Streamable HTTP. A single endpoint (POST /) accepts JSON-RPC
// 2.0 requests: `initialize`, `tools/list`, `tools/call`. GET / returns a small
// human-readable info page.
//
// Every tool response includes, per lens: verdict and evidence_tier (source_type).
// Citations come from public.claim_citations_v2 (status='live', RLS service-key
// only) via the shared provenance module. Evidence model:
//   evidence_state='cited'      -> >=1 VERIFIED citation (curated / licensed regulator)
//   evidence_state='referenced' -> only 'sourced' (real but category-level) citations
//   no citations                -> those keys are omitted; the verdict/tier still stand
// citation_count = VERIFIED only (the "Cited · N" stamp); referenced_count = sourced.
// Agents get the claim AND its provenance — honesty over completeness is the design
// (see docs/operations/CITATION_BACKBONE_README.md).
//
// Query logic mirrors workers/clarity-check (Supabase REST, cascading ilike)
// and workers/clarity-services (OFF/OBF barcode lookup).

import {
  type Cite,
  PROVENANCE_LENS_MAP as LENS_MAP,
  fetchLiveCitations,
  fetchCitationsBySourceKey,
  mapWebLensToProvenance,
  resolveEvidence,
  isVerifiedCite,
  dedupeCites,
} from "./provenance";
import { getIngredientAmbiguityForQuery } from "./ingredient-ambiguity";
import { fetchIngredientSignalOverlays } from "./product-signal-overlays";
import { looksLikeProbiotic, fetchProbioticSignals } from "./probiotic-signals";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  // Workers Analytics Engine (optional binding) — per-tool usage telemetry.
  MCP_ANALYTICS?: { writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void };
  // Cloudflare rate-limiting binding — cheap first-pass burst filter only.
  // Empirically its counters are per-SERVER within a colo: 100-req bursts
  // from one IP passed untouched. Never sufficient alone.
  ANON_RL?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  // Durable Object rate limiter — the authoritative per-IP counter (one DO
  // instance per IP, globally unique, single-threaded → exact).
  RATE_DO?: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(url: string): Promise<Response> };
  };
}

// Globally-unique per-key sliding-window counter. In-memory state may reset
// if the DO hibernates after idle gaps — which only ever FORGIVES a caller,
// never over-blocks. Acceptable for abuse control.
export class RateLimiter {
  private hits: number[] = [];
  async fetch(): Promise<Response> {
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < 60_000);
    if (this.hits.length >= 60) return new Response("deny", { status: 429 });
    this.hits.push(now);
    return new Response("allow");
  }
}

// Served with every tool result. Consumer-health output consumed by agents
// MUST carry its own liability language — the agent may strip page context.
const DISCLAIMER =
  "Informational only — not medical advice. Where a verified citation exists it is surfaced with the claim; verify cited sources before acting. Consult a clinician for medical decisions.";

const SERVER_INFO = { name: "clarity-mcp", version: "0.5.0" };
const PROTOCOL_VERSION = "2025-06-18";

const IV_FIELDS = [
  "id", "name", "canonical_name", "category", "verdict", "source_type",
  "source_provenance", "citations", "lactation_safety", "pregnancy_safety",
  "toddler_safety", "histamine_severity", "dao_severity", "allergen_class",
  "is_hs_trigger", "hs_notes", "rosacea_flag", "mcas_notes",
].join(",");

// NOTE: this table's citation column is `pmid` (there is no pmid_refs); there is
// no research_notes column. The prior field list selected both nonexistent
// columns, which 400'd the PostgREST query and made strain_lookup match nothing.
const STRAIN_FIELDS = [
  "id", "name", "canonical_name", "verdict", "source_type", "pmid",
  "is_mcas_trigger", "is_hepatotoxic", "is_uterine_stimulant",
  "is_phytoestrogenic", "is_anticoagulant", "allergen_class",
].join(",");

// Per-lens claim mapping now lives in the core provenance module (imported
// above as LENS_MAP) so every surface grades evidence the same way.

function readHeaders(env: Env) {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
  };
}

// Strip PostgREST filter metacharacters so user input can't break out of an
// `or=(...)` group or inject filters. encodeURIComponent leaves ( ) * . ' , !
// unescaped, and those are PostgREST-reserved. Ingredient names/species never
// legitimately need them. Also caps length to bound abuse.
function sanitizeToken(raw: string): string {
  return String(raw || "")
    .replace(/[(),.*'"!:;{}\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

async function fetchRows(env: Env, url: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(url, { headers: readHeaders(env), signal: AbortSignal.timeout(2000) });
  if (!res.ok) return [];
  return (await res.json()) as Array<Record<string, unknown>>;
}

// evidence_state — the honesty contract — is resolved by the core provenance
// module (resolveEvidence); this just composes the MCP result shape around it.
function shape(row: Record<string, unknown>, lens: string, cites: Cite[]) {
  const map = LENS_MAP[lens] ?? LENS_MAP.all;
  const lensFindings: Record<string, unknown> = {};
  for (const f of map.display) if (row[f] !== undefined && row[f] !== null) lensFindings[f] = row[f];

  const ev = resolveEvidence(row, lens, cites);
  // dedupe within the lens list (verified-first so the strongest sources lead),
  // then drop from the general list any paper already surfaced lens-specifically.
  const lensDeduped = dedupeCites(ev.citations);
  const lensCites = [...lensDeduped.filter(isVerifiedCite), ...lensDeduped.filter((c) => !isVerifiedCite(c))];
  const seen = new Set(
    lensCites.map((c) => (c.pmid ? `pmid:${c.pmid}` : c.url ? `url:${c.url}` : "")).filter(Boolean),
  );
  const generalDeduped = dedupeCites(ev.general_citations ?? []).filter((c) => {
    const k = c.pmid ? `pmid:${c.pmid}` : c.url ? `url:${c.url}` : "";
    return !(k && seen.has(k));
  });
  const generalCites = [...generalDeduped.filter(isVerifiedCite), ...generalDeduped.filter((c) => !isVerifiedCite(c))];
  const all = [...lensCites, ...generalCites];
  const verifiedCount = all.filter(isVerifiedCite).length;

  return {
    name: row.name,
    canonical_name: row.canonical_name,
    category: row.category,
    verdict: row.verdict ?? "Unknown",
    evidence_tier: row.source_type ?? "Unrated",
    lens,
    // evidence_state 'cited' = >=1 VERIFIED citation (curated / licensed regulator).
    // 'referenced' = only 'sourced' citations (real, but category-level, unverified):
    // surfaced so agents see them, but citation_count (the verified stamp) stays 0.
    ...(all.length
      ? {
          evidence_state: verifiedCount ? "cited" : "referenced",
          citation_count: verifiedCount,
          referenced_count: all.length - verifiedCount,
          citations: lensCites,
          general_citations: generalCites.length ? generalCites : undefined,
        }
      : {}),
    lens_findings: map.display.length ? lensFindings : undefined,
  };
}

// --- Tool implementations --------------------------------------------------

// Resolve an OFF/OBF ingredient token that DIDN'T match a curated name via the
// ingredient_resolution_crosswalk (OFF token -> ingredient_id: E-numbers like
// 'e330', and common tags like 'skimmed milk' / 'glucose syrup'). This is why
// scan_barcode was under-matching: OFF text is full of tokens that never ilike
// a canonical name but ARE mapped here. Tries the token and an e-number-style
// space-stripped variant. Returns the resolved iv rows (usually one), or [].
async function resolveViaCrosswalk(env: Env, q: string): Promise<Array<Record<string, unknown>>> {
  const lower = q.toLowerCase();
  const variants = new Set([lower, lower.replace(/\s+/g, "")]);
  const inList = [...variants].map((v) => `"${encodeURIComponent(v)}"`).join(",");
  const xw = await fetchRows(env,
    `${env.SUPABASE_URL}/rest/v1/ingredient_resolution_crosswalk?select=ingredient_id&source_token=in.(${inList})&limit=1`);
  const id = xw[0]?.ingredient_id;
  if (id === undefined || id === null) return [];
  return fetchRows(env,
    `${env.SUPABASE_URL}/rest/v1/ingredients_variants?select=${IV_FIELDS}&id=eq.${Number(id)}&limit=1`);
}

// EU CosIng cosmetic-ingredient fallback. 24k INCI entries (Bronze tier) with
// per-lens flags and EFSA/PubMed provenance — a whole parallel cosmetic DB that
// was sitting in staging. Only consulted when the curated DB + crosswalk miss,
// so it's purely additive; results are clearly marked source='cosing' (Bronze).
// Lifts skincare/OBF coverage on both check_ingredient and scan_barcode.
const COSING_FIELDS = [
  "id", "inci_name", "verdict", "source_type", "cosing_function", "category", "pmid",
  "lactation_safety", "lactation_notes", "breastfeeding_notes", "pregnancy_notes",
  "is_histamine_liberator", "is_dao_inhibitor", "is_mcas_trigger", "is_mast_cell_activator",
  "rosacea_flag", "is_hs_trigger", "hs_notes", "is_allergenic", "is_photosensitizer",
  "is_endocrine_active", "is_retinoid", "is_comedogenic", "is_fragrance_component",
].join(",");

// lens -> the cosing flag/note fields that speak to it.
const COSING_LENS: Record<string, string[]> = {
  breastfeeding: ["lactation_safety", "lactation_notes", "breastfeeding_notes"],
  lactation: ["lactation_safety", "lactation_notes", "breastfeeding_notes"],
  pregnancy: ["pregnancy_notes"],
  histamine: ["is_histamine_liberator", "is_dao_inhibitor"],
  mcas: ["is_mcas_trigger", "is_mast_cell_activator"],
  rosacea: ["rosacea_flag"],
  hs: ["is_hs_trigger", "hs_notes"],
  allergy: ["is_allergenic"],
};

// cites come from claim_citations_v2 looked up by source_key ('cosing_staging:'+id),
// carrying the verified/sourced tiering. A cosing citation attests the SOURCE
// (EFSA / IARC / EU Annex / PubMed), not a lens-specific claim — so it surfaces as
// "Source: <regulator>" via evidence_note, never "EFSA says this is an HS trigger".
function shapeCosing(row: Record<string, unknown>, lens: string, cites: Cite[] = []) {
  const fields = COSING_LENS[lens] ?? [];
  const findings: Record<string, unknown> = {};
  for (const f of fields) if (row[f] !== undefined && row[f] !== null) findings[f] = row[f];

  const pLens = mapWebLensToProvenance(lens);
  const lensDeduped = dedupeCites(cites.filter((c) => pLens === "all" || c.lens === pLens));
  const lensCites = [...lensDeduped.filter(isVerifiedCite), ...lensDeduped.filter((c) => !isVerifiedCite(c))];
  const seen = new Set(
    lensCites.map((c) => (c.pmid ? `pmid:${c.pmid}` : c.url ? `url:${c.url}` : "")).filter(Boolean),
  );
  const generalDeduped = dedupeCites(cites.filter((c) => c.lens === "general")).filter((c) => {
    const k = c.pmid ? `pmid:${c.pmid}` : c.url ? `url:${c.url}` : "";
    return !(k && seen.has(k));
  });
  const generalCites = [...generalDeduped.filter(isVerifiedCite), ...generalDeduped.filter((c) => !isVerifiedCite(c))];
  const all = [...lensCites, ...generalCites];
  const verifiedCount = all.filter(isVerifiedCite).length;

  return {
    name: row.inci_name,
    canonical_name: row.inci_name,
    category: row.category ?? "Skincare",
    verdict: row.verdict ?? "Unknown",
    evidence_tier: row.source_type ?? "Bronze",
    lens,
    ...(all.length
      ? {
          evidence_state: verifiedCount ? "cited" : "referenced",
          citation_count: verifiedCount,
          referenced_count: all.length - verifiedCount,
          citations: lensCites,
          general_citations: generalCites.length ? generalCites : undefined,
          evidence_note: "Citation attests the source (EU CosIng / EFSA / IARC), not a lens-specific claim.",
        }
      : {}),
    lens_findings: Object.keys(findings).length ? findings : undefined,
    source: "cosing (EU CosIng, cosmetic INCI — Bronze)",
    cosing_function: row.cosing_function ?? null,
  };
}

async function resolveViaCosing(env: Env, q: string, lens: string) {
  const enc = encodeURIComponent(`%${q}%`);
  const rows = await fetchRows(env,
    `${env.SUPABASE_URL}/rest/v1/cosing_staging?select=${COSING_FIELDS}&inci_name=ilike.${enc}&limit=5`);
  if (!rows.length) return [];
  const keys = rows.map((r) => `cosing_staging:${r.id}`);
  const byKey = await fetchCitationsBySourceKey({
    supabaseUrl: env.SUPABASE_URL, headers: readHeaders(env), keys, timeoutMs: 900,
  }).catch(() => new Map<string, Cite[]>());
  return rows.map((r) => shapeCosing(r, lens, byKey.get(`cosing_staging:${r.id}`) ?? []));
}

// withSignals attaches the additive safety context (ambiguity + signal overlays
// + probiotic strains) — only on direct tool calls: scan_barcode/validate_claim
// probe many tokens through this function internally and must stay lean.
async function checkIngredient(env: Env, name: string, lens: string, withSignals = false) {
  const q = sanitizeToken(name);
  if (!q) return { error: "name is required" };
  const enc = encodeURIComponent(`%${q}%`);
  let rows = await fetchRows(env,
    `${env.SUPABASE_URL}/rest/v1/ingredients_variants?select=${IV_FIELDS}&or=(name.ilike.${enc},canonical_name.ilike.${enc})&limit=5`);
  if (!rows.length) {
    rows = await fetchRows(env,
      `${env.SUPABASE_URL}/rest/v1/ingredients_variants?select=${IV_FIELDS}&aliases=cs.%7B${encodeURIComponent(q.toLowerCase())}%7D&limit=5`);
  }
  if (!rows.length) {
    rows = await resolveViaCrosswalk(env, q);  // OFF-token fallback (E-numbers, common tags)
  }
  let out: Record<string, unknown>;
  if (!rows.length) {
    // Last resort: EU CosIng cosmetic INCI (Bronze). Marked source='cosing'.
    const cosing = await resolveViaCosing(env, q, lens);
    out = cosing.length ? { query: q, matched: true, results: cosing } : { query: q, matched: false, results: [] };
  } else {
    const ids = rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
    const citesById = await fetchLiveCitations({ supabaseUrl: env.SUPABASE_URL, headers: readHeaders(env), ids });
    out = {
      query: q,
      matched: true,
      results: rows.map((r) => shape(r, lens, citesById.get(Number(r.id)) ?? [])),
    };
  }
  if (withSignals) await attachIngredientSignals(env, out, q, lens);
  return out;
}

// The same safety context human surfaces get (scan.ts pattern): opportunistic,
// timeout-bounded, ADDITIVE — the answer must never depend on these tables
// being up, and MCP clients ignore unknown fields.
async function attachIngredientSignals(env: Env, out: Record<string, unknown>, q: string, lens: string) {
  const ambiguity = getIngredientAmbiguityForQuery(q);
  if (ambiguity) {
    out.ambiguity = {
      reason: ambiguity.reason,
      answer: ambiguity.answer,
      options: ambiguity.options.map((o) => ({ label: o.label, query: o.query })),
    };
  }
  const names = [q];
  const results = Array.isArray(out.results) ? (out.results as Array<Record<string, unknown>>) : [];
  for (const r of results) {
    for (const n of [r.name, r.canonical_name]) if (n) names.push(String(n));
  }
  const [overlays, probiotics] = await Promise.all([
    fetchIngredientSignalOverlays({
      supabaseUrl: env.SUPABASE_URL, readKey: env.SUPABASE_SERVICE_KEY,
      names, lens, timeoutMs: 700,
    }).catch(() => []),
    looksLikeProbiotic(q)
      ? fetchProbioticSignals({
          supabaseUrl: env.SUPABASE_URL, headers: readHeaders(env),
          ingredient: q, timeoutMs: 900,
        }).catch(() => [])
      : Promise.resolve([]),
  ]);
  if (overlays.length) out.signal_overlays = overlays.slice(0, 6);
  if (probiotics.length) out.probiotic_signals = probiotics;
}

async function strainLookup(env: Env, species: string) {
  const q = sanitizeToken(species);
  if (!q) return { error: "species is required" };
  const enc = encodeURIComponent(`%${q}%`);
  const rows = await fetchRows(env,
    `${env.SUPABASE_URL}/rest/v1/cannabis_mushroom_staging?select=${STRAIN_FIELDS}&or=(name.ilike.${enc},canonical_name.ilike.${enc})&order=name&limit=5`);
  if (!rows.length) return { query: q, matched: false, results: [] };
  // v2 citations for cannabis_mushroom share ONE canonical id space with iv/coa,
  // so a bare-id lookup is collision-safe (same id = same ingredient).
  const ids = rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
  const citesById = await fetchLiveCitations({
    supabaseUrl: env.SUPABASE_URL, headers: readHeaders(env), ids, timeoutMs: 900,
  }).catch(() => new Map<number, Cite[]>());
  return {
    query: q,
    matched: true,
    results: rows.map((r) => {
      const deduped = dedupeCites(citesById.get(Number(r.id)) ?? []);
      const cites = [...deduped.filter(isVerifiedCite), ...deduped.filter((c) => !isVerifiedCite(c))];
      const verifiedCount = cites.filter(isVerifiedCite).length;
      return {
        name: r.name,
        canonical_name: r.canonical_name,
        verdict: r.verdict ?? "Unknown",
        evidence_tier: r.source_type ?? "Unrated",
        citation: (r.pmid as string)?.trim() ? `PMID: ${r.pmid}` : null,
        cited: Boolean((r.pmid as string)?.trim()),
        ...(cites.length
          ? {
              evidence_state: verifiedCount ? "cited" : "referenced",
              citation_count: verifiedCount,
              referenced_count: cites.length - verifiedCount,
              citations: cites.slice(0, 3),
            }
          : {}),
        flags: {
          is_mcas_trigger: r.is_mcas_trigger, is_hepatotoxic: r.is_hepatotoxic,
          is_uterine_stimulant: r.is_uterine_stimulant, is_phytoestrogenic: r.is_phytoestrogenic,
          is_anticoagulant: r.is_anticoagulant,
        },
      };
    }),
  };
}

// Conservative recall match. product_recalls has NO barcode — only free text —
// so a loose match would falsely flag a safe product (a worse error than a
// miss). Rule: require a known brand match AND >=1 shared significant name
// token. Returns [] when brand is unknown (too risky to match on name alone).
const RECALL_FIELDS = "product_name,brand,classification,reason,recall_date,status,source,source_url,recall_number";

function bigTokens(s: string): string[] {
  return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
    .filter((t) => t.length >= 4);
}

async function fetchRecalls(env: Env, productName: string, brand: string) {
  const b = sanitizeToken(brand);
  if (!b) return [];  // no brand -> do not attempt (false-positive guard)
  const enc = encodeURIComponent(`%${b}%`);
  const rows = await fetchRows(env,
    `${env.SUPABASE_URL}/rest/v1/product_recalls?select=${RECALL_FIELDS}&brand=ilike.${enc}&limit=20`);
  const nameTokens = new Set(bigTokens(productName));
  return rows
    .filter((r) => {
      // Enforce the documented rule strictly: brand match alone is NOT enough.
      // (Previously an empty recall product_name auto-passed — over-match hole.)
      const recallName = bigTokens(String(r.product_name || ""));
      return recallName.some((t) => nameTokens.has(t));
    })
    .map((r) => ({
      product_name: r.product_name, brand: r.brand,
      classification: r.classification, reason: r.reason,
      recall_date: r.recall_date, status: r.status,
      source: r.source, source_url: r.source_url, recall_number: r.recall_number,
      match_basis: "brand + product-name token (no barcode in recall data — verify via source_url)",
    }));
}

// Normalized English ingredient tokens from a product, whatever the shape.
// Priority: ingredients_tags ("en:palm-oil") — present on BOTH the local mirror
// and the live OFF API and already language-normalized; then the live parsed
// ingredients[].id; then localized text as a last resort. This is why coverage
// no longer collapses on non-English products.
function productTokens(product: Record<string, unknown>): string[] {
  // 1. Live API parsed ingredients[] — leaf ingredients only, cleanest.
  let tokens: string[] = [];
  if (Array.isArray(product.ingredients)) {
    tokens = (product.ingredients as Array<Record<string, unknown>>).map((ing) => {
      const id = String(ing.id || "");
      return id.startsWith("en:") ? id.slice(3).replace(/-/g, " ") : String(ing.text || id || "").trim();
    }).filter((s) => s.length > 2);
  }
  // 2. ingredients_tags (mirror rows lack the parsed array) — normalized English
  //    but includes OFF category ancestors (en:vegetable), so it's second choice.
  if (!tokens.length) {
    const tags = Array.isArray(product.ingredients_tags) ? (product.ingredients_tags as string[]) : [];
    tokens = tags.map((t) => String(t || "")).filter((t) => t.startsWith("en:"))
      .map((t) => t.slice(3).replace(/-/g, " ")).filter((s) => s.length > 2);
  }
  // 3. Localized text — last resort.
  if (!tokens.length) {
    const raw = String(product.ingredients_text_en || product.ingredients_text || "");
    tokens = raw.split(/[,;()]/).map((s) => s.trim()).filter((s) => s.length > 2);
  }
  return tokens.slice(0, 40);
}

// Look up a product in the LOCAL mirror first (off_barcode_products food,
// obf_barcode_products beauty). The mirror is the 1.2M-row asset we already
// store; using it avoids a third-party round-trip on every scan. Returns a
// product-shaped object or null (miss -> live-API fallback).
async function lookupLocalProduct(env: Env, code: string): Promise<Record<string, unknown> | null> {
  for (const [tbl, sel] of [
    ["off_barcode_products", "product_name,brand,ingredients_text,ingredients_tags"],
    ["obf_barcode_products", "product_name,brand,ingredients_text,ingredients_tags"],
  ] as const) {
    const rows = await fetchRows(env,
      `${env.SUPABASE_URL}/rest/v1/${tbl}?select=${sel}&barcode=eq.${code}&has_ingredients=eq.true&limit=1`);
    if (rows[0]) {
      const r = rows[0];
      return { product_name: r.product_name, brands: r.brand,
               ingredients_text: r.ingredients_text, ingredients_tags: r.ingredients_tags,
               _source: "local_mirror" };
    }
  }
  return null;
}

// Upsert a live-fetched product into the local mirror so the DB self-fills from
// real scan demand (the user's directive: log the fallback and add it in).
// Fire-and-forget; never affects the scan result.
function ingestToMirror(env: Env, code: string, product: Record<string, unknown>, beauty: boolean) {
  const table = beauty ? "obf_barcode_products" : "off_barcode_products";
  const row = {
    barcode: code,
    source: beauty ? "open_beauty_facts" : "open_food_facts",
    product_name: product.product_name ?? null,
    brand: String(product.brands || "").split(",")[0].trim() || null,
    ingredients_text: product.ingredients_text ?? null,
    ingredients_tags: Array.isArray(product.ingredients_tags) ? product.ingredients_tags : null,
    has_ingredients: Boolean(product.ingredients_text || (product.ingredients_tags as unknown[])?.length),
    source_url: `https://world${beauty ? "-en.openbeautyfacts" : "-en.openfoodfacts"}.org/product/${code}`,
    refreshed_at: new Date().toISOString(),
  };
  fetch(`${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=barcode`, {
    method: "POST",
    headers: { ...readHeaders(env), "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(row),
  }).catch(() => { /* mirror ingest must never affect the scan */ });
}

async function scanBarcode(env: Env, barcode: string, lens: string) {
  const code = String(barcode || "").trim();
  if (!/^\d{6,14}$/.test(code)) return { error: "barcode must be 6-14 digits" };

  // Local mirror FIRST; live Open Food/Beauty Facts only as a fallback (and when
  // we do fall back, ingest the result so the mirror self-fills).
  let product: Record<string, unknown> | null = await lookupLocalProduct(env, code);
  let source = "local_mirror";
  if (!product) {
    source = "live_api";
    for (const [i, base] of ["https://world.openfoodfacts.org", "https://world.openbeautyfacts.org"].entries()) {
      const res = await fetch(`${base}/api/v2/product/${code}`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
      if (res && res.ok) {
        const data = (await res.json()) as { status?: number; product?: Record<string, unknown> };
        if (data.status === 1 && data.product) {
          product = data.product;
          ingestToMirror(env, code, product, i === 1);  // i===1 -> beauty
          break;
        }
      }
    }
  }
  if (!product) return { barcode: code, matched: false, note: "not found in local mirror or Open Food/Beauty Facts" };

  const tokens = productTokens(product);
  const findings: unknown[] = [];
  const unmatched: string[] = [];
  for (const tok of tokens) {
    const r = await checkIngredient(env, tok, lens);
    if ((r as { matched?: boolean }).matched) findings.push((r as { results: unknown[] }).results[0]);
    else unmatched.push(tok);
  }
  // Harvest unresolved tokens for demand-driven crosswalk growth (the hand-written
  // expander is exhausted; ~1 in 4 real tokens still misses). Fire-and-forget:
  // the RPC dedupes + counts, and a weekly job proposes the frequent ones.
  if (unmatched.length) {
    fetch(`${env.SUPABASE_URL}/rest/v1/rpc/log_crosswalk_candidates`, {
      method: "POST",
      headers: { ...readHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({ p_tokens: unmatched.slice(0, 40), p_product: String(product.product_name || "") }),
    }).catch(() => { /* harvesting must never affect the scan result */ });
  }
  const flagged = findings.filter((f) => (f as { verdict?: string }).verdict && !/safe/i.test((f as { verdict: string }).verdict));

  // Recall check (authoritative FDA signal, kept fresh by the radar cron).
  const brand = String(product.brands || "").split(",")[0].trim();
  const recalls = await fetchRecalls(env, String(product.product_name || ""), brand);
  // Product-level signal overlays — one bounded read across all tokens (never
  // per-token), additive exactly like scan.ts; [] on timeout or table trouble.
  const signalOverlays = await fetchIngredientSignalOverlays({
    supabaseUrl: env.SUPABASE_URL, readKey: env.SUPABASE_SERVICE_KEY,
    names: tokens, lens, timeoutMs: 700,
  }).catch(() => []);
  const activeClass1 = recalls.filter((r) =>
    /^i\b|class i\b|^1\b/i.test(String(r.classification || "")) &&
    !/terminated|complete/i.test(String(r.status || "")));

  return {
    barcode: code,
    matched: true,
    product_name: product.product_name || null,
    source,
    lens,
    ingredients_evaluated: findings.length,
    flagged_count: flagged.length,
    verdict: flagged.length ? "Contains flagged ingredients" : (findings.length ? "No flagged ingredients found" : "No matched ingredients"),
    flagged_ingredients: flagged,
    // Honest coverage: how much of the ingredient list Clarity could actually
    // resolve. Unmatched tokens are being harvested to close the gap over time.
    coverage: {
      tokens_total: tokens.length,
      matched: findings.length,
      unmatched: unmatched.length,
      unmatched_tokens: unmatched.slice(0, 20),
    },
    // Recall is the strongest safety signal — surfaced separately, never
    // silently folded into the verdict. Agents/users verify via source_url.
    recall_flag: activeClass1.length > 0,
    recalls,
    signal_overlays: signalOverlays.length ? signalOverlays.slice(0, 8) : undefined,
  };
}

// validate_claim — the provenance oracle (see PROVENANCE_MCP_STRATEGY_2026-07).
// Agents hallucinate health claims; this answers "is this actually cited in a
// human-curated, evidence-graded source?" It does NOT do free-form medical NLI.
// It: (1) finds the ingredient the statement is about, (2) pulls Clarity's
// curated position for the lens, (3) reports supported / contradicted /
// consistent_with_curated_position / conflicts_with_curated_position /
// curated_position_available / not_covered_for_this_lens — with any verified
// citation on file. A curated verdict without a verified citation is a human
// judgment, surfaced on its own merits, never reported as "unsupported".
const CLAIM_STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "with", "that", "this", "safe", "unsafe", "during",
  "while", "when", "can", "you", "your", "have", "has", "not", "but", "does", "did",
  "is", "it", "to", "of", "in", "on", "a", "an", "be", "or", "if", "as", "at", "by",
  "avoid", "risk", "risky", "harmful", "toxic", "dangerous", "fine", "okay", "take",
  "use", "using", "eat", "eating", "eaten", "drink", "cause", "causes", "should",
  "pregnancy", "pregnant", "breastfeeding", "lactation", "nursing", "histamine",
  "rosacea", "allergy", "allergic", "fertility", "toddler", "infant", "baby",
]);

function statementPolarity(s: string): "safe" | "unsafe" | "unclear" {
  const t = ` ${s.toLowerCase()} `;
  const unsafe = /(unsafe|not safe|isn'?t safe|avoid|contraindicat|dangerous|harmful|toxic|should not|shouldn'?t|do not|don'?t|risk\b|risky|unsuitable|not recommended)/.test(t);
  const safe = /(is safe|are safe|safe to|generally safe|no known risk|low risk|fine to|okay to|compatible|well[- ]tolerated|can be (taken|used|eaten|consumed))/.test(t);
  if (unsafe && !safe) return "unsafe";
  if (safe && !unsafe) return "safe";
  return "unclear";
}

function verdictPolarity(v: string): "safe" | "unsafe" | "unclear" {
  const t = (v || "").toLowerCase();
  if (/(avoid|caution|contraindicat|high|not recommended|unsafe|trigger)/.test(t)) return "unsafe";
  if (/(safe|low|none|compatible|minimal|no known)/.test(t)) return "safe";
  return "unclear";
}

// Pull candidate ingredient phrases from a free-text claim, longest first, so we
// probe "aged cheddar cheese" before "cheese". Bounded to keep worker latency sane.
function candidateTerms(statement: string): string[] {
  const words = sanitizeToken(statement).toLowerCase().split(" ")
    .filter((w) => w.length >= 3 && !CLAIM_STOPWORDS.has(w));
  const cands = new Set<string>();
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) cands.add(words.slice(i, i + n).join(" "));
  }
  return [...cands].sort((a, b) => b.length - a.length).slice(0, 12);
}

async function validateClaim(env: Env, statement: string, lens: string) {
  const stmt = String(statement || "").trim();
  if (!stmt) return { error: "statement is required" };
  const useLens = LENS_MAP[lens] ? lens : "all";

  // 1. Find the ingredient the claim is about (longest match wins).
  let matched: { name: string; result: Record<string, unknown> } | null = null;
  for (const term of candidateTerms(stmt)) {
    const r = await checkIngredient(env, term, useLens) as { matched?: boolean; results?: Record<string, unknown>[] };
    if (r.matched && r.results?.length) {
      const first = r.results[0];
      // Prefer the match whose returned name is actually present in the statement.
      matched = { name: String(first.name || term), result: first };
      break;
    }
  }
  if (!matched) {
    return {
      statement: stmt, lens: useLens, subject_matched: false,
      assessment: "not_in_our_db",
      basis: "No ingredient in this statement matches Clarity's curated database, so we cannot validate it against our sources.",
      citations: [],
    };
  }

  const r = matched.result;
  // Citation tool paused: check_ingredient no longer surfaces evidence_state, so
  // detect a curated position from the verdict itself, and cited vs curated from
  // whether verified citations came back. No "unsupported"/pending/uncited language.
  const citations = (r.citations as unknown[]) || [];
  const hasCitations = citations.length > 0;
  const ourVerdict = String(r.verdict || "Unknown");
  const hasVerdict = Boolean(ourVerdict) && ourVerdict !== "Unknown";
  const tier = String(r.evidence_tier || "curated");
  const sp = statementPolarity(stmt);
  const vp = verdictPolarity(ourVerdict);

  let assessment: string;
  let basis: string;
  if (!hasVerdict) {
    assessment = "not_covered_for_this_lens";
    basis = `Clarity does not hold a position on ${matched.name} for the ${useLens} lens.`;
  } else if (hasCitations && sp !== "unclear" && vp !== "unclear") {
    assessment = sp === vp ? "supported" : "contradicted";
    basis = `The statement ${sp === vp ? "aligns with" : "conflicts with"} Clarity's cited position on ${matched.name} for ${useLens} ("${ourVerdict}").`;
  } else if (hasCitations) {
    assessment = "cited_position_available";
    basis = `Clarity has a cited position on ${matched.name} for ${useLens}: "${ourVerdict}". Compare the statement against the cited sources below.`;
  } else if (sp !== "unclear" && vp !== "unclear") {
    assessment = sp === vp ? "consistent_with_curated_position" : "conflicts_with_curated_position";
    basis = `Clarity's human-curated position on ${matched.name} for ${useLens} is "${ourVerdict}" (${tier} tier).`;
  } else {
    assessment = "curated_position_available";
    basis = `Clarity's human-curated position on ${matched.name} for ${useLens} is "${ourVerdict}" (${tier} tier).`;
  }

  return {
    statement: stmt,
    lens: useLens,
    subject_matched: true,
    subject: matched.name,
    assessment,
    basis,
    our_verdict: ourVerdict,
    evidence_tier: r.evidence_tier ?? "Unrated",
    // Citation tool paused: only surface evidence_state/citations when verified.
    ...(citations.length ? { evidence_state: "cited", citations } : {}),
  };
}

// check_interaction — curated ingredient×ingredient interactions (Phase 3 v1).
// The table is A×B and a pair may be stored in EITHER column order, so we query
// both columns and normalize output so `subject` is always the queried term.
// One arg → one-to-many ("what interacts with iron?"); two args → the pair.
function shapeInteraction(row: Record<string, unknown>, subject: string): Record<string, unknown> {
  const a = String(row.ingredient_a || "");
  const b = String(row.ingredient_b || "");
  const subjLower = subject.toLowerCase();
  // Orient so the queried ingredient is `subject` and the other is `with`.
  const subjectIsA = a.toLowerCase().includes(subjLower) || !b.toLowerCase().includes(subjLower);
  return {
    subject: subjectIsA ? a : b,
    interacts_with: subjectIsA ? b : a,
    interaction_type: row.interaction_type ?? "Unknown",
    severity: row.severity ?? "Unknown",
    mechanism: row.mechanism ?? null,
    clinical_note: row.clinical_note ?? null,
    source: row.source ?? null,
    affects_lactation: row.affects_lactation ?? null,
    affects_infant: row.affects_infant ?? null,
    affects_absorption: row.affects_absorption ?? null,
  };
}

async function checkInteraction(env: Env, ingredientA: string, ingredientB: string) {
  const a = sanitizeToken(ingredientA);
  if (!a) return { error: "ingredient_a is required" };
  const b = sanitizeToken(ingredientB);
  const fields = "ingredient_a,ingredient_b,interaction_type,severity,mechanism,clinical_note,source,affects_lactation,affects_infant,affects_absorption";
  const encA = encodeURIComponent(`%${a}%`);

  if (b) {
    // Directed pair, either stored order: (a~A and b~B) or (a~B and b~A).
    const encB = encodeURIComponent(`%${b}%`);
    const rows = await fetchRows(env,
      `${env.SUPABASE_URL}/rest/v1/ingredient_interactions?select=${fields}&or=(and(ingredient_a.ilike.${encA},ingredient_b.ilike.${encB}),and(ingredient_a.ilike.${encB},ingredient_b.ilike.${encA}))&limit=10`);
    return {
      query: { ingredient_a: a, ingredient_b: b },
      matched: rows.length > 0,
      interactions: rows.map((r) => shapeInteraction(r, a)),
      note: rows.length ? undefined : "No curated interaction on file for this pair. Absence is not proof of safety — Clarity's interaction set is nutrient/ingredient-focused and still growing.",
    };
  }

  // One-to-many: everything that interacts with the single ingredient.
  const rows = await fetchRows(env,
    `${env.SUPABASE_URL}/rest/v1/ingredient_interactions?select=${fields}&or=(ingredient_a.ilike.${encA},ingredient_b.ilike.${encA})&limit=25`);
  return {
    query: { ingredient: a },
    matched: rows.length > 0,
    count: rows.length,
    interactions: rows.map((r) => shapeInteraction(r, a)),
    note: rows.length ? undefined : "No curated interactions on file for this ingredient yet.",
  };
}

// Category-distinct product score. food / skincare / supplement scores have
// DIFFERENT semantics and are NEVER merged (project rule). Always returns the
// data_quality/coverage so a bare score is never handed over without confidence.
async function scoreProduct(env: Env, barcode: string, category: string, lens: string) {
  const code = String(barcode || "").replace(/\D/g, "");
  if (!/^\d{6,14}$/.test(code)) return { error: "barcode required (6-14 digits)" };
  const cat = String(category || "").toLowerCase();
  const out: Record<string, unknown> = { barcode: code, category: cat || "auto", lens: lens || null };

  if (cat === "food" || !cat) {
    const f = (await fetchRows(env,
      `${env.SUPABASE_URL}/rest/v1/food_product_scores?barcode=eq.${code}&limit=1`))[0];
    if (f) out.food = {
      overall_score: f.overall_score, rating: f.rating,
      subscores: { nutrition: f.nutrition_score, additive: f.additive_score, processing: f.processing_score, organic: f.organic_score },
      drivers: { nutrition: f.nutrition_reasons, additive: f.additive_reasons, processing: f.processing_reasons },
      data_quality: f.data_quality, scoring_version: f.scoring_version,
    };
  }
  if (cat === "skincare" || !cat) {
    const s = (await fetchRows(env,
      `${env.SUPABASE_URL}/rest/v1/skincare_product_scores?barcode=eq.${code}&limit=1`))[0];
    if (s) out.skincare = {
      overall_score: s.overall_score, rating: s.rating,
      subscores: { irritation: s.irritation_score, allergen: s.allergen_score, endocrine_repro: s.endocrine_repro_score, condition: s.condition_score },
      drivers: s.reasons, data_quality: s.data_quality, scoring_version: s.scoring_version,
    };
  }
  if (cat === "supplement" || !cat) {
    // Lead with the computed score (supplement-v1) keyed on the SAME digit-
    // normalized UPC we store — dsld_products.upc_normalized is often not pure
    // digits, so keying label lookup on it directly under-hits. Fetch the label
    // context by dsld_id from the score row. Distinct semantics from food/skincare,
    // never merged. Headline signal is dose transparency (proprietary blends).
    const sc = (await fetchRows(env,
      `${env.SUPABASE_URL}/rest/v1/supplement_product_scores?select=dsld_id,overall_score,rating,transparency_score,safety_score,label_quality_score,complexity_score,active_ingredients,hidden_dose_actives,reasons,data_quality,scoring_version&upc_normalized=eq.${code}&limit=1`))[0];
    if (sc) {
      const d = (await fetchRows(env,
        `${env.SUPABASE_URL}/rest/v1/dsld_products?select=full_name,brand_name,has_preg_warning,has_nurs_warning,allergens&dsld_id=eq.${encodeURIComponent(String(sc.dsld_id))}&limit=1`))[0] || {};
      out.supplement = {
        product: d.full_name ?? null, brand: d.brand_name ?? null,
        overall_score: sc.overall_score, rating: sc.rating,
        subscores: {
          transparency: sc.transparency_score, safety: sc.safety_score,
          label_quality: sc.label_quality_score, complexity: sc.complexity_score,
        },
        active_ingredients: sc.active_ingredients, hidden_dose_actives: sc.hidden_dose_actives,
        drivers: sc.reasons,
        pregnancy_warning: d.has_preg_warning ?? null, nursing_warning: d.has_nurs_warning ?? null,
        allergens: d.allergens ?? null,
        data_quality: sc.data_quality, scoring_version: sc.scoring_version,
      };
    } else {
      // Not in the scored set — fall back to raw DSLD label signals if present.
      const d = (await fetchRows(env,
        `${env.SUPABASE_URL}/rest/v1/dsld_products?select=full_name,brand_name,has_preg_warning,has_nurs_warning,allergens,scorable&upc_normalized=eq.${code}&limit=1`))[0];
      if (d) out.supplement = {
        note: "label-derived signals only (not in the computed-score set — often a malformed DSLD UPC)",
        product: d.full_name, brand: d.brand_name,
        pregnancy_warning: d.has_preg_warning, nursing_warning: d.has_nurs_warning,
        allergens: d.allergens, scorable: d.scorable, data_quality: "label-only",
      };
    }
  }

  // Per-lens Clarity fit (matched/unmatched coverage — the honest confidence).
  // Select only scalar columns — the `result` jsonb blob holds internal URLs.
  if (lens) {
    const bs = (await fetchRows(env,
      `${env.SUPABASE_URL}/rest/v1/barcode_scan_scores?select=total,matched,ambiguous,unmatched,overall,lens_overall&barcode=eq.${code}&lens=eq.${encodeURIComponent(lens)}&limit=1`))[0];
    if (bs) out.lens_fit = {
      overall: bs.lens_overall ?? bs.overall,
      coverage: { total: bs.total, matched: bs.matched, ambiguous: bs.ambiguous, unmatched: bs.unmatched },
    };
  }

  out.scored = Boolean(out.food || out.skincare || out.supplement || out.lens_fit);
  if (!out.scored) out.note = "no score on record for this barcode in the requested category (unscored/uncovered product — a known coverage gap)";
  return out;
}

// --- MCP tool registry -----------------------------------------------------

const TOOLS = [
  {
    name: "check_ingredient",
    description: "Look up a cosmetic/food/supplement ingredient in Clarity's condition-aware database. Returns verdict, evidence tier (Gold/Silver/Bronze), and citation for a given condition lens.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Ingredient name, e.g. 'niacinamide' or 'aged cheddar cheese'" },
        lens: { type: "string", description: "Condition lens", enum: Object.keys(LENS_MAP), default: "all" },
      },
      required: ["name"],
    },
  },
  {
    name: "strain_lookup",
    description: "Look up a cannabis or mushroom species/strain in Clarity's database. Returns verdict, evidence tier, PMID citation, and safety flags.",
    inputSchema: {
      type: "object",
      properties: { species: { type: "string", description: "Species or strain name, e.g. 'Cannabis sativa' or 'Lion's Mane'" } },
      required: ["species"],
    },
  },
  {
    name: "scan_barcode",
    description: "Look up a product by barcode (Open Food Facts / Open Beauty Facts), match its ingredients against Clarity's database, return which ingredients are flagged for the given condition lens, AND flag any active FDA recall for the product (recall_flag + recalls[], sourced from FDA — verify via source_url).",
    inputSchema: {
      type: "object",
      properties: {
        barcode: { type: "string", description: "UPC/EAN barcode, 6-14 digits" },
        lens: { type: "string", description: "Condition lens", enum: Object.keys(LENS_MAP), default: "all" },
      },
      required: ["barcode"],
    },
  },
  {
    name: "validate_claim",
    description: "Fact-check a free-text health/safety claim against Clarity's human-curated, evidence-graded database. Given a statement (e.g. 'fenugreek is safe while breastfeeding') and a condition lens, returns whether Clarity's curated position supports / contradicts / does-not-cover it, plus any verified citation on file. Use this to check whether a health claim an agent already holds aligns with Clarity's curation. Descriptive — not medical advice.",
    inputSchema: {
      type: "object",
      properties: {
        statement: { type: "string", description: "The health/safety claim to validate, e.g. 'niacinamide is safe during pregnancy'" },
        lens: { type: "string", description: "Condition lens the claim is about", enum: Object.keys(LENS_MAP), default: "all" },
      },
      required: ["statement"],
    },
  },
  {
    name: "check_interaction",
    description: "Check Clarity's curated ingredient-to-ingredient interaction database. Give one ingredient to list everything it interacts with (e.g. 'iron'), or two ingredients to check a specific pair (e.g. 'calcium' + 'iron'). Returns interaction_type, severity (Beneficial/Moderate/High), mechanism, clinical_note, source, and whether it affects lactation/infant/absorption. Queries both directions of the pair. Absence of a result is NOT proof of safety — the set is curated and growing. Descriptive with sources, not medical advice.",
    inputSchema: {
      type: "object",
      properties: {
        ingredient_a: { type: "string", description: "The ingredient to check, e.g. 'iron' or 'calcium'" },
        ingredient_b: { type: "string", description: "Optional second ingredient to check a specific pair. Omit to list all interactions for ingredient_a." },
      },
      required: ["ingredient_a"],
    },
  },
  {
    name: "score_product",
    description: "Get Clarity's product quality score by barcode. Returns category-specific scores (food: nutrition/additive/processing/organic; skincare: irritation/allergen/endocrine/condition; supplement: transparency/safety/label_quality/complexity — dose transparency penalizes proprietary blends, safety flags high-risk botanicals) — these are DISTINCT and never merged — plus per-lens fit with match coverage. Always includes data_quality/coverage so a score is never given without its confidence.",
    inputSchema: {
      type: "object",
      properties: {
        barcode: { type: "string", description: "UPC/EAN barcode, 6-14 digits" },
        category: { type: "string", description: "Product category (omit for auto)", enum: ["food", "skincare", "supplement"] },
        lens: { type: "string", description: "Condition lens for per-lens fit", enum: Object.keys(LENS_MAP) },
      },
      required: ["barcode"],
    },
  },
];

async function callTool(env: Env, name: string, args: Record<string, unknown>, keyed: boolean, caller = "?") {
  const lens = String(args.lens || "all").toLowerCase();
  let out: Record<string, unknown>;
  switch (name) {
    case "check_ingredient": out = await checkIngredient(env, String(args.name || ""), lens, true); break;
    case "strain_lookup": out = await strainLookup(env, String(args.species || "")); break;
    case "scan_barcode": out = await scanBarcode(env, String(args.barcode || ""), lens); break;
    case "validate_claim": out = await validateClaim(env, String(args.statement || ""), lens); break;
    case "check_interaction": out = await checkInteraction(env, String(args.ingredient_a || ""), String(args.ingredient_b || "")); break;
    case "score_product": out = await scoreProduct(env, String(args.barcode || ""), String(args.category || ""), String(args.lens || "")); break;
    default: throw new Error(`unknown tool: ${name}`);
  }
  // Usage telemetry (fire-and-forget; absent binding = no-op in local dev).
  try {
    env.MCP_ANALYTICS?.writeDataPoint({
      // blob4 = caller = first 8 hex of sha256(ip). Privacy-safe: not reversible
      // to an IP, but stable per source, so one hash dominating = one caller
      // (e.g. our own testing) vs many distinct hashes = real distributed users.
      blobs: [name, keyed ? "keyed" : "anon", lens, caller],
      doubles: [1],
      indexes: [name],
    });
  } catch { /* telemetry must never break a tool call */ }
  return { ...out, disclaimer: DISCLAIMER };
}

// --- JSON-RPC 2.0 dispatch -------------------------------------------------

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleRpc(env: Env, msg: any, keyed = false, caller = "?") {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        // Server-level guidance the agent's model reads. This is where the
        // evidence model + usage contract live — a primary discovery/trust signal.
        instructions:
          "Clarity provides condition-aware ingredient and product safety. Use check_ingredient " +
          "for an ingredient under a condition lens (breastfeeding, pregnancy, histamine, mcas, " +
          "rosacea, hs, allergy, fertility, toddler); validate_claim to fact-check a free-text " +
          "health claim against Clarity's curated, evidence-graded database (supported / " +
          "contradicted / consistent_with_curated_position / conflicts_with_curated_position / " +
          "not_covered_for_this_lens); scan_barcode for a packaged product (also " +
          "flags active FDA recalls); score_product for a quality score; check_interaction for " +
          "curated ingredient-to-ingredient interactions (one ingredient for one-to-many, or a pair); " +
          "strain_lookup for cannabis/" +
          "mushroom species. Every result carries an evidence_tier (Gold/Silver/Bronze). When a " +
          "verified citation is on file the result carries evidence_state 'cited' plus the citation; " +
          "when only an unverified (category-level) citation exists it carries 'referenced'; otherwise " +
          "the verdict stands on Clarity's curation and no citation is claimed. citation_count counts " +
          "verified citations only. Always show the user the verdict and any citation. Informational, not medical advice.",
      });
    case "notifications/initialized":
      return null; // notification, no response
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const toolName = params?.name;
      const args = params?.arguments || {};
      try {
        const out = await callTool(env, toolName, args, keyed, caller);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        return rpcError(id, -32000, (e as Error).message);
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

// --- Access control: anonymous IP rate limit + optional API-key tiers -------
// Scrape defense (this DB was scraped before). tools/call is metered; the cheap
// handshake methods (initialize/tools/list/ping) are not.
const ANON_LIMIT = 60;          // requests per window for anonymous callers
const ANON_WINDOW_MS = 60_000;  // 1 minute
const ipHits = new Map<string, number[]>();

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")
      || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim()
      || "unknown";
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Returns null if allowed, else {status, message} to reject with.
async function enforceLimit(request: Request, env: Env): Promise<{ status: number; message: string } | null> {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey) {
    // Keyed: server-side monthly quota via api_keys (keys stored hashed).
    const hash = await sha256Hex(apiKey);
    const rows = await fetchRows(env,
      `${env.SUPABASE_URL}/rest/v1/api_keys?select=id,is_active,monthly_limit,requests_this_month&key_hash=eq.${hash}&limit=1`);
    const k = rows[0] as { id?: string; is_active?: boolean; monthly_limit?: number; requests_this_month?: number } | undefined;
    if (!k || k.is_active === false) return { status: 401, message: "invalid or inactive API key" };
    if (typeof k.monthly_limit === "number" && (Number(k.requests_this_month) || 0) >= k.monthly_limit) {
      return { status: 429, message: "monthly quota exceeded for this API key" };
    }
    // atomic increment (best-effort; failure never blocks a valid keyed call)
    await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/increment_api_usage`, {
      method: "POST",
      headers: { ...readHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({ key_id: k.id }),
    }).catch(() => {});
    return null;
  }
  const ip = clientIp(request);
  const limitMsg = `rate limit: ${ANON_LIMIT} requests/min for anonymous use — add an API key (X-API-Key header) for higher limits`;
  // Layer 1 (cheap, lossy): native ratelimit binding — catches same-server
  // bursts without a DO round-trip. Per-server counters; a pass here is NOT
  // a pass overall.
  if (env.ANON_RL) {
    const { success } = await env.ANON_RL.limit({ key: ip }).catch(() => ({ success: true }));
    if (!success) return { status: 429, message: limitMsg };
  }
  // Layer 2 (authoritative): globally-unique per-IP Durable Object counter.
  if (env.RATE_DO) {
    try {
      const stub = env.RATE_DO.get(env.RATE_DO.idFromName(ip));
      const res = await stub.fetch("https://rl/");
      if (res.status === 429) return { status: 429, message: limitMsg };
      return null;
    } catch { /* DO failure must not take the service down — fall through */ }
  }
  // Fallback (no bindings, e.g. local dev): per-isolate in-memory bucket.
  const now = Date.now();
  const recent = (ipHits.get(ip) || []).filter((t) => now - t < ANON_WINDOW_MS);
  if (recent.length >= ANON_LIMIT) {
    return { status: 429, message: `rate limit: ${ANON_LIMIT} requests/min for anonymous use — add an API key (X-API-Key header) for higher limits` };
  }
  recent.push(now);
  ipHits.set(ip, recent);
  if (ipHits.size > 20000) ipHits.delete(ipHits.keys().next().value as string); // bound memory
  return null;
}

function isToolCall(body: any): boolean {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => m && m.method === "tools/call");
}

const INFO_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clarity MCP — condition-aware ingredient intelligence for agents</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebAPI","name":"Clarity MCP","description":"Condition-aware ingredient, product, and strain safety for AI agents. Evidence-graded (Gold/Silver/Bronze); each claim reports evidence_state cited (a verified citation is on file) or referenced (an unverified, category-level citation), across breastfeeding, pregnancy, histamine/MCAS, rosacea, HS, allergy, fertility, and toddler lenses.","documentation":"https://healthai.com/clarity/api/","termsOfService":"https://healthai.com/clarity/api/license/","provider":{"@type":"Organization","name":"Health AI","url":"https://healthai.com"},"potentialAction":{"@type":"SearchAction","target":"https://mcp.healthai.com","description":"MCP Streamable HTTP JSON-RPC tools: check_ingredient, validate_claim, scan_barcode, score_product, check_interaction, strain_lookup"}}</script>
<style>
  :root{--ink:#0f1b2d;--muted:#5b6b7f;--line:#e3e8ef;--bg:#f7f9fc;--card:#fff;
        --accent:#0d9488;--accent2:#0369a1;--gold:#b7791f;--silver:#64748b;--bronze:#9a6b4f;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
       -webkit-font-smoothing:antialiased}
  .wrap{max-width:820px;margin:0 auto;padding:56px 22px 80px}
  header{margin-bottom:36px}
  .badge{display:inline-block;font-size:12px;letter-spacing:.06em;text-transform:uppercase;
         color:var(--accent);background:#e6f7f4;border:1px solid #cdeee9;border-radius:999px;
         padding:4px 12px;font-weight:600}
  h1{font-size:34px;line-height:1.15;margin:16px 0 8px;letter-spacing:-.02em}
  .lede{font-size:18px;color:var(--muted);margin:0 0 6px;max-width:60ch}
  .meta{color:var(--muted);font-size:14px;margin-top:14px}
  .meta code{background:#eef2f7;padding:2px 7px;border-radius:6px;font-size:13px}
  h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);
     margin:44px 0 14px;font-weight:700}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:640px){.grid{grid-template-columns:1fr}}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px}
  .card h3{margin:0 0 4px;font-size:15px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
           color:var(--accent2)}
  .card p{margin:0;color:var(--muted);font-size:14px}
  .tiers{display:flex;gap:10px;flex-wrap:wrap;margin-top:4px}
  .tier{font-size:13px;border-radius:8px;padding:6px 12px;border:1px solid var(--line);background:#fff}
  .tier b{font-weight:700}
  .g{color:var(--gold)} .s{color:var(--silver)} .b{color:var(--bronze)}
  pre{background:#0f1b2d;color:#d6e2f0;border-radius:12px;padding:18px;overflow:auto;
      font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0}
  .note{margin-top:12px;color:var(--muted);font-size:13px}
  footer{margin-top:48px;padding-top:20px;border-top:1px solid var(--line);
         color:var(--muted);font-size:13px}
  a{color:var(--accent2)}
</style></head>
<body><div class="wrap">
<header>
  <span class="badge">Model Context Protocol</span>
  <h1>Clarity MCP</h1>
  <p class="lede">Condition-aware ingredient intelligence for agents. Every answer carries its verdict, its evidence tier, and — honestly — how well-evidenced it is.</p>
  <p class="meta">Transport <code>Streamable HTTP · JSON-RPC 2.0</code> at <code>POST /</code> &nbsp;·&nbsp; v${SERVER_INFO.version}</p>
</header>

<h2>Tools</h2>
<div class="grid">
  <div class="card"><h3>check_ingredient</h3><p>Verdict, evidence tier, evidence_state &amp; citations for an ingredient, under a condition lens.</p></div>
  <div class="card"><h3>validate_claim</h3><p>Fact-check a free-text health claim against Clarity's cited sources — supported, contradicted, or unsupported, with the citations that decide it.</p></div>
  <div class="card"><h3>scan_barcode</h3><p>Resolve a product by barcode, flag its ingredients for the lens, and surface any active FDA recall.</p></div>
  <div class="card"><h3>score_product</h3><p>Category-distinct quality scores — food, skincare, and supplements (dose transparency, flagged botanicals) — with match-coverage confidence.</p></div>
  <div class="card"><h3>check_interaction</h3><p>Curated ingredient-to-ingredient interactions — severity, mechanism, and source — for one ingredient (one-to-many) or a specific pair.</p></div>
  <div class="card"><h3>strain_lookup</h3><p>Cannabis &amp; mushroom species verdicts with tier and PMID references.</p></div>
</div>

<h2>Evidence model — honesty over completeness</h2>
<div class="tiers">
  <span class="tier"><b class="g">Gold</b> primary-source + human-reviewed</span>
  <span class="tier"><b class="s">Silver</b> literature-cited + reviewed</span>
  <span class="tier"><b class="b">Bronze</b> curated, review in progress</span>
</div>
<p class="note">When a verified citation is on file, a lens reports <code>evidence_state: cited</code> with that citation; when only an unverified, category-level citation exists it reports <code>referenced</code>. Otherwise the verdict stands on Clarity's curation. The verdict and evidence tier are always there.</p>

<h2>Quick start</h2>
<pre>curl -s https://mcp.healthai.com \\
  -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"check_ingredient",
                 "arguments":{"name":"aged cheddar cheese","lens":"histamine"}}}'</pre>
<p class="note">List tools with <code>{"method":"tools/list"}</code>. Condition lenses: breastfeeding, pregnancy, histamine, mcas, rosacea, hs, allergy, fertility, toddler.</p>

<h2>Access</h2>
<p class="note"><b>Free</b>, 60 tool calls/min per client. Send an <code>X-API-Key</code> header for higher, metered limits. Bulk snapshots &amp; high-volume commercial access are licensed — <a href="mailto:hello@healthai.com">hello@healthai.com</a>.</p>

<footer>
  Informational only — <b>not medical advice</b>. Evidence states are disclosed per claim; verify cited sources before acting. Consult a clinician for medical decisions.<br>
  Clarity by Health AI · <a href="https://healthai.com/clarity/api/">healthai.com/clarity/api</a>
</footer>
</div></body></html>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
      "X-Served-By": "clarity-mcp",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method === "GET") {
      // MCP discovery metadata for registries/agents that probe well-known.
      if (new URL(request.url).pathname === "/.well-known/mcp.json") {
        return Response.json({
          name: SERVER_INFO.name,
          version: SERVER_INFO.version,
          protocolVersion: PROTOCOL_VERSION,
          description:
            "Condition-aware ingredient, product, and strain safety intelligence for AI agents. Evidence-graded verdicts (Gold/Silver/Bronze); each claim reports evidence_state cited (verified citation on file) or referenced (unverified, category-level citation), across breastfeeding, pregnancy, histamine/MCAS, rosacea, HS, and allergy lenses.",
          endpoint: "https://mcp.healthai.com",
          transport: "streamable-http",
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
          documentation: "https://healthai.com/clarity/api/",
          contact: "hello@healthai.com",
        }, { headers: cors });
      }
      const pathname = new URL(request.url).pathname;
      if (pathname !== "/" && pathname !== "") {
        // Unknown GET path -> 404 (not the info page). Scanners such as Smithery
        // probe /.well-known/oauth-protected-resource; a 200 there was being read
        // as "this server uses OAuth", triggering an auth flow that then fails.
        // A 404 lets them correctly conclude the server needs no authentication.
        return new Response("Not Found", { status: 404, headers: cors });
      }
      return new Response(INFO_HTML, { headers: { "Content-Type": "text/html", ...cors } });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: cors });
    }
    let body: any;
    try {
      body = await request.json();
    } catch {
      return Response.json(rpcError(null, -32700, "parse error"), { headers: cors });
    }
    // Meter the data-returning path (tools/call); leave the handshake free.
    if (isToolCall(body)) {
      const blocked = await enforceLimit(request, env);
      if (blocked) {
        const id = Array.isArray(body) ? null : body?.id ?? null;
        return Response.json(rpcError(id, -32000, blocked.message),
          { status: blocked.status, headers: { ...cors, "Retry-After": "60" } });
      }
    }
    // Support a single request or a JSON-RPC batch.
    const keyed = Boolean(request.headers.get("x-api-key"));
    // Privacy-safe per-source fingerprint for telemetry (distinguishes one
    // caller — e.g. our own testing — from many distinct real users).
    const caller = (await sha256Hex(clientIp(request)).catch(() => "")).slice(0, 8) || "?";
    if (Array.isArray(body)) {
      const results = (await Promise.all(body.map((m) => handleRpc(env, m, keyed, caller)))).filter(Boolean);
      return Response.json(results, { headers: cors });
    }
    const result = await handleRpc(env, body, keyed, caller);
    if (result === null) return new Response(null, { status: 202, headers: cors });
    return Response.json(result, { headers: cors });
  },
};
