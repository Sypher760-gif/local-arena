// Shared building blocks. Each function returns a DOM element. Meters, rings and readouts
// update in place through a .set() method. Look and sizes come from components.css.

const SVG_NS = "http://www.w3.org/2000/svg";
const ARC_LENGTH = 270;       // ring arc in dash units (270 degrees)
const RING_CIRCUMFERENCE = 360;
const RING_RADIUS = 57.3;
const RING_STROKE = 9;
const RING_ROTATE = "rotate(135 70 70)";
const EASE_MS = 50;           // time constant: about 95% of the way to a value in 150 ms
const PEAK_HOLD_MS = 2000;
const PEAK_FALL_MS = 300;

export function el(tag, cls = "", content = "") {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (content !== "") node.textContent = content;
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

function chevron() {
  const icon = svg("svg", { width: 10, height: 10, viewBox: "0 0 10 10", "aria-hidden": "true" });
  icon.append(svg("path", {
    d: "M2 3.5 L5 6.5 L8 3.5", fill: "none", stroke: "var(--color-text-secondary)",
    "stroke-width": 1.4, "stroke-linecap": "round", "stroke-linejoin": "round",
  }));
  return icon;
}

// Panel with a 1 px hairline and a faint top highlight. The parent grid supplies the gaps.
export function module({ tag = "section", cls = "", children = [] } = {}) {
  const node = el(tag, cls ? `module ${cls}` : "module");
  node.append(...children);
  return node;
}

// Uppercase section label, 10.5 px, wide tracking.
export function sectionLabel(text, tag = "h2") {
  return el(tag, "section-label", text);
}

// Segmented level meter. variant: 'wide' (default), 'thin', 'small', 'bar' or 'fit'.
// ticks: scale labels under the meter. peakHold: a white tick that holds about 2 s, then falls.
// The glow sits on a wrapper outside the mask, so the mask does not cut it.
export function segMeter({ min = 0, max = 100, color = "var(--color-accent)", peakHold = false, ticks = null, variant = "wide" } = {}) {
  const group = el("div", "seg-meter-group");
  const bar = el("div", `seg-meter ${variant}`);
  bar.style.setProperty("--meter-color", color);
  bar.setAttribute("role", "meter");
  bar.setAttribute("aria-valuemin", String(min));
  bar.setAttribute("aria-valuemax", String(max));

  const track = el("div", "meter-track");
  const glow = el("div", "meter-glow");
  glow.append(el("div", "meter-fill"));
  bar.append(track, glow);

  let peakMark = null;
  if (peakHold) {
    peakMark = el("div", "meter-peak");
    bar.append(peakMark);
  }
  group.append(bar);

  let labels = null;
  if (ticks) {
    labels = el("div", "meter-labels");
    for (const tick of ticks) labels.append(el("span", "", tick));
    group.append(labels);
  }

  let shown = 0;
  let target = 0;
  let peak = 0;
  let peakAt = 0;
  let frame = 0;
  let last = 0;
  const pct = (v) => Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100));

  const draw = () => {
    glow.style.width = `${pct(shown)}%`;
    bar.setAttribute("aria-valuenow", shown.toFixed(1));
    if (peakMark) peakMark.style.left = `${pct(peak)}%`;
  };

  const step = (now) => {
    const dt = last ? now - last : 16;
    last = now;
    shown += (target - shown) * (1 - Math.exp(-dt / EASE_MS));
    if (peakMark) {
      if (shown >= peak) {
        peak = shown;
        peakAt = now;
      } else if (now - peakAt > PEAK_HOLD_MS) {
        peak += (shown - peak) * (1 - Math.exp(-dt / PEAK_FALL_MS));
      }
    }
    draw();
    const moving = Math.abs(target - shown) > 0.01 || (peakMark && peak - shown > 0.01);
    frame = moving ? requestAnimationFrame(step) : 0;
    if (!frame) last = 0;
  };

  group.set = (value) => {
    target = Math.min(max, Math.max(min, value));
    if (!frame) {
      last = 0;
      frame = requestAnimationFrame(step);
    }
  };
  // A new full scale (the speed meter grows with a fast model). Ticks relabel when given.
  group.setMax = (nextMax, nextTicks = null) => {
    if (nextMax === max) return;
    max = nextMax;
    bar.setAttribute("aria-valuemax", String(max));
    if (labels && nextTicks) labels.replaceChildren(...nextTicks.map((tick) => el("span", "", tick)));
    target = Math.min(max, target);
    draw();
  };
  draw();
  return group;
}

