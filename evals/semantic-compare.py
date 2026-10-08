# Semantic recall comparison: 40 mendadak-pos lessons x blind EN/ID paraphrase queries (semantic-probes.json), top-1/top-3
# per model and per RRF fusion. Run: uv run --with "sentence-transformers[image]>=6.1" --with transformers --with torch python evals/semantic-compare.py
# 2026-10-08 result: gemma2+me5-small EN 35/40 ID 36/40 (BM25 18/33); see docs/plan/2026-10-08-semantic-recall/plan.md.
import json, time, itertools, os
os.environ.setdefault("HF_HOME", os.path.expanduser("~/.batas/hf"))
from sentence_transformers import SentenceTransformer
HERE = os.path.dirname(os.path.abspath(__file__))
# corpus: every mendadak-pos lesson over 200 chars, exported by:
#   bun -e 'import {parseLessons} from "./src/lessons.ts"; await Bun.write("evals/.corpus.json", JSON.stringify(parseLessons(process.env.HOME+"/Documents/PROJECT_MISPAQUL_ATTORIQ/mendadak-pos").filter(l=>l.text.length>200)))'
corpus = json.load(open(os.path.join(HERE, ".corpus.json"))); probes = json.load(open(os.path.join(HERE, "semantic-probes.json")))
want = [next(i for i, c in enumerate(corpus) if c["title"] == p["title"]) for p in probes]
MODELS = {  # name -> (hf id, query prefix, passage prefix)
  "gemma2":    ("google/embeddinggemma-2", "@SearchQuery", "@Document"),
  "me5-small": ("intfloat/multilingual-e5-small", "query: ", "passage: "),
  "bge-m3":    ("BAAI/bge-m3", "", ""),
}
ranks = {}
for name, (mid, qp, pp) in MODELS.items():
    t = time.time()
    # text only: the vision and audio encoders are never loaded (740M -> 270M parameters)
    kw = {"config_kwargs": {"vision_config": None, "audio_config": None}} if "embeddinggemma" in mid else {}
    m = SentenceTransformer(mid, device="mps", **kw); load = time.time() - t
    docs = [c["title"] + "\n" + c["text"][:1500] for c in corpus]
    t = time.time()
    P = m.encode(docs, prompt_name=pp[1:], batch_size=16, normalize_embeddings=True) if pp.startswith("@") else m.encode([pp + d for d in docs], batch_size=16, normalize_embeddings=True)
    idx = time.time() - t
    for lang in ("en", "id"):
        t = time.time()
        Q = m.encode([p[lang] for p in probes], prompt_name=qp[1:], normalize_embeddings=True) if qp.startswith("@") else m.encode([qp + p[lang] for p in probes], normalize_embeddings=True)
        q = (time.time() - t) / len(probes)
        ranks[(name, lang)] = [list((-(P @ v)).argsort()[:50]) for v in Q]
    print(f"{name:10} load {load:5.1f}s index {idx:5.1f}s query {q*1000:4.0f}ms", flush=True)
def score(rk):
    t1 = sum(r[0] == w for r, w in zip(rk, want)); t3 = sum(w in r[:3] for r, w in zip(rk, want)); return t1, t3
def rrf(a, b, k=60):
    out = []
    for ra, rb in zip(a, b):
        s = {}
        for r in (ra, rb):
            for pos, d in enumerate(r): s[d] = s.get(d, 0) + 1 / (k + pos + 1)
        out.append(sorted(s, key=lambda d: -s[d])[:50])
    return out
rows = []
for name in MODELS:
    rows.append((name, score(ranks[(name, "en")]), score(ranks[(name, "id")])))
def rrf3(a, b, c, k=60):
    out = []
    for ra, rb, rc in zip(a, b, c):
        s = {}
        for r in (ra, rb, rc):
            for pos, d in enumerate(r): s[d] = s.get(d, 0) + 1 / (k + pos + 1)
        out.append(sorted(s, key=lambda d: -s[d])[:50])
    return out
names = list(MODELS)
if len(names) == 3:
    a, b, c = names
    rows.append((f"{a}+{b}+{c}", score(rrf3(*[ranks[(n, "en")] for n in names])), score(rrf3(*[ranks[(n, "id")] for n in names]))))
for a, b in itertools.combinations(MODELS, 2):
    rows.append((f"{a}+{b}", score(rrf(ranks[(a, "en")], ranks[(b, "en")])), score(rrf(ranks[(a, "id")], ranks[(b, "id")]))))
print("\nmodel(s)               EN top1 top3 | ID top1 top3 | both top3")
for n, (e1, e3), (i1, i3) in sorted(rows, key=lambda r: -(r[1][1] + r[2][1])):
    print(f"{n:22} {e1:7} {e3:4} | {i1:7} {i3:4} | {e3+i3}")
