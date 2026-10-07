"""Measure memory trigger words against the user's real prompt history.

A trigger is only as good as the prompts it fires on: this reports, per project, which triggers fire on a large share
of that project's past prompts (too general), and how many prompts would pull any memory at all. Mirrors the hook's
matching: own words only (quoted lines and side-agent notes cut), whole-word hit, multi-word triggers in any order.
"""

import collections
import glob
import json
import os
import re
import sys

CLAUDE = os.environ.get("BATAS_CLAUDE_HOME", os.path.expanduser("~/.claude"))
THRESHOLD = float(sys.argv[1]) if len(sys.argv) > 1 else 0.03


def own_words(text: str) -> str:
    text = re.split(r"(?i)Here is a note offered by a side agent", text)[0]
    return "\n".join(line for line in text.split("\n") if not line.lstrip().startswith(">")).lower()


def says_word(text: str, word: str) -> bool:
    return word in text and re.search(r"(^|[^\w])" + re.escape(word) + r"($|[^\w])", text) is not None


def says(text: str, trigger: str) -> bool:
    words = trigger.split()
    return says_word(text, trigger) or (len(words) > 1 and all(says_word(text, w) for w in words))


prompts: dict[str, list[str]] = collections.defaultdict(list)
for line in open(os.path.join(CLAUDE, "history.jsonl"), errors="ignore"):
    try:
        row = json.loads(line)
    except json.JSONDecodeError:
        continue
    text = (row.get("display") or "").strip()
    if len(text) < 4 or text.startswith("/"):
        continue
    prompts[re.sub(r"[^A-Za-z0-9]", "-", row.get("project") or "")].append(own_words(text))

memories: dict[str, list[tuple[str, list[str]]]] = collections.defaultdict(list)
for path in glob.glob(os.path.join(CLAUDE, "projects", "*", "memory", "*.md")):
    if path.endswith("MEMORY.md"):
        continue
    # Same as the hook's parser: top-level or nested under metadata:, quoted or bare.
    found = re.search(r'(?m)^\s*triggers:\s*"?([^"\n]+)"?\s*$', open(path, errors="ignore").read())
    project = path.split("/projects/")[1].split("/")[0]
    terms = [t.strip().lower() for t in found.group(1).split(",") if t.strip()] if found else []
    memories[project].append((os.path.basename(path), terms))

missing = [(p, n) for p, ms in memories.items() for n, t in ms if not t]
general = []
total = hit = 0
per_prompt: collections.Counter[int] = collections.Counter()
for project, texts in prompts.items():
    mems = memories.get(project, [])
    if not mems:
        total += len(texts)
        per_prompt[0] += len(texts)
        continue
    fires = {(name, t): 0 for name, terms in mems for t in terms}
    for text in texts:
        n = 0
        for name, terms in mems:
            matched = [t for t in terms if says(text, t)]
            for t in matched:
                fires[(name, t)] += 1
            n += bool(matched)
        total += 1
        hit += n > 0
        per_prompt[min(n, 5)] += 1
    for (name, t), n in fires.items():
        if n / len(texts) >= THRESHOLD:
            general.append((n / len(texts), n, len(texts), t, name, project[-30:]))

print(f"prompts {total}; pulling any memory: {hit} ({hit / max(total, 1) * 100:.1f}%)")
print("memories per prompt (5 = 5+):", dict(sorted(per_prompt.items())))
print(f"memories without triggers: {len(missing)}")
for p, n in missing[:20]:
    print(f"  {n} [{p[-30:]}]")
print(f"triggers firing on >= {THRESHOLD * 100:.0f}% of their project's prompts (candidates to make more specific):")
for share, n, of, t, name, project in sorted(general, reverse=True):
    print(f"  {share * 100:5.1f}% {n:4}/{of:<5} {t!r:30} {name} [{project}]")
