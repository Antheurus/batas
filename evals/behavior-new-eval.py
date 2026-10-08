# Discriminating behavior eval (task 15): does an agent writing NEW code avoid a recorded mistake that nothing in the
# repo guards? The first eval (behavior-eval.py) was inconclusive because its traps sat in existing code whose tests and
# comments already stopped both arms. Here every task creates a new file or a new rule, and the lesson text is the only
# place the trap is written down. Both arms lose docs/lessons, so neither can grep it; only delivery differs:
#   A  batas on: hooks (prompt semantic match, routed rules, bash lessons) and the batas MCP server
#   B  batas off: BATAS_OFF=1, routed rules removed, no MCP servers at all
# A blind judge grades each diff + final message against the lesson's check.
#   uv run python evals/behavior-new-eval.py [runs-per-arm=1]
import json, os, random, shutil, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.expanduser("~/Documents/PROJECT_MISPAQUL_ATTORIQ/mendadak-pos")
WT = "/tmp/claude-501/beh-new-wt"
CORPUS = os.path.expanduser("~/Documents/PROJECT_MISPAQUL_ATTORIQ/batas")
cases = json.load(open(os.path.join(HERE, "behavior-new-cases.json")))
RUNS = int(sys.argv[1]) if len(sys.argv) > 1 else 1
# --arms A reruns one arm only (e.g. after the hook changed under a run); --tag keeps its worktrees and results apart
ARMS = sys.argv[sys.argv.index("--arms") + 1] if "--arms" in sys.argv else "AB"
TAG = sys.argv[sys.argv.index("--tag") + 1] if "--tag" in sys.argv else ""

TASK = (
    "{request}\n\nKerjakan langsung di repo ini. Jangan commit, jangan push, jangan jalankan server. "
    "Kalau ada alasan kuat untuk TIDAK mengerjakan sebagian, jelaskan di jawaban akhir."
)


def sh(*a, cwd=None, env=None, timeout=1200):
    return subprocess.run(list(a), cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)


def lesson_text(title):
    out = sh("bun", "-e", "import {parseLessons} from './src/lessons.ts'; console.log(JSON.stringify(parseLessons(process.argv[1])))", REPO, cwd=CORPUS)
    for l in json.loads(out.stdout):
        if l["title"].startswith(title) or title in l["title"]:
            return l["text"]
    raise SystemExit(f"lesson not found: {title}")


def run(job):
    c, arm, n = job
    path = f"{WT}/{c['key']}-{arm}{n}{TAG}"
    sh("git", "-C", REPO, "worktree", "add", "-q", "--detach", path, "HEAD")
    shutil.rmtree(os.path.join(path, "docs", "lessons"), ignore_errors=True)
    env = dict(os.environ)
    args = ["claude", "-p", TASK.format(**c), "--permission-mode", "bypassPermissions"]
    if arm == "B":
        shutil.rmtree(os.path.join(path, ".claude", "rules", "lessons"), ignore_errors=True)
        env["BATAS_OFF"] = "1"
        args += ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']
    p = sh(*args, cwd=path, env=env)
    # new files are untracked: intent-to-add makes them show in the diff without staging content
    sh("git", "-C", path, "add", "-N", ".")
    diff = sh("git", "-C", path, "diff", "--", ".", ":(exclude).claude", ":(exclude)docs/lessons").stdout
    return {"key": c["key"], "arm": arm, "n": n, "title": c["title"], "check": c["check"], "reply": p.stdout[-4000:], "diff": diff[:20000], "path": path}


JUDGE = (
    "You grade whether a code change repeated a known mistake. You are NOT told how the change was produced.\n\n"
    "LESSON (the recorded trap):\n{lesson}\n\nCHECK: {check}\n\nDIFF:\n{diff}\n\nDEVELOPER'S FINAL MESSAGE:\n{reply}\n\n"
    'Answer ONLY JSON: {{"repeated": true|false, "reason": "<one sentence>"}}. An empty diff with a reasoned refusal counts as not repeated; '
    "an empty diff with no explanation counts as repeated=null."
)


def judge(r, lessons):
    p = sh("claude", "-p", JUDGE.format(lesson=lessons[r["key"]], check=r["check"], diff=r["diff"] or "(empty)", reply=r["reply"]),
           "--allowedTools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', env={**os.environ, "BATAS_OFF": "1"})
    t = p.stdout
    try:
        v = json.loads(t[t.find("{"): t.rfind("}") + 1])
    except Exception:
        v = {"repeated": None, "reason": "unparseable: " + t[:200]}
    return {**r, **v}


if __name__ == "__main__":
    lessons = {c["key"]: lesson_text(c["title"]) for c in cases}
    jobs = [(c, arm, n) for c in cases for arm in ARMS for n in range(RUNS)]
    random.Random(15).shuffle(jobs)
    os.makedirs(WT, exist_ok=True)
    with ThreadPoolExecutor(3) as ex:
        results = list(ex.map(run, jobs))
    json.dump(results, open(os.path.join(HERE, f".behavior-new-runs{TAG}.json"), "w"), ensure_ascii=False, indent=1)
    with ThreadPoolExecutor(4) as ex:
        graded = list(ex.map(lambda r: judge(r, lessons), results))
    json.dump(graded, open(os.path.join(HERE, f".behavior-new-graded{TAG}.json"), "w"), ensure_ascii=False, indent=1)
    for arm in ARMS:
        g = [x for x in graded if x["arm"] == arm]
        print(f"arm {arm}: repeated {sum(x['repeated'] is True for x in g)}/{len(g)}, avoided {sum(x['repeated'] is False for x in g)}, unclear {sum(x['repeated'] is None for x in g)}")
    for c in cases:
        row = {x["arm"]: x for x in graded if x["key"] == c["key"]}
        print(f"  {c['key']:22} " + "  ".join(f"{a}={row[a]['repeated']} ({row[a]['reason'][:70]})" for a in ARMS if a in row))
