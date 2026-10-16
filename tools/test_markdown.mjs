// Tests for app/js/markdown.js (the safe model-text renderer).
// Run: node tools/test_markdown.mjs
// No ports, no servers, no real engine: a hand-rolled fake DOM stands in for the browser.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKDOWN_JS = pathToFileURL(path.join(ROOT, "app", "js", "markdown.js")).href;

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

// Minimal DOM stand-in: createElement / createTextNode / createDocumentFragment, append
// (moves a fragment's children), textContent get/set, setAttribute/getAttribute.
class FNode {
  constructor(nodeType) { this.nodeType = nodeType; this.childNodes = []; this.parentNode = null; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  append(...nodes) {
    for (const n of nodes) {
      if (n == null) continue;
      if (typeof n === "string") { const t = new FText(n); t.parentNode = this; this.childNodes.push(t); continue; }
      if (n.nodeType === 11) { for (const c of n.childNodes.slice()) { c.parentNode = this; this.childNodes.push(c); } n.childNodes.length = 0; continue; }
      n.parentNode = this; this.childNodes.push(n);
    }
  }
  appendChild(n) { this.append(n); return n; }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
  set textContent(v) {
    this.childNodes = [];
    if (v !== "") { const t = new FText(String(v)); t.parentNode = this; this.childNodes.push(t); }
  }
}
class FElement extends FNode {
  constructor(tag) { super(1); this.tagName = String(tag).toUpperCase(); this.nodeName = this.tagName; this.className = ""; this._attrs = {}; }
  setAttribute(name, value) { this._attrs[name] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name); }
}
class FText extends FNode {
  constructor(s) { super(3); this.nodeValue = String(s); }
  get textContent() { return this.nodeValue; }
  set textContent(v) { this.nodeValue = String(v); }
}
class FFragment extends FNode { constructor() { super(11); } }

globalThis.document = {
  createElement: (tag) => new FElement(tag),
  createTextNode: (s) => new FText(s),
  createDocumentFragment: () => new FFragment(),
};

function walk(node, fn) { for (const c of node.childNodes) { if (c.nodeType === 1) { fn(c); walk(c, fn); } } }
function findAll(root, tag) { const t = tag.toUpperCase(); const out = []; walk(root, (n) => { if (n.tagName === t) out.push(n); }); return out; }
function hasTag(root, tag) { return findAll(root, tag).length > 0; }
function byClass(root, cls) { const out = []; walk(root, (n) => { if ((n.className || "").split(/\s+/).includes(cls)) out.push(n); }); return out; }

const { renderMarkdown } = await import(MARKDOWN_JS);

// 1. bold
const b = renderMarkdown("**hi** there");
const strongs = findAll(b, "strong");
check("bold makes a <strong>", strongs.length === 1 && strongs[0].textContent === "hi", strongs.map((s) => s.textContent).join("|"));
check("bold keeps the rest as plain text", b.textContent.includes("there"), b.textContent);

// 2. italic with * and _
const it = renderMarkdown("*it* and _em_");
const ems = findAll(it, "em");
check("italic makes <em> for * and _", ems.length === 2 && ems[0].textContent === "it" && ems[1].textContent === "em", ems.map((e) => e.textContent).join("|"));

// 3. inline code
const ic = renderMarkdown("use `npm run` now");
const codes = findAll(ic, "code");
check("inline code makes a <code>", codes.length === 1 && codes[0].textContent === "npm run", codes.map((c) => c.textContent).join("|"));

// 4. nested list (one level)
const nl = renderMarkdown("- a\n  - b\n- c");
const lis = findAll(nl, "li");
const nestedUl = lis[0] ? lis[0].children.filter((c) => c.tagName === "UL") : [];
check("list makes a <ul> with all items", findAll(nl, "ul").length >= 1 && lis.length === 3, `${findAll(nl, "ul").length} ul, ${lis.length} li`);
check("nested list is one level deep inside the first item",
  nestedUl.length === 1 && findAll(nestedUl[0], "li").length === 1 && findAll(nestedUl[0], "li")[0].textContent === "b",
  nestedUl.length ? nestedUl[0].textContent : "no nested list");

// 5. ordered list
const ol = renderMarkdown("1. one\n2. two");
check("1. list makes an <ol>", findAll(ol, "ol").length === 1 && findAll(ol, "li").length === 2, `${findAll(ol, "ol").length} ol`);

// 6. table with alignment
const tb = renderMarkdown("| Name | Age |\n| :--- | ---: |\n| Ann | 30 |");
const ths = findAll(tb, "th");
const tds = findAll(tb, "td");
check("table makes a <table> with header and body", findAll(tb, "table").length === 1 && ths.length === 2 && tds.length === 2,
  `${findAll(tb, "table").length} table, ${ths.length} th, ${tds.length} td`);
