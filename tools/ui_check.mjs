// Headless browser checks for the Local Arena UI. Starts the fake engine (8781), the gateway (8782) and
// headless Chrome (debugging port 9231), runs tools/ui_checks/*.mjs, prints PASS or FAIL per check.
// Run: node tools/ui_check.mjs [--only <name>] [--keep] [--list]   (Node 22+: global fetch, WebSocket)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECKS_DIR = path.join(ROOT, "tools", "ui_checks");
const SHOTS_DIR = path.join(ROOT, "data", "test-artifacts", "shots");
const PYTHON = process.env.PYTHON ?? "python";
const OFFSET = Number(process.env.ARENA_PORT_OFFSET ?? 0); // 100, 200 ... moves every test port
const ENGINE_PORT = 8781 + OFFSET;
const GATEWAY_PORT = 8782 + OFFSET;
const CHROME_PORT = 9231 + OFFSET;
const ENGINE = `http://127.0.0.1:${ENGINE_PORT}`;
const BASE = `http://127.0.0.1:${GATEWAY_PORT}`;
const CHROME = `http://127.0.0.1:${CHROME_PORT}`;
const BROWSERS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
const CHECK_LIMIT_MS = 90000;
const RUN_LIMIT_MS = 600000;

const args = process.argv.slice(2);
const onlyAt = args.indexOf("--only");
const only = onlyAt >= 0 ? args[onlyAt + 1] : null;
const keep = args.includes("--keep");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Process and temp-file bookkeeping. cleanup() kills everything started here.
const procs = { engine: null, gateway: null, chrome: null };
const tempDirs = [];
const results = { passed: 0, failed: 0 };
let lastStarted = null;    // the check that was running when the run itself failed
const failedChecks = [];   // check names that failed, in run order, for the closing line

function makeTempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const logDir = makeTempDir("arena-ui-logs-");

function startChild(label, cmd, cargs, env = {}) {
  const log = openSync(path.join(logDir, `${label}.log`), "a");
  return spawn(cmd, cargs, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGKILL");
}

function stopFakeEngineOnPort(port) {
  if (process.platform !== "win32") return;
  const script = `$pids = @((Get-NetTCPConnection -LocalPort ${port} -State Listen -EA SilentlyContinue).OwningProcess | Select-Object -Unique); foreach ($p in $pids) { $c = (Get-CimInstance Win32_Process -Filter "ProcessId=$p").CommandLine; if ($c -match 'fake_engine\\.py') { Stop-Process -Id $p -Force -EA SilentlyContinue } } for ($i = 0; $i -lt 60; $i++) { if (-not (Get-NetTCPConnection -LocalPort ${port} -State Listen -EA SilentlyContinue)) { break }; Start-Sleep -Milliseconds 250 }`;
  spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { stdio: "ignore", windowsHide: true });
}

async function cleanup() {
  for (const key of ["chrome", "gateway", "engine"]) {
    killTree(procs[key]);
    procs[key] = null;
  }
  // Wait for the ports to close, so the next run can start and Chrome has let go of its profile folder.
  await waitUntil(async () => {
    const open = await Promise.all([ENGINE_PORT, GATEWAY_PORT, CHROME_PORT].map(portInUse));
    return !open.some(Boolean);
  }, 5000, "shutdown").catch(() => {});
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch {
      // Still locked after the retries. The folder is under TMPDIR and is harmless.
    }
  }
}

function showLogs() {
  for (const file of readdirSync(logDir)) {
    const lines = readFileSync(path.join(logDir, file), "utf8").trim().split("\n").slice(-5);
    console.log(`  ${file}: ${lines.join(" | ")}`);
  }
}

// Small helpers ----------------------------------------------------------------

const isUp = (url) => fetch(url).then((r) => r.ok).catch(() => false);

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitUntil(test, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return;
    await sleep(100);
  }
  throw new Error(`${what} did not answer within ${ms / 1000} s`);
}

function withTimeout(promise, ms, message) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

async function getJson(url) {
  // A dropped keep-alive connection shows up as "fetch failed"; retry those a few times. HTTP errors are real and not retried.
  let last;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw Object.assign(new Error(`${url} answered ${res.status}`), { final: true });
      return await res.json();
    } catch (err) {
      if (err.final) throw err;
      last = err;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw last;
}

// Check files ------------------------------------------------------------------

