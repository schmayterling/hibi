"""Offline only: exercise actual quality/parser/collector; every subprocess is intercepted."""
import argparse
from contextlib import redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import re
import runpy
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
import zipfile

SOURCE = Path(__file__).with_name("paragraph-width-evidence.py")
ACTUAL = runpy.run_path(str(SOURCE))
quality, parse, collect = (ACTUAL[k] for k in ("quality", "tap_complete", "collect"))
TITLE, PREVIOUS = ACTUAL["TITLE"], ACTUAL["PREVIOUS"]
EXPECTED = {"run": "17", "head": "a" * 40, "tree": "b" * 40, "attempt": "1"}
RESULTS = []


def dump(folder, name, value):
    (folder / name).write_text(json.dumps(value), encoding="utf-8")


def fixture(folder, green_tap, red=False):
    folder.mkdir()
    test_source = SOURCE.parents[1] / ACTUAL["TEST"]
    source = test_source.read_bytes()
    line = source[:source.index(b"    assert.ok(\n      steps.every(")].count(b"\n") + 1
    binary = {"path": "C:/node.exe", "bytes": 100, "sha256": "1" * 64}
    runtime = {"node": binary, "electron": {**binary, "path": "C:/electron.exe"}, "electronVersion": "45.0.0"}
    output = {"files": {"main.js": {"bytes": 1, "sha256": "2" * 64}}, "dirs": [""], "links": [], "other": [], "missing": [],
              "counts": {"files": 1, "dirs": 1, "links": 0, "other": 0, "missing": 0}, "complete": True}
    pin = {**EXPECTED, "base": ACTUAL["BASE"], "baseTree": ACTUAL["BASE_TREE"],
           "node": {"platform": "win32", "arch": "x64", "version": "v24.19.0", "versions": {"node": "24.19.0"}, "execPath": binary["path"], "canonicalExecPath": binary["path"]},
           "runtime": runtime, "actor": ACTUAL["ACTOR"], "branch": ACTUAL["BRANCH"], "fileLimitMs": ACTUAL["FILE_LIMIT_MS"], "command": ACTUAL["COMMAND"],
           "event": "workflow_dispatch", "reverse": {"stripped": ACTUAL["TEST_HASH"], "widthAssertLine": line},
           "source": {"test": "canned"}, "dependencies": {"cm": "canned"}, "output": output}
    dump(folder, "before.json", pin)
    dump(folder, "after.json", pin)
    for side in ("before", "after"):
        dump(folder, "fixture-" + side + ".json", [{"path": "harness.js", "bytes": 1, "sha256": "3" * 64}])
    hashes = {
        "/src/renderer/src/reading-position.ts": "0011b5429c15f1fe16fe25c139026b5f1c956d08b574b8c67ee9a22ffce329fb",
        "/@codemirror/view/dist/index.js": "602f8203c6f39d8ba8a9b8a6a10c6e28f93537c07244b2d6d28aefb88fe8db91",
    }
    dump(folder, "transforms.json", [{"suffix": k, "original": v, "stripped": v} for k, v in hashes.items()])
    dump(folder, "exit.json", {"code": int(red), "command": ACTUAL["COMMAND"], "fileLimitMs": ACTUAL["FILE_LIMIT_MS"], "node": binary})
    dump(folder, "io-status.json", {"results": {"widths": True, "fixture-after": True}, "faults": []})
    rows = []
    def row(event, **fields):
        value = {"seq": len(rows), "event": event, "view": 1, "doc": 2, **fields}
        rows.append(value)
        return value
    for event in ("armed", "hold-top-held", "hold-held", "restore-enter", "cm-measure-read"):
        row(event)
    row("oracle-dom", node=3)
    row("oracle-range", node=3)
    row("cm-existing-size", width=900, actualWidth=900, cachedWidth=1100)
    row("widths-baseline", pos=1000, start=0.25)
    offsets = []
    for width in (1100, 900, 1400):
        for stage in ("first", "settled"):
            off = -59159.09375 if red and width == 900 and stage == "first" else 0
            row("width-oracle", width=width, stage=stage, pos=1000, start=0.25, top=0.25 + off)
            offsets.append(off)
    oracle = {"steps": [0] * 32, "widths": offsets}
    first = [r for r in rows if r["event"] == "width-oracle"][2]
    error = None
    tap = green_tap
    if red:
        message = json.dumps(oracle, separators=(",", ":"))
        frame = f"TestContext.<anonymous> (file:///D:/a/hibi/hibi/tests/formatted-tables.test.mjs:{line}:12)"
        error = {"name": "AssertionError", "message": message, "stack": "AssertionError: " + message + "\n    at " + frame}
        diagnostic = (f"not ok 12 - {TITLE}\n  ---\n  duration_ms: 5849.8239\n  type: 'test'\n"
                      f"  error: '{message}'\n  code: 'ERR_ASSERTION'\n  name: 'AssertionError'\n"
                      f"  expected: true\n  actual: false\n  operator: '=='\n  stack: |-\n    {frame}\n  ...")
        tap, count = re.subn(r"ok 12 - " + re.escape(TITLE) + r"\n  ---\n[\s\S]*?\n  \.\.\.", lambda _: diagnostic, tap, count=1)
        if count != 1:
            raise AssertionError("seed target diagnostic not unique")
        total = ACTUAL["EXPECTED_TESTS"]
        tap = tap.replace(f"# pass {total}\n# fail 0", f"# pass {total - 1}\n# fail 1")
    (folder / "full-file.tap").write_text(tap, encoding="utf-8")
    dump(folder, "widths.json", {"base": ACTUAL["BASE"], "baseTree": ACTUAL["BASE_TREE"], "aborted": False,
         "originalPassed": not red, "originalError": error, "oracle": oracle,
         "receipt": {"rows": rows, "cap": 20000, "resets": 1, "dropped": 0, "faults": 0, "first900": first}})
    return tap


