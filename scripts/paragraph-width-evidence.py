"""Never-merge diagnostic evidence. No dispatch, rerun, watch, or cancellation."""
import argparse
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import zipfile

BASE = "ca59edf52761200902c117532875ae46407b687c"
BASE_TREE = "a98103405aa77b249bd07127f3054814ef7cdba1"
TEST = "tests/formatted-tables.test.mjs"
TEST_HASH = "208800c8169bd43a386e3c6674b60b31051c67f6a1be24d37ec858427666fe8d"
TITLE = "the text at the pane's top in a huge paragraph holds through wheel steps and new widths"
PREVIOUS = TITLE.replace("huge paragraph", "huge line")
ROOT = Path(".cache/paragraph-width")
COMMAND = ["node", "--import", "./tests/file-limit.mjs", "--test", "--test-reporter=tap", "--test-concurrency=1", TEST]
FILE_LIMIT_MS = "1200000"
BRANCH = "may/nlr-paragraph-width-diag"
ACTOR = 53419401
TEST_STEP = "One original full formatted-tables file"
EXPECTED_ROOTS, EXPECTED_TESTS = 143, 297
IO_FAILURE = "paragraph diagnostic I/O failure"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def files(paths):
    result = {}
    for path in sorted(paths):
        p = Path(path)
        if p.is_symlink() or not p.is_file():
            raise ValueError("missing or non-file pin: " + path)
        data = p.read_bytes()
        result[path.replace("\\", "/")] = {"bytes": len(data), "sha256": sha(data)}
    return result


def executable(path):
    resolved = Path(path).resolve(strict=True)
    value = files([str(resolved)])[str(resolved).replace("\\", "/")]
    return {"path": str(resolved), **value}


def tree_manifest(root):
    result = {"files": {}, "dirs": [], "links": [], "other": [], "missing": []}
    def visit(path, name):
        details = path.lstat()
        mode = details.st_mode
        if stat.S_ISLNK(mode) or getattr(details, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0):
            result["links"].append({"path": name, "target": os.readlink(path)})
        elif stat.S_ISDIR(mode):
            result["dirs"].append(name)
            for child in sorted(path.iterdir()):
                visit(child, (name + "/" if name else "") + child.name)
        elif stat.S_ISREG(mode):
            data = path.read_bytes()
            result["files"][name] = {"bytes": len(data), "sha256": sha(data)}
        else:
            result["other"].append({"path": name, "mode": stat.S_IFMT(mode)})
    if root.exists() or root.is_symlink():
        visit(root, "")
    else:
        result["missing"].append(str(root))
    result["counts"] = {key: len(result[key]) for key in ("files", "dirs", "links", "other", "missing")}
    result["complete"] = not (result["links"] or result["other"] or result["missing"])
    return result


def reverse():
    data = Path(TEST).read_bytes()
    stripped = re.sub(rb"/\* pwdiag:start \*/[\s\S]*?/\* pwdiag:end \*/", b"", data)
    original = subprocess.check_output(["git", "show", BASE + ":" + TEST])
    if stripped != original or sha(stripped) != TEST_HASH:
        raise ValueError("test does not strip to exact ca59 source")
    assertion = b"    assert.ok(\n      steps.every("
    if data.count(assertion) != 1:
        raise ValueError("width assertion signature")
    line = data[:data.index(assertion)].count(b"\n") + 1
    return {"widthAssertLine": line, "logged": sha(data), "stripped": sha(stripped), "bytes": len(stripped),
            "insertions": data.count(b"/* pwdiag:start */")}


