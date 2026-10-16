// Saved records through the gateway's /api/store. Live mode only: in demo mode (?sim=1) nothing is
// saved or loaded, and every call resolves to an empty result without a request. The contract is docs/API.md.

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const BAD_ID = "An id is 1 to 64 lowercase letters, digits, _ or -, starting with a letter or digit.";
const sim = new URLSearchParams(location.search).has("sim");
const writes = new Map();

function orderedWrite(key, fn) {
  const previous = writes.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(fn);
  writes.set(key, current);
  const clear = () => { if (writes.get(key) === current) writes.delete(key); };
  current.then(clear, clear);
  return current;
}

// The gateway's plain sentence from an error body, or a generic one when the body is not JSON.
async function gatewayError(res) {
  try {
    const body = await res.json();
    if (typeof body?.error === "string") return body.error;
  } catch {
    // Not JSON: fall through to the generic sentence.
  }
  return "The gateway returned an error. Try again.";
}

async function call(method, path, body, headers = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw Object.assign(new Error(await gatewayError(res)), { status: res.status });
  return res.json();
}

// Reject a bad id before any request is made, so a typo cannot reach the gateway.
function checkId(id) {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error(BAD_ID);
}

// c + the current time in base 36 + 3 random base-36 characters. Always matches the id pattern.
export function newId() {
  const random = Math.floor(Math.random() * 46656).toString(36).padStart(3, "0");
  return `c${Date.now().toString(36)}${random}`;
}

// Run fn at most once, ms after the last call to the returned function. .flush() runs a pending call now.
export function debounced(fn, ms = 400) {
  let timer = 0;
  let lastArgs = null;
  const wrapped = (...args) => {
    lastArgs = args;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      lastArgs = null;
      fn(...args);
    }, ms);
  };
  wrapped.flush = () => {
    if (!timer) return undefined;
    clearTimeout(timer);
    timer = 0;
    const args = lastArgs;
    lastArgs = null;
    return fn(...args);
  };
  wrapped.cancel = () => {
    clearTimeout(timer);
    timer = 0;
    lastArgs = null;
  };
  return wrapped;
}

export const store = {
  available: !sim,

  // Newest first, as the gateway lists them: [{ id, updated, title }].
  async list(collection) {
    if (sim) return [];
    const body = await call("GET", `/api/store/${collection}`);
    return body.items ?? [];
  },

  // The stored object, or a thrown Error when it is not there.
  async get(collection, id) {
    if (sim) return null;
    checkId(id);
    return call("GET", `/api/store/${collection}/${id}`);
  },

  // Save obj under id. Returns the gateway's { ok, id, updated }.
  async put(collection, id, obj) {
    if (sim) return null;
    checkId(id);
    const snapshot = structuredClone(obj);
    return orderedWrite(`${collection}/${id}`, () => call("PUT", `/api/store/${collection}/${id}`, snapshot));
  },

  // Create the record only if it does not exist yet. An existing record fails with 412.
  async create(collection, id, obj) {
    if (sim) return null;
    checkId(id);
    const snapshot = structuredClone(obj);
    return orderedWrite(`${collection}/${id}`, () => call("PUT", `/api/store/${collection}/${id}`, snapshot, { "If-None-Match": "*" }));
  },

  // Delete the record. Succeeds even when it was not there.
  async remove(collection, id) {
    if (sim) return null;
    checkId(id);
    return orderedWrite(`${collection}/${id}`, () => call("DELETE", `/api/store/${collection}/${id}`));
  },
};