// 270-degree segmented ring gauge. Set it with [{value, color, free?}]. Entries with free: true
// are not counted in the centre figure; the dim track shows whatever no entry covers.
export function ring({ total = 12, unit = "GB" } = {}) {
  const root = el("div", "ring");
  const gauge = svg("svg", { width: 140, height: 140, viewBox: "0 0 140 140", role: "img" });
  gauge.append(svg("circle", {
    cx: 70, cy: 70, r: RING_RADIUS, fill: "none", stroke: "var(--color-meter-track)",
    "stroke-width": RING_STROKE, "stroke-dasharray": `${ARC_LENGTH} 90`, transform: RING_ROTATE,
  }));
  let segments = [];

  const centre = el("div", "ring-centre");
  const value = el("span", "ring-value", "0.0");
  const totalText = el("span", "ring-unit", `of ${total} ${unit}`);
  centre.append(value, totalText);
  root.append(gauge, centre);

  root.setTotal = (next) => {
    if (!(Number.isFinite(next) && next > 0) || next === total) return;
    total = next;
    totalText.textContent = `of ${Number(total.toFixed(1))} ${unit}`;
  };

  root.set = (entries) => {
    while (segments.length > entries.length) segments.pop().remove();
    let start = 0;
    let used = 0;
    entries.forEach((entry, i) => {
      const length = (entry.value / total) * ARC_LENGTH;
      const segment = segments[i] ?? svg("circle", {
        cx: 70, cy: 70, r: RING_RADIUS, fill: "none", stroke: entry.color,
        "stroke-width": RING_STROKE, "stroke-dasharray": `${length} ${RING_CIRCUMFERENCE}`,
        "stroke-dashoffset": -start, transform: RING_ROTATE,
      });
      segment.setAttribute("stroke", entry.color);
      segment.setAttribute("stroke-dasharray", `${length} ${RING_CIRCUMFERENCE}`);
      segment.setAttribute("stroke-dashoffset", -start);
      // The first entry (the model) gets the glow.
      if (i === 0) segment.setAttribute("class", "ring-segment");
      if (!segments[i]) { gauge.append(segment); segments.push(segment); }
      start += length;
      if (!entry.free) used += entry.value;
    });
    value.textContent = used.toFixed(1);
    gauge.setAttribute("aria-label", `${used.toFixed(1)} of ${total} ${unit} used`);
  };
  return root;
}

// A round scale for a speed: { max, step, ticks } with about five even steps and some headroom
// over `value`, never below `floor`. 182 gives 0 50 ... 250; 40 gives 0 10 ... 50.
export function speedScale(value, floor = 60) {
  const raw = Math.max(floor, (Number(value) || 0) * 1.12);
  const rough = raw / 5;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough);
  const max = step * Math.ceil(raw / step - 1e-9);
  const ticks = [];
  for (let v = 0; v <= max + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
  return { max, step, ticks };
}

