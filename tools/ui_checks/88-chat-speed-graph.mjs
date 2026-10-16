// Chat: the speed graph's scale grows to fit a fast reply, its lines are numbered and a
// hover reads a speed; the sidebars resize, fold and remember their size; the setting boxes have
// no spinner arrows; text boxes draw no orange outline when focused.
export const name = "88-chat-speed-graph";

const SEND = ".chat-composer-bar .btn-primary";

export async function run(t) {
  await t.open("chat");
  await t.waitFor(`!document.querySelector("#topbar .chip")?.innerText.includes("No model")`, 15000);

  // Push a fast sample straight into the graph: the scale must grow past it.
  await t.waitFor(`!!document.querySelector(".speed-chart")`);
  // Samples half a second apart, as the screen pushes them.
  const scale = await t.eval(`(async () => {
    const chart = document.querySelector(".speed-chart");
    for (const v of [0, 350, 310]) { chart.push(v); await new Promise((r) => setTimeout(r, 500)); }
    return null;
  })()`);
  await t.waitFor(`(() => {
    const labels = [...document.querySelectorAll(".speed-chart-grid text")].map((n) => Number(n.textContent));
    return labels.length >= 3 && Math.max(...labels) >= 350;
  })()`, 5000);
  const labels = await t.eval(`[...document.querySelectorAll(".speed-chart-grid text")].map((n) => n.textContent)`);
  t.assert(labels[0] === "0", `graph's lowest line is "${labels[0]}", want "0"`);
  const axis = await t.eval(`[...document.querySelectorAll(".speed-chart-axis text")].map((n) => n.textContent)`);
  t.assert(axis.includes("now") && axis.includes("60s"), `time axis reads ${JSON.stringify(axis)}`);
  const peak = await t.eval(`document.querySelector(".speed-chart-peak-text")?.textContent ?? ""`);
  t.assert(peak.includes("350"), `graph peak label is "${peak}", want 350`);

  // Hover over the peak: the readout shows its speed.
  const tip = await t.eval(`(() => {
    const svg = document.querySelector(".speed-chart-svg");
    const box = svg.getBoundingClientRect();
    const dot = document.querySelector(".speed-chart-peak");
    svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: box.left + Number(dot.getAttribute("cx")), clientY: box.top + 30 }));
    return document.querySelector(".speed-chart").classList.contains("is-scrubbing")
      ? document.querySelector(".speed-chart-tip-value").textContent : null;
  })()`);
  t.assert(tip === "350.0 tok/s", `hover readout is "${tip}", want "350.0 tok/s"`);
  void scale;

  // A real reply from the fake engine: the meter's labels stay on a round scale.
  await t.type(".chat-input", "a quick one");
  await t.waitFor(`!document.querySelector("${SEND}").disabled`);
  await t.click(SEND);
  await t.waitFor(`!!document.querySelector(".chat-msg-model .chat-stats")`, 30000);
  const ticks = await t.eval(`[...document.querySelectorAll(".meter-module .meter-labels span")].map((n) => n.textContent)`);
  t.assert(ticks.length >= 3 && ticks[0] === "0", `speed meter labels ${JSON.stringify(ticks)}`);

  // Sidebars: drag the conversations edge wider, it sticks after a reload; fold and unfold it.
  const before = await t.eval(`document.querySelector(".chat-list").getBoundingClientRect().width`);
  // The column width glides; wait for each move to settle before measuring.
  await t.eval(`(() => {
    const h = document.querySelector(".side-handle-list");
    const b = h.getBoundingClientRect();
    const x = b.left + 4, y = b.top + 60;
    h.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y }));
    h.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: x + 80, clientY: y }));
    h.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: x + 80, clientY: y }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const after = await t.eval(`document.querySelector(".chat-list").getBoundingClientRect().width`);
  t.assert(after > before + 60, `conversations list went from ${before} to ${after} px, want about 80 px wider`);
  await t.reload();
  await t.waitFor(`!!document.querySelector(".chat-list")`);
  await t.waitFor(`Math.abs(document.querySelector(".chat-list").getBoundingClientRect().width - ${after}) < 2`, 5000);

  await t.click(".side-handle-meters .side-fold");
  await t.waitFor(`document.querySelector(".chat-cols").classList.contains("meters-collapsed")`);
  await t.waitFor(`document.querySelector(".meters").getBoundingClientRect().width < 2`, 3000);
  await t.click(".side-handle-meters .side-fold");
  await t.waitFor(`document.querySelector(".meters").getBoundingClientRect().width > 250`, 3000);
  // Put the list back to its normal size so later checks see the usual layout.
  await t.eval(`document.querySelector(".side-handle-list").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })) || true`);

  // Setting boxes: no spinner arrows; a focused box has no outline.
  await t.click(".chat-settings-toggle");
  await t.waitFor(`!document.querySelector(".chat-settings").hidden`);
  const style = await t.eval(`(() => {
    const input = document.querySelector(".chat-setting-input");
    input.focus();
    const cs = getComputedStyle(input);
    const spin = getComputedStyle(input, "::-webkit-inner-spin-button").webkitAppearance;
    const sel = getComputedStyle(document.querySelector(".chat-setting-select"));
    return { outline: cs.outlineStyle, appearance: cs.appearance, spin, selectAppearance: sel.appearance };
  })()`);
  t.assert(style.outline === "none", `focused setting box draws an outline: ${style.outline}`);
  t.assert(style.appearance === "textfield", `setting box appearance is ${style.appearance}, want textfield (no arrows)`);
  t.assert(style.selectAppearance === "none", `dropdown keeps the system arrow: ${style.selectAppearance}`);
}