def snapshot(phase):
    ROOT.mkdir(parents=True, exist_ok=True)
    source = git("ls-files", "-z").split("\0")
    deps = [
        "node_modules/@codemirror/view/dist/index.js",
        "node_modules/@codemirror/state/dist/index.js",
        "node_modules/@codemirror/language/dist/index.js",
        "node_modules/@lezer/common/dist/index.js",
        "node_modules/@lezer/markdown/dist/index.js",
        "node_modules/electron/package.json",
        "node_modules/playwright-core/package.json",
        "node_modules/vite/package.json",
    ]
    head, tree = git("rev-parse", "HEAD"), git("rev-parse", "HEAD^{tree}")
    if git("merge-base", BASE, "HEAD") != BASE or git("rev-parse", BASE + "^{tree}") != BASE_TREE:
        raise ValueError("wrong diagnostic base")
    if head != os.environ["GITHUB_SHA"] or head != os.environ["EXPECTED_HEAD"] or tree != os.environ["EXPECTED_TREE"]:
        raise ValueError("wrong diagnostic checkout")
    if git("status", "--porcelain", "--untracked-files=all"):
        raise ValueError("dirty native source")
    node = json.loads(subprocess.check_output(
        ["node", "-p", "JSON.stringify({version:process.version,platform:process.platform,arch:process.arch,versions:process.versions,execPath:process.execPath})"],
        text=True))
    if node["platform"] != "win32" or node["arch"] != "x64":
        raise ValueError("not native windows x64")
    node["canonicalExecPath"] = str(Path(node["execPath"]).resolve(strict=True))
    electron_path = subprocess.check_output(["node", "-p", "require('electron')"], text=True).strip()
    electron_version = json.loads(Path("node_modules/electron/package.json").read_text())["version"]
    runtime = {"node": executable(node["execPath"]), "electron": executable(electron_path),
               "electronVersion": electron_version}
    value = {
        "runtime": runtime, "fileLimitMs": os.environ.get("CI_FILE_LIMIT_MS"),
        "actor": int(os.environ["GITHUB_ACTOR_ID"]), "branch": os.environ["GITHUB_REF_NAME"],
        "phase": phase, "base": BASE, "baseTree": BASE_TREE,
        "head": head, "tree": tree, "run": os.environ["GITHUB_RUN_ID"],
        "attempt": os.environ["GITHUB_RUN_ATTEMPT"], "node": node,
        "event": os.environ["GITHUB_EVENT_NAME"],
        "image": os.environ.get("ImageVersion"), "command": COMMAND,
        "reverse": reverse(), "source": files(p for p in source if p),
        "dependencies": files(deps),
        "output": tree_manifest(Path("out")),
    }
    if not value["output"]["complete"] or not value["output"]["files"] or value["event"] != "workflow_dispatch" or value["fileLimitMs"] != FILE_LIMIT_MS:
        raise ValueError("missing fresh output or wrong event")
    save(ROOT / (phase + ".json"), value)


