<!-- mcp-name: com.healthai/clarity -->

# Clarity MCP — `com.healthai/clarity`

Clarity is a condition-aware ingredient checker and scanner for wellness,
fitness, tracker, and health-AI workflows. Results can include a verdict, an
evidence tier (Gold/Silver/Bronze), and citations when available.

Hosted MCP server — no install and no key required for anonymous,
rate-limited access. Endpoint:
**`https://mcp.healthai.com`** (Streamable HTTP, JSON-RPC 2.0). Published to the
official MCP Registry as **`com.healthai/clarity`** (domain-verified namespace).

For a human-readable implementation guide covering Claude.ai, Claude Code,
OpenAI's Responses API, generic remote MCP configuration, tool boundaries, and
the MCP-versus-REST decision, see
**[healthai.com/clarity/mcp](https://healthai.com/clarity/mcp/)**.

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

**OpenAI Responses API:** pass the hosted endpoint as a remote MCP tool and
keep approvals enabled while evaluating it:

```js
import OpenAI from "openai";

const client = new OpenAI();
const response = await client.responses.create({
  model: "gpt-5.6",
  tools: [{
    type: "mcp",
    server_label: "clarity",
    server_url: "https://mcp.healthai.com",
    require_approval: "always"
  }],
  input: "Audit iron, calcium, and magnesium for pregnancy and interactions."
});
```

## Tools (9)

| Tool | What it answers |
|---|---|
| `check_ingredient` | Verdict + evidence tier + citation for a cosmetic/food/supplement ingredient, under one condition lens or several at once (`lenses: [..]`) |
| `check_stack` | Audit a supplement stack in one call: per-item condition verdicts plus every curated interaction within the stack |
| `find_alternatives` | Safer same-category swaps for a flagged product — general quality-score ranked, lens-flag screened, coverage-honest (food/skincare; verify the pick with `scan_barcode`) |
| `strain_lookup` | Verdict, tier, PMID citation and safety flags for a cannabis or mushroom species/strain |
| `scan_barcode` | Look up a product by UPC/EAN, flag its ingredients for a condition lens, and surface any active FDA recall |
| `validate_claim` | Fact-check a free-text health claim against Clarity's curated position — supports / contradicts / does-not-cover, with citation |
| `check_interaction` | Curated ingredient-to-ingredient interactions — type, severity, mechanism, clinical note, source (single or pair) |
| `score_product` | Category-specific product quality score by barcode (food / skincare / supplement), each dimension distinct, always with data-quality coverage |
| `check_recall` | Consumer-product recall matches by brand and optional product name, with source URLs and a medical-device scope boundary |

**Condition lenses:** `breastfeeding`, `lactation`, `pregnancy`, `histamine`,
`mcas`, `rosacea`, `hs`, `allergy`, `all`.

Every result includes `human_url` — a live Clarity page for that exact answer
(gated against the site's keep-list so it never 410s), for agents to hand their
user as the source link. The server also exposes MCP `prompts`
(audit_supplement_stack, fact_check_health_claim, product_safety_check) and
`resources` (`clarity://methodology`, `clarity://lenses`).

Anonymous use is rate-limited to 60 tool calls/min per IP (Durable Object
limiter); add an `X-API-Key` header for higher metered limits. The
`scan_barcode` live fallback can refresh Clarity's product mirror and count
unmatched ingredient tokens. Uncovered `validate_claim` statements can be
counted in the review queue, so inputs must not contain personal information.
Descriptive — **not medical advice**; absence of a flag is not proof of safety.

For MCP transport security, non-browser clients may omit `Origin`. Requests to
the MCP endpoint that include `Origin` must match the requested endpoint's
origin exactly; mismatches return HTTP 403.

## Data handling

Tool inputs can include ingredient or product names, condition lenses,
supplement stacks, barcodes, ingredient pairs, and free-text health claims.
Every tool call writes bounded operational telemetry for reliability, abuse
prevention, and latency monitoring. That telemetry includes the tool name,
keyed/anonymous status, condition lens, a short request fingerprint, status,
and duration; it does not include raw tool arguments. `scan_barcode` may query
Open Food Facts or Open Beauty Facts and refresh a private Clarity mirror.
Uncovered `validate_claim` text may enter a private review queue.

Do not send names, contact details, medical records, or other personal
information. Review the public [privacy policy](https://healthai.com/privacy-policy)
before connecting this server.

Runnable direct, LangChain, LlamaIndex, Cloudflare Agents, and Hugging Face
client examples live in [`examples/mcp`](examples/mcp).

This repository is the curated public developer surface for the hosted server:
setup, examples, metadata, and the stdio bridge. Production implementation,
deployment configuration, credentials, and operational data are maintained
separately.
