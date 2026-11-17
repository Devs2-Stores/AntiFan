// trello-card.js - read-only probe for anti.browser.evaluate in a Trello card tab (https://trello.com/c/<shortLink>/...).
// WHY: card descriptions and comments carry bare passwords on a line of their own; returning body.innerText put them
//   into the session JSONL twice (13/11/2026). This returns the card in blocks and masks every secret-shaped string
//   INSIDE the page, so the secret never reaches the tool result.
// USAGE: pass the expression `LJ probe --name trello-card` prints, unchanged, to anti.browser.evaluate. It waits up to
//   ~9 s (evaluate is cut at 15 s; navigate first and let the tab settle: a cold card took 8.6 s to mount on 13/11/2026)
//   for the card back to mount, then returns {title, listName, labels, due, descriptionMasked, checklist,
//   comments:[{author,textMasked}], attachments, shape} plus partial:true and ready:{back,loading,title,description} if it gave up waiting.
// SECRET FOR A LOGIN: the Admin password on the card must be typed, not read. Add `--copy-secret [N]` to `LJ probe`: the probe
//   puts the N-th secret-shaped value of the DESCRIPTION (default 1; order = labelled values, then bare tokens) into the
//   clipboard and returns {copy:{copied,len,index,total,secrets:[{index,kind,len}]}} without the value. Then Ctrl+V into the
//   password field with anti.agent.sequence, and overwrite the clipboard with an empty string (navigator.clipboard.writeText("")
//   in the same tab). The Trello tab must be the ACTIVE tab for the clipboard write to be allowed.
// MASKING (heuristic, shape based, never a guarantee): everything after a label password|mật khẩu|mk|pass|pw|otp|token|
//   key|secret (with a ':'/'=' up to the next ' | ', ' / ' or ';', or the next token if it has a digit or symbol) and any
//   whitespace-free token of 6-64 chars with >= 2 of {upper, lower, digit, symbol} that is NOT letters-only (a line that
//   is a lone token needs one digit or symbol, inside a line it needs 3 classes) becomes [masked:<length>]. Emails, URLs,
//   domains, file names, dates, numbers and metrics like LCP<2.5s are kept. Letters-only mixed-case words (PageSpeed,
//   HelloWorld) are kept, so a camelCase password with no digit or symbol and no label is NOT masked.
// shape lists which selectors matched, so a changed Trello DOM shows up as zeros instead of silently empty fields.
// TEST HOOK: window.__PROBE_MASK_TEXT = "<text>" returns {masked} for that text without touching the DOM.
// DOES NOT PROVE: that the card has no other secret form (an image of a password, an attachment's content).
(async () => {
  const LABEL = "password|passwd|mật khẩu|mat khau|pass|pw|pwd|mk|otp|token|api[ _-]?key|key|secret";
  const NB = "(?<![\\p{L}\\p{N}_])";
  const NA = "(?![\\p{L}\\p{N}_])";
  const withSep = new RegExp(`${NB}(?:${LABEL})${NA}([\\s\\p{L}*_\`()]{0,30}?\\s*[:：=][*_\`]*\\s*)([^\\n]*)`, "giu");
  const noSep = new RegExp(`${NB}(?:${LABEL})${NA}([*_\`]*[ \\t]+)(\\S+)`, "giu");
  const isMarker = (s) => /^\[masked:\d+\]$/.test(s);
  const strip = (tok) => {
    const m = /^([("'`\[{<*_]*)(.*?)([)"'`\]}>*_,;.:：]*)$/su.exec(tok);
    return { pre: m[1], core: m[2], post: m[3] };
  };
  const classes = (s) => ({
    U: /\p{Lu}/u.test(s),
    L: /\p{Ll}/u.test(s),
    D: /\p{Nd}/u.test(s),
    S: /[^\p{L}\p{N}\-_.\s]/u.test(s),
  });
  const safeToken = (c) =>
    isMarker(c) ||
    /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(c) ||
    /:\/\//.test(c) ||
    /^www\./i.test(c) ||
    /\]\(/.test(c) ||
    /^[\p{L}\p{N}_-]+(\.[\p{L}\p{N}_-]+)*\.[A-Za-z]{2,6}$/u.test(c) ||
    /^v?\d+(\.\d+)+$/.test(c) ||
    /^[\d.,\-:/+()]+\p{L}{0,3}$/u.test(c) ||
    /^[A-Za-z]{2,6}\s*[<>≤≥=:~≈]\s*[\d.]+\p{L}{0,3}%?$/u.test(c) ||
    /^[<>≤≥~≈][\d.]+\p{L}{0,3}%?$/u.test(c);
  const tokenSecret = (c, lone) => {
    if (c.length < 6 || c.length > 64 || /\s/.test(c) || safeToken(c)) return false;
    const k = classes(c);
    const n = (k.U ? 1 : 0) + (k.L ? 1 : 0) + (k.D ? 1 : 0) + (k.S ? 1 : 0);
    if (n < 2 || !(k.D || k.S)) return false;
    return lone ? true : n >= 3;
  };
  let sink = null; // collects the raw secret values of the DESCRIPTION pass only; never returned
  const maskText = (input) => {
    let text = String(input ?? "");
    text = text.replace(withSep, (all, head, rest) => {
      const cut = rest.search(/\s[|/]\s|;/);
      const value = (cut < 0 ? rest : rest.slice(0, cut)).trimEnd();
      if (!value.trim()) return all;
      sink?.push({ v: value.trim(), kind: "label" });
      const tail = cut < 0 ? "" : rest.slice(cut);
      return `${all.slice(0, all.length - rest.length)}[masked:${value.trim().length}]${tail}`;
    });
    text = text.replace(noSep, (all, gap, tok) => {
      const { pre, core, post } = strip(tok);
      if (core.length < 4 || /[:：=]$/.test(core) || safeToken(core)) return all;
      const k = classes(core);
      if (!(k.D || k.S)) return all;
      sink?.push({ v: core, kind: "label" });
      return `${all.slice(0, all.length - tok.length)}${pre}[masked:${core.length}]${post}`;
    });
    return text
      .split("\n")
      .map((line) => {
        const bare = line.replace(/^\s*(?:[-*+•]\s+|\d+[.)]\s+)?/, "").trim();
        const lone = bare !== "" && !/\s/.test(bare);
        return line.replace(/\S+/g, (tok) => {
          const { pre, core, post } = strip(tok);
          let body = core;
          let lead = "";
          const kv = /^([\p{L}\p{N}_]{1,20}[:=])(?!\/\/)(.+)$/u.exec(core);
          if (kv) {
            lead = kv[1];
            body = kv[2];
          }
          if (!tokenSecret(body, lone)) return tok;
          sink?.push({ v: body, kind: "bare" });
          return `${pre}${lead}[masked:${body.length}]${post}`;
        });
      })
      .join("\n");
  };

  // Moves ONE found secret (1-based, in discovery order: labelled values, then bare tokens) into the clipboard and reports
  // only {copied, len, index, total, secrets:[{index,kind,len}]}; the value itself is never returned.
  const copySecret = async (found, wanted) => {
    const list = found.map((s, i) => ({ index: i + 1, kind: s.kind, len: s.v.length }));
    const pick = found[Number(wanted) - 1];
    const out = { copied: false, total: found.length, secrets: list };
    if (!pick) return { ...out, error: found.length ? "index out of range" : "no secret-shaped value in the description" };
    try {
      await navigator.clipboard.writeText(pick.v);
      return { ...out, copied: true, len: pick.v.length, index: Number(wanted) };
    } catch (e) {
      try {
        const ta = document.createElement("textarea");
        ta.value = pick.v;
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok ? { ...out, copied: true, len: pick.v.length, index: Number(wanted) } : { ...out, error: "clipboard refused (tab not active?)" };
      } catch {
        return { ...out, error: "clipboard refused (tab not active?)" };
      }
    }
  };
  const COPY = Number(window.__PROBE_COPY_SECRET) || 0;
  if (typeof window.__PROBE_MASK_TEXT === "string") {
    sink = [];
    const masked = maskText(window.__PROBE_MASK_TEXT);
    const found = sink;
    sink = null;
    return { masked, ...(COPY ? { copy: await copySecret(found, COPY) } : {}) };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  if (!/trello\.com\/c\//.test(location.href)) return { error: "not a Trello card URL", url: location.href.split("?")[0] };

  const t0 = Date.now();
  const flags = () => ({
    back: !!$('[data-testid="card-back-name"]'),
    loading: !!$('[data-testid="card-back-loading"]'),
    title: !!($('[data-testid="card-back-title-input"]') || $('[data-testid="card-back-name"] h2')),
    description: !!$('[data-testid="description-content-area"]') || $$('[data-testid="card-back-name"] h3').some((h) => /^Description$/i.test(h.innerText.trim())),
  });
  const ready = () => {
    const f = flags();
    return f.back && !f.loading && f.title && (f.description || Date.now() - t0 > 5000);
  };
  while (!ready() && Date.now() - t0 < 9000) await sleep(250);
  const readyFlags = flags();
  if (!readyFlags.back) return { error: "card back not mounted", ready: readyFlags, waitedMs: Date.now() - t0, url: location.href.split("?")[0] };
  await sleep(300);

  const back = $('[data-testid="card-back-name"]');
  const titleEl = $('[data-testid="card-back-title-input"]', back);
  const title = titleEl ? titleEl.value || titleEl.textContent : ($("h2", back)?.innerText ?? "");
  const listBtn = $$('button[aria-label^="Change list for this card"]', back)[0];
  const listName = listBtn ? (listBtn.innerText || listBtn.getAttribute("aria-label").replace(/^.*currently in\s*/i, "")).trim() : null;
  const labelEls = $$('[data-testid="card-label"]', back);
  const dueEl = $('[data-testid="due-date-badge-with-date-range-picker"]', back) || $('[data-testid="due-date-badge"]', back);
  const descEl = $('[data-testid="description-content-area"]', back);
  const checklistEls = $$('[data-testid="checklist"]', back);
  const commentEls = $$('[data-testid="comment-container"]', back);
  const attachEls = $$('[data-testid="attachment-thumbnail-name"], [data-testid="attachment-name"]', back);
  const text = (e) => (e ? (e.innerText || e.textContent || "").trim() : "");
  const comments = commentEls.map((c) => {
    const action = c.closest('[data-testid="card-back-action"]') || c.parentElement;
    const author = $('[data-testid="comment-author"]', action || c) || $('a[href^="/u/"]', action || c) || $("h3", action || c);
    return { author: maskText(text(author)).slice(0, 80), textMasked: maskText(text(c)).slice(0, 2000) };
  });
  const checklist = checklistEls.map((cl) => ({
    name: maskText(text($('[data-testid="checklist-title"]', cl) || $("h3", cl))).slice(0, 120),
    items: $$('[data-testid="check-item-container"]', cl).map((it) => ({
      textMasked: maskText(text(it)).slice(0, 300),
      done: !!$('input[type="checkbox"]:checked, [aria-checked="true"]', it),
    })),
  }));
  sink = [];
  const descriptionMasked = maskText(text(descEl)).slice(0, 6000);
  const found = sink;
  sink = null;
  const copy = COPY ? await copySecret(found, COPY) : null;
  return {
    url: location.href.split("?")[0],
    title: maskText(title).slice(0, 200),
    listName: listName === null ? null : maskText(listName).slice(0, 80),
    labels: labelEls.map((l) => maskText(text(l) || l.getAttribute("aria-label") || "").slice(0, 60)),
    due: dueEl ? text(dueEl).slice(0, 60) : null,
    descriptionMasked,
    checklist,
    comments,
    attachments: attachEls.map((a) => maskText(text(a)).slice(0, 120)),
    shape: { title: !!titleEl, list: !!listBtn, labels: labelEls.length, due: !!dueEl, description: !!descEl, checklists: checklistEls.length, comments: commentEls.length, attachments: attachEls.length },
    ...(copy ? { copy } : {}),
    ...(readyFlags.loading || !readyFlags.description ? { partial: true, ready: readyFlags } : {}),
    waitedMs: Date.now() - t0,
  };
})()