export function fmtSpeed(value) {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

let chartIds = 0;

// Speed over the last `seconds`: a scale that grows to fit the fastest sample, numbered lines,
// a time axis, a peak marker, and a readout under the pointer (hover or drag; arrow keys when
// focused). Samples carry their own time, so a gap (another tab, say) draws as a gap.
// `history` may be an array kept by the caller, so the graph survives a re-render.
// .push(value) adds a sample now. .clear() empties it.
export function speedChart({ seconds = 60, unit = "tok/s", floor = 20, history = [] } = {}) {
  const windowMs = seconds * 1000;
  const pad = { left: 34, right: 12, top: 13, bottom: 20 };
  const id = `speed-chart-${++chartIds}`;
  const samples = history;

  const root = el("div", "speed-chart");
  root.tabIndex = 0;
  root.setAttribute("role", "img");
  const graph = svg("svg", { class: "speed-chart-svg", "aria-hidden": "true" });
  const defs = svg("defs");
  const gradient = svg("linearGradient", { id: `${id}-fill`, x1: 0, y1: 0, x2: 0, y2: 1 });
  gradient.append(
    svg("stop", { offset: "0%", "stop-color": "var(--color-accent)", "stop-opacity": 0.32 }),
    svg("stop", { offset: "100%", "stop-color": "var(--color-accent)", "stop-opacity": 0 }),
  );
  const clip = svg("clipPath", { id: `${id}-clip` });
  const clipRect = svg("rect");
  clip.append(clipRect);
  defs.append(gradient, clip);
  const grid = svg("g", { class: "speed-chart-grid" });
  const axisX = svg("g", { class: "speed-chart-axis" });
  const plot = svg("g", { "clip-path": `url(#${id}-clip)` });
  const area = svg("path", { fill: `url(#${id}-fill)` });
  const line = svg("path", { class: "speed-chart-line" });
  plot.append(area, line);
  const peakDot = svg("circle", { class: "speed-chart-peak", r: 3.5 });
  const peakText = svg("text", { class: "speed-chart-peak-text" });
  const cursorLine = svg("line", { class: "speed-chart-cursor" });
  const cursorDot = svg("circle", { class: "speed-chart-cursor-dot", r: 4 });
  graph.append(defs, grid, axisX, plot, peakDot, peakText, cursorLine, cursorDot);

  const tip = el("div", "speed-chart-tip");
  const tipValue = el("span", "speed-chart-tip-value");
  const tipWhen = el("span", "speed-chart-tip-when");
  tip.append(tipValue, tipWhen);
  root.append(graph, tip);

  let width = 0;
  let height = 0;
  let shownMax = speedScale(0, floor).max;
  let scale = speedScale(0, floor);
  let frame = 0;
  let last = 0;
  let cursorX = null;      // pointer position in px, or null
  let keyAgoMs = null;     // keyboard cursor: how long ago, or null

  const plotW = () => Math.max(1, width - pad.left - pad.right);
  const plotH = () => Math.max(1, height - pad.top - pad.bottom);
  const xFor = (t, now) => pad.left + plotW() * (1 - (now - t) / windowMs);
  const yFor = (v) => pad.top + plotH() * (1 - Math.min(v, shownMax * 1.02) / shownMax);

  function visible(now) {
    while (samples.length && now - samples[0].t > windowMs + 2000) samples.shift();
    return samples.filter((s) => now - s.t <= windowMs + 1000);
  }

  // The sample nearest to time `t`, if one is within two sample gaps of it.
  function nearest(list, t) {
    let best = null;
    for (const s of list) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    return best && Math.abs(best.t - t) < 2500 ? best : null;
  }

  function agoLabel(ms) {
    const s = Math.round(ms / 1000);
    return s <= 0 ? "now" : `${s} s ago`;
  }

  function drawGrid() {
    grid.replaceChildren();
    for (const tick of scale.ticks) {
      if (tick > shownMax * 1.001) continue;
      const y = yFor(tick);
      grid.append(svg("line", { x1: pad.left, x2: width - pad.right, y1: y, y2: y, class: tick === 0 ? "base" : "" }));
      const label = svg("text", { x: pad.left - 7, y: y + 3.5, "text-anchor": "end" });
      label.textContent = fmtSpeed(tick);
      grid.append(label);
    }
    axisX.replaceChildren();
    const marks = seconds >= 60 ? [60, 45, 30, 15, 0] : [seconds, Math.round(seconds / 2), 0];
    for (const ago of marks) {
      const x = pad.left + plotW() * (1 - ago / seconds);
      const label = svg("text", { x, y: height - 5, "text-anchor": ago === seconds ? "start" : ago === 0 ? "end" : "middle" });
      label.textContent = ago === 0 ? "now" : `${ago}s`;
      axisX.append(label);
    }
  }

  function draw() {
    if (!width || !height) return;
    const now = performance.now();
    const list = visible(now);
    graph.setAttribute("viewBox", `0 0 ${width} ${height}`);
    clipRect.setAttribute("x", pad.left);
    clipRect.setAttribute("y", 0);
    clipRect.setAttribute("width", plotW());
    clipRect.setAttribute("height", height - pad.bottom + 2);
    drawGrid();

    // Line and fill, broken wherever samples are more than 2.5 s apart.
    const base = yFor(0);
    let d = "";
    let fill = "";
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const pts = run.map((s) => [xFor(s.t, now), yFor(s.v)]);
      d += pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
      fill += `M${pts[0][0].toFixed(1)} ${base.toFixed(1)} ${pts.map(([x, y]) => `L${x.toFixed(1)} ${y.toFixed(1)}`).join(" ")} L${pts.at(-1)[0].toFixed(1)} ${base.toFixed(1)} Z `;
      run = [];
    };
    list.forEach((s, i) => {
      if (i && s.t - list[i - 1].t > 2500) flush();
      run.push(s);
    });
    flush();
    line.setAttribute("d", d);
    area.setAttribute("d", fill);

    // Peak marker: the fastest sample still on screen.
    const peak = list.reduce((best, s) => (s.v > (best?.v ?? 0) ? s : best), null);
    const hovering = cursorX !== null || keyAgoMs !== null;
    if (peak && peak.v > 0) {
      const px = xFor(peak.t, now);
      const py = yFor(peak.v);
      peakDot.setAttribute("cx", px);
      peakDot.setAttribute("cy", py);
      peakDot.style.display = "";
      peakText.textContent = `peak ${peak.v.toFixed(1)}`;
      // Above the dot when there is room, so it never runs into the line; beside it otherwise.
      const above = py - 9 > pad.top + 2;
      const right = px > width - pad.right - 44;
      const left = px < pad.left + 44;
      peakText.setAttribute("x", above ? Math.min(width - pad.right - 2, Math.max(pad.left + 2, px)) : (right ? px - 8 : px + 8));
      peakText.setAttribute("text-anchor", above ? (right ? "end" : left ? "start" : "middle") : (right ? "end" : "start"));
      peakText.setAttribute("y", above ? py - 8 : py + 3.5);
      peakText.style.display = hovering ? "none" : "";
    } else {
      peakDot.style.display = "none";
      peakText.style.display = "none";
    }

    // Readout under the pointer or the keyboard cursor.
    let at = null;
    if (cursorX !== null) at = now - ((pad.left + plotW() - cursorX) / plotW()) * windowMs;
    else if (keyAgoMs !== null) at = now - keyAgoMs;
    const hit = at === null ? null : nearest(list, at);
    if (hit) {
      const hx = xFor(hit.t, now);
      const hy = yFor(hit.v);
      cursorLine.setAttribute("x1", hx);
      cursorLine.setAttribute("x2", hx);
      cursorLine.setAttribute("y1", pad.top);
      cursorLine.setAttribute("y2", base);
      cursorDot.setAttribute("cx", hx);
      cursorDot.setAttribute("cy", hy);
      tipValue.textContent = `${hit.v.toFixed(1)} ${unit}`;
      tipWhen.textContent = agoLabel(now - hit.t);
      root.classList.add("is-scrubbing");
      const tipW = tip.offsetWidth || 90;
      const left = Math.min(width - tipW - 4, Math.max(4, hx - tipW / 2));
      tip.style.transform = `translate(${left.toFixed(0)}px, 0)`;
    } else {
      root.classList.remove("is-scrubbing");
    }

    const latest = list.at(-1);
    root.setAttribute("aria-label", `Speed over the last ${seconds} seconds. ${latest ? `Now ${latest.v.toFixed(1)} ${unit}` : "No speed yet"}${peak && peak.v > 0 ? `, peak ${peak.v.toFixed(1)} ${unit}` : ""}. Scale 0 to ${fmtSpeed(scale.max)}.`);
  }

  // The scale glides to its new top instead of jumping.
  function step(time) {
    const dt = last ? time - last : 16;
    last = time;
    shownMax += (scale.max - shownMax) * (1 - Math.exp(-dt / 90));
    if (Math.abs(scale.max - shownMax) < scale.max * 0.002) shownMax = scale.max;
    draw();
    frame = shownMax === scale.max ? 0 : requestAnimationFrame(step);
    if (!frame) last = 0;
  }

  function rescale() {
    const now = performance.now();
    const top = visible(now).reduce((m, s) => Math.max(m, s.v), 0);
    const next = speedScale(top, floor);
    if (next.max !== scale.max) {
      scale = next;
      if (!frame && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        frame = requestAnimationFrame(step);
        return;
      }
      if (!frame) shownMax = scale.max;
    }
    if (!frame) draw();
  }

  const observer = new ResizeObserver(() => {
    width = root.clientWidth;
    height = root.clientHeight;
    draw();
  });
  observer.observe(root);

  graph.addEventListener("pointermove", (event) => {
    const box = graph.getBoundingClientRect();
    cursorX = Math.min(width - pad.right, Math.max(pad.left, event.clientX - box.left));
    keyAgoMs = null;
    draw();
  });
  graph.addEventListener("pointerdown", (event) => {
    graph.setPointerCapture(event.pointerId);
  });
  const leave = () => { cursorX = null; draw(); };
  graph.addEventListener("pointerleave", leave);
  graph.addEventListener("pointercancel", leave);
  root.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const stepMs = event.shiftKey ? 5000 : 1000;
      const ago = keyAgoMs ?? 0;
      keyAgoMs = Math.min(windowMs, Math.max(0, ago + (event.key === "ArrowLeft" ? stepMs : -stepMs)));
      cursorX = null;
      draw();
    } else if (event.key === "Escape" && keyAgoMs !== null) {
      keyAgoMs = null;
      draw();
    }
  });
  root.addEventListener("blur", () => { if (keyAgoMs !== null) { keyAgoMs = null; draw(); } });

  root.push = (value) => {
    samples.push({ t: performance.now(), v: Math.max(0, Number(value) || 0) });
    rescale();
  };
  root.clear = () => {
    samples.length = 0;
    rescale();
  };
  root.redraw = () => rescale();
  root.dispose = () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
  };
  return root;
}

