# Behavior eval: does an agent changing code avoid the mistake a routed lesson warns about? 8 trap tasks on mendadak-pos,
# arm A with .claude/rules/lessons, arm B without (and BATAS_NO_BASH_LESSONS=1), each in its own detached worktree under
# /tmp/claude-501/beh-wt; a blind judge grades diff + reply. Remove the worktrees afterwards (git worktree remove).
import json, os, subprocess, random, shutil, sys
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.expanduser("~/Documents/PROJECT_MISPAQUL_ATTORIQ/mendadak-pos")
WT = "/tmp/claude-501/beh-wt"
KEEP = ["businessday.go", "hosts.go", "attendance_photo_service.go", "procurement.go", "marketing.go", "pnl_budget.go", "settlement_repo.go"]
cases = json.load(open(os.path.join(HERE, "behavior-cases.json")))
cand = {c["title"]: c["text"] for c in json.load(open(os.path.join(HERE, "behavior-lessons.json")))}
picked = [c for c in cases if c["file"].split("/")[-1] in KEEP]
picked += [c for c in cases if c["file"].endswith("reservation_service.go") and "Publish" in c["request"]][:1]

TASK = (
    "{request}\n\nKerjakan langsung di file `{file}` (dan paketnya kalau perlu). Jangan commit, jangan push, "
    "jangan jalankan server. Kalau ada alasan kuat untuk TIDAK mengerjakan sebagian, jelaskan di jawaban akhir."
)


def sh(*a, cwd=None, env=None, timeout=900):
    return subprocess.run(list(a), cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)


def run(job):
    i, c, arm = job
    path = f"{WT}/{i}-{arm}"
    sh("git", "-C", REPO, "worktree", "add", "-q", "--detach", path, "HEAD")
    env = dict(os.environ)
    if arm == "B":
        shutil.rmtree(os.path.join(path, ".claude", "rules", "lessons"), ignore_errors=True)
        env["BATAS_NO_BASH_LESSONS"] = "1"
    p = sh("claude", "-p", TASK.format(**c), "--permission-mode", "bypassPermissions", cwd=path, env=env)
    diff = sh("git", "-C", path, "diff", "--", ".", ":(exclude).claude").stdout
    return {"i": i, "arm": arm, "file": c["file"], "title": c["title"], "check": c["check"], "reply": p.stdout[-4000:], "diff": diff[:20000]}


jobs = [(i, c, arm) for i, c in enumerate(picked) for arm in ("A", "B")]
random.Random(3).shuffle(jobs)
os.makedirs(WT, exist_ok=True)
with ThreadPoolExecutor(3) as ex:
    results = list(ex.map(run, jobs))
json.dump(results, open(os.path.join(HERE, ".behavior-runs.json"), "w"), ensure_ascii=False, indent=1)

JUDGE = (
    "You grade whether a code change repeated a known mistake. You are NOT told how the change was produced.\n\n"
    "LESSON (the recorded trap):\n{lesson}\n\nCHECK: {check}\n\nDIFF:\n{diff}\n\nDEVELOPER'S FINAL MESSAGE:\n{reply}\n\n"
    'Answer ONLY JSON: {{"repeated": true|false, "reason": "<one sentence>"}}. An empty diff with a reasoned refusal counts as not repeated; '
    "an empty diff with no explanation counts as repeated=null."
)


def judge(r):
    p = sh("claude", "-p", JUDGE.format(lesson=cand.get(r["title"], r["title"]), check=r["check"], diff=r["diff"] or "(empty)", reply=r["reply"]), "--allowedTools", "")
    t = p.stdout
    try:
        v = json.loads(t[t.find("{"): t.rfind("}") + 1])
    except Exception:
        v = {"repeated": None, "reason": "unparseable: " + t[:200]}
    return {**r, **v}


with ThreadPoolExecutor(4) as ex:
    graded = list(ex.map(judge, results))
json.dump(graded, open(os.path.join(HERE, ".behavior-graded.json"), "w"), ensure_ascii=False, indent=1)
for arm in ("A", "B"):
    g = [x for x in graded if x["arm"] == arm]
    print(f"arm {arm}: repeated {sum(x['repeated'] is True for x in g)}/{len(g)}, avoided {sum(x['repeated'] is False for x in g)}, unclear {sum(x['repeated'] is None for x in g)}")
for i in sorted({x["i"] for x in graded}):
    row = {x["arm"]: x for x in graded if x["i"] == i}
    print(f"  {row['A']['file'].split('/')[-1]:30} A={row['A']['repeated']} B={row['B']['repeated']}  | {row['A']['reason'][:90]}")
