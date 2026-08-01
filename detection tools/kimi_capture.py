"""
MITM capture script for Kimi app API calls.
Logs all HTTP request/response details to kimi-capture.jsonl
"""
import json
import os
from datetime import datetime
from mitmproxy import http

LOG_FILE = os.path.join(os.path.dirname(__file__), "kimi-capture.jsonl")

def request(flow: http.HTTPFlow) -> None:
    # Log all requests to kimi.com domains
    host = flow.request.pretty_host
    if "kimi" not in host and "moonshot" not in host:
        return

    entry = {
        "timestamp": datetime.now().isoformat(),
        "type": "request",
        "method": flow.request.method,
        "url": flow.request.pretty_url,
        "headers": dict(flow.request.headers),
        "content_type": flow.request.headers.get("content-type", ""),
    }

    # Capture request body
    body = flow.request.get_text()
    if body:
        entry["body"] = body[:10000]  # cap at 10k chars

    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    print(f"[REQ] {flow.request.method} {flow.request.pretty_url}")

def response(flow: http.HTTPFlow) -> None:
    host = flow.request.pretty_host
    if "kimi" not in host and "moonshot" not in host:
        return

    entry = {
        "timestamp": datetime.now().isoformat(),
        "type": "response",
        "method": flow.request.method,
        "url": flow.request.pretty_url,
        "status_code": flow.response.status_code,
        "res_headers": dict(flow.response.headers),
        "content_type": flow.response.headers.get("content-type", ""),
    }

    # Capture response body (but not huge streaming SSE dumps)
    body = flow.response.get_text()
    if body:
        entry["body"] = body[:15000]  # cap at 15k chars

    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    print(f"[RES] {flow.response.status_code} {flow.request.method} {flow.request.pretty_url}")