// Radar chart. Axis count comes from `axes` (labels). Scale 0 to 100; rings at 50 and 100.
// .set(thisRun, comparedRun): arrays of numbers in axis order. comparedRun may be null.
export function radar({ axes = [] } = {}) {
  const cx = 160;
  const cy = 110;
  const radius = 80;
  const count = axes.length;
  const angle = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / count;
  const vertex = (i, r) => [cx + r * Math.cos(angle(i)), cy + r * Math.sin(angle(i))];
  const polygon = (values) => values
    .map((v, i) => vertex(i, (radius * v) / 100).map((n) => n.toFixed(1)).join(","))
    .join(" ");
  const ring100 = axes.map(() => 100);
  const ring50 = axes.map(() => 50);

  const graph = svg("svg", { class: "radar", viewBox: "0 0 320 220", role: "img", "aria-label": "Radar chart" });
  graph.append(
    svg("polygon", { points: polygon(ring100), fill: "#0e0f11", stroke: "#ffffff1f", "stroke-width": 1 }),
    svg("polygon", { points: polygon(ring50), fill: "none", stroke: "#ffffff14", "stroke-width": 1 }),
  );
  const spokes = axes.map((_, i) => {
    const [x, y] = vertex(i, radius);
    return `M${cx} ${cy} L${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
  graph.append(svg("path", { d: spokes, stroke: "#ffffff14", "stroke-width": 1 }));

  const compared = svg("polygon", {
    fill: "none", stroke: "var(--color-compare)", "stroke-width": 1.5,
    "stroke-dasharray": "4 3", "stroke-linejoin": "round", display: "none",
  });
  const current = svg("polygon", {
    fill: "var(--color-accent)", "fill-opacity": 0.16, stroke: "var(--color-accent)",
    "stroke-width": 1.75, "stroke-linejoin": "round",
  });
  graph.append(compared, current);

  const labels = svg("g", { "font-size": 10.5 });
  axes.forEach((label, i) => {
    const [x, y] = vertex(i, radius + 14);
    const cos = Math.cos(angle(i));
    const sin = Math.sin(angle(i));
    const anchor = cos > 0.3 ? "start" : cos < -0.3 ? "end" : "middle";
    const text = svg("text", { x: x.toFixed(1), y: (y + (sin > 0.3 ? 12 : 4)).toFixed(1), "text-anchor": anchor });
    text.textContent = label;
    labels.append(text);
  });
  graph.append(labels);

  graph.set = (thisRun, comparedRun = null) => {
    current.setAttribute("points", polygon(thisRun));
    if (comparedRun) {
      compared.setAttribute("points", polygon(comparedRun));
      compared.setAttribute("display", "inline");
    } else {
      compared.setAttribute("display", "none");
    }
  };
  return graph;
}

// Big mono number with an optional unit label. size: 'hero' (68 px), 'large' (48 px), 'medium' (38 px).
export function readout({ size = "large", unit = "", decimals = 0 } = {}) {
  const wrap = el("div", "readout-wrap");
  const number = el("span", `readout readout-${size}`, (0).toFixed(decimals));
  wrap.append(number);
  if (unit) wrap.append(el("span", "readout-unit", unit));
  wrap.set = (value) => {
    number.textContent = typeof value === "number" ? value.toFixed(decimals) : String(value);
  };
  return wrap;
}

// Status light: 'ok' (green, glow), 'idle' (grey), 'warn' (amber), 'bad' (coral).
export function statusLight(state = "idle") {
  const node = el("span", `status-light ${state}`);
  node.setAttribute("aria-hidden", "true");
  node.set = (next) => {
    node.className = `status-light ${next}`;
  };
  return node;
}

// Chip with an optional status light, sub line and chevron (when clickable).
// small: the settings tag. light: null for none, or a statusLight state.
export function chip({ text = "", sub = "", light = null, small = false, onClick = null } = {}) {
  const node = el(onClick ? "button" : "span", small ? "chip small" : "chip");
  if (onClick) {
    node.type = "button";
    node.addEventListener("click", onClick);
  }
  const lamp = statusLight(light ?? "idle");
  const name = el("span", "", text);
  const subText = el("span", "chip-sub", sub);
  lamp.hidden = light === null;
  subText.hidden = !sub;
  node.append(lamp, name, subText);
  if (onClick) node.append(chevron());
  node.set = (next) => {
    if ("text" in next) name.textContent = next.text;
    if ("sub" in next) {
      subText.textContent = next.sub;
      subText.hidden = !next.sub;
    }
    if ("light" in next) {
      lamp.hidden = next.light === null;
      lamp.set(next.light ?? "idle");
    }
  };
  return node;
}

// kind: 'primary' (amber), 'secondary' or 'ghost'.
export function button({ kind = "secondary", text = "", onClick = null, small = false, large = false } = {}) {
  const classes = ["btn", `btn-${kind}`];
  if (small) classes.push("btn-small");
  if (large) classes.push("btn-large");
  const node = el("button", classes.join(" "), text);
  node.type = "button";
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

export function largeButton(options = {}) {
  return button({ ...options, large: true });
}

// Two-line row: title, then a mono sub line with a right-aligned meta. Selected: raised, amber dot.
export function listRow({ title = "", sub = "", meta = "", selected = false, onClick = null } = {}) {
  const node = el("button", selected ? "list-row selected" : "list-row");
  node.type = "button";
  node.setAttribute("aria-pressed", String(selected));
  const top = el("div", "list-row-top");
  top.append(el("span", "dot"), el("span", "list-row-title", title));
  const line = el("div", "list-row-sub");
  line.append(el("span", "", sub), el("span", "", meta));
  node.append(top, line);
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

// Right-click menu at (x, y). items: { label, onSelect, danger?, disabled?, hint? } or "-" for a
// divider. Arrow keys move, Enter picks, Escape or a click elsewhere closes. Returns close().
let openContext = null;
export function contextMenu({ x, y, items = [], label = "Menu", onClose = null } = {}) {
  openContext?.close();
  const menu = el("div", "ctx-menu");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);
  const buttons = [];
  for (const item of items) {
    if (item === "-") { menu.append(el("div", "ctx-sep")); continue; }
    const node = el("button", item.danger ? "ctx-item danger" : "ctx-item");
    node.type = "button";
    node.setAttribute("role", "menuitem");
    node.disabled = Boolean(item.disabled);
    node.append(el("span", "ctx-label", item.label));
    if (item.hint) node.append(el("span", "ctx-hint", item.hint));
    node.addEventListener("click", () => { close(); item.onSelect?.(); });
    node.addEventListener("pointerenter", () => { if (!node.disabled) node.focus({ preventScroll: true }); });
    menu.append(node);
    buttons.push(node);
  }
  document.body.append(menu);
  // Keep the menu on screen.
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(x, innerWidth - box.width - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, innerHeight - box.height - 6))}px`;
  if (y + box.height + 6 > innerHeight) menu.classList.add("from-bottom");
  const returnFocus = document.activeElement;
  const enabled = () => buttons.filter((b) => !b.disabled);
  enabled()[0]?.focus({ preventScroll: true });

  function onKey(event) {
    const list = enabled();
    const at = list.indexOf(document.activeElement);
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); returnFocus?.focus?.(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); list[(at + 1) % list.length]?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus(); }
    else if (event.key === "Home") { event.preventDefault(); list[0]?.focus(); }
    else if (event.key === "End") { event.preventDefault(); list.at(-1)?.focus(); }
    else if (event.key === "Tab") { event.preventDefault(); close(); returnFocus?.focus?.(); }
  }
  function onPointer(event) { if (!menu.contains(event.target)) close(); }
  function onLeave() { close(); }
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("blur", onLeave);
  window.addEventListener("resize", onLeave);
  document.addEventListener("scroll", onLeave, true);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onPointer, true);
    window.removeEventListener("blur", onLeave);
    window.removeEventListener("resize", onLeave);
    document.removeEventListener("scroll", onLeave, true);
    menu.classList.add("is-closing");
    setTimeout(() => menu.remove(), 90);
    if (openContext?.close === close) openContext = null;
    onClose?.();
  }
  openContext = { close };
  return close;
}

