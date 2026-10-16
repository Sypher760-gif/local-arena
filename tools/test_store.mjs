// Tests for app/js/store.js (the saved-records client).
// Run: node tools/test_store.mjs   (Node 22+: global fetch)
// Starts tools/fake_engine.py on 8784 and the real gateway (server.py) on 8783 with a fresh temp store.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OFFSET = Number(process.env.ARENA_PORT_OFFSET ?? 0); // 100, 200 ... moves every test port
const GATEWAY = `http://127.0.0.1:${8783 + OFFSET}`;
const ENGINE = `http://127.0.0.1:${8784 + OFFSET}`;
const PYTHON = process.env.PYTHON ?? "python";
const STORE_JS = pathToFileURL(path.join(ROOT, "app", "js", "store.js")).href;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const children = [];
const tempDirs = [];
let failures = 0;
let fetchCalls = 0;

function check(name, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(test, timeoutMs, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await test()) return true;
    await sleep(stepMs);
  }
  return false;
}

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

function startChild(label, cmd, cargs, env = {}) {
  const child = spawn(cmd, cargs, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  child.label = label;
  child.stderrText = "";
  child.stderr.on("data", (chunk) => {
    child.stderrText += chunk;
  });
  children.push(child);
  return child;
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGKILL");
}

async function main() {
  for (const port of [8783 + OFFSET, 8784 + OFFSET]) {
    if (await portInUse(port)) throw new Error(`port ${port} is already in use; not starting`);
  }
  const store = mkdtempSync(path.join(os.tmpdir(), "arena-store-test-"));
  tempDirs.push(store);

  startChild("fake engine", PYTHON, [path.join(ROOT, "tools", "fake_engine.py"), "--port", String(8784 + OFFSET), "--wps", "60"]);
  startChild("gateway", PYTHON, [path.join(ROOT, "server.py")], {
    ARENA_ENGINE: `127.0.0.1:${8784 + OFFSET}`,
    ARENA_PORT: String(8783 + OFFSET),
    ARENA_STORE: store,
  });
  check("fake engine and gateway start", await waitUntil(async () =>
    (await isUp(`${ENGINE}/health`)) && (await isUp(`${GATEWAY}/index.html`)), 15000));

  // store.js talks to the same origin; in Node, resolve its relative paths against the gateway.
  const realFetch = globalThis.fetch;
  globalThis.location = { origin: GATEWAY, search: "", href: `${GATEWAY}/index.html` };
  globalThis.fetch = (url, init) => {
    fetchCalls += 1;
    const text = String(url);
    return realFetch(text.startsWith("/") ? GATEWAY + text : text, init);
  };

  const { store: client, newId, debounced } = await import(STORE_JS);
  check("store is available in live mode", client.available === true);

  // 1. put then get returns the same object.
  const obj = { id: "abc123", title: "First chat", model: "fake-model", messages: [{ role: "user", text: "hello there" }] };
  const putResult = await client.put("chats", "abc123", obj);
  const got = await client.get("chats", "abc123");
  check("put returns ok with the id", putResult?.ok === true && putResult?.id === "abc123", JSON.stringify(putResult));
  check("get returns the same object",
    got.title === obj.title && got.model === obj.model && got.messages.length === 1
      && got.messages[0].role === "user" && got.messages[0].text === "hello there",
    JSON.stringify(got));

  // 2. list is newest first and carries titles.
  await client.put("chats", "aaa1", { id: "aaa1", title: "Oldest" });
  await sleep(1100);
  await client.put("chats", "bbb2", { id: "bbb2", title: "Middle" });
  await sleep(1100);
  await client.put("chats", "ccc3", { id: "ccc3", title: "Newest" });
  const items = await client.list("chats");
  const titles = Object.fromEntries(items.map((i) => [i.id, i.title]));
  const sorted = items.every((item, i) => i === 0 || items[i - 1].updated >= item.updated);
  check("list is newest first", items[0]?.id === "ccc3" && sorted, items.map((i) => i.id).join(","));
  check("list carries titles", titles.aaa1 === "Oldest" && titles.bbb2 === "Middle" && titles.ccc3 === "Newest",
    JSON.stringify(titles));

  // 3. remove then get gives a not-found error.
  const removed = await client.remove("chats", "abc123");
  let notFound = null;
  try {
    await client.get("chats", "abc123");
  } catch (error) {
    notFound = error;
  }
  check("remove returns ok", removed?.ok === true, JSON.stringify(removed));
  check("get after remove throws the gateway's not-found sentence",
    notFound instanceof Error && /that id/i.test(notFound.message), notFound?.message);

  // 4. a bad id is rejected before any request is made.
  for (const [label, run] of [
    ["get", () => client.get("chats", "Bad ID!")],
    ["put", () => client.put("chats", "_leading", { a: 1 })],
    ["remove", () => client.remove("chats", "x".repeat(65))],
  ]) {
    const before = fetchCalls;
    let bad = null;
    try {
      await run();
    } catch (error) {
      bad = error;
    }
    check(`${label} rejects a bad id before any request`,
      bad instanceof Error && fetchCalls === before && /id is 1 to 64/i.test(bad.message), bad?.message);
  }

  // 5. newId always matches the id pattern across 1000 calls.
  let allMatch = true;
  for (let i = 0; i < 1000; i += 1) {
    if (!ID_RE.test(newId())) allMatch = false;
  }
  check("newId matches the id pattern 1000 times", allMatch);

  // 6. debounced runs fn once, after the last call.
  let calls = 0;
  const bump = debounced(() => {
    calls += 1;
  }, 120);
  bump();
  bump();
  bump();
  await sleep(60);
  check("debounced has not fired yet mid-window", calls === 0);
  await sleep(120);
  check("debounced fired once after the window", calls === 1, `${calls} calls`);
  bump();
  bump();
  bump.flush();
  check("debounced flush runs a pending call now", calls === 2, `${calls} calls`);
  await sleep(160);
  check("debounced flush does not fire the pending call twice", calls === 2, `${calls} calls`);

  // 7. demo mode (?sim=1): available false, calls resolve without a request.
  globalThis.location = { ...globalThis.location, search: "?sim=1" };
  const simClient = (await import(`${STORE_JS}?sim=1`)).store;
  check("sim: available is false", simClient.available === false);
  const beforeSim = fetchCalls;
  const simList = await simClient.list("chats");
  const simGet = await simClient.get("chats", "aaa1");
  const simPut = await simClient.put("chats", "x1", { a: 1 });
  const simRemove = await simClient.remove("chats", "aaa1");
  check("sim: every call resolves empty without a request",
    simList.length === 0 && simGet === null && simPut === null && simRemove === null && fetchCalls === beforeSim,
    `${fetchCalls - beforeSim} requests`);
}

let exitCode = 1;
try {
  await main();
  exitCode = failures === 0 ? 0 : 1;
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAIL`);
} catch (error) {
  console.log(`FAIL test run stopped: ${error?.stack ?? error}`);
  exitCode = 1;
} finally {
  for (const child of children) {
    killTree(child);
    if (child.stderrText) console.log(`stderr of ${child.label} (pid ${child.pid}): ${child.stderrText.trim().split("\n").slice(-3).join(" | ")}`);
  }
  await sleep(300);
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch {
      // Still locked; the folder is under the temp dir and harmless.
    }
  }
  process.exit(exitCode);
}
