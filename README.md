# Paper Crawler /[•]\

A spider that reads ML research papers for you.

A procedurally animated, inverse-kinematics spider drops onto a real arXiv paper on a silk thread. It walks across the page and plants its feet on actual words, marking up what it touches the way a researcher annotates a paper. As it crawls into each section, Claude explains that section in plain English in a side panel. Then the spider runs to the exact phrase or number Claude says matters most and hits it with a big highlight.

It's a pun on "web crawler", but it really does read the paper.

Plain JavaScript (ES modules) and CSS. No frameworks, no build step, no npm. Python standard library only.

## Quick start

```bash
python fetch_paper.py                 # downloads "Attention Is All You Need" (1706.03762)
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env   # optional: enables the AI explainer
python serve.py                       # then open http://localhost:5173
```

Without an API key, the spider still crawls and marks up the paper. The panel tells you the explainer is off.

More papers:

```bash
python fetch_paper.py 1810.04805
python fetch_paper.py https://arxiv.org/abs/2005.14165
python fetch_paper.py --batch "1706.03762 2005.14165 1810.04805"
```

Or skip the terminal: **drag an arXiv PDF onto the page** (or click **PDF** in the panel, or paste an arXiv link and press **go**). The spider drops onto it as soon as it's downloaded.

Every paper in `papers/` appears in the dropdown, and you can switch between them live.

## Controls

| Input | What it does |
|---|---|
| Mouse move | The spider chases the cursor |
| Click | Send the spider there |
| `Space` | Pause |
| `F` | Camera follow on/off |
| `T` | Title overlay ("I built a spider that reads ML papers for me", set by `TITLE_TEXT` in `index.html`) |
| `1` `2` `3` | Markup intensity: calm / normal / wild |
| `B` `S` `R` | Explanation level: beginner / student / researcher |
| Select text + `E` | The spider runs to your selection and Claude explains just that passage or equation |
| `C` | Clear all markup |
| `D` | Re-drop the spider from the top |
| `?debug` | Draws IK bones, foot targets and step thresholds, plus an FPS HUD. Exposes `window.__crawler` and `window.__analyst` |

The panel also has export buttons. **Export breakdown (.md)** saves a Markdown "paper breakdown" (TL;DR, each section explained, key results), which works well as Obsidian notes or a carousel script. **Export notes (.json)** saves every metric, model and dataset the spider stepped on, with its section and surrounding sentence.

## File structure

```
fetch_paper.py      downloads an arXiv paper as HTML into papers/
papers/             saved papers ({id}.html + {id}.json metadata + index.json)
serve.py            static server, /api/explain proxy to Claude (holds the API key), /api/add for dropped PDFs
cache/              cached AI explanations, one JSON file per paper/section/level
index.html          entry point (also wires the modules together + keyboard controls)
css/style.css       paper theme + all markup effect classes (.m-*)
js/loader.js        loads the paper, cleans it, detects sections, wraps words in spans
js/crawler.js       spider: IK, gait, thread drop, foot anchoring, effects, camera, loop
js/spider-draw.js   renders the spider + silk on a <canvas> overlay
js/analyst.js       AI explainer panel + crawler notes
```

## How it works, in plain English

### 1. Getting the paper (`fetch_paper.py`)

Browsers won't let a page on `localhost` fetch arxiv.org directly (that's CORS), so we download each paper once.

1. **Metadata.** We ask the arXiv API (`export.arxiv.org/api/query?id_list=...`) for the title, authors, date and abstract. It answers in Atom XML, which Python's `xml.etree` parses.
2. **HTML.** arXiv renders LaTeX to HTML with a tool called LaTeXML. Newer papers (mostly late 2023 onward) live at `arxiv.org/html/{id}`. Older ones are at `ar5iv.labs.arxiv.org/html/{id}`. We try the first, fall back to the second, and print a clear error if neither has the paper.
3. **Fix links.** Figure `src` attributes are relative (`x1.png`), so we rewrite them to absolute arXiv URLs. That way the figures still load from our local copy.
4. **Be polite.** We send a descriptive User-Agent and wait about 3 seconds between requests, as arXiv's API terms ask.

