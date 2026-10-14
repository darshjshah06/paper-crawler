#!/usr/bin/env python3
"""
fetch_paper.py: download an arXiv paper as HTML so the browser app can read it.

Why download at all? Browsers block cross-origin requests (CORS), so the page
can't fetch arxiv.org directly. We grab the paper once, save it locally under
papers/, and serve.py hands it to the browser from the same origin.

Usage:
    python fetch_paper.py                     # defaults to "Attention Is All You Need"
    python fetch_paper.py 1706.03762
    python fetch_paper.py https://arxiv.org/abs/2005.14165v4
    python fetch_paper.py --batch "1706.03762 2005.14165 1810.04805"

Pipeline for each paper:
  1. Metadata (title, authors, date, abstract) from the arXiv Atom API.
  2. HTML from arxiv.org/html/{id} (native LaTeXML HTML, mostly papers from late
     2023 onward). If that 404s, fall back to ar5iv.labs.arxiv.org, which
     covers older papers.
  3. Rewrite relative image/CSS URLs to absolute ones so figures still load.
  4. Save papers/{id}.html and papers/{id}.json, and refresh papers/index.json.

Standard library only. We wait ~3 seconds between requests, as arXiv's API
terms ask.
"""

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PAPERS_DIR = ROOT / "papers"

DEFAULT_ID = "1706.03762"  # Attention Is All You Need
USER_AGENT = "PaperCrawler/1.0 (educational paper-reading demo; python-urllib)"
POLITE_DELAY = 3.0  # seconds between requests to arXiv

ATOM = "{http://www.w3.org/2005/Atom}"

_last_request = 0.0


def polite_get(url):
    """GET a URL with our User-Agent, waiting so we never hit arXiv faster than
    once every POLITE_DELAY seconds. Returns (final_url, bytes)."""
    global _last_request
    wait = POLITE_DELAY - (time.time() - _last_request)
    if wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.geturl(), resp.read()
    finally:
        _last_request = time.time()


def parse_arxiv_id(text):
    """Accept '1706.03762', '1706.03762v7', 'arxiv.org/abs/1706.03762',
    'https://arxiv.org/pdf/1706.03762v2.pdf', or old-style 'cs/0112017'."""
    text = text.strip()
    m = re.search(r"(\d{4}\.\d{4,5}(?:v\d+)?)", text)
    if m:
        return m.group(1)
    m = re.search(r"([a-z\-]+(?:\.[A-Z]{2})?/\d{7}(?:v\d+)?)", text)
    if m:
        return m.group(1)
    raise ValueError(f"Couldn't find an arXiv ID in {text!r}")


def file_stem(arxiv_id):
    """Old-style IDs contain a slash; make them filename-safe."""
    return arxiv_id.replace("/", "_")


# ---------------------------------------------------------------------------
# 1. Metadata from the arXiv API (Atom XML)
# ---------------------------------------------------------------------------

def fetch_metadata(arxiv_id):
    url = "https://export.arxiv.org/api/query?id_list=" + urllib.parse.quote(arxiv_id)
    _, body = polite_get(url)
    feed = ET.fromstring(body)
    entry = feed.find(ATOM + "entry")
    if entry is None or entry.find(ATOM + "title") is None:
        raise RuntimeError(f"arXiv API returned no entry for {arxiv_id}")

    def clean(s):
        return re.sub(r"\s+", " ", s or "").strip()

    return {
        "id": arxiv_id,
        "title": clean(entry.findtext(ATOM + "title")),
        "authors": [clean(a.findtext(ATOM + "name")) for a in entry.findall(ATOM + "author")],
        "published": (entry.findtext(ATOM + "published") or "")[:10],
        "updated": (entry.findtext(ATOM + "updated") or "")[:10],
        "abstract": clean(entry.findtext(ATOM + "summary")),
        "abs_url": f"https://arxiv.org/abs/{arxiv_id}",
    }


# ---------------------------------------------------------------------------
# 2. The paper as HTML: native arXiv HTML first, ar5iv as a fallback
# ---------------------------------------------------------------------------

def looks_like_paper(html):
    # Both arXiv HTML and ar5iv are produced by LaTeXML, whose root article
    # carries the class "ltx_document".
    return "ltx_document" in html


