#!/usr/bin/env python3
"""
serve.py: static file server + /api/explain proxy to Claude.

    python serve.py            then open http://localhost:5173

Why a proxy? The Anthropic API key must never reach the browser. The page posts
{ title, section, text, level } here, this server adds the key, calls the
Anthropic Messages API with streaming on, and relays the text to the page as
Server-Sent Events (SSE) so the explanation types out live.

Every finished explanation is cached in cache/{paperId}_{sectionSlug}_{level}.json,
so re-runs don't get billed again.

Standard library only.
"""

import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# ---------------------------------------------------------------------------
# Settings you might want to change
# ---------------------------------------------------------------------------

MODEL = "claude-sonnet-5-5"  # a current Claude Sonnet model
PORT = 5173
MAX_TOKENS = 4000            # headroom for the model's (hidden) thinking + ~70 words
EFFORT = "low"               # short plain-English summaries don't need deep thinking
# If Claude's safety classifiers decline a request, retry it server-side on a
# fallback model instead of returning a refusal (beta feature).
USE_SERVER_FALLBACKS = True

API_URL = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/") + "/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"

ROOT = Path(__file__).resolve().parent
CACHE_DIR = ROOT / "cache"
PAPERS_DIR = ROOT / "papers"

# Only these paths are served. Everything else (.env, cache/, .git, *.py) is off-limits.
PUBLIC_FILES = {"/index.html", "/README.md"}
PUBLIC_DIRS = ("/css/", "/js/", "/papers/")

# ---------------------------------------------------------------------------
# The prompt. Edit freely: {section}, {title}, {level} and {text} are filled in.
# ---------------------------------------------------------------------------

LEVELS = {
    "beginner": "CS freshman",
    "student": "CS student who knows basic ML",
    "researcher": "ML researcher; be precise and technical",
}

SECTION_PROMPT = (
    "You are explaining the '{section}' section of the ML paper '{title}' to a {level}. "
    "In under 70 words: what this section says, why it matters, and any key number or result. "
    "Use plain English and one simple analogy if it helps. Define any jargon you use. "
    "Then output one line starting with 'KEY:' containing the single most important exact "
    "phrase or number from the section text (copied exactly as written)."
)

TLDR_PROMPT = (
    "You are writing a TL;DR of the ML paper '{title}' for a {level}, based on its abstract. "
    "In under 70 words: what problem it tackles, what the authors did, and the headline result. "
    "Use plain English and one simple analogy if it helps. Define any jargon you use. "
    "Then output one line starting with 'KEY:' containing the single most important exact "
    "phrase or number from the abstract (copied exactly as written)."
)

SELECTION_PROMPT = (
    "You are explaining a passage the reader highlighted in the ML paper '{title}' "
    "(from the '{section}' section) to a {level}. It may be a sentence, a table cell, or an "
    "equation written in LaTeX. In under 70 words: what it says and why it matters. For an "
    "equation, say what each symbol means. Use plain English and define any jargon. "
    "Then output one line starting with 'KEY:' containing the single most important exact "
    "phrase or number from the passage (copied exactly as written)."
)

PROMPTS = {"section": SECTION_PROMPT, "tldr": TLDR_PROMPT, "selection": SELECTION_PROMPT}
MAX_TEXT_CHARS = 12000


def build_prompt(mode, title, section, level, text):
    template = PROMPTS.get(mode, SECTION_PROMPT)
    instructions = template.format(
        section=section, title=title, level=LEVELS.get(level, LEVELS["student"])
    )
    return f"{instructions}\n\n<section_text>\n{text[:MAX_TEXT_CHARS]}\n</section_text>"


# ---------------------------------------------------------------------------
# API key: environment variable first, then a .env file next to this script
# ---------------------------------------------------------------------------

def load_api_key():
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if key:
        return key
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line.startswith("export "):
                line = line[7:]
            if line.startswith("ANTHROPIC_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


API_KEY = load_api_key()


# ---------------------------------------------------------------------------
# Cache helpers
# ---------------------------------------------------------------------------

def slug(s):
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s[:60] or "section"


def cache_path(paper_id, mode, section, level, text):
    safe_id = re.sub(r"[^A-Za-z0-9._-]", "_", paper_id or "paper")
    if mode == "selection":
        # Selections are arbitrary text, so key them by a hash of the passage.
        name = "sel-" + hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]
    elif mode == "tldr":
        name = "tldr"
    else:
        name = slug(section)
    return CACHE_DIR / f"{safe_id}_{name}_{level}.json"


# ---------------------------------------------------------------------------
# Streaming call to the Anthropic Messages API
# ---------------------------------------------------------------------------