**Adding papers from the page.** A dropped PDF is POSTed to `serve.py`'s `/api/add`. The app never reads text out of the PDF itself: PDFs have no real words to stand on. Instead the server works out *which* arXiv paper it is, then runs the same download as `fetch_paper.py`. Every PDF arXiv serves has a stamp down the left margin like `arXiv:2106.09685v2 [cs.CL] 16 Oct 2021`. The server inflates the PDF's compressed page streams with `zlib` and looks for that stamp; the `[category]` part tells it apart from cited papers. If there's no stamp, it tries the file name (`1706.03762v7.pdf`). PDFs that aren't from arXiv get a clear error.

### 2. The page (`loader.js`)

- The saved HTML is parsed with `DOMParser`, which is inert: nothing runs. We keep just the `<article>` and strip site chrome and scripts.
- **Sections.** Each heading (Abstract, `1 Introduction`, `3.2 Attention`, References...) starts a section that runs to the next heading. For each one we store a DOM `Range`, its paragraphs, and its plain text. Math becomes its LaTeX source, because MathML text is unreadable.
- **Footholds.** Every word becomes `<span class="w">word</span>`, so the spider has something to stand on. We never touch `<math>`, code or images. A long paper has tens of thousands of words, so we only wrap paragraphs near the screen. An `IntersectionObserver` queues them, and the crawler wraps a few per frame.

### 3. The spider (`crawler.js` + `spider-draw.js`)

**Two-bone inverse kinematics.** Each leg has a femur (length *a*) and a tibia (length *b*). We know where the hip is (on the body) and where the foot should be (on a word). The hip, knee and foot form a triangle with sides *a*, *b* and *d* (the hip-to-foot distance). The law of cosines gives the angle at the hip:

```
cos(A) = (a² + d² − b²) / (2·a·d)
```

The knee sits at that angle off the hip→foot line. A triangle can fold two ways, so each leg has a fixed "bend" sign that makes its knee bulge outward like a real spider's. If the foot is out of reach, `d` is clamped and the leg straightens. See `solveLeg()`.

**Gait: alternating tetrapod.** Real spiders move legs in two sets of four: L1, R2, L3, R4, then R1, L2, R3, L4. Each leg has a rest pose relative to the body. As the body moves, a planted foot drifts away from its rest pose. When a group's feet drift past a threshold, and the other group is fully planted, the whole group steps. So the spider always stands on four legs. A step is an eased lift–swing–plant arc lasting 120–180ms (shorter when running). A badly over-stretched leg steps immediately. Feet aim a little ahead of the body's velocity, so steps land where the spider is going.

**Wandering.** While reading, the spider picks waypoints that hop sideways a bit, like eyes along a line, while drifting down the page. It sometimes pauses to "read". Smooth value noise wobbles its heading and speed so it never looks robotic. It stops progressing at References.

**The entrance.** The spider falls from above the screen on a silk thread with its legs tucked. It bounces on a damped spring (the silk stretching), then splays its legs onto the title. The thread stays pinned to the top of the screen, swaying, until the spider has walked about 240px. Then it snaps and recoils.

**Feet on real words.** To place a foot, we call `document.elementFromPoint` at the target and a small ring around it, and take the nearest `.w` word (or a link or table cell). The foot stores *which* element it stands on and where inside it. Every frame it re-reads that element's position, so feet stay glued to words through scrolling. If the word disappears or reflows away, the foot lets go and re-steps.

**Drawing.** `spider-draw.js` is pure canvas code: a glossy black thorax and abdomen with a tiny white eye, thin cyan legs with red dots at the knees and feet, twitching palps, and faint silk to the last few touched words. The canvas has `pointer-events: none`, so the paper underneath stays clickable and selectable.

### 4. Research markup and smart targeting

Every time a foot plants, the `Marker` may mark the word: thin colored boxes, an orange/purple/magenta/cyan bar, a green highlighter, a 2–3x number blow-up, a phrase rotated −70° in green, or a recolor. Marks persist, so the spider leaves an annotation trail. Section headings get a purple monospace bar as the spider enters them.

Words that look important are always considered, and get the dramatic effects about 3x more often:

- metrics and results (`28.4 BLEU`, `92.1%`, `+3.2`, `175B`)
- model and method names (Transformer, BERT, LoRA, CamelCase, ALL-CAPS)
- datasets (ImageNet, WMT 2014, GLUE, COCO, MMLU...)
- citations like `[12]` and equation numbers like `(1)`
- claims ("we propose", "outperforms", "novel", "state-of-the-art"...)