def json_change(folder, name, mutate):
    path = folder / name
    value = json.loads(path.read_text())
    mutate(value)
    dump(folder, name, value)


def zip_bytes(entries):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return stream.getvalue()


def collector_case(root, seed, label, red=False, api_mutation=None, file_mutation=None, expected=0):
    folder = root / (label + "-fixture")
    tap = fixture(folder, seed, red)
    if file_mutation:
        file_mutation(folder)
    tap = (folder / "full-file.tap").read_text()
    raw = b"".join(b"2026-11-08T00:00:00Z " + line + b"\n" for line in tap.encode().splitlines())
    artifact_zip = zip_bytes({p.name: p.read_bytes() for p in folder.iterdir()})
    run_logs = zip_bytes({"windows-paragraph204/6_One original full formatted-tables file.txt": raw})
    outcome = "failure" if red else "success"
    run = {"id": 17, "head_sha": EXPECTED["head"], "run_attempt": 1, "event": "workflow_dispatch",
           "path": ".github/workflows/check.yml", "status": "completed", "head_branch": ACTUAL["BRANCH"],
           "actor": {"id": ACTUAL["ACTOR"]}, "triggering_actor": {"id": ACTUAL["ACTOR"]}, "conclusion": outcome}
    job = {"id": 19, "run_id": 17, "run_attempt": 1, "name": "windows-paragraph204", "status": "completed",
           "head_sha": EXPECTED["head"], "labels": ["windows-latest"], "conclusion": outcome,
           "steps": [{"name": ACTUAL["TEST_STEP"], "status": "completed", "conclusion": outcome}]}
    artifact = {"id": 23, "name": "paragraph-width-17-1", "expired": False,
                "workflow_run": {"id": 17, "head_sha": EXPECTED["head"]},
                "digest": "sha256:" + hashlib.sha256(artifact_zip).hexdigest()}
    routes = {
        "actions/runs/17/attempts/1": run, "git/commits/" + EXPECTED["head"]: {"tree": {"sha": EXPECTED["tree"]}},
        "actions/runs/17/attempts/1/jobs?per_page=100": {"total_count": 1, "jobs": [job]},
        "actions/jobs/19/logs": raw, "actions/runs/17/attempts/1/logs": run_logs,
        "actions/runs/17/artifacts?per_page=100": {"total_count": 1, "artifacts": [artifact]},
        "actions/artifacts/23": artifact, "actions/artifacts/23/zip": artifact_zip,
    }
    if api_mutation:
        api_mutation(routes)
    calls = []
    def fake_api(command, **kwargs):
        if command[:3] != ["gh", "api", "--allow-escape-sequences"]:
            raise AssertionError("escape-preserving API flags missing")
        if kwargs != {"timeout": 180}:
            raise AssertionError("unexpected/unbounded API call")
        route = command[3].split("/hibi/", 1)[1]
        calls.append(route)
        value = routes[route]
        return value if isinstance(value, bytes) else json.dumps(value).encode()
    dest = root / (label + "-collected")
    args = SimpleNamespace(**EXPECTED, destination=str(dest))
    with patch.object(ACTUAL["subprocess"], "check_output", side_effect=fake_api), patch.object(ACTUAL["subprocess"], "Popen", side_effect=AssertionError("offline process forbidden")), redirect_stdout(io.StringIO()):
        code = collect(args)
    if code != expected:
        raise AssertionError((label, code, expected, json.loads((dest / "assessment.json").read_text())))
    if file_mutation and not (dest / "full-file.raw.tap").is_file():
        raise AssertionError("artifact TAP not preserved before quality gate")
    if expected in (0, 1) and not (dest / "run-logs.zip").is_file():
        raise AssertionError("missing full run ZIP")
    return calls


