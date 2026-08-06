#!/usr/bin/env python3
"""Load the remote Clarity MCP tools with LangChain."""

from __future__ import annotations

import argparse
import asyncio
import json
import os

DEFAULT_ENDPOINT = "https://mcp.healthai.com"


def server_config(endpoint: str) -> dict[str, dict[str, object]]:
    headers: dict[str, str] = {}
    if api_key := os.environ.get("CLARITY_MCP_API_KEY"):
        headers["X-API-Key"] = api_key
    return {
        "clarity": {
            "transport": "http",
            "url": endpoint,
            "headers": headers,
        }
    }


async def load_tool_names(endpoint: str) -> list[str]:
    from langchain_mcp_adapters.client import MultiServerMCPClient

    client = MultiServerMCPClient(server_config(endpoint))
    tools = await client.get_tools()
    return sorted(tool.name for tool in tools)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--check-config", action="store_true")
    args = parser.parse_args()

    if args.check_config:
        print(json.dumps(server_config(args.endpoint), sort_keys=True))
        return 0

    print(json.dumps(asyncio.run(load_tool_names(args.endpoint)), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

