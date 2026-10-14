// =============================================================================
// analyst.js: the AI explainer panel. The spider walks; Claude reads.
//
// Pipeline:
//   1. On load, queue a TL;DR of the abstract.
//   2. Each time the spider's body enters a new section, crawler.js emits
//      'section'. We queue { title, section, text } for that section.
//   3. One request at a time: POST /api/explain (serve.py), which streams
//      Claude's answer back as Server-Sent Events. We type it out live.
//   4. The answer ends with a "KEY: ..." line: the most important exact phrase.
//      We hand it to crawler.pointAt(), which finds it in the paper, runs the
//      spider over, and hits it with the biggest markup.
//
// Also: "Explain this" (select text + E), a scrollable history, the Crawler
// Notes tab (metrics/models/datasets the spider stepped on), and exports.
// =============================================================================

const MAX_CHARS = 12000; // section text budget per request (~3k tokens)

export class Analyst {
  constructor({ crawler, toast }) {
    this.crawler = crawler;
    this.toast = toast;
    this.level = 'student';
    this.paper = null;
    this.queue = [];
    this.busy = false;
    this.seen = new Set();   // dedupe keys of queued/explained items
    this.history = [];       // finished explanations, oldest first
    this.notes = [];         // crawler notes
    this.aiEnabled = null;   // unknown until /api/status answers
    this.model = '';
    this.abort = null;

    this.$ = (id) => document.getElementById(id);
    this.el = {
      status: this.$('ai-status'),
      liveSection: this.$('live-section'),
      liveText: this.$('live-text'),
      liveKey: this.$('live-key'),
      history: this.$('history'),
      notesList: this.$('notes-list'),
      notesCount: this.$('notes-count'),
    };

    // Tabs
    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
        this.$('tab-explain').hidden = tab.dataset.tab !== 'explain';
        this.$('tab-notes').hidden = tab.dataset.tab !== 'notes';
      });
    }
    this.$('export-md').addEventListener('click', () => this.exportMarkdown());
    this.$('export-notes').addEventListener('click', () => this.exportNotes());
    this.el.liveKey.addEventListener('click', () => {
      if (this.liveKey) this.crawler.pointAt(this.liveKey.phrase, this.liveKey.sectionIndex);
    });

    crawler.on('section', ({ index, section }) => this.onSection(index, section));
    crawler.on('note', (n) => this.addNote(n));
    crawler.on('pointMissed', (phrase) => this.toast(`couldn't find "${phrase}" in the text`));

    this.checkStatus();
  }

  async checkStatus() {
    try {
      const res = await fetch('/api/status');
      const s = await res.json();
      this.aiEnabled = s.ai;
      this.model = s.model;
    } catch {
      this.aiEnabled = false;
    }
    if (!this.aiEnabled) {
      this.el.status.textContent =
        'AI explainer is off: no ANTHROPIC_API_KEY.\n' +
        'Add ANTHROPIC_API_KEY=sk-ant-... to a .env file next to serve.py and restart it. ' +
        'The spider keeps crawling either way. (Cached explanations still play.)';
    }
    this.pump();
  }

  // ------------------------------------------------------------------ paper --
  setPaper(paper) {
    this.paper = paper;
    if (this.abort) this.abort.abort();
    this.queue = [];
    this.busy = false;
    this.seen.clear();
    this.history = [];
    this.notes = [];
    this.renderHistory();
    this.renderNotes();
    this.setLive('TL;DR', '');
    // Explain the abstract right away as a TL;DR.
    const abs = paper.sections.find((s) => s.isAbstract);
    const text = (abs && abs.text) || paper.meta.abstract || paper.sections[0].text;
    this.enqueue({
      mode: 'tldr', label: 'TL;DR', section: 'Abstract',
      sectionIndex: abs ? abs.index : 0, text,
    });
  }

  setLevel(level) {
    if (level === this.level) return;
    this.level = level;
    document.getElementById('level-select').value = level;
    const names = { beginner: 'beginner (CS freshman)', student: 'student', researcher: 'researcher' };
    this.toast(`explaining for: ${names[level]}`);
    // Re-explain where the spider is right now, at the new level.
    const idx = this.crawler.sectionIndex;
    const s = this.paper?.sections[idx];
    if (s && idx > 0 && !s.isRefs && !s.isAbstract) this.enqueueSection(idx, s, true);
  }

  onSection(index, section) {
    if (index === 0 || section.isAbstract || section.isRefs) {
      if (section.isRefs) this.toast('reached References: done reading');
      return;
    }
    this.enqueueSection(index, section, false);
  }

  enqueueSection(index, section, front) {
    this.enqueue({ mode: 'section', label: section.label, section: section.label, sectionIndex: index }, front);
  }

  /** "Explain this": the user selected text and pressed E. */
  explainSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !this.paper) { this.toast('select some text in the paper first, then press E'); return; }
    const range = sel.getRangeAt(0);
    if (!this.paper.root.contains(range.commonAncestorContainer)) { this.toast('select text inside the paper'); return; }
    // Clone the selection so math comes through as LaTeX (alttext), not MathML soup.
    const box = document.createElement('div');
    box.append(range.cloneContents());
    const text = this.paper.blockText(box).slice(0, 4000);
    if (text.length < 2) return;
    const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const idx = this.paper.sectionIndexOf(node);
    this.crawler.gotoSelection(range);
    const short = text.length > 42 ? text.slice(0, 40) + '…' : text;
    this.enqueue({
      mode: 'selection', label: `“${short}”`, section: this.paper.sections[idx].label,
      sectionIndex: idx, text,
    }, true);
  }

  // ------------------------------------------------------------------ queue --
  enqueue(item, front = false) {
    item.level = this.level;
    const key = `${item.mode}|${item.label}|${item.level}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    item.paperId = this.paper.meta.file || this.paper.meta.id;
    if (front) this.queue.unshift(item); else this.queue.push(item);
    this.pump();
  }

  async pump() {
    if (this.busy || this.aiEnabled === null || !this.queue.length || !this.paper) return;
    const item = this.queue.shift();
    this.busy = true;
    const paper = this.paper;
    try {
      await this.explain(item);
    } finally {
      if (paper === this.paper) {
        this.busy = false;
        // A short breath between explanations so each one can be read.
        setTimeout(() => this.pump(), 900);
      }
    }
  }

  /** Section text, trimmed to the budget, prioritizing paragraphs the spider walked over. */
  sectionText(index) {
    const s = this.paper.sections[index];
    if (s.text.length <= MAX_CHARS) return s.text;
    const walked = [...this.crawler.walked];
    const isWalked = (b) => walked.some((w) => b === w || b.contains(w));
    const texts = s.blocks.map((b) => this.paper.blockText(b));
    const chosen = new Set();
    let used = 0;
    const take = (i) => {
      if (chosen.has(i) || used + texts[i].length > MAX_CHARS) return;
      chosen.add(i);
      used += texts[i].length + 2;
    };
    s.blocks.forEach((b, i) => { if (isWalked(b)) take(i); }); // walked paragraphs first
    s.blocks.forEach((_, i) => take(i));                         // then fill in order
    return [...chosen].sort((a, b) => a - b).map((i) => texts[i]).join('\n\n');
  }

  // ---------------------------------------------------------------- explain --
  async explain(item) {
    const text = item.text ?? this.sectionText(item.sectionIndex);
    this.setLive(item.mode === 'tldr' ? 'TL;DR' : item.label, '');
    this.el.liveText.classList.add('typing');

    // Typewriter: network chunks land in `target`; the display catches up smoothly.
    let target = '';
    let shown = 0;
    let streamDone = false;
    let raf;
    const typed = new Promise((resolve) => {
      const tick = () => {
        const backlog = target.length - shown;
        if (backlog > 0) {
          shown += Math.max(1, Math.ceil(backlog / 12)); // faster when far behind
          this.el.liveText.innerHTML = render(visiblePart(target.slice(0, shown)));
        }
        if (streamDone && shown >= target.length) return resolve();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });

    let error = null;
    let cached = false;
    this.abort = new AbortController();
    try {
      const res = await fetch('/api/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: this.abort.signal,
        body: JSON.stringify({
          paperId: item.paperId, title: this.paper.meta.title, section: item.section,
          text, level: item.level, mode: item.mode,
        }),
      });
      if (!res.ok || !res.body) throw new Error(`server returned ${res.status}`);
      // Read the SSE stream by hand: frames are "event: x\ndata: {...}\n\n".
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const ev = /^event: (.*)$/m.exec(frame)?.[1];
          const data = JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] || '{}');
          if (ev === 'delta') target += data.text;
          else if (ev === 'error') error = data.message;
          else if (ev === 'done') cached = data.cached;
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') { cancelAnimationFrame(raf); return; }
      error = e.message;
    }
    streamDone = true;
    await typed;
    this.el.liveText.classList.remove('typing');

    if (error && !target) {
      this.el.liveText.innerHTML = `<span style="color:#ffb08a">⚠ ${escapeHtml(error)}</span>`;
      if (/API_KEY/.test(error)) this.aiEnabled = false;
      return;
    }

    // Split off the KEY line and send the spider to it.
    const { body, key } = splitKey(target);
    this.el.liveText.innerHTML = render(body);
    const entry = { ...item, text: body, key, cached, model: this.model };
    this.history.push(entry);
    this.renderHistory();
    if (key) {
      this.liveKey = { phrase: key, sectionIndex: item.sectionIndex };
      this.el.liveKey.textContent = `KEY ▸ ${key}`;
      this.el.liveKey.hidden = false;
      this.crawler.pointAt(key, item.sectionIndex);
    }
  }

  setLive(label, text) {
    this.el.liveSection.textContent = label;
    this.el.liveText.textContent = text;
    this.el.liveKey.hidden = true;
    this.liveKey = null;
  }

  renderHistory() {
    // Newest first. The live card already shows the latest, so skip it.
    const items = this.history.slice(0, -1).reverse();
    this.el.history.innerHTML = items.map((h, i) => `
      <div class="h-item">
        <div class="h-head"><span>${escapeHtml(h.mode === 'tldr' ? 'TL;DR' : h.label)}</span>
          <span class="h-tag">${h.mode === 'selection' ? 'selection · ' : ''}${h.level}</span></div>
        <div class="h-text">${render(h.text)}</div>
        ${h.key ? `<div class="h-key" data-i="${this.history.length - 2 - i}">KEY ▸ ${escapeHtml(h.key)}</div>` : ''}
      </div>`).join('');
    for (const k of this.el.history.querySelectorAll('.h-key')) {
      k.addEventListener('click', () => {
        const h = this.history[Number(k.dataset.i)];
        this.crawler.pointAt(h.key, h.sectionIndex);
      });
    }
  }

  // ------------------------------------------------------------------ notes --
  addNote(n) {
    this.notes.push(n);
    this.renderNotes();
  }

  renderNotes() {
    this.el.notesCount.textContent = this.notes.length;
    this.el.notesList.innerHTML = this.notes.slice().reverse().map((n) => `
      <div class="note">
        <div class="note-head"><span class="note-type ${n.type}">${n.type}</span>
          <span class="note-text">${escapeHtml(n.text)}</span> <span class="note-sec">· ${escapeHtml(n.section)}</span></div>
        <div class="note-ctx">${escapeHtml(n.sentence)}</div>
      </div>`).join('');
  }

  // ----------------------------------------------------------------- export --
  exportMarkdown() {
    if (!this.paper) return;
    const m = this.paper.meta;
    const tldr = this.history.find((h) => h.mode === 'tldr');
    const sections = this.history.filter((h) => h.mode === 'section');
    const selections = this.history.filter((h) => h.mode === 'selection');
    const keys = this.history.filter((h) => h.key);
    const metrics = this.notes.filter((n) => n.type === 'metric');
    const L = [];
    L.push(`# ${m.title}`, '');
    L.push(`**Authors:** ${(m.authors || []).join(', ')}  `);
    L.push(`**arXiv:** [${m.id}](https://arxiv.org/abs/${m.id})${m.published ? ` · ${m.published}` : ''}  `);
    L.push(`**Explained for:** ${this.level} · generated by Paper Crawler${this.model ? ` with ${this.model}` : ''}`, '');
    if (tldr) L.push('## TL;DR', '', tldr.text, '', tldr.key ? `> **Key:** ${tldr.key}` : '', '');
    if (sections.length) {
      L.push('## Section by section', '');
      for (const s of sections) {
        L.push(`### ${s.label}`, '', s.text, '');
        if (s.key) L.push(`> **Key:** ${s.key}`, '');
      }
    }
    if (selections.length) {
      L.push('## Passages explained on request', '');
      for (const s of selections) L.push(`### ${s.label} (${s.section})`, '', s.text, '');
    }
    if (keys.length || metrics.length) {
      L.push('## Key results', '');
      for (const k of keys) L.push(`- **${k.key}**: ${k.mode === 'tldr' ? 'TL;DR' : k.label}`);
      for (const n of metrics) L.push(`- ${n.text} (${n.section}): “${n.sentence}”`);
      L.push('');
    }
    const models = uniq(this.notes.filter((n) => n.type === 'model').map((n) => n.text));
    const datasets = uniq(this.notes.filter((n) => n.type === 'dataset').map((n) => n.text));
    if (models.length) L.push(`**Models & methods mentioned:** ${models.join(', ')}`, '');
    if (datasets.length) L.push(`**Datasets mentioned:** ${datasets.join(', ')}`, '');
    download(`${m.file || m.id}-breakdown.md`, L.join('\n'), 'text/markdown');
  }

  exportNotes() {
    if (!this.paper) return;
    const m = this.paper.meta;
    const data = { paper: { id: m.id, title: m.title }, exported: new Date().toISOString(), notes: this.notes };
    download(`${m.file || m.id}-crawler-notes.json`, JSON.stringify(data, null, 2), 'application/json');
  }
}

// ----------------------------------------------------------------- helpers ---

// Everything before the KEY: line (and hide a half-typed "KE..." at the end).
function visiblePart(text) {
  const i = text.search(/(^|\n)\s*\**KEY\**:/);
  if (i >= 0) return text.slice(0, i);
  return text.replace(/(^|\n)\s*\**K(E(Y)?)?$/, '');
}

function splitKey(text) {
  const m = /(?:^|\n)\s*\**KEY\**:\s*(.+)\s*$/m.exec(text);
  const key = m ? m[1].trim().replace(/^["'“`*]+|["'”`*]+$/g, '').trim() : '';
  return { body: visiblePart(text).trim(), key };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Minimal markdown: **bold** and *italic*, after escaping.
function render(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
}

function uniq(arr) { return [...new Set(arr)]; }

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
