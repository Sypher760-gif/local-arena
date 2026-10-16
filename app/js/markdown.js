// Safe markdown renderer for model text. Builds DOM with createElement/textContent only,
// never innerHTML, so model output can never inject markup. renderMarkdown(text) returns a
// DocumentFragment. It re-renders safely on half-finished input while a reply streams: an
// unclosed ** or an unclosed fence shows the text so far and never throws. The Copy button on
// a code block is created here; wiring its click is the caller's job.

const QUOTE_RE = /^ {0,3}>/;
const QUOTE_STRIP = /^ {0,3}> ?/;

export function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i += 1; continue; }

    const fence = matchFence(line);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !isFenceClose(lines[i], fence.marker, fence.minLen)) { body.push(lines[i]); i += 1; }
      if (i < lines.length) i += 1;
      frag.append(codeBlock(body.join("\n"), fence.lang));
      continue;
    }

    const heading = matchHeading(line);
    if (heading) {
      const h = make(`h${heading.level}`, "md-heading");
      h.append(...inlineNodes(heading.text));
      frag.append(h);
      i += 1;
      continue;
    }

    if (isRule(line)) { frag.append(make("hr", "md-rule")); i += 1; continue; }

    if (QUOTE_RE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) { inner.push(lines[i].replace(QUOTE_STRIP, "")); i += 1; }
      const quote = make("blockquote", "md-quote");
      quote.append(renderMarkdown(inner.join("\n")));
      frag.append(quote);
      continue;
    }

    if (looksLikeTable(lines, i)) { i = parseTable(lines, i, frag); continue; }

    if (matchListItem(line)) { i = parseList(lines, i, frag); continue; }

    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !startsNewBlock(lines, i)) { para.push(lines[i].trim()); i += 1; }
    const p = make("p", "md-para");
    para.forEach((ln, k) => { if (k > 0) p.append(document.createElement("br")); p.append(...inlineNodes(ln)); });
    frag.append(p);
  }
  return frag;
}

function make(tag, cls) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

function inlineNodes(text) {
  const out = [];
  let plain = "";
  let i = 0;
  const flush = () => { if (plain !== "") { out.push(document.createTextNode(plain)); plain = ""; } };
  while (i < text.length) {
    const c = text[i];

    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        flush();
        const code = make("code", "md-inline-code");
        code.textContent = text.slice(i + 1, end);
        out.push(code);
        i = end + 1;
        continue;
      }
      plain += c; i += 1; continue;
    }

    if (c === "[") {
      const close = text.indexOf("]", i + 1);
      if (close !== -1 && text[close + 1] === "(") {
        const paren = text.indexOf(")", close + 2);
        if (paren !== -1) {
          const label = text.slice(i + 1, close);
          const url = text.slice(close + 2, paren).trim();
          if (/^https?:\/\//i.test(url)) {
            flush();
            const a = make("a", "md-link");
            a.setAttribute("href", url);
            a.setAttribute("target", "_blank");
            a.setAttribute("rel", "noopener noreferrer");
            a.append(...inlineNodes(label));
            out.push(a);
            i = paren + 1;
            continue;
          }
          plain += text.slice(i, paren + 1); i = paren + 1; continue;
        }
      }
      plain += c; i += 1; continue;
    }

    if (c === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        flush();
        const strong = make("strong", "md-bold");
        strong.append(...inlineNodes(text.slice(i + 2, end)));
        out.push(strong);
        i = end + 2;
        continue;
      }
      plain += "**"; i += 2; continue;
    }

    if (c === "*") {
      const end = text.indexOf("*", i + 1);
      if (end !== -1) {
        flush();
        const em = make("em", "md-italic");
        em.append(...inlineNodes(text.slice(i + 1, end)));
        out.push(em);
        i = end + 1;
        continue;
      }
      plain += c; i += 1; continue;
    }

    if (c === "_" && canOpenUnderscore(text, i)) {
      const end = findUnderscoreClose(text, i + 1);
      if (end !== -1) {
        flush();
        const em = make("em", "md-italic");
        em.append(...inlineNodes(text.slice(i + 1, end)));
        out.push(em);
        i = end + 1;
        continue;
      }
    }

    plain += c; i += 1;
  }
  flush();
  return out;
}

function canOpenUnderscore(text, i) {
  return i === 0 || !/[A-Za-z0-9]/.test(text[i - 1]);
}