async function loadChecks() {
  const files = readdirSync(CHECKS_DIR).filter((f) => f.endsWith(".mjs")).sort();
  const checks = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(CHECKS_DIR, file)).href);
    if (typeof mod.name !== "string" || typeof mod.run !== "function") {
      throw new Error(`${file} must export a string name and an async run(t)`);
    }
    checks.push({ file, name: mod.name, run: mod.run });
  }
  return checks;
}

// Servers and Chrome -------------------------------------------------------------

async function startServers() {
  for (const port of [ENGINE_PORT, GATEWAY_PORT, CHROME_PORT]) {
    if (await portInUse(port)) throw new Error(`port ${port} is already in use; not starting`);
  }
  const browser = BROWSERS.find((p) => existsSync(p));
  if (!browser) throw new Error("neither Chrome nor Edge was found at the expected paths");

  await startEngine();

  const store = makeTempDir("arena-ui-store-");
  const modelsFile = path.join(store, "models.json");
  writeFileSync(modelsFile, JSON.stringify([
    { id: "switch-b-q4", name: "switch-b", version: "Q4", engine: "llama.cpp", contextTokens: 4096, folder: store, matchId: "switch-b-q4" },
    { id: "missing-model-q4", name: "missing-model", version: "Q4", engine: "llama.cpp", contextTokens: 4096, configPath: path.join(store, "does-not-exist.json"), matchId: "missing-model-q4" },
  ]));
  procs.gateway = startChild("gateway", PYTHON, [path.join(ROOT, "server.py")], {
    ARENA_ENGINE: `127.0.0.1:${ENGINE_PORT}`,
    ARENA_PORT: String(GATEWAY_PORT),
    ARENA_STORE: store,
    ARENA_LIVE: path.join(store, "live"),
    ARENA_SWITCH_FAKE: "1",
    ARENA_MODELS: modelsFile,
    // One check (75) needs the gateway to report a strata kind; it sets this before the test starts.
    ARENA_ENGINE_KIND: process.env.ARENA_ENGINE_OVERRIDE ?? "",
  });
  await waitUntil(() => isUp(`${BASE}/index.html`), 15000, "gateway");

  const profile = makeTempDir("arena-ui-chrome-");
  procs.chrome = startChild("chrome", browser, [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    `--remote-debugging-port=${CHROME_PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--window-size=1440,900",
    "about:blank",
  ]);
  await waitUntil(() => isUp(`${CHROME}/json/version`), 20000, "headless browser");
}

async function startEngine(extra = []) {
  procs.engine = startChild("engine", PYTHON, [
    path.join(ROOT, "tools", "fake_engine.py"), "--port", String(ENGINE_PORT), "--wps", "60", ...extra,
  ]);
  await waitUntil(() => isUp(`${ENGINE}/health`), 15000, "fake engine");
}

async function killEngine() {
  killTree(procs.engine);
  procs.engine = null;
  stopFakeEngineOnPort(ENGINE_PORT);
  await waitUntil(async () => !(await portInUse(ENGINE_PORT)), 5000, "fake engine shutdown").catch(() => {});
}

// Page session over the DevTools protocol ------------------------------------------

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.calls = new Map();
    this.handlers = [];
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined) {
        const call = this.calls.get(msg.id);
        if (!call) return;
        this.calls.delete(msg.id);
        if (msg.error) call.reject(new Error(msg.error.message));
        else call.resolve(msg.result);
      } else {
        for (const handler of this.handlers) handler(msg.method, msg.params);
      }
    });
    this.ws.addEventListener("close", () => {
      for (const call of this.calls.values()) call.reject(new Error("DevTools connection closed"));
      this.calls.clear();
    });
  }

  opened() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("could not connect to the browser tab")), { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.calls.set(id, { resolve, reject }));
  }
}

// Functions below run inside the page. They are sent as source text, so keep them self-contained.
function pageClick(sel) {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`no element matches ${sel}`);
  if (el.disabled) throw new Error(`element is disabled: ${sel}`);
  el.focus();
  el.click();
  return true;
}

function pageType(sel, text) {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`no element matches ${sel}`);
  el.focus();
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

function pageText(sel) {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`no element matches ${sel}`);
  return el.innerText;
}

function pageCount(sel) {
  return document.querySelectorAll(sel).length;
}

async function openPage() {
  const info = await fetch(`${CHROME}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
  const cdp = new Cdp(info.webSocketDebuggerUrl);
  await cdp.opened();
  const page = { id: info.id, cdp, errors: [], networkFailures: [], requestUrls: new Map(), allowErrors: false, waiters: [] };
  cdp.handlers.push((method, params) => {
    if (method === "Network.requestWillBeSent") page.requestUrls.set(params.requestId, params.request.url);
    if (method === "Network.loadingFailed") page.networkFailures.push(`${params.type}: ${page.requestUrls.get(params.requestId)}: ${params.errorText}`);
    if (method === "Network.responseReceived" && params.response.status >= 400) page.networkFailures.push(`${params.type}: ${params.response.url}: ${params.response.status}`);
    if (method === "Runtime.exceptionThrown") {
      const d = params.exceptionDetails;
      page.errors.push(d.exception?.description?.split("\n")[0] ?? d.text ?? "uncaught exception");
    }
    if (method === "Runtime.consoleAPICalled" && params.type === "error") {
      const parts = params.args.map((a) => a.value ?? a.description ?? a.type);
      page.errors.push(`console.error: ${parts.join(" ")}`);
    }
    for (const waiter of page.waiters) if (waiter.method === method) waiter.resolve(params);
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  return page;
}

function closePage(page) {
  fetch(`${CHROME}/json/close/${page.id}`).catch(() => {});
  page.cdp.ws.close();
}

// The helper object `t` handed to each check. Its API is documented in docs/TESTING.md.
function makeHelper(page) {
  const { cdp } = page;

  const evaluate = async (expression) => {
    const res = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(d.exception?.description?.split("\n")[0] ?? d.text);
    }
    return res.result.value;
  };

  // Calls a page-side function with JSON-encoded arguments.
  const inPage = (fn, ...values) => evaluate(`(${fn.toString()})(${values.map((v) => JSON.stringify(v)).join(", ")})`);

  const waitEvent = (method, ms = 15000) => {
    let waiter;
    const fired = new Promise((resolve) => {
      waiter = { method, resolve };
      page.waiters.push(waiter);
    });
    const limit = new Promise((_, reject) => setTimeout(() => reject(new Error(`no ${method} within ${ms} ms`)), ms));
    return Promise.race([fired, limit]).finally(() => {
      page.waiters.splice(page.waiters.indexOf(waiter), 1);
    });
  };

  const waitFor = async (expression, ms = 15000) => {
    const end = Date.now() + ms;
    let last = "";
    while (Date.now() < end) {
      try {
        const value = await evaluate(expression);
        if (value) return value;
        last = "";
      } catch (error) {
        last = ` (last error: ${error.message})`;
      }
      await sleep(100);
    }
    throw new Error(`timed out after ${ms} ms waiting for: ${expression}${last}`);
  };

  const shellReady = async () => {
    try {
      await waitFor("!!document.querySelector('#topbar nav')", 30000);
    } catch (error) {
      const state = await evaluate(`JSON.stringify({url:location.href,ready:document.readyState,engine:typeof globalThis.benchEngine,header:document.querySelector('#topbar')?.innerHTML})`).catch(() => "unavailable");
      throw new Error(`${error.message}; page state: ${state}; network: ${page.networkFailures.join(" | ")}`);
    }
  };

  const open = async (hash, query = "") => {
    const url = `${BASE}/index.html${query}#/${hash}`;
    const current = await evaluate("location.href.split('#')[0]").catch(() => "");
    const sameDocument = current === `${BASE}/index.html${query}`;
    const loaded = sameDocument ? null : waitEvent("Page.loadEventFired");
    const nav = await cdp.send("Page.navigate", { url });
    if (nav.errorText) throw new Error(`navigation to ${url} failed: ${nav.errorText}`);
    if (loaded) await loaded;
    await shellReady();
    await waitFor(`location.hash === ${JSON.stringify(`#/${hash}`)}`);
  };

  const reload = async () => {
    const loaded = waitEvent("Page.loadEventFired");
    await cdp.send("Page.reload");
    await loaded;
    await shellReady();
  };

  const press = async (key) => {
    const keys = { Enter: { code: "Enter", vk: 13, text: "\r" }, Escape: { code: "Escape", vk: 27 } };
    const k = keys[key];
    if (!k) throw new Error(`press: unsupported key ${key}`);
    const base = { key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: k.text });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };

  const screenshot = async (name) => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    mkdirSync(SHOTS_DIR, { recursive: true });
    const file = path.join(SHOTS_DIR, `${name}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    console.log(`  screenshot ${file}`);
    return file;
  };

  return {
    open,
    reload,
    eval: evaluate,
    waitFor,
    click: async (sel) => {
      // A button that is disabled while the screen is still loading gets up to 8 s to become usable.
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await inPage(pageClick, sel);
        } catch (err) {
          if (!String(err.message).includes("element is disabled") || attempt >= 32) throw err;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    },
    type: (sel, text) => inPage(pageType, sel, text),
    press,
    text: (sel) => inPage(pageText, sel),
    exists: (sel) => inPage(pageCount, sel).then((n) => n > 0),
    count: (sel) => inPage(pageCount, sel),
    fakeRequests: () => getJson(`${ENGINE}/debug/requests`).then((j) => j.requests),
    storeList: (collection) => getJson(`${BASE}/api/store/${collection}`).then((j) => j.items),
    storeGet: (collection, id) => getJson(`${BASE}/api/store/${collection}/${id}`),
    killEngine,
    startEngine,
    screenshot,
    setViewport: async (width, height = 900) => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    },
    assert(condition, message) {
      if (!condition) throw new Error(message);
    },
    allowErrors() {
      page.allowErrors = true;
    },
  };
}

// Runs one check on a fresh page with a fresh fake-engine request log and empty browser storage.
async function runCheck(check) {
  await fetch(`${ENGINE}/debug/reset`, { method: "POST" });
  const page = await openPage();
  const t = makeHelper(page);
  let failure = null;
  const started = Date.now();
  try {
    await t.open("chat");
    await t.eval("localStorage.clear(); sessionStorage.clear(); true");
    await withTimeout(check.run(t), CHECK_LIMIT_MS, "timed out after 90 s");
    if (page.errors.length && !page.allowErrors) {
      throw new Error(`page logged errors: ${page.errors.join(" | ")}`);
    }
  } catch (error) {
    failure = [error.message, ...page.errors].join(" | ");
  } finally {
    closePage(page);
  }
  return { failure, seconds: ((Date.now() - started) / 1000).toFixed(1) };
}

// The last line of a failing run names what failed, so a wrapper (tools/verify.py) can say which
// checks to look at without rerunning the suite. Nothing extra is printed when everything passed.
function reportFailures(fallback = null) {
  const names = failedChecks.length ? failedChecks.slice() : (fallback ? [fallback] : []);
  console.log(`ui_check failed: ${names.length ? names.join(", ") : "run"}`);
}

// Main ----------------------------------------------------------------------------

async function run() {
  const all = await loadChecks();
  if (args.includes("--list")) {
    for (const check of all) console.log(check.name);
    return 0;
  }
  if (only !== null && !all.some((c) => c.name === only)) {
    console.log(`FAIL no check named ${only}`);
    reportFailures("run");
    return 1;
  }
  const selected = only ? all.filter((c) => c.name === only) : all;
  if (selected.length === 0) {
    console.log("FAIL no checks found in tools/ui_checks");
    reportFailures("run");
    return 1;
  }

  await startServers();
  if (keep) {
    console.log(`servers started; pids: fake engine ${procs.engine.pid}, gateway ${procs.gateway.pid}, chrome ${procs.chrome.pid}`);
  }

  for (const check of selected) {
    lastStarted = check.name;
    const { failure, seconds } = await runCheck(check);
    if (failure === null) {
      results.passed += 1;
      console.log(`PASS ${check.name} (${seconds}s)`);
    } else {
      results.failed += 1;
      failedChecks.push(check.name);
      console.log(`FAIL ${check.name}: ${failure}`);
    }
  }
  console.log(`ui_check: ${results.passed} passed, ${results.failed} failed`);
  if (failedChecks.length) reportFailures();
  return results.failed === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await Promise.race([
    run(),
    sleep(RUN_LIMIT_MS).then(() => "deadline"),
  ]);
  if (code === "deadline") {
    console.log("FAIL run: 10 minute limit reached");
    console.log(`ui_check: ${results.passed} passed, ${results.failed + 1} failed`);
    if (lastStarted) console.log(`ui_check last check started: ${lastStarted}`);
    reportFailures("run");
    code = 1;
  }
} catch (error) {
  console.log(`FAIL startup: ${error.message}`);
  showLogs();
  if (lastStarted) console.log(`ui_check last check started: ${lastStarted}`);
  reportFailures("startup");
  code = 1;
} finally {
  if (keep) {
    for (const child of Object.values(procs)) child?.unref();
    console.log("--keep: servers left running. Stop them by hand (or rerun without --keep).");
  } else {
    await cleanup();
  }
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (!keep) await cleanup();
    process.exit(130);
  });
}
