// Chat keyboard access: every focusable element has an accessible name; Tab reaches them.
export const name = "52-chat-accessible";

const CHIP = "#topbar .chip";
const SEND = ".chat-composer-bar .btn-primary";

const ACC = `(el) => {
  const al = el.getAttribute("aria-label");
  if (al && al.trim()) return al.trim();
  const lb = el.getAttribute("aria-labelledby");
  if (lb) { const n = document.getElementById(lb); if (n && n.textContent.trim()) return n.textContent.trim(); }
  const txt = (el.textContent || "").trim();
  if (txt) return txt;
  const ph = el.getAttribute("placeholder");
  if (ph && ph.trim()) return ph.trim();
  const ti = el.getAttribute("title");
  if (ti && ti.trim()) return ti.trim();
  return "";
}`;

const FOCUS_SEL = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export async function run(t) {
  await t.open("chat");
  await t.waitFor(`!document.querySelector("${CHIP}")?.innerText.includes("No model")`, 15000);

  // Send a message so a chat row and the message actions join the tab order.
  await t.type(".chat-input", "hello there");
  await t.waitFor(`!document.querySelector("${SEND}").disabled`);
  await t.click(SEND);
  await t.waitFor(`document.querySelector(".chat-msg-model .chat-body") !== null`, 30000);
  await t.waitFor(`!document.querySelector(".chat-writing")`, 30000);

  // Open the settings row so its controls are focusable too.
  await t.click(".chat-settings-toggle");
  await t.waitFor(`document.querySelector(".chat-settings-toggle").getAttribute("aria-expanded") === "true"`);

  // Walk the tab order: focus each visible focusable in DOM order, confirm it takes focus and has a name.
  const walkExpr = `(() => {
    const acc = ${ACC};
    const nodes = [...document.querySelectorAll(${JSON.stringify(FOCUS_SEL)})].filter((el) => {
      if (el.closest("[hidden]")) return false;
      if (el.offsetParent === null) return false;
      return true;
    });
    return nodes.map((el) => {
      el.focus();
      const got = document.activeElement === el;
      return { got, cls: (el.className || el.tagName).toString(), name: acc(el) };
    });
  })()`;
  const walk = await t.eval(walkExpr);
  t.assert(walk.length >= 6, `only ${walk.length} focusable elements on Chat`);
  for (const r of walk) {
    t.assert(r.name !== "", `focusable element with no accessible name: ${r.cls}`);
    t.assert(r.got, `element did not take keyboard focus: ${r.cls}`);
  }
}