def windows_canned_seed(original):
    # Approved Mac file: 143 roots/306 total. Source has exactly 8+1 Mac-only children.
    parsed = parse(original, (143, 306))
    children, lines, removed, total = [], ["TAP version 13"], 0, 0
    for record in parsed["records"]:
        if record["indent"] == 4:
            children.append(record)
            continue
        kept = children
        if record["name"] == "edit keys stay in a table action cell while its parse is pending":
            kept = [r for r in children if not re.fullmatch(r"(Meta\+Backspace|Meta\+Delete|Control\+h|Control\+d): (new|existing)", r["name"])]
        elif record["name"] == "document commands leave an undrawn action cell intact and focused":
            kept = [r for r in children if json.loads(r["name"]) != {"key": "o", "ctrlKey": True}]
        removed += len(children) - len(kept)
        lines.append("# Subtest: " + record["name"])
        for number, child in enumerate(kept, 1):
            name = child["name"].replace("Alt+Backspace", "Control+Backspace").replace("Alt+Delete", "Control+Delete")
            lines.extend(["    # Subtest: " + name, f"    ok {number} - " + name])
        if kept:
            lines.append("    1.." + str(len(kept)))
        lines.extend([f"ok {record['number']} - " + record["name"], "  ---", "  duration_ms: 1", "  type: 'test'", "  ..."])
        total += 1 + len(kept)
        children = []
    if removed != 9 or total != ACTUAL["EXPECTED_TESTS"]:
        raise AssertionError("source-platform canned normalization")
    lines.extend(["1..143", f"# tests {total}", "# suites 0", f"# pass {total}", "# fail 0", "# cancelled 0", "# skipped 0", "# todo 0", "# duration_ms 1"])
    result = "\n".join(lines) + "\n"
    parse(result, (143, ACTUAL["EXPECTED_TESTS"]))
    return result


