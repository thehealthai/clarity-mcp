#!/usr/bin/env python3
"""Minimal dependency-free client for the remote Clarity MCP server."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

DEFAULT_ENDPOINT = "https://mcp.healthai.com"
PROTOCOL_VERSION = "2025-06-18"


def request(endpoint: str, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
    }
    if params is not None:
        payload["params"] = params

    headers = {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        "User-Agent": "clarity-mcp-direct-example/1.0",
    }
    api_key = os.environ.get("CLARITY_MCP_API_KEY")
    if api_key:
        headers["X-API-Key"] = api_key

    http_request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(http_request, timeout=20) as response:
        return json.load(response)


def initialize(endpoint: str) -> None:
    response = request(
        endpoint,
        "initialize",
        {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "clarity-mcp-direct-example", "version": "1.0.0"},
        },
    )
    if "error" in response:
        raise RuntimeError(response["error"])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--check-config", action="store_true")
    parser.add_argument("--list-tools", action="store_true")
    parser.add_argument("--ingredient")
    parser.add_argument("--conditions", default="")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.check_config:
        print(json.dumps({"endpoint": args.endpoint, "protocolVersion": PROTOCOL_VERSION}))
        return 0

    try:
        initialize(args.endpoint)
        if args.ingredient:
            result = request(
                args.endpoint,
                "tools/call",
                {
                    "name": "check_ingredient",
                    "arguments": {
                        "name": args.ingredient,
                        "lenses": [
                            value.strip()
                            for value in args.conditions.split(",")
                            if value.strip()
                        ],
                    },
                },
            )
        else:
            result = request(args.endpoint, "tools/list")
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except (OSError, urllib.error.URLError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"Clarity MCP request failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
