# Clarity MCP — `com.healthai/clarity`

[![MCP Queen grade](https://mcpqueen.com/badge/com.healthai/clarity.svg)](https://mcpqueen.com/s/com.healthai/clarity)

Condition-aware ingredient & product safety intelligence for AI agents. Every
answer carries a **verdict**, an **evidence tier** (Gold / Silver / Bronze), and
a **citation** — curated against authoritative sources (LactMed, InfantRisk,
PubMed, DSLD, DermNet, EU CosIng) by Health AI (Dr. Olga Lavinda, PhD).

Hosted MCP server — no install, no key. Endpoint:
**`https://mcp.healthai.com`** (Streamable HTTP, JSON-RPC 2.0). Published to the
official MCP Registry as **`com.healthai/clarity`** (domain-verified namespace).

## Use it

**Claude Code:**

```bash
claude mcp add --transport http clarity https://mcp.healthai.com
```

**Claude Desktop / Cursor / any client with native remote MCP** — add to the
config's `mcpServers`:

```json
{
  "mcpServers": {
    "clarity": {
      "type": "streamable-http",
      "url": "https://mcp.healthai.com"
    }
  }
}
```

For older clients without native remote support, bridge with `mcp-remote`:
`"command": "npx", "args": ["-y", "mcp-remote", "https://mcp.healthai.com"]`.

## Tools (6)

| Tool | What it answers |
|---|---|
| `check_ingredient` | Verdict + evidence tier + citation for a cosmetic/food/supplement ingredient, under a condition lens |
| `strain_lookup` | Verdict, tier, PMID citation and safety flags for a cannabis or mushroom species/strain |
| `scan_barcode` | Look up a product by UPC/EAN, flag its ingredients for a condition lens, and surface any active FDA recall |
| `validate_claim` | Fact-check a free-text health claim against Clarity's curated position — supports / contradicts / does-not-cover, with citation |
| `check_interaction` | Curated ingredient-to-ingredient interactions — type, severity, mechanism, clinical note, source (single or pair) |
| `score_product` | Category-specific product quality score by barcode (food / skincare / supplement), each dimension distinct, always with data-quality coverage |

**Condition lenses:** `breastfeeding`, `lactation`, `pregnancy`, `histamine`,
`mcas`, `rosacea`, `hs`, `allergy`, `all`.

Anonymous use is rate-limited to 60 req/min per IP (Durable Object limiter); add
an `X-API-Key` header for higher tiers. Descriptive and cited — **not medical
advice**; absence of a flag is not proof of safety. Sibling server:
**Radar** (`com.healthai/radar`) at `https://radar.healthai.com/api/mcp`.

## Deploy (Cloudflare Workers)

```bash
npx wrangler deploy        # from workers/clarity-mcp/
```

`server.json` (this directory, mirrored at the repo root) is the MCP Registry
metadata; the registry stores only this pointer — the server runs here on
Cloudflare.
