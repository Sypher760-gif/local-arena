r"""Find local model files and read what they say about themselves. Standard library only.

  read_gguf(path)      the GGUF header: architecture, name, context length, layers (no tensors read)
  scan(folders)        every .gguf model under the folders, with its header facts and a vision file
  find_runtimes()      llama-server programs on this PC, so a model file can be started
  default_folders()    where model files usually live (LM Studio, Hugging Face cache, ...)

Reading a header only touches its first few megabytes (the tokenizer list is skipped, not decoded),
so scanning a folder of 20 GB files is quick. Results are cached by path, size and change time.
"""
import os
import re
import shutil
import struct
import time

GGUF_MAGIC = b"GGUF"
# GGUF value types: their fixed sizes, or None for string (8) and array (9).
_FIXED = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}
_FMT = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 6: "<f", 7: "<?", 10: "<Q", 11: "<q", 12: "<d"}
MIN_MODEL_BYTES = int(os.environ.get("ARENA_MIN_MODEL_BYTES") or 16 * 1024 * 1024)  # smaller: vocab or test stubs
SPLIT = re.compile(r"-(\d{5})-of-(\d{5})\.gguf$", re.I)
QUANT = re.compile(r"(?<![A-Za-z0-9])([A-Z]{0,3}Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32)(?![A-Za-z0-9])", re.I)
SCAN_LIMIT_S = 6.0                      # a scan gives up after this long and returns what it found
SCAN_MAX_FILES = 400
SCAN_MAX_DEPTH = 7
_cache = {}


class GGUFError(ValueError):
    pass


class _Reader:
    """Little-endian reads from a buffered file, with skips that do not decode."""

    def __init__(self, f):
        self.f = f
        self.size = os.fstat(f.fileno()).st_size

    def skip(self, n):
        if n < 0 or n > self.size - self.f.tell():
            raise GGUFError("The file ends inside its header.")
        self.f.seek(n, os.SEEK_CUR)

    def take(self, n):
        data = self.f.read(n)
        if len(data) != n:
            raise GGUFError("The file ends inside its header.")
        return data

    def u32(self):
        return struct.unpack("<I", self.take(4))[0]

    def u64(self):
        return struct.unpack("<Q", self.take(8))[0]

    def string(self, keep=True):
        n = self.u64()
        if n > 1 << 24:
            raise GGUFError("A header string is implausibly long.")
        if not keep:
            self.skip(n)
            return None
        return self.take(n).decode("utf-8", "replace")

    def value(self, kind, keep=True, depth=0):
        if depth > 16:
            raise GGUFError("The header has too many nested arrays.")
        if kind in _FIXED:
            raw = self.take(_FIXED[kind])
            return struct.unpack(_FMT[kind], raw)[0] if keep else None
        if kind == 8:
            return self.string(keep)
        if kind == 9:
            item, count = self.u32(), self.u64()
            if item in _FIXED:
                self.skip(_FIXED[item] * count)   # e.g. token scores: skip in one jump
            else:
                if count > self.size - self.f.tell():
                    raise GGUFError("The file ends inside its header.")
                for _ in range(count):                            # token strings: lengths must be read
                    self.value(item, keep=False, depth=depth + 1)
            return None
        raise GGUFError("Unknown header value type %d." % kind)


def read_gguf(path):
    """The facts a GGUF header states. Raises GGUFError when the file is not a GGUF model."""
    with open(path, "rb", buffering=1 << 20) as f:
        r = _Reader(f)
        if r.take(4) != GGUF_MAGIC:
            raise GGUFError("Not a GGUF file.")
        version = r.u32()
        if version not in (2, 3):
            raise GGUFError("GGUF version %d is not supported." % version)
        r.u64()                       # tensor count
        kv_count = r.u64()
        if kv_count > 100000:
            raise GGUFError("The header lists an implausible number of keys.")
        meta = {}
        for _ in range(kv_count):
            key = r.string() or ""
            kind = r.u32()
            wanted = key.startswith("general.") or key.endswith((
                ".context_length", ".block_count", ".expert_count", ".expert_used_count",
                ".embedding_length", ".head_count_kv", ".head_count", ".key_length", ".value_length",
                ".full_attention_interval", ".sliding_window"))
            meta[key] = r.value(kind, keep=wanted)
    arch = meta.get("general.architecture")
    get = lambda name: meta.get("%s.%s" % (arch, name)) if arch else None  # noqa: E731
    return {
        "architecture": arch,
        "name": meta.get("general.name"),
        "contextLength": _pos_int(get("context_length")),
        "layers": _pos_int(get("block_count")),
        "experts": _pos_int(get("expert_count")),
        "expertsUsed": _pos_int(get("expert_used_count")),
        "isProjector": arch == "clip" or str(meta.get("general.type") or "").lower() in ("mmproj", "projector"),
        "sizeLabel": meta.get("general.size_label"),
        "kvBytesPerToken": _kv_bytes_per_token(
            get("block_count"), get("embedding_length"), get("attention.head_count"),
            get("attention.head_count_kv") or get("attention.head_count"),
            get("attention.key_length"), get("attention.value_length"), get("full_attention_interval")),
    }