check("table cells carry the text",
  ths.map((t) => t.textContent).join(",") === "Name,Age" && tds.map((t) => t.textContent).join(",") === "Ann,30",
  `${ths.map((t) => t.textContent).join(",")} | ${tds.map((t) => t.textContent).join(",")}`);
check("table alignment comes from :--- and ---:",
  /text-align:\s*left/.test(ths[0]?.getAttribute("style") || "") && /text-align:\s*right/.test(ths[1]?.getAttribute("style") || ""),
  `${ths[0]?.getAttribute("style")} / ${ths[1]?.getAttribute("style")}`);

// 7. fenced code block with language and Copy button
const fc = renderMarkdown("```js\nconst x = 1;\n```");
check("fence makes a <pre><code> with the code text",
  findAll(fc, "pre").length === 1 && findAll(fc, "code").some((c) => c.textContent === "const x = 1;"),
  `${findAll(fc, "pre").length} pre`);
check("fence shows the language label", byClass(fc, "md-code-lang").length === 1 && byClass(fc, "md-code-lang")[0].textContent === "js",
  byClass(fc, "md-code-lang").map((l) => l.textContent).join(","));
check("fence has a Copy button", findAll(fc, "button").length === 1 && findAll(fc, "button")[0].textContent === "Copy",
  findAll(fc, "button").map((x) => x.textContent).join(","));

// 8. half-finished fence shows the text so far
const uf = renderMarkdown("```python\nprint(1)");
check("unclosed fence shows the text so far", findAll(uf, "code").some((c) => c.textContent === "print(1)"), uf.textContent);

// 9. half-finished bold shows the text so far and makes no <strong>
const hb = renderMarkdown("hello **world");
check("half-finished bold makes no <strong>", findAll(hb, "strong").length === 0, `${findAll(hb, "strong").length} strong`);
check("half-finished bold shows the text so far", hb.textContent.includes("hello **world"), hb.textContent);

// 10. a <script> string stays plain text
const sc = renderMarkdown("<script>alert(1)</script>");
check("a <script> string stays plain text", !hasTag(sc, "script") && sc.textContent.includes("<script>alert(1)</script>"), sc.textContent);

// 11. javascript: links are not made into links
const jl = renderMarkdown("[click](javascript:alert(1))");
check("javascript: link is not made into a link", findAll(jl, "a").length === 0 && jl.textContent.includes("javascript:"), jl.textContent);

// 12. http(s) links become safe links
const gl = renderMarkdown("[docs](https://example.com/a)");
const links = findAll(gl, "a");
check("http(s) link becomes an <a> opened safely",
  links.length === 1 && links[0].getAttribute("href") === "https://example.com/a"
    && links[0].getAttribute("target") === "_blank" && links[0].getAttribute("rel") === "noopener noreferrer",
  links.length ? `${links[0].getAttribute("href")} ${links[0].getAttribute("rel")}` : "no link");

// 13. headings # to ######
const hd = renderMarkdown("# Title\n### Sub");
check("headings become h1..h6", findAll(hd, "h1").length === 1 && findAll(hd, "h1")[0].textContent === "Title"
  && findAll(hd, "h3").length === 1 && findAll(hd, "h3")[0].textContent === "Sub",
  `${findAll(hd, "h1").length} h1, ${findAll(hd, "h3").length} h3`);

// 14. blockquote keeps inline formatting
const q = renderMarkdown("> quoted **text**");
const bq = findAll(q, "blockquote");
check("quote makes a <blockquote> and keeps inline bold",
  bq.length === 1 && findAll(bq[0], "strong").length === 1 && bq[0].textContent.includes("quoted"),
  bq.length ? bq[0].textContent : "no quote");

// 15. --- rule
const r = renderMarkdown("a\n---\nb");
check("--- makes an <hr> rule", hasTag(r, "hr") && r.textContent.includes("a") && r.textContent.includes("b"), r.textContent);

// 16. single line break becomes a <br> inside one paragraph
const lb = renderMarkdown("line one\nline two");
check("single line break becomes a <br> in one paragraph",
  findAll(lb, "br").length === 1 && findAll(lb, "p").length === 1 && lb.textContent.includes("line one") && lb.textContent.includes("line two"),
  `${findAll(lb, "p").length} p, ${findAll(lb, "br").length} br`);

// 17. empty and null input never throw
let threw = false;
try { renderMarkdown(""); renderMarkdown(null); renderMarkdown(undefined); } catch { threw = true; }
check("empty and null input do not throw", !threw);

console.log(failures === 0 ? "ALL PASS" : `${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