// A short message at the bottom of the window, with an optional action (Undo).
export function toast({ text = "", action = null, onAction = null, ms = 5000 } = {}) {
  let host = document.querySelector(".toast-host");
  if (!host) {
    host = el("div", "toast-host");
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    document.body.append(host);
  }
  const node = el("div", "toast");
  node.append(el("span", "toast-text", text));
  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    node.classList.add("is-closing");
    setTimeout(() => node.remove(), 160);
  };
  if (action) {
    const act = el("button", "toast-action", action);
    act.type = "button";
    act.addEventListener("click", () => { dismiss(); onAction?.(); });
    node.append(act);
  }
  host.append(node);
  timer = setTimeout(dismiss, ms);
  return dismiss;
}

export function keycap(text) {
  return el("kbd", "keycap", text);
}

// Inset status box ('ok', green dot) or warning box ('warn', amber tint and triangle).
export function notice({ kind = "ok", text = "" } = {}) {
  const node = el("div", `notice ${kind}`);
  if (kind === "warn") {
    const icon = svg("svg", { width: 16, height: 16, viewBox: "0 0 16 16", "aria-hidden": "true" });
    icon.append(
      svg("path", { d: "M8 2 L14.5 13.5 H1.5 Z", fill: "none", stroke: "var(--color-accent)", "stroke-width": 1.4, "stroke-linejoin": "round" }),
      svg("path", { d: "M8 6.5 V9.5 M8 11.3 V11.6", stroke: "var(--color-accent)", "stroke-width": 1.4, "stroke-linecap": "round" }),
    );
    node.append(icon);
  } else {
    node.append(el("span", "dot"));
  }
  node.append(el("span", "", text));
  return node;
}