def fetch_html(arxiv_id):
    sources = [
        ("arxiv.org/html", f"https://arxiv.org/html/{arxiv_id}"),
        ("ar5iv", f"https://ar5iv.labs.arxiv.org/html/{arxiv_id}"),
    ]
    for name, url in sources:
        try:
            final_url, body = polite_get(url)
        except urllib.error.HTTPError as e:
            print(f"  {name}: HTTP {e.code}, trying next source")
            continue
        except urllib.error.URLError as e:
            print(f"  {name}: {e.reason}, trying next source")
            continue
        html = body.decode("utf-8", errors="replace")
        # ar5iv redirects to the abstract page when it has no rendering.
        if "/html/" not in final_url or not looks_like_paper(html):
            print(f"  {name}: no HTML rendering, trying next source")
            continue
        print(f"  {name}: ok ({len(body) // 1024} KB)")
        return final_url, html, name
    raise RuntimeError(
        f"Paper {arxiv_id} has no HTML version on arxiv.org/html or ar5iv. "
        "(Some papers, usually ones whose LaTeX failed to convert, are PDF-only.)"
    )


# ---------------------------------------------------------------------------
# 3. Make relative URLs absolute so figures and stylesheets still resolve
#    once the file is served from localhost.
# ---------------------------------------------------------------------------

ATTR_RE = re.compile(r'(\s(?:src|href|data-src|poster))=(["\'])(.*?)\2', re.I | re.S)
SRCSET_RE = re.compile(r'(\ssrcset)=(["\'])(.*?)\2', re.I | re.S)
SKIP_PREFIXES = ("#", "data:", "mailto:", "javascript:", "http://", "https://", "//")


def absolutize(html, base_url):
    # A <base href> tag, if present, changes what relative URLs resolve against.
    m = re.search(r'<base\s[^>]*href=(["\'])(.*?)\1', html, re.I)
    if m:
        base_url = urllib.parse.urljoin(base_url, m.group(2))
        html = re.sub(r"<base\s[^>]*>", "", html, flags=re.I)

    def fix_attr(m):
        attr, quote, url = m.groups()
        if url.startswith(SKIP_PREFIXES) or not url.strip():
            if url.startswith("//"):
                url = "https:" + url
            return f"{attr}={quote}{url}{quote}"
        return f"{attr}={quote}{urllib.parse.urljoin(base_url, url)}{quote}"

    def fix_srcset(m):
        attr, quote, value = m.groups()
        parts = []
        for item in value.split(","):
            bits = item.strip().split()
            if bits and not bits[0].startswith(SKIP_PREFIXES):
                bits[0] = urllib.parse.urljoin(base_url, bits[0])
            parts.append(" ".join(bits))
        return f"{attr}={quote}{', '.join(parts)}{quote}"

    html = ATTR_RE.sub(fix_attr, html)
    html = SRCSET_RE.sub(fix_srcset, html)
    return html


def strip_scripts(html):
    # We never execute the paper's scripts, so drop them from the saved file.
    return re.sub(r"<script\b.*?</script>", "", html, flags=re.I | re.S)


# ---------------------------------------------------------------------------
# 4. Save + index
# ---------------------------------------------------------------------------

def update_index():
    """papers/index.json lists every saved paper. serve.py also builds this
    list on the fly; the file is a fallback for plain static hosting."""
    items = []
    for meta_file in sorted(PAPERS_DIR.glob("*.json")):
        if meta_file.name == "index.json":
            continue
        try:
            meta = json.loads(meta_file.read_text())
            items.append({"id": meta["id"], "file": meta_file.stem, "title": meta["title"]})
        except (ValueError, KeyError):
            pass
    (PAPERS_DIR / "index.json").write_text(json.dumps(items, indent=2))


def fetch_paper(raw_id):
    arxiv_id = parse_arxiv_id(raw_id)
    print(f"[{arxiv_id}] fetching metadata")
    meta = fetch_metadata(arxiv_id)
    print(f"  title: {meta['title']}")
    print(f"[{arxiv_id}] fetching HTML")
    final_url, html, source = fetch_html(arxiv_id)
    html = strip_scripts(absolutize(html, final_url))
    meta["html_source"] = source
    meta["html_url"] = final_url
    meta["file"] = file_stem(arxiv_id)

    PAPERS_DIR.mkdir(exist_ok=True)
    (PAPERS_DIR / f"{meta['file']}.html").write_text(html, encoding="utf-8")
    (PAPERS_DIR / f"{meta['file']}.json").write_text(json.dumps(meta, indent=2))
    update_index()
    print(f"[{arxiv_id}] saved papers/{meta['file']}.html + .json")
    return meta


def main():
    ap = argparse.ArgumentParser(description="Download arXiv papers as HTML for Paper Crawler.")
    ap.add_argument("paper", nargs="?", default=DEFAULT_ID, help="arXiv ID or URL")
    ap.add_argument("--batch", help='space-separated list, e.g. "1706.03762 1810.04805"')
    args = ap.parse_args()

    ids = args.batch.split() if args.batch else [args.paper]
    failures = 0
    for raw in ids:
        try:
            fetch_paper(raw)
        except Exception as e:  # keep going in batch mode
            failures += 1
            print(f"ERROR ({raw}): {e}", file=sys.stderr)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