def _kv_bytes_per_token(layers, width, heads, kv_heads, key_len=None, value_len=None, full_every=None):
    """Rough f16 cache cost of one token: keys and values for every attention layer. The header's own
    key/value widths win over width/heads; hybrid models (Qwen 3.5: one attention layer in four, the rest
    linear with a fixed-size state) only cache their attention layers. None when the header does not say."""
    ok = lambda v: isinstance(v, int) and not isinstance(v, bool) and v > 0  # noqa: E731
    if not (ok(layers) and ok(kv_heads)):
        return None
    k = key_len if ok(key_len) else (width // heads if ok(width) and ok(heads) else None)
    v = value_len if ok(value_len) else k
    if not k:
        return None
    attention_layers = -(-layers // full_every) if ok(full_every) and full_every > 1 else layers
    return attention_layers * kv_heads * (k + v) * 2


def _pos_int(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def header(path):
    """read_gguf with a cache; None when the file cannot be read as a model header."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = (os.path.normcase(os.path.abspath(path)), st.st_size, st.st_mtime_ns)
    if key not in _cache:
        try:
            _cache[key] = read_gguf(path)
        except (OSError, GGUFError, struct.error, UnicodeError):
            _cache[key] = None
    return _cache[key]


def quant_from_name(filename):
    """The compression named in a file name (Q4_K_M, IQ3_XXS, BF16, ...), or None."""
    stem = SPLIT.sub(".gguf", filename)
    found = QUANT.findall(stem)
    return found[-1].upper() if found else None


GENERIC_STEMS = {"model", "ggml-model", "main", "weights"}


def display_name(path, meta=None):
    """A readable model name. The file name is what people recognise, so it wins; the folder name
    stands in for generic file names ("model-Q4_K_M.gguf"). Header names are often build leftovers
    ("Hf_V47"), so they are used only when the file name says nothing."""
    filename = os.path.basename(path)
    stem = SPLIT.sub("", filename)
    stem = re.sub(r"\.gguf$", "", stem, flags=re.I)
    q = quant_from_name(filename)
    if q:
        stem = re.sub(r"[-_. ]*" + re.escape(q) + r"$", "", stem, flags=re.I)
    stem = stem.strip(" -_.")
    if stem.lower() in GENERIC_STEMS or not stem:
        folder = os.path.basename(os.path.dirname(path))
        stem = re.sub(r"[-_]?GGUF$", "", folder, flags=re.I) or stem
    if not stem:
        name = (meta or {}).get("name")
        stem = name.strip() if isinstance(name, str) else filename
    return stem


def default_folders():
    """Where model files usually are. Missing folders are left out."""
    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, ".lmstudio", "models"),
        os.path.join(home, ".cache", "lm-studio", "models"),
        os.path.join(home, ".cache", "huggingface", "hub"),
        os.path.join(home, ".cache", "llama.cpp"),
        os.path.join(home, "models"),
        os.path.join(home, "Downloads"),
    ]
    return [p for p in candidates if os.path.isdir(p)]


def _walk(folder, deadline):
    base_depth = folder.rstrip("\\/").count(os.sep)
    for root, dirs, files in os.walk(folder, followlinks=False):
        if time.monotonic() > deadline:
            return
        depth = root.count(os.sep) - base_depth
        dirs[:] = [d for d in dirs if not d.startswith((".git", "node_modules", "__pycache__", "$"))
                   and (depth + 1) <= SCAN_MAX_DEPTH and d != ".internal"]
        for name in files:
            if name.lower().endswith(".gguf"):
                yield os.path.join(root, name)


def scan(folders):
    """Every GGUF model under the folders: one item per model (split files joined), vision
    projector files attached to the model next to them instead of listed on their own."""
    deadline = time.monotonic() + SCAN_LIMIT_S
    seen, models, projectors = set(), [], {}
    truncated = False
    for folder in folders:
        if not os.path.isdir(folder):
            continue
        for path in _walk(folder, deadline):
            real = os.path.normcase(os.path.realpath(path))
            if real in seen:
                continue
            seen.add(real)
            name = os.path.basename(path)
            split = SPLIT.search(name)
            if split and split.group(1) != "00001":
                continue                       # later shards: counted with the first one
            if "mmproj" in name.lower():
                projectors.setdefault(os.path.dirname(path), []).append(path)
                continue
            try:
                size = os.path.getsize(path)
            except OSError:
                continue
            if split:
                size = _split_size(path, int(split.group(2))) or size
            if size < MIN_MODEL_BYTES:
                continue
            meta = header(path)
            if meta is None:
                continue
            if meta["isProjector"]:
                projectors.setdefault(os.path.dirname(path), []).append(path)
                continue
            models.append({
                "path": path,
                "file": name,
                "name": display_name(path, meta),
                "quant": quant_from_name(name),
                "sizeBytes": size,
                "parts": int(split.group(2)) if split else 1,
                "architecture": meta["architecture"],
                "contextLength": meta["contextLength"],
                "layers": meta["layers"],
                "experts": meta["experts"],
                "sizeLabel": meta["sizeLabel"],
                "kvBytesPerToken": meta["kvBytesPerToken"],
            })
            if len(models) >= SCAN_MAX_FILES:
                truncated = True
                break
        if truncated or time.monotonic() > deadline:
            truncated = truncated or time.monotonic() > deadline
            break
    for m in models:
        near = projectors.get(os.path.dirname(m["path"]))
        if near:
            m["projector"] = sorted(near)[0]
    models.sort(key=lambda m: (m["name"].lower(), m["sizeBytes"]))
    return {"models": models, "truncated": truncated}


def describe(path):
    """One model file, the same shape scan() gives, or raises GGUFError with a plain reason."""
    if not isinstance(path, str) or not path.lower().endswith(".gguf"):
        raise GGUFError("Pick a .gguf model file.")
    if not os.path.isfile(path):
        raise GGUFError("No file at that path.")
    meta = header(path)
    if meta is None:
        raise GGUFError("That file is not a GGUF model Local Arena can read.")
    if meta["isProjector"]:
        raise GGUFError("That is a vision add-on file (mmproj), not a model. Pick the model next to it.")
    name = os.path.basename(path)
    split = SPLIT.search(name)
    size = os.path.getsize(path)
    if split:
        size = _split_size(path, int(split.group(2))) or size
    item = {"path": os.path.abspath(path), "file": name, "name": display_name(path, meta),
            "quant": quant_from_name(name), "sizeBytes": size, "parts": int(split.group(2)) if split else 1}
    item.update({k: meta[k] for k in ("architecture", "contextLength", "layers", "experts", "sizeLabel", "kvBytesPerToken")})
    folder = os.path.dirname(path)
    try:
        near = sorted(os.path.join(folder, f) for f in os.listdir(folder) if f.lower().endswith(".gguf") and "mmproj" in f.lower())
    except OSError:
        near = []
    if near:
        item["projector"] = near[0]
    return item


def _split_size(first, parts):
    total = 0
    for i in range(1, parts + 1):
        p = SPLIT.sub("-%05d-of-%05d.gguf" % (i, parts), first)
        try:
            total += os.path.getsize(p)
        except OSError:
            return None
    return total


def find_runtimes(extra=()):
    """llama-server programs on this PC: the PATH first, then the usual install places."""
    home = os.path.expanduser("~")
    exe = "llama-server.exe" if os.name == "nt" else "llama-server"
    found = []
    on_path = shutil.which("llama-server")
    if on_path:
        found.append(on_path)
    roots = [os.path.join(home, "llama.cpp"),
             os.path.join(home, "AppData", "Local", "Microsoft", "WinGet", "Packages"),
             os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "runtime")]
    deadline = time.monotonic() + 3.0
    for root in [r for r in roots if os.path.isdir(r)]:
        base = root.count(os.sep)
        for dirpath, dirs, files in os.walk(root):
            if time.monotonic() > deadline:
                break
            if dirpath.count(os.sep) - base >= 4:
                dirs[:] = []
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("node_modules", "models")]
            if exe in files:
                found.append(os.path.join(dirpath, exe))
    for p in extra:
        if isinstance(p, str) and os.path.isfile(p):
            found.append(p)
    out, keys = [], set()
    for p in found:
        k = os.path.normcase(os.path.abspath(p))
        if k not in keys:
            keys.add(k)
            out.append(os.path.abspath(p))
    return out