def run_file():
    # Keep complete merged output both in TAP and in the original Actions log.
    if os.environ.get("CI_FILE_LIMIT_MS") != FILE_LIMIT_MS:
        raise ValueError("original file cap missing")
    node_executable = executable(shutil.which("node"))
    with (ROOT / "full-file.tap").open("wb") as stream:
        child = subprocess.Popen(COMMAND, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        for line in child.stdout:
            stream.write(line)
            stream.flush()
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()
        code = child.wait()
    save(ROOT / "exit.json", {"code": code, "command": COMMAND, "fileLimitMs": FILE_LIMIT_MS, "node": node_executable})
    return code


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def tap_complete(tap, expected=None):
    """Scope/numbering rules from approved run-candidate-v2 tap_complete; adds red diagnostics."""
    def need(ok, reason):
        if not ok:
            raise ValueError(reason)
    lines = tap.splitlines()
    need(lines and lines[0] == "TAP version 13" and lines.count("TAP version 13") == 1, "TAP envelope")
    counts = {}
    for key in ("tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"):
        rows = re.findall(r"^# " + key + r" (\d+)$", tap, re.M)
        need(len(rows) == 1, "missing/duplicate TAP " + key)
        counts[key] = int(rows[0])
    need(counts["tests"] > 0 and all(counts[k] == 0 for k in ("suites", "cancelled", "skipped", "todo")), "incomplete TAP cases")
    need(len(re.findall(r"^# duration_ms [\d.]+$", tap, re.M)) == 1 and re.fullmatch(r"# duration_ms [\d.]+", lines[-1]), "TAP duration/end")
    stack = [{"indent": -4, "name": None, "children": 0, "plan": None, "failed": 0}]
    records, yaml_indent, yaml_lines = [], None, []
    for line in lines:
        if yaml_indent is not None:
            yaml_lines.append(line)
            if line == " " * yaml_indent + "...":
                records[-1]["diagnostic"] = "\n".join(yaml_lines)
                yaml_indent, yaml_lines = None, []
            continue
        diagnostic = re.fullmatch(r"( +)---", line)
        sub = re.fullmatch(r"( *)# Subtest: (.*)", line)
        result = re.fullmatch(r"( *)(not ok|ok) (\d+) - (.*)", line)
        plan = re.fullmatch(r"( *)1\.\.(\d+)", line)
        if diagnostic:
            need(records and len(diagnostic[1]) == records[-1]["indent"] + 2 and "diagnostic" not in records[-1], "TAP diagnostic scope")
            yaml_indent, yaml_lines = len(diagnostic[1]), [line]
        elif sub:
            need(len(sub[1]) == stack[-1]["indent"] + 4 and stack[-1]["plan"] is None, "subtest scope")
            stack.append({"indent": len(sub[1]), "name": sub[2], "children": 0, "plan": None, "failed": 0})
        elif result:
            need(len(stack) > 1 and len(result[1]) == stack[-1]["indent"], "result scope")
            frame = stack.pop()
            need(result[4] == frame["name"] and int(result[3]) == stack[-1]["children"] + 1, "result name/order")
            need(not frame["failed"] or result[2] == "not ok", "failed child/green parent")
            if frame["children"] or frame["plan"] is not None:
                need(frame["plan"] == frame["children"], "nested plan")
            stack[-1]["children"] += 1
            stack[-1]["failed"] += result[2] == "not ok"
            records.append({"indent": len(result[1]), "number": int(result[3]), "name": result[4], "status": result[2]})
        elif plan:
            frame = stack[-1]
            need(len(plan[1]) == frame["indent"] + 4 and frame["plan"] is None, "plan scope/duplicate")
            frame["plan"] = int(plan[2])
        elif re.match(r"\s*(?:not ok\b|ok\b|1\.\.|# Subtest:)", line):
            raise ValueError("malformed TAP structure")
    need(yaml_indent is None and len(stack) == 1 and stack[0]["plan"] == stack[0]["children"] > 0, "root plan/end")
    need(len(records) == counts["tests"] and sum(r["status"] == "ok" for r in records) == counts["pass"] and sum(r["status"] == "not ok" for r in records) == counts["fail"], "TAP hierarchy/counts")
    roots = [r for r in records if r["indent"] == 0]
    need(expected is None or (len(roots), len(records)) == expected, "wrong full-file case counts")
    return {**counts, "rootTests": len(roots), "nestedTests": len(records) - len(roots), "records": records}


def tap_session(raw):
    text = raw.decode("utf-8")
    ansi = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
    lines = [ansi.sub("", re.sub(r"^\ufeff?\d{4}-\d{2}-\d{2}T\S+Z ", "", line)) for line in text.splitlines()]
    starts = [i for i, line in enumerate(lines) if line == "TAP version 13"]
    if len(starts) != 1:
        raise ValueError("missing/duplicate actual TAP session")
    end = [i for i in range(starts[0], len(lines)) if re.fullmatch(r"# duration_ms [\d.]+", lines[i])]
    if len(end) != 1:
        raise ValueError("missing/duplicate actual TAP ending")
    return "\n".join(lines[starts[0]:end[0] + 1]) + "\n"


def diagnostic_scalar(block, key):
    rows = re.findall(r"^  " + re.escape(key) + r": (.*)$", block, re.M)
    if len(rows) != 1:
        raise ValueError("missing/duplicate target diagnostic " + key)
    value = rows[0]
    return value[1:-1].replace("''", "'") if value.startswith("'") and value.endswith("'") else value


def quality(folder, expected):
    problems = []
    def read(name):
        try:
            return json.loads((folder / name).read_text(encoding="utf-8"))
        except Exception as error:
            problems.append(name + ": " + str(error))
            return {}
    pre, post = read("before.json"), read("after.json")
    for label, value in [("before", pre), ("after", post)]:
        actual = {key: str(value.get(key)) for key in ("run", "head", "tree", "attempt")}
        if actual != expected:
            problems.append(label + " identity")
        if value.get("actor") != ACTOR or value.get("branch") != BRANCH:
            problems.append(label + " actor/branch")
        if value.get("base") != BASE or value.get("baseTree") != BASE_TREE:
            problems.append(label + " base")
        if value.get("node", {}).get("platform") != "win32" or value.get("node", {}).get("arch") != "x64":
            problems.append(label + " platform")
        if value.get("command") != COMMAND or value.get("event") != "workflow_dispatch" or value.get("fileLimitMs") != FILE_LIMIT_MS:
            problems.append(label + " full-file command/event")
        if value.get("reverse", {}).get("stripped") != TEST_HASH:
            problems.append(label + " reverse")
    for key in ("source", "dependencies", "output", "runtime", "node"):
        if not pre.get(key) or pre.get(key) != post.get(key):
            problems.append("unstable/missing " + key)
    output = pre.get("output", {})
    if output.get("complete") is not True or not output.get("files") or any(output.get(k) for k in ("links", "other", "missing")) or output.get("counts") != {k: len(output.get(k, [])) for k in ("files", "dirs", "links", "other", "missing")}:
        problems.append("output enumeration incomplete")
    runtime = pre.get("runtime", {})
    for key in ("node", "electron"):
        pin = runtime.get(key, {})
        if not pin.get("path") or type(pin.get("bytes")) is not int or pin["bytes"] <= 0 or not re.fullmatch(r"[a-f0-9]{64}", pin.get("sha256", "")):
            problems.append("missing binary identity " + key)
    if pre.get("node", {}).get("canonicalExecPath") != runtime.get("node", {}).get("path") or pre.get("node", {}).get("versions", {}).get("node") != pre.get("node", {}).get("version", "").removeprefix("v") or not runtime.get("electronVersion"):
        problems.append("actual runtime identity")
    io_status = read("io-status.json")
    if io_status.get("results") != {"widths": True, "fixture-after": True} or io_status.get("faults") != []:
        problems.append("post-outcome diagnostic I/O")
    before, after = read("fixture-before.json"), read("fixture-after.json")
    if not before or before != after:
        problems.append("unstable/missing fixture")
    transforms = read("transforms.json")
    required = {
        "/src/renderer/src/reading-position.ts": "0011b5429c15f1fe16fe25c139026b5f1c956d08b574b8c67ee9a22ffce329fb",
        "/@codemirror/view/dist/index.js": "602f8203c6f39d8ba8a9b8a6a10c6e28f93537c07244b2d6d28aefb88fe8db91",
    }
    if not isinstance(transforms, list) or len(transforms) != len(required) or {
        item.get("suffix"): item.get("original") for item in transforms
    } != required or any(item.get("stripped") != item.get("original") for item in transforms):
        problems.append("module reverse proof")
    tape = read("widths.json")
    if tape.get("aborted") is not False:
        problems.append("aborted/missing original case")
    receipt, oracle = tape.get("receipt", {}), tape.get("oracle", {})
    rows = receipt.get("rows", [])
    if tape.get("base") != BASE or tape.get("baseTree") != BASE_TREE:
        problems.append("tape base")
    if receipt.get("resets") != 1 or receipt.get("dropped") != 0 or receipt.get("faults") != 0:
        problems.append("tape loss/fault/reset")
    if receipt.get("cap") != 20000 or not 0 < len(rows) <= 20000 or [r.get("seq") for r in rows] != list(range(len(rows))):
        problems.append("tape bounds/sequence")
    baseline = [r for r in rows if r.get("event") == "widths-baseline"]
    samples = [r for r in rows if r.get("event") == "width-oracle"]
    schedule = [(r.get("width"), r.get("stage")) for r in samples]
    if len(baseline) != 1 or schedule != [(w, s) for w in (1100, 900, 1400) for s in ("first", "settled")]:
        problems.append("baseline/sample schedule")
    baseline = baseline[0] if len(baseline) == 1 else {}
    if not finite(baseline.get("start")) or not finite(baseline.get("pos")) or not baseline.get("view") or not baseline.get("doc"):
        problems.append("baseline values")
    for row in samples:
        if any(row.get(k) != baseline.get(k) for k in ("view", "doc", "pos", "start")):
            problems.append("oracle identity")
    first = samples[2] if len(samples) == 6 else {}
    if not first or first != receipt.get("first900") or not finite(first.get("top")):
        problems.append("immutable finite first900")
    offsets = [(r["top"] - r["start"]) if finite(r.get("top")) and finite(r.get("start")) else None for r in samples]
    if oracle.get("widths") != offsets or len(oracle.get("steps", [])) != 32:
        problems.append("original oracle transport")
    for event in ("armed", "oracle-dom", "oracle-range", "hold-top-held", "hold-held", "restore-enter", "cm-measure-read", "cm-existing-size"):
        if not any(r.get("event") == event for r in rows):
            problems.append("missing event " + event)
    if not any(r.get("event") == "oracle-dom" and r.get("node") and r.get("view") == baseline.get("view") and r.get("doc") == baseline.get("doc") for r in rows):
        problems.append("real node/view/doc identity")
    if not any(r.get("event") == "cm-existing-size" and r.get("width") == 900 and r.get("view") == baseline.get("view") and r.get("doc") == baseline.get("doc") and finite(r.get("actualWidth")) and finite(r.get("cachedWidth")) for r in rows):
        problems.append("actual/cached width")
    exit_record = read("exit.json")
    if exit_record.get("command") != COMMAND or exit_record.get("fileLimitMs") != FILE_LIMIT_MS or exit_record.get("node") != runtime.get("node") or type(exit_record.get("code")) is not int:
        problems.append("original exit")
    try:
        tap = (folder / "full-file.tap").read_text(encoding="utf-8")
    except Exception as error:
        tap = ""
        problems.append("TAP: " + str(error))
    target, previous, parsed = [], [], {}
    condition900 = "unproved"
    is_red = False
    try:
        parsed = tap_complete(tap, (EXPECTED_ROOTS, EXPECTED_TESTS))
        roots = [r for r in parsed["records"] if r["indent"] == 0]
        targets = [r for r in roots if r["name"] == TITLE]
        predecessors = [r for r in roots if r["name"] == PREVIOUS]
        if len(targets) != 1 or targets[0]["number"] != 12 or len(predecessors) != 1 or predecessors[0]["number"] != 11 or predecessors[0]["status"] != "ok":
            raise ValueError("original target/predecessor scope")
        record = targets[0]
        target, previous = [record["status"]], [predecessors[0]["status"]]
        is_red = parsed["fail"] > 0
        if (exit_record.get("code") == 0) != (not is_red):
            raise ValueError("native original exit/TAP disagreement")
        error = tape.get("originalError")
        if target == ["ok"]:
            if tape.get("originalPassed") is not True or error is not None:
                raise ValueError("target green/originalPassed/error disagreement")
        else:
            if tape.get("originalPassed") is not False or not isinstance(error, dict) or not error.get("name") or not error.get("message") or not error.get("stack"):
                raise ValueError("target red/originalPassed/error disagreement")
            block = record.get("diagnostic", "")
            if diagnostic_scalar(block, "name") != error["name"] or diagnostic_scalar(block, "error") != error["message"]:
                raise ValueError("target original error/TAP disagreement")
        steps = oracle.get("steps", [])
        first_assert_fails = any(not finite(v) or abs(v) > 30 for v in steps) or any(not finite(v) or abs(v) > 60 for v in offsets)
        if first_assert_fails:
            block = record.get("diagnostic", "")
            line = pre.get("reverse", {}).get("widthAssertLine")
            frame = rf"formatted-tables\.test\.mjs:{line}:\d+"
            if target != ["not ok"] or error.get("name") != "AssertionError" or json.loads(error["message"]) != oracle or not isinstance(line, int) or not re.search(frame, error["stack"]):
                raise ValueError("original width assertion/error/frame disagreement")
            if diagnostic_scalar(block, "code") != "ERR_ASSERTION" or diagnostic_scalar(block, "operator") != "==" or "  stack: |-" not in block or not re.search(frame, block.split("  stack: |-", 1)[1]):
                raise ValueError("original width assertion TAP operator/frame")
        if finite(first.get("top")) and finite(first.get("start")):
            condition900 = "finite-breach" if abs(first["top"] - first["start"]) > 60 else "within-original-bound"
        if IO_FAILURE in tap:
            raise ValueError("diagnostic I/O failure in original TAP")
    except Exception as error:
        problems.append(str(error))
    return {
        "classification": "incomplete" if problems else "real-red" if is_red else "healthy-miss-stop",
        "problems": problems, "target": target, "originalError": tape.get("originalError"),
        "first900": first, "offsets": offsets, "condition900": condition900 if not problems else "unproved",
        "summary": {k: v for k, v in parsed.items() if k != "records"}, "nativeExit": exit_record.get("code"),
        "limits": "ordering evidence only; no unobserved native writer or historical failure closure",
    }


def collect(args):
    dest = Path(args.destination)
    try:
        dest.mkdir(parents=True, exist_ok=False)
    except OSError as error:
        print(json.dumps({"classification": "incomplete", "problems": ["new evidence destination: " + str(error)]}))
        return 2
    repo = os.environ.get("HIBI_REPOSITORY", "schmayterling/hibi")
    expected = {k: str(getattr(args, k)) for k in ("run", "head", "tree", "attempt")}
    report = {"expected": expected, "classification": "incomplete", "problems": []}
    def api(suffix, name, binary=False):
        data = subprocess.check_output(["gh", "api", "--allow-escape-sequences", "repos/" + repo + "/" + suffix], timeout=180)
        (dest / name).write_bytes(data)
        return data if binary else json.loads(data)
    try:
        run = api(f"actions/runs/{args.run}/attempts/{args.attempt}", "run.api.json")
        if str(run["id"]) != args.run or run["head_sha"] != args.head or str(run["run_attempt"]) != args.attempt or run["event"] != "workflow_dispatch" or run["path"] != ".github/workflows/check.yml" or run["status"] != "completed" or run["head_branch"] != BRANCH or run["actor"]["id"] != ACTOR or run["triggering_actor"]["id"] != ACTOR:
            raise ValueError("run actor/branch/identity/state")
        commit = api("git/commits/" + args.head, "commit.api.json")
        if commit["tree"]["sha"] != args.tree:
            raise ValueError("API tree")
        jobs = api(f"actions/runs/{args.run}/attempts/{args.attempt}/jobs?per_page=100", "jobs.api.json")
        if jobs["total_count"] != 1 or len(jobs["jobs"]) != 1:
            raise ValueError("not exactly one job")
        job = jobs["jobs"][0]
        if job["name"] != "windows-paragraph204" or job["status"] != "completed" or job["head_sha"] != args.head or str(job["run_id"]) != args.run or str(job["run_attempt"]) != args.attempt or "windows-latest" not in job.get("labels", []):
            raise ValueError("job identity/attempt/state/platform")
        steps = [step for step in job["steps"] if step["name"] == TEST_STEP]
        if len(steps) != 1 or steps[0]["status"] != "completed" or steps[0]["conclusion"] not in ("success", "failure"):
            raise ValueError("named original test step missing/incomplete")
        raw = api(f"actions/jobs/{job['id']}/logs", "job.raw.log", True)
        run_logs = api(f"actions/runs/{args.run}/attempts/{args.attempt}/logs", "run-logs.zip", True)
        with zipfile.ZipFile(io.BytesIO(run_logs)) as archive:
            if not archive.namelist() or archive.testzip() is not None:
                raise ValueError("full run logs ZIP incomplete")
            log_sessions = []
            for name in archive.namelist():
                if name.endswith(".txt"):
                    try:
                        log_sessions.append(tap_session(archive.read(name)))
                    except ValueError:
                        pass
        artifacts = api(f"actions/runs/{args.run}/artifacts?per_page=100", "artifacts.api.json")
        name = f"paragraph-width-{args.run}-{args.attempt}"
        candidates = [a for a in artifacts["artifacts"] if a["name"] == name and not a["expired"]]
        if artifacts["total_count"] > 100 or len(candidates) != 1:
            raise ValueError("artifact identity/list incomplete")
        artifact = api(f"actions/artifacts/{candidates[0]['id']}", "artifact.api.json")
        if artifact["workflow_run"]["id"] != int(args.run) or artifact["workflow_run"]["head_sha"] != args.head:
            raise ValueError("artifact source")
        blob = api(f"actions/artifacts/{artifact['id']}/zip", "artifact.zip", True)
        if artifact.get("digest") != "sha256:" + sha(blob):
            raise ValueError("API ZIP digest")
        extracted = dest / "artifact"
        extracted.mkdir()
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)) or len(names) > 10000 or sum(i.file_size for i in archive.infolist()) > 100 * 1024 * 1024:
                raise ValueError("artifact bounds/duplicates")
            for item in archive.infolist():
                path = Path(item.filename)
                if path.is_absolute() or ".." in path.parts or "\\" in item.filename:
                    raise ValueError("unsafe archive path")
                target = extracted / path
                if not item.is_dir():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(archive.read(item))
        # Preserve original artifact TAP before any semantic quality gate.
        tap_bytes = (extracted / "full-file.tap").read_bytes()
        (dest / "full-file.raw.tap").write_bytes(tap_bytes)
        actual = tap_session(raw)
        if actual != tap_bytes.decode("utf-8").replace("\r\n", "\n") or actual not in log_sessions:
            raise ValueError("artifact/job/full-run TAP disagree")
        report.update(quality(extracted, expected))
        code = report.get("nativeExit")
        if type(code) is not int or (steps[0]["conclusion"] == "success") != (code == 0):
            report["problems"].append("named native test step/original exit disagree")
        if job["conclusion"] != ("success" if code == 0 else "failure") or run["conclusion"] != job["conclusion"]:
            report["problems"].append("native original exit/job/run disagree")
        if report["problems"]:
            report["classification"] = "incomplete"
        report.update({"job": job["id"], "testStep": steps[0], "artifact": artifact["id"], "rawSha256": sha(raw), "runLogsSha256": sha(run_logs), "zipSha256": sha(blob)})
    except Exception as error:
        report["classification"] = "incomplete"
        report["problems"].append(str(error))
    try:
        report["preservedFiles"] = tree_manifest(dest)
        save(dest / "assessment.json", report)
    except Exception as error:
        report["classification"] = "incomplete"
        report["problems"].append("assessment preservation: " + str(error))
    print(json.dumps({k: report[k] for k in ("classification", "problems")}))
    return {"incomplete": 2, "real-red": 1, "healthy-miss-stop": 0}[report["classification"]]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    snap = modes.add_parser("snapshot")
    snap.add_argument("phase", choices=["before", "after"])
    modes.add_parser("run")
    modes.add_parser("context")
    query = modes.add_parser("collect")
    for key in ("run", "head", "tree", "attempt", "destination"):
        query.add_argument(key)
    args = parser.parse_args()
    if args.mode == "context":
        value = {"head": git("rev-parse", "HEAD"), "tree": git("rev-parse", "HEAD^{tree}"),
                 "run": os.environ["GITHUB_RUN_ID"], "attempt": os.environ["GITHUB_RUN_ATTEMPT"],
                 "event": os.environ["GITHUB_EVENT_NAME"], "base": BASE, "baseTree": BASE_TREE,
                 "actor": int(os.environ["GITHUB_ACTOR_ID"]), "branch": os.environ["GITHUB_REF_NAME"]}
        save(ROOT / "context.json", value)
        if value["actor"] != ACTOR or value["branch"] != BRANCH or value["head"] != os.environ["EXPECTED_HEAD"] or value["head"] != os.environ["GITHUB_SHA"] or value["tree"] != os.environ["EXPECTED_TREE"]:
            raise ValueError("wrong reviewed checkout")
    elif args.mode == "snapshot":
        snapshot(args.phase)
    elif args.mode == "run":
        sys.exit(run_file())
    else:
        sys.exit(collect(args))
