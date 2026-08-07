#!/usr/bin/env python3
"""Load the remote Clarity MCP tools with LlamaIndex."""

from __future__ import annotations

import argparse
import asyncio
import json
import os

DEFAULT_ENDPOINT = "https://mcp.healthai.com"


def connection_config(endpoint: str) -> dict[str, object]:
    headers: dict[str, str] = {}
    if api_key := os.environ.get("CLARITY_MCP_API_KEY"):
        headers["X-API-Key"] = api_key
    return {"url": endpoint, "headers": headers}


async def load_tool_names(endpoint: str) -> list[str]:
    from llama_index.tools.mcp import BasicMCPClient, McpToolSpec

    config = connection_config(endpoint)
    client = BasicMCPClient(config["url"], headers=config["headers"])
    tool_spec = McpToolSpec(client=client)
    tools = await tool_spec.to_tool_list_async()
    return sorted(tool.metadata.name for tool in tools)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--check-config", action="store_true")
    args = parser.parse_args()

    if args.check_config:
        print(json.dumps(connection_config(args.endpoint), sort_keys=True))
        return 0

    print(json.dumps(asyncio.run(load_tool_names(args.endpoint)), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
