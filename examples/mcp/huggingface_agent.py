#!/usr/bin/env python3
"""Connect a Hugging Face agent to Clarity's read-only MCP tools."""

from __future__ import annotations

import argparse
import asyncio
import json
import os

DEFAULT_ENDPOINT = "https://mcp.healthai.com"
READ_ONLY_TOOLS = [
    "check_ingredient",
    "check_stack",
    "find_alternatives",
    "strain_lookup",
    "check_interaction",
    "score_product",
    "check_recall",
]


def connection_config(endpoint: str) -> dict[str, object]:
    headers: dict[str, str] = {}
    if api_key := os.environ.get("CLARITY_MCP_API_KEY"):
        headers["X-API-Key"] = api_key
    return {
        "transport": "http",
        "url": endpoint,
        "headers": headers,
        "allowed_tools": READ_ONLY_TOOLS,
    }


async def run_prompt(prompt: str, model: str, config: dict[str, object]) -> None:
    from huggingface_hub import MCPClient

    messages = [{"role": "user", "content": prompt}]
    async with MCPClient(model=model) as client:
        await client.add_mcp_server(
            config["transport"],
            url=config["url"],
            headers=config["headers"],
            allowed_tools=config["allowed_tools"],
        )
        async for item in client.process_single_turn_with_tools(messages):
            print(item)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", nargs="?")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--model", default=os.environ.get("HF_INFERENCE_MODEL"))
    parser.add_argument("--check-config", action="store_true")
    args = parser.parse_args()

    config = connection_config(args.endpoint)
    if args.check_config:
        print(json.dumps(config, sort_keys=True))
        return 0
    if not args.prompt or not args.model:
        parser.error("provide a prompt and --model (or HF_INFERENCE_MODEL)")

    asyncio.run(run_prompt(args.prompt, args.model, config))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
