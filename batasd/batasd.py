# /// script
# requires-python = ">=3.11"
# dependencies = ["sentence-transformers[image]>=6.1", "transformers", "torch", "lancedb>=0.40", "numpy", "pyarrow"]
# ///
"""batasd: semantic search over the batas corpus, two models held warm behind a unix socket.

EmbeddingGemma 2 (text only) and multilingual-e5-small, fused by reciprocal rank (k=60): on 40 mendadak-pos lessons
with blind English and Indonesian queries that pair put the right lesson in the top 3 for 35/40 and 36/40, against
32/34 for Gemma alone and 18/33 for the SQLite BM25 it replaces (evals/semantic-compare.py). Vectors persist in
LanceDB so a restart re-embeds nothing; the text itself stays in the source files, which the bun side parses.

Protocol: one JSON object per line in, one per line out. ops: ping, status, search, sync.
"""
import fcntl, json, os, socket, socketserver, subprocess, sys, threading, time
from datetime import timedelta
from pathlib import Path

STATE = Path(os.environ.get("BATAS_STATE_DIR", Path.home() / ".batas"))
SOCK = STATE / "batasd.sock"
LOCK = STATE / "batasd.lock"
VECTORS = STATE / "vectors.lance"
LOG = STATE / "batasd.log"
REPO = Path(__file__).resolve().parent.parent
# 0 = never exit on idle (the default: the user chose always-on, started at login by the launchd agent from `just install`)
IDLE_S = float(os.environ.get("BATASD_IDLE_MIN", "0")) * 60
RESYNC_S = 120
RRF_K = 60
STASH_S = 300
POOL = 50
# The model cache is shared by every state dir (tests use their own), and once both models are in it nothing goes online.
HF = Path(os.environ.get("BATAS_HF_HOME", Path.home() / ".batas" / "hf"))
os.environ["HF_HOME"] = str(HF)
if all((HF / "hub" / f"models--{mid.replace('/', '--')}").exists() for mid in ("google/embeddinggemma-2", "intfloat/multilingual-e5-small")):
    os.environ["HF_HUB_OFFLINE"] = "1"

MODELS = {
    "g": ("google/embeddinggemma-2", "SearchQuery", "Document"),
    "e": ("intfloat/multilingual-e5-small", "query: ", "passage: "),
}


def log(msg):
    with open(LOG, "a") as f:
        f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}\n")


class Index:
    """Rows and their vectors, swapped in whole so a search never sees a half-applied sync."""

    def __init__(self):
        import numpy as np

        self.np = np
        self.meta = []  # dicts: id kind scope title source hash
        self.vec = {k: np.zeros((0, 1), dtype="float32") for k in MODELS}
        self.synced_at = 0.0
        self.syncing = False

    def snapshot(self):
        return self.meta, self.vec