Metrics, models and datasets also go into the **Crawler Notes** tab.

### 5. The AI explainer (`serve.py` + `analyst.js`)

1. When the spider's body enters a new section, `analyst.js` queues it. On load, it also queues a TL;DR of the abstract. Only one request runs at a time.
2. The section text is trimmed to about 12k characters. Paragraphs the spider actually walked over are kept first.
3. The browser POSTs `{ title, section, text, level }` to `/api/explain`. **The API key never leaves `serve.py`**: it's read from the environment or `.env`, and `.env` is never served (the server only serves an allowlist of folders).
4. `serve.py` calls the Anthropic Messages API with `"stream": true` and relays the text to the browser as Server-Sent Events, so it types out live. The prompt is at the top of `serve.py`, easy to edit. It asks for under 70 words plus a final `KEY:` line holding the single most important exact phrase or number.
5. When the answer finishes, the panel finds the `KEY:` text in the paper, including inside equations. The spider runs to it and hits it with an orange blow-up and a red box. Click any KEY chip in the history to send it back.
6. Finished explanations are cached in `cache/{paperId}_{section}_{level}.json`, so re-runs don't re-bill.

The model is set by `MODEL` at the top of `serve.py` (default: `claude-sonnet-5-5`, with low effort, since these are short summaries). `serve.py` also opts into Anthropic's server-side fallbacks: if a request is declined by a safety classifier, it is retried on a fallback model.

### 6. Staying at 60fps

The main loop runs `update()`, `draw()`, then `commit()`:

- `update()` only **reads** the DOM (positions, scroll, `elementFromPoint`).
- `draw()` only touches the canvas.
- `commit()` applies every queued DOM **write** at once: markup classes, word wrapping, scrolling.

Mixing reads and writes makes the browser recompute layout repeatedly ("layout thrashing"). Batching them keeps it to at most one layout per frame. Section positions are re-measured twice a second, not every frame.

The camera auto-scrolls to keep the spider about 42% down the screen. If you scroll yourself, the camera backs off for 2.5s. If the spider is then off-screen, it drops into wherever you scrolled to.

## 5 famous ML papers to try

| Paper | arXiv ID |
|---|---|
| Attention Is All You Need (Transformer) | `1706.03762` |
| BERT: Pre-training of Deep Bidirectional Transformers | `1810.04805` |
| Language Models are Few-Shot Learners (GPT-3) | `2005.14165` |
| Deep Residual Learning for Image Recognition (ResNet) | `1512.03385` |
| LoRA: Low-Rank Adaptation of Large Language Models | `2106.09685` |

```bash
python fetch_paper.py --batch "1706.03762 1810.04805 2005.14165 1512.03385 2106.09685"
```

Some papers have no HTML rendering (their LaTeX failed to convert). `fetch_paper.py` will say so.

## Tuning

- `CFG` at the top of `js/crawler.js`: leg lengths, step threshold and timing, speeds, reading pace, camera anchor, thread snap distance.
- `LEG_LAYOUT` in `js/crawler.js`: where each leg attaches and rests.
- `INTENSITY` in `js/crawler.js`: how much markup each mode leaves.
- `SECTION_PROMPT`, `TLDR_PROMPT`, `SELECTION_PROMPT` and `LEVELS` in `serve.py`: what Claude is asked.
- `.m-*` classes in `css/style.css`: what each markup looks like.

## Auto-commit every 3 days

`tools/autocommit/` commits and pushes every 3 days at 18:30. A macOS launchd agent wakes it daily, and the script skips until 3 days have passed since its last run (tracked in `.git/autocommit-last-run`). It uses one of 10 short, casual commit messages and never repeats the previous one. If nothing changed, it makes an empty commit, so there is always one every 3 days.

```bash
./tools/autocommit/install.sh             # install / reinstall
./tools/autocommit/install.sh uninstall   # remove
./tools/autocommit/autocommit.sh --force  # run once by hand, ignoring the 3-day wait
```

Log: `~/Library/Logs/paper-crawler-autocommit.log`. Edit the `MESSAGES` list in `autocommit.sh` to change the wording.