def main(seed_path):
    seed_bytes = seed_path.read_bytes()
    if hashlib.sha256(seed_bytes).hexdigest() != "9d0944126328d10fe5b2e7771b094c57c08da3b1f771a7742bfc9c3dbd7e5f20":
        raise AssertionError("wrong approved full-file seed")
    original_seed = seed_bytes.decode()
    seed = windows_canned_seed(original_seed)
    with tempfile.TemporaryDirectory(prefix="paragraph-width-offline-") as temporary:
        root = Path(temporary)
        for red, result in ((False, "healthy-miss-stop"), (True, "real-red")):
            folder = root / result
            fixture(folder, seed, red)
            report = quality(folder, EXPECTED)
            if report["classification"] != result:
                raise AssertionError(report)
            RESULTS.append("quality-" + result)
        mutations = [
            ("drop", False, lambda f: json_change(f, "widths.json", lambda v: v["receipt"].update(dropped=1))),
            ("fault", False, lambda f: json_change(f, "widths.json", lambda v: v["receipt"].update(faults=1))),
            ("missing", False, lambda f: (f / "widths.json").unlink()),
            ("missing-exit", False, lambda f: (f / "exit.json").unlink()),
            ("partial", False, lambda f: (f / "full-file.tap").write_text(seed.split("1..143")[0])),
            ("darwin-fullcase", False, lambda f: (f / "full-file.tap").write_text(original_seed)),
            ("duplicate-root-plan", False, lambda f: (f / "full-file.tap").write_text(seed.replace("1..143", "1..143\n1..143"))),
            ("wrong-root-plan", False, lambda f: (f / "full-file.tap").write_text(seed.replace("1..143", "1..142"))),
            ("wrong-fullcase-count", False, lambda f: (f / "full-file.tap").write_text(seed.replace("# tests 297", "# tests 296"))),
            ("green-flag-false", False, lambda f: json_change(f, "widths.json", lambda v: v.update(originalPassed=False))),
            ("green-has-error", False, lambda f: json_change(f, "widths.json", lambda v: v.update(originalError={"name": "Error"}))),
            ("red-flag-true", True, lambda f: json_change(f, "widths.json", lambda v: v.update(originalPassed=True))),
            ("red-missing-error", True, lambda f: json_change(f, "widths.json", lambda v: v.update(originalError=None))),
            ("green-exit1", False, lambda f: json_change(f, "exit.json", lambda v: v.update(code=1))),
            ("red-exit0", True, lambda f: json_change(f, "exit.json", lambda v: v.update(code=0))),
            ("missing-file-cap", False, lambda f: json_change(f, "exit.json", lambda v: v.pop("fileLimitMs"))),
            ("missing-import", False, lambda f: json_change(f, "exit.json", lambda v: v.update(command=["node", "--test", ACTUAL["TEST"]]))),
            ("missing-node", False, lambda f: json_change(f, "before.json", lambda v: v["runtime"].pop("node"))),
            ("missing-electron", False, lambda f: json_change(f, "before.json", lambda v: v["runtime"].pop("electron"))),
            ("output-symlink", False, lambda f: json_change(f, "before.json", lambda v: v["output"]["links"].append({"path": "hidden-dir"}))),
            ("output-other", False, lambda f: json_change(f, "before.json", lambda v: v["output"]["other"].append({"path": "fifo"}))),
            ("missing-io-status", False, lambda f: (f / "io-status.json").unlink()),
            ("io-fault", False, lambda f: json_change(f, "io-status.json", lambda v: v["faults"].append({"label": "widths"}))),
            ("io-failure-tap", False, lambda f: (f / "full-file.tap").write_text(seed.replace("# duration_ms ", "# paragraph diagnostic I/O failure widths\n# duration_ms "))),
            ("bad-operator", True, lambda f: (f / "full-file.tap").write_text((f / "full-file.tap").read_text().replace("operator: '=='", "operator: '==='"))),
            ("bad-frame", True, lambda f: json_change(f, "widths.json", lambda v: v["originalError"].update(stack="wrong-file:1:1"))),
        ]
        for label, red, mutate in mutations:
            folder = root / label
            fixture(folder, seed, red)
            mutate(folder)
            report = quality(folder, EXPECTED)
            if report["classification"] != "incomplete":
                raise AssertionError((label, report))
            RESULTS.append("quality-reject-" + label)
        for label, value in [
            ("duplicate-target", seed.replace("1..143", "# Subtest: " + TITLE + "\nok 144 - " + TITLE + "\n1..144")),
            ("duplicate-nested-plan", re.sub(r"(?m)^(    1\.\.\d+)$", r"\1\n\1", seed, count=1)),
            ("wrong-nested-number", re.sub(r"(?m)^    ok 1 - ", "    ok 2 - ", seed, count=1)),
            ("wrong-scope", re.sub(r"(?m)^    # Subtest: ", "   # Subtest: ", seed, count=1)),
        ]:
            try:
                parse(value, (143, ACTUAL["EXPECTED_TESTS"]))
            except ValueError:
                RESULTS.append("parser-reject-" + label)
            else:
                raise AssertionError("parser accepted " + label)
        manifest_root = root / "manifest"
        manifest_root.mkdir()
        (manifest_root / "file").write_bytes(b"ok")
        if ACTUAL["tree_manifest"](manifest_root)["counts"]["files"] != 1:
            raise AssertionError("complete manifest failed")
        (manifest_root / "link").symlink_to(manifest_root, target_is_directory=True)
        manifest = ACTUAL["tree_manifest"](manifest_root)
        if manifest["complete"] or manifest["counts"]["links"] != 1:
            raise AssertionError("symlink directory omitted")
        if hasattr(os, "mkfifo"):
            os.mkfifo(manifest_root / "fifo")
            manifest = ACTUAL["tree_manifest"](manifest_root)
            if manifest["counts"]["other"] != 1:
                raise AssertionError("other entry omitted")
        RESULTS.append("actual-tree-enumeration-types")
        existing = root / "already-preserved"
        existing.mkdir()
        with patch.object(ACTUAL["subprocess"], "check_output", side_effect=AssertionError("existing destination must not fetch")), redirect_stdout(io.StringIO()):
            code = collect(SimpleNamespace(**EXPECTED, destination=str(existing)))
        if code != 2:
            raise AssertionError("existing destination must be incomplete exit2")
        RESULTS.append("collector-existing-destination-exit2")
        collector_case(root, seed, "collector-green")
        collector_case(root, seed, "collector-red", red=True, expected=1)
        RESULTS.extend(["collector-green-exit0", "collector-real-red-exit1"])
        for label, mutate in [
            ("actor", lambda r: r["actions/runs/17/attempts/1"]["actor"].update(id=1)),
            ("triggering-actor", lambda r: r["actions/runs/17/attempts/1"]["triggering_actor"].update(id=1)),
            ("branch", lambda r: r["actions/runs/17/attempts/1"].update(head_branch="main")),
            ("attempt", lambda r: r["actions/runs/17/attempts/1"].update(run_attempt=2)),
            ("job-name", lambda r: r["actions/runs/17/attempts/1/jobs?per_page=100"]["jobs"][0].update(name="wrong")),
            ("job-run", lambda r: r["actions/runs/17/attempts/1/jobs?per_page=100"]["jobs"][0].update(run_id=18)),
            ("job-attempt", lambda r: r["actions/runs/17/attempts/1/jobs?per_page=100"]["jobs"][0].update(run_attempt=2)),
            ("step", lambda r: r["actions/runs/17/attempts/1/jobs?per_page=100"]["jobs"][0]["steps"][0].update(name="wrong")),
            ("step-exit", lambda r: r["actions/runs/17/attempts/1/jobs?per_page=100"]["jobs"][0]["steps"][0].update(conclusion="failure")),
            ("job-exit", lambda r: r["actions/runs/17/attempts/1/jobs?per_page=100"]["jobs"][0].update(conclusion="failure")),
            ("run-exit", lambda r: r["actions/runs/17/attempts/1"].update(conclusion="failure")),
            ("run-zip", lambda r: r.update({"actions/runs/17/attempts/1/logs": b"truncated"})),
            ("raw-mismatch", lambda r: r.update({"actions/jobs/19/logs": b"partial raw"})),
            ("api-zip-digest", lambda r: r["actions/artifacts/23"].update(digest="sha256:bad")),
        ]:
            collector_case(root, seed, "collector-" + label, api_mutation=mutate, expected=2)
            RESULTS.append("collector-reject-" + label + "-exit2")
        for label, red, mutate in mutations[:5] + [m for m in mutations if m[0] in ("green-flag-false", "red-flag-true", "bad-operator")]:
            collector_case(root, seed, "collector-quality-" + label, red=red, file_mutation=mutate, expected=2)
            RESULTS.append("collector-quality-" + label + "-exit2")
        for label in ("drop", "fault"):
            mutate = next(m[2] for m in mutations if m[0] == label)
            collector_case(root, seed, "collector-red-" + label, red=True, file_mutation=mutate, expected=2)
            RESULTS.append("collector-red-" + label + "-incomplete-priority")
    return {"passed": len(RESULTS), "cases": RESULTS, "seedSha256": hashlib.sha256(seed_bytes).hexdigest(),
            "seed": str(seed_path), "actualSourceSha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
            "cannedWindowsSeedSha256": hashlib.sha256(seed.encode()).hexdigest(), "windowsRoots": 143, "windowsTests": 297,
            "limits": "offline canned evidence only; no native journey/build/dispatch/network/process launch"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tap", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(main(args.tap), indent=2))
