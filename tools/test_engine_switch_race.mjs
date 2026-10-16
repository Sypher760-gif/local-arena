// A ready switch must read fresh status after an older in-flight poll settles.
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.location = { search: "", href: "http://127.0.0.1/index.html" };
let releaseOld;
let statusCalls = 0;
const status = model => ({ engine: { reachable: Boolean(model), model, maxContext: 4096 }, gpu: null });
globalThis.fetch = async url => {
  if (url === "/api/status") {
    statusCalls += 1;
    if (statusCalls === 1) return new Promise(resolve => { releaseOld = resolve; });
    return Response.json(status("wanted"));
  }
  if (url === "/api/models") return Response.json({ models: [{ id: "wanted", loaded: true, tuning: {} }] });
  if (url === "/api/switch") return Response.json({ ok: true });
  if (url === "/api/switch/status") return Response.json({ state: "ready" });
  throw new Error(`Unexpected request ${url}`);
};
try {
  const { engine } = await import(pathToFileURL(path.join(root, "app/js/engine.js")));
  const loading = engine.loadModel("wanted");
  await new Promise(resolve => setTimeout(resolve, 1200));
  if (!engine.loading) throw new Error("Switch unlocked while old status was unresolved");
  releaseOld(Response.json(status(null)));
  await loading;
  if (statusCalls < 2 || engine.loadedModelId !== "wanted" || engine.loading) throw new Error("Switch resolved using stale status");
  console.log("PASS switch waits for a fresh post-ready status response");
  process.exit(0);
} catch (error) {
  console.log(`FAIL ${error.stack}`);
  process.exit(1);
}
