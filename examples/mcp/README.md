# Clarity MCP client examples

These examples connect to the public Clarity MCP endpoint at
`https://mcp.healthai.com`. Clarity is a condition-aware ingredient checker and
scanner for wellness, fitness, tracker, and health-AI workflows.

See the [Clarity MCP connection guide](https://healthai.com/clarity/mcp/) for
Claude.ai, Claude Code, OpenAI Responses API, generic client, trust-boundary,
and MCP-versus-REST instructions.

The endpoint uses MCP Streamable HTTP with JSON-RPC 2.0. Anonymous access is
rate limited; an optional API key can be supplied through
`CLARITY_MCP_API_KEY`. Never put an API key in source code.

## Examples

| File | Purpose | Local validation |
|---|---|---|
| `direct_client.py` | Dependency-free MCP initialize, tool listing, and explicit tool call | `python3 examples/mcp/direct_client.py --check-config` |
| `langchain_tools.py` | Load Clarity tools with `langchain-mcp-adapters` | `python3 examples/mcp/langchain_tools.py --check-config` |
| `llamaindex_tools.py` | Load Clarity tools with LlamaIndex | `python3 examples/mcp/llamaindex_tools.py --check-config` |
| `huggingface_agent.py` | Give a Hugging Face agent only Clarity's read-only tools | `python3 examples/mcp/huggingface_agent.py --check-config` |
| `cloudflare-agent.mjs` | Connect a Cloudflare Agent to Clarity as a remote MCP server | `node --check examples/mcp/cloudflare-agent.mjs` |

Run the direct example:

```bash
python3 examples/mcp/direct_client.py --list-tools
python3 examples/mcp/direct_client.py --ingredient "magnesium glycinate" \
  --conditions "pregnancy,histamine"
```

Install optional framework dependencies only for the example you intend to
run:

```bash
python3 -m pip install langchain-mcp-adapters
python3 -m pip install llama-index-tools-mcp
python3 -m pip install huggingface_hub
```

The framework examples load or expose tools; they do not deploy Clarity,
publish a marketplace listing, or change product data. The Hugging Face example
allows only the seven tools annotated as read-only. `scan_barcode` can query
live external product sources and update Clarity's product mirror, while
uncovered text sent to `validate_claim` can enter a review queue. Call those
tools only through an explicit user action and do not send personal information.

Clarity provides informational evidence screening, not medical advice.

The local checks above validate configuration and syntax without contacting the
endpoint. Run framework examples against a pinned dependency version before
describing them as runtime-tested.