class Daemon:
    def __init__(self):
        import lancedb, torch
        from sentence_transformers import SentenceTransformer

        # cpu: ~1.3 GB, a query ~60-85 ms; mps: ~3.1-3.5 GB (Metal buffers), a query ~45 ms. Measured 2026-10-08.
        device = os.environ.get("BATASD_DEVICE") or ("mps" if torch.backends.mps.is_available() else "cpu")
        t = time.time()
        self.models = {}
        for key, (mid, _, _) in MODELS.items():
            # Text only: the vision and audio encoders are never loaded (740M -> 270M parameters).
            kw = {"config_kwargs": {"vision_config": None, "audio_config": None}} if "embeddinggemma" in mid else {}
            self.models[key] = SentenceTransformer(mid, device=device, **kw)
        log(f"models loaded on {device} in {time.time() - t:.1f}s")
        self.torch, self.device = torch, device
        self.encode_lock = threading.Lock()
        self.sync_lock = threading.Lock()
        self.db = lancedb.connect(str(VECTORS))
        self.index = Index()
        self.load()
        self.last_seen = time.time()
        self.wake = threading.Event()
        self.stash = {}

    def encode(self, key, texts, query):
        _, qp, pp = MODELS[key]
        m = self.models[key]
        prefix = qp if query else pp
        out = []
        # The lock is taken per batch of 16, not per call: a search arriving during a full index waits for one batch
        # (a second or two), not for a whole chunk of 512 documents.
        for i in range(0, len(texts), 16):
            part = texts[i:i + 16]
            with self.encode_lock:
                if key == "g":
                    out.append(m.encode(part, prompt_name=prefix, batch_size=16, normalize_embeddings=True))
                else:
                    out.append(m.encode([prefix + t for t in part], batch_size=16, normalize_embeddings=True))
        return self.index.np.vstack(out)

    def load(self):
        np = self.index.np
        if "entries" not in self.db.table_names():
            return
        tbl = self.db.open_table("entries").to_arrow()
        meta = tbl.select(["id", "kind", "scope", "title", "source", "hash"]).to_pylist()
        # Straight from the Arrow buffer: to_pydict() made ~9M Python floats first, and the heap never shrank back.
        vec = {}
        for k in MODELS:
            col = tbl.column(k).combine_chunks()
            vec[k] = col.flatten().to_numpy().astype("float32").reshape(len(col), col.type.list_size) if meta else np.zeros((0, 1), dtype="float32")
        self.index.meta, self.index.vec = meta, vec
        log(f"loaded {len(meta)} vectors")

    def persist(self, meta, vec):
        import pyarrow as pa

        data = {k: [m[k] for m in meta] for k in ("id", "kind", "scope", "title", "source", "hash")}
        for key in MODELS:
            dim = vec[key].shape[1]
            data[key] = pa.FixedSizeListArray.from_arrays(pa.array(vec[key].reshape(-1)), dim)
        self.db.create_table("entries", pa.table(data), mode="overwrite")

    def release(self):
        # After a sync: each overwrite kept the previous table version on disk (47 versions, 1.5 GB for ~40 MB of
        # vectors), and MPS keeps the encode batches' buffers cached (fresh 1.1 GB of Metal memory, 2.2 GB after syncs).
        # delete_unverified: Lance otherwise keeps any file younger than 7 days, i.e. every one of them. Safe only because
        # batasd is the table's sole reader and writer (searches run on the in-memory arrays) and sync_lock serialises it.
        try:
            self.db.open_table("entries").optimize(cleanup_older_than=timedelta(0), delete_unverified=True)
        except Exception as err:
            log(f"version cleanup failed: {err}")
        if self.device == "mps":
            self.torch.mps.empty_cache()

    def export(self):
        out = subprocess.run(["bun", str(REPO / "src" / "export.ts")], capture_output=True, text=True, timeout=120)
        if out.returncode != 0:
            raise RuntimeError(out.stderr[-500:])
        return [json.loads(l) for l in out.stdout.splitlines() if l.strip()]

    def stamp(self):
        out = subprocess.run(["bun", str(REPO / "src" / "export.ts"), "--stamp"], capture_output=True, text=True, timeout=60)
        return out.stdout.strip() if out.returncode == 0 else None

    def sync(self, force=False):
        # `just reindex` (op sync, wait) and the background loop can both arrive here; release() deletes unverified files,
        # so a second sync writing while the first cleans up would lose its data files.
        with self.sync_lock:
            return self._sync(force)

    def _sync(self, force=False):
        np = self.index.np
        # The periodic check costs a stat per source file; the full parse (~0.4 s of CPU) runs only when one moved.
        stamp = self.stamp()
        if not force and stamp and stamp == getattr(self, "last_stamp", None):
            self.index.synced_at = time.time()
            return {"changed": 0, "removed": 0, "total": len(self.index.meta)}
        self.index.syncing = True
        try:
            rows = self.export()
            meta, vec = self.index.snapshot()
            have = {m["id"]: i for i, m in enumerate(meta)}
            keep_meta, keep_idx, todo = [], [], []
            for r in rows:
                i = have.get(r["id"])
                if i is not None and meta[i]["hash"] == r["hash"]:
                    keep_meta.append({**meta[i], "kind": r["kind"], "scope": r["scope"], "title": r["title"], "source": r["source"]})
                    keep_idx.append(i)
                else:
                    todo.append(r)
            removed = len(meta) - len(keep_idx)
            new_meta = keep_meta
            new_vec = {k: vec[k][keep_idx] if keep_idx else None for k in MODELS}
            self.last_stamp = stamp
            if not todo and not removed:
                self.index.synced_at = time.time()
                return {"changed": 0, "removed": 0, "total": len(meta)}
            t = time.time()
            # Chunks persist as they finish, so a first full index interrupted halfway keeps what it already paid for.
            for start in range(0, max(len(todo), 1), 512):
                chunk = todo[start:start + 512]
                if chunk:
                    docs = [f"{r['title']}\n{r['text'][:1500]}" for r in chunk]
                    for k in MODELS:
                        v = self.encode(k, docs, query=False).astype("float32")
                        new_vec[k] = v if new_vec[k] is None else np.vstack([new_vec[k], v])
                    new_meta = new_meta + [{k: r[k] for k in ("id", "kind", "scope", "title", "source", "hash")} for r in chunk]
                self.persist(new_meta, new_vec)
                self.index.meta, self.index.vec = new_meta, new_vec
            self.release()
            log(f"sync: {len(todo)} embedded, {removed} removed, {len(new_meta)} total, {time.time() - t:.1f}s")
            self.index.synced_at = time.time()
            return {"changed": len(todo), "removed": removed, "total": len(new_meta)}
        finally:
            self.index.syncing = False

    def search(self, query, kinds=None, scope=None, limit=8, prefix=None):
        np = self.index.np
        meta, vec = self.index.snapshot()
        if not meta:
            return []
        cols = self.columns(meta)
        mask = np.ones(len(meta), dtype=bool)
        if kinds:
            mask &= np.isin(cols["kind"], list(kinds))
        # A repo's memories are scoped by the Claude project slug of its path ("-Users-...-mendadak-pos").
        own = lambda m: m["scope"] == scope or (m["kind"] == "memory" and m["scope"].endswith("-" + scope))
        if scope:
            # Memories cross repo lines: Funnel's decisions are recorded under its backend project and govern its
            # frontend repos too, so a scoped search keeps every project's memories (ranked as "other" unless the
            # session's own) and drops only other repos' rules, lessons and history.
            mask &= (cols["scope"] == "global") | (cols["scope"] == scope) | (cols["kind"] == "memory")
        if prefix:
            mask &= np.array([m["id"].startswith(prefix) for m in meta])
        idx = np.nonzero(mask)[0]
        if not len(idx):
            return []
        fused, qv = {}, {}
        for k in MODELS:
            q = qv[k] = self.encode(k, [query], query=True)[0].astype("float32")
            sims = vec[k][idx] @ q
            order = np.argsort(-sims)[:POOL]
            if k == "g":
                ref = float(sims[order[min(9, len(order) - 1)]])
            for rank, j in enumerate(order):
                d = int(idx[j])
                fused[d] = fused.get(d, 0.0) + 1.0 / (RRF_K + rank + 1)
        ranked = sorted(fused, key=lambda d: -fused[d])
        if scope:
            # Inside a repo, its own entries and the global corpus are ranked apart and interleaved, repo first. Fused
            # as one list, English global references outranked the repo's Indonesian lessons for an English query
            # (right lesson in top 3: 17/40 fused, see docs/plan/2026-10-08-semantic-recall/plan.md).
            local = [d for d in ranked if own(meta[d])]
            other = [d for d in ranked if not own(meta[d])]
            ranked = [d for pair in zip(local, other) for d in pair] + local[len(other):] + other[len(local):]
        best = ranked[:limit]
        # Both cosines for every hit, including one that reached the fused list through a single model: the hook's
        # standout gate reads the Gemma cosine of the 10th hit, and a missing one read as 0 opened it on most prompts.
        # ref: the 10th-best Gemma cosine over the whole filtered set, so a caller can tell a hit that stands out from the
        # usual nearest neighbour without it depending on how many hits it asked for.
        return [{**meta[d], "score": round(fused[d], 5), "cos": {k: float(vec[k][d] @ qv[k]) for k in MODELS}, "ref": ref} for d in best]

    def columns(self, meta):
        # Kind and scope as arrays, rebuilt only when the row list itself is replaced by a sync.
        if getattr(self, "_cols_for", None) is not meta:
            np = self.index.np
            self._cols = {"kind": np.array([m["kind"] for m in meta]), "scope": np.array([m["scope"] for m in meta])}
            self._cols_for = meta
        return self._cols

    def handle(self, req):
        self.last_seen = time.time()
        op = req.get("op")
        if op == "ping":
            return {"ok": True}
        if op == "status":
            return {"ok": True, "entries": len(self.index.meta), "synced_at": self.index.synced_at, "syncing": self.index.syncing, "pid": os.getpid()}
        if op == "sync":
            if req.get("wait"):
                return {"ok": True, **self.sync(force=True)}
            self.wake.set()
            return {"ok": True, "queued": True}
        if op == "quit":
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return {"ok": True, "pid": os.getpid()}
        if op == "search":
            t = time.time()
            hits = self.search(req["query"], req.get("kinds"), req.get("scope"), int(req.get("limit", 8)), req.get("prefix"))
            # A caller that could not wait (the prompt hook on a GPU that had powered down) leaves a key; the result is
            # kept for its next call to take, so a slow first query costs nobody a wait.
            if req.get("stash"):
                now = time.time()
                self.stash = {k: v for k, v in self.stash.items() if now - v[0] < STASH_S}
                self.stash[req["stash"]] = (now, hits)
            return {"ok": True, "hits": hits, "ms": round((time.time() - t) * 1000, 1), "partial": self.index.syncing or not self.index.synced_at}
        if op == "take":
            # wait_ms: a search for this key may still be running (an idle GPU needs 0.5-0.7 s); Stop waits for it.
            deadline = time.time() + float(req.get("wait_ms", 0)) / 1000
            while req.get("key") not in self.stash and time.time() < deadline:
                time.sleep(0.02)
            got = self.stash.pop(req.get("key"), None)
            fresh = got and time.time() - got[0] < STASH_S
            return {"ok": True, "hits": got[1] if fresh else None}
        return {"ok": False, "error": f"unknown op {op!r}"}

    def background(self):
        while True:
            self.wake.wait(timeout=RESYNC_S)
            self.wake.clear()
            try:
                self.sync()
            except Exception as err:
                log(f"sync failed: {err}")

    def watchdog(self, server):
        while True:
            time.sleep(30)
            if IDLE_S > 0 and time.time() - self.last_seen > IDLE_S and not self.index.syncing:
                log("idle, exiting")
                server.shutdown()
                return


def main():
    STATE.mkdir(parents=True, exist_ok=True)
    lock = open(LOCK, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit(0)  # another batasd owns the socket
    if SOCK.exists():
        SOCK.unlink()
    daemon = Daemon()

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            for line in self.rfile:
                try:
                    resp = daemon.handle(json.loads(line))
                except Exception as err:
                    resp = {"ok": False, "error": str(err)}
                try:
                    self.wfile.write((json.dumps(resp, ensure_ascii=False) + "\n").encode())
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    return  # the caller stopped waiting; a stashed result is still kept

    class Server(socketserver.ThreadingUnixStreamServer):
        daemon_threads = True

    server = Server(str(SOCK), Handler)
    daemon.server = server
    log(f"listening on {SOCK} pid {os.getpid()}")
    threading.Thread(target=daemon.background, daemon=True).start()
    daemon.wake.set()
    threading.Thread(target=daemon.watchdog, args=(server,), daemon=True).start()
    try:
        server.serve_forever()
    finally:
        SOCK.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