def stream_claude(prompt, use_fallbacks=True):
    """Yield text chunks from Claude as they arrive.

    With "stream": true the API answers with SSE events. We only care about
    content_block_delta events carrying a text_delta; thinking blocks and
    the rest are skipped.
    """
    body = {
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "stream": True,
        "output_config": {"effort": EFFORT},
        "messages": [{"role": "user", "content": prompt}],
    }
    headers = {
        "x-api-key": API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
    }
    if use_fallbacks:
        body["fallbacks"] = "default"
        headers["anthropic-beta"] = "server-side-fallback-2026-07-01"

    req = urllib.request.Request(API_URL, data=json.dumps(body).encode(), headers=headers)
    try:
        resp = urllib.request.urlopen(req, timeout=120)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        # If this account/model doesn't accept the fallback beta, retry once without it.
        if e.code == 400 and use_fallbacks and "fallback" in detail.lower():
            yield from stream_claude(prompt, use_fallbacks=False)
            return
        raise RuntimeError(f"Anthropic API error {e.code}: {detail[:400]}") from None

    with resp:
        for raw in resp:  # the response body is line-delimited SSE
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            try:
                event = json.loads(line[5:].strip())
            except ValueError:
                continue
            etype = event.get("type")
            if etype == "content_block_delta":
                delta = event.get("delta", {})
                if delta.get("type") == "text_delta":
                    yield delta.get("text", "")
            elif etype == "message_delta":
                if event.get("delta", {}).get("stop_reason") == "refusal":
                    raise RuntimeError("Claude declined to explain this passage.")
            elif etype == "error":
                raise RuntimeError(event.get("error", {}).get("message", "stream error"))


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        # Keep the console quiet except for API calls (logged below).
        pass

    # ---- static files (allowlisted) ---------------------------------------
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            self.path = "/index.html"
            return super().do_GET()
        if path == "/api/papers":
            return self.send_json(list_papers())
        if path == "/api/status":
            return self.send_json({"ai": bool(API_KEY), "model": MODEL})
        if path in PUBLIC_FILES or (path.startswith(PUBLIC_DIRS) and ".." not in path):
            return super().do_GET()
        self.send_error(404)

    def end_headers(self):
        # Papers are fetched locally; never let the browser cache stale JS during dev.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, obj, status=200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ---- /api/explain ------------------------------------------------------
    def do_POST(self):
        if self.path.split("?", 1)[0] != "/api/explain":
            return self.send_error(404)
        try:
            length = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self.send_json({"error": "bad JSON"}, 400)

        paper_id = str(req.get("paperId", "paper"))
        title = str(req.get("title", "Untitled paper"))[:300]
        section = str(req.get("section", "Section"))[:200]
        text = str(req.get("text", ""))[:MAX_TEXT_CHARS]
        level = req.get("level") if req.get("level") in LEVELS else "student"
        mode = req.get("mode") if req.get("mode") in PROMPTS else "section"

        # SSE response: the browser reads "event:" / "data:" frames as they arrive.
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        cfile = cache_path(paper_id, mode, section, level, text)
        if cfile.exists():
            cached = json.loads(cfile.read_text())["text"]
            # Replay the cache in small chunks so it still "types out".
            for i in range(0, len(cached), 24):
                if not self.sse("delta", {"text": cached[i:i + 24]}):
                    return
            self.sse("done", {"cached": True})
            return

        if not API_KEY:
            self.sse("error", {"message": "No ANTHROPIC_API_KEY set. Add it to .env and restart serve.py."})
            return

        print(f"[explain] {paper_id} / {mode} / {section!r} ({level}, {len(text)} chars)")
        full = []
        try:
            for chunk in stream_claude(build_prompt(mode, title, section, level, text)):
                full.append(chunk)
                if not self.sse("delta", {"text": chunk}):
                    return  # browser went away; don't cache a partial answer
        except Exception as e:
            print(f"[explain] error: {e}", file=sys.stderr)
            self.sse("error", {"message": str(e)})
            return

        result = "".join(full).strip()
        if result:
            CACHE_DIR.mkdir(exist_ok=True)
            cfile.write_text(json.dumps({
                "paperId": paper_id, "section": section, "mode": mode, "level": level,
                "model": MODEL, "created": int(time.time()), "text": result,
            }, indent=2))
        self.sse("done", {"cached": False})

    def sse(self, event, data):
        """Write one SSE frame. Returns False if the client disconnected."""
        try:
            self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())
            self.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError):
            return False


def list_papers():
    items = []
    for meta_file in sorted(PAPERS_DIR.glob("*.json")):
        if meta_file.name == "index.json":
            continue
        if not (PAPERS_DIR / f"{meta_file.stem}.html").exists():
            continue
        try:
            meta = json.loads(meta_file.read_text())
            items.append({"id": meta["id"], "file": meta_file.stem, "title": meta["title"]})
        except (ValueError, KeyError):
            continue
    return items


def main():
    CACHE_DIR.mkdir(exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Paper Crawler running at http://localhost:{PORT}")
    print(f"  model: {MODEL}")
    print(f"  AI explainer: {'ON' if API_KEY else 'OFF (set ANTHROPIC_API_KEY in env or .env)'}")
    print(f"  papers: {len(list_papers())} in papers/ (add more with: python fetch_paper.py <arxiv-id>)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