function findUnderscoreClose(text, start) {
  let j = text.indexOf("_", start);
  while (j !== -1) {
    const after = text[j + 1];
    if (after === undefined || !/[A-Za-z0-9]/.test(after)) return j;
    j = text.indexOf("_", j + 1);
  }
  return -1;
}

function matchFence(line) {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  return { marker: m[1][0], minLen: m[1].length, lang: m[2].trim().split(/\s+/)[0] || "" };
}

function isFenceClose(line, marker, minLen) {
  const esc = marker === "`" ? "`" : "~";
  return new RegExp("^ {0,3}(" + esc + "{" + minLen + ",})[ \\t]*$").test(line);
}

function matchHeading(line) {
  const m = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
  if (!m) return null;
  return { level: m[1].length, text: m[2] };
}

function isRule(line) {
  return /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/.test(line);
}

function matchListItem(line) {
  const un = /^(\s*)([-*+])\s+(.*)$/.exec(line);
  if (un) return { indent: un[1], ordered: false, text: un[3] };
  const ord = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line);
  if (ord) return { indent: ord[1], ordered: true, text: ord[3] };
  return null;
}

function startsNewBlock(lines, i) {
  const line = lines[i];
  if (line.trim() === "") return true;
  return !!(matchFence(line) || matchHeading(line) || isRule(line) || QUOTE_RE.test(line)
    || matchListItem(line) || looksLikeTable(lines, i));
}

function parseList(lines, i, frag) {
  const first = matchListItem(lines[i]);
  const top = make(first.ordered ? "ol" : "ul", "md-list" + (first.ordered ? " md-list-ordered" : ""));
  frag.append(top);
  let lastTopLi = null;
  let nested = null;
  let nestedTag = null;
  while (i < lines.length) {
    const item = matchListItem(lines[i]);
    if (!item) break;
    const li = make("li", "md-list-item");
    li.append(...inlineNodes(item.text));
    if (item.indent.length < 2) {
      top.append(li);
      lastTopLi = li;
      nested = null;
      nestedTag = null;
    } else if (lastTopLi) {
      const wantTag = item.ordered ? "ol" : "ul";
      if (!nested || nestedTag !== wantTag) {
        nested = make(wantTag, "md-list" + (item.ordered ? " md-list-ordered" : ""));
        nestedTag = wantTag;
        lastTopLi.append(nested);
      }
      nested.append(li);
    } else {
      top.append(li);
      lastTopLi = li;
    }
    i += 1;
  }
  return i;
}

function looksLikeTable(lines, i) {
  return i + 1 < lines.length && lines[i].includes("|") && isSeparatorRow(lines[i + 1]);
}

function isSeparatorRow(line) {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c)) && cells.some((c) => c.includes("-"));
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function cellAlign(cell) {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

function parseTable(lines, i, frag) {
  const header = splitRow(lines[i]);
  const aligns = splitRow(lines[i + 1]).map(cellAlign);
  const table = make("table", "md-table");
  const thead = make("thead");
  const htr = make("tr", "md-tr");
  header.forEach((cell, idx) => {
    const th = make("th", "md-th");
    applyAlign(th, aligns[idx]);
    th.append(...inlineNodes(cell));
    htr.append(th);
  });
  thead.append(htr);
  table.append(thead);
  const tbody = make("tbody");
  i += 2;
  while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
    const tr = make("tr", "md-tr");
    splitRow(lines[i]).forEach((cell, idx) => {
      const td = make("td", "md-td");
      applyAlign(td, aligns[idx]);
      td.append(...inlineNodes(cell));
      tr.append(td);
    });
    tbody.append(tr);
    i += 1;
  }
  table.append(tbody);
  frag.append(table);
  return i;
}

function applyAlign(cell, align) {
  if (align) cell.setAttribute("style", `text-align:${align}`);
}

function codeBlock(code, lang) {
  const wrap = make("div", "md-codeblock");
  const head = make("div", "md-code-head");
  if (lang) {
    const label = make("span", "md-code-lang");
    label.textContent = lang;
    head.append(label);
  }
  const copy = make("button", "md-copy");
  copy.type = "button";
  copy.textContent = "Copy";
  head.append(copy);
  const pre = make("pre", "md-code");
  const codeEl = make("code");
  codeEl.textContent = code;
  pre.append(codeEl);
  wrap.append(head, pre);
  return wrap;
}
