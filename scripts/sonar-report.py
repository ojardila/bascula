#!/usr/bin/env python3
"""Summarise a SonarQube analysis for the job summary and the PR comment.

Run by .github/workflows/sonarqube.yml right after the scanner. Waits for the
Compute Engine to finish the report the scanner uploaded, then asks the Web
API for the quality gate of *that* analysis and the project's measures.

Community Build has no PR analysis, so a PR is scanned into the scratch
project `bascula-pr` and compared here against `bascula` (master): measure
deltas, and the open issues in the files the PR touches that master does not
have. It is advisory: this script always exits 0 unless the API is
unreachable, and the workflow does not gate on it either.

Environment: SONAR_HOST_URL, SONAR_TOKEN, SONAR_PROJECT (analysed key),
SONAR_BASE_PROJECT (PR mode only: the master project), CHANGED_FILES (PR mode
only: path to a file with one repo-relative path per line), OUT (markdown).
"""

import base64
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter

HOST = os.environ["SONAR_HOST_URL"].rstrip("/")
TOKEN = os.environ["SONAR_TOKEN"]
PROJECT = os.environ["SONAR_PROJECT"]
BASE = os.environ.get("SONAR_BASE_PROJECT", "")
CHANGED = os.environ.get("CHANGED_FILES", "")
OUT = os.environ.get("OUT", "sonar-report.md")
TASK_FILE = os.environ.get("REPORT_TASK", ".scannerwork/report-task.txt")

AUTH = "Basic " + base64.b64encode(f"{TOKEN}:".encode()).decode()

METRICS = [
    ("bugs", "Bugs"),
    ("vulnerabilities", "Vulnerabilities"),
    ("security_hotspots", "Security hotspots"),
    ("code_smells", "Code smells"),
    ("coverage", "Coverage %"),
    ("duplicated_lines_density", "Duplication %"),
    ("ncloc", "Lines of code"),
]
# A rise in these is a regression; for coverage a fall is.
WORSE_IF_UP = {"bugs", "vulnerabilities", "security_hotspots"}
GATE_ICON = {"OK": "✅ Passed", "ERROR": "❌ Failed", "WARN": "⚠️ Warning", "NONE": "➖ None"}


def api(path, **params):
    url = f"{HOST}/api/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": AUTH})
    # The URL is SONAR_HOST_URL (a repo secret, https) plus a fixed API path; nothing user-controlled.
    # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def report_task():
    props = {}
    with open(TASK_FILE) as f:
        for line in f:
            if "=" in line:
                k, v = line.rstrip("\n").split("=", 1)
                props[k] = v
    return props["ceTaskId"]


def wait_for_analysis(task_id, timeout=600):
    deadline = time.time() + timeout
    while True:
        task = api("ce/task", id=task_id)["task"]
        if task["status"] in ("SUCCESS", "FAILED", "CANCELED"):
            return task
        if time.time() > deadline:
            raise SystemExit(f"Compute Engine task {task_id} still {task['status']} after {timeout}s")
        time.sleep(3)


def measures(project):
    comp = api("measures/component", component=project, metricKeys=",".join(k for k, _ in METRICS))
    return {m["metric"]: m.get("value") for m in comp["component"].get("measures", [])}


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def fmt(v):
    n = num(v)
    if n is None:
        return "–"
    return f"{n:.1f}" if n != int(n) else f"{int(n)}"


def issues(project, paths):
    """Open issues in the given files, as (rule, path, message) tuples."""
    found = []
    paths = list(paths)
    for i in range(0, len(paths), 40):
        keys = ",".join(f"{project}:{p}" for p in paths[i:i + 40])
        page = 1
        while True:
            res = api("issues/search", components=keys, resolved="false", ps=500, p=page)
            for it in res["issues"]:
                path = it["component"].split(":", 1)[1]
                found.append((it["rule"], path, it.get("message", ""), it.get("line"),
                              it.get("severity", ""), it.get("type", "")))
            if page * 500 >= res["paging"]["total"]:
                break
            page += 1
    return found


def main():
    task = wait_for_analysis(report_task())
    dash = f"{HOST}/dashboard?id={urllib.parse.quote(PROJECT)}"
    lines = ["<!-- sonarqube-report -->", "### SonarQube"]

    if task["status"] != "SUCCESS":
        lines.append(f"Analysis **{task['status']}** on the server ({task.get('errorMessage', 'no message')}).")
        write(lines)
        return

    gate = api("qualitygates/project_status", analysisId=task["analysisId"])["projectStatus"]
    status = gate.get("status", "NONE")
    cur = measures(PROJECT)
    latest = api("project_analyses/search", project=PROJECT, ps=1)["analyses"]
    raced = bool(latest) and latest[0]["key"] != task["analysisId"]

    if not BASE:
        lines.append(f"Quality gate: **{GATE_ICON.get(status, status)}** · [dashboard]({dash})")
        lines.append("")
        lines.append("| Metric | Value |")
        lines.append("|:--|--:|")
        for k, label in METRICS:
            lines.append(f"| {label} | {fmt(cur.get(k))} |")
        failed = [c for c in gate.get("conditions", []) if c.get("status") == "ERROR"]
        if failed:
            lines.append("")
            lines.append("Failing conditions: " + ", ".join(
                f"`{c['metricKey']}` {c.get('actualValue')} (threshold {c.get('errorThreshold')})" for c in failed))
        write(lines)
        print(f"quality gate: {status}")
        return

    base = measures(BASE)
    regressions = []
    rows = []
    for k, label in METRICS:
        a, b = num(cur.get(k)), num(base.get(k))
        delta = ""
        if a is not None and b is not None and a != b:
            d = a - b
            delta = f"{d:+.1f}" if k in ("coverage", "duplicated_lines_density") else f"{int(d):+d}"
            if (k in WORSE_IF_UP and d > 0) or (k == "coverage" and d < -1.0):
                regressions.append(label)
                delta += " ⚠️"
        rows.append(f"| {label} | {fmt(base.get(k))} | {fmt(cur.get(k))} | {delta} |")

    new_issues = []
    if CHANGED and os.path.exists(CHANGED):
        with open(CHANGED) as f:
            paths = [p.strip() for p in f if p.strip()]
        if paths:
            pr_issues = issues(PROJECT, paths)
            seen = Counter((r, p, m) for r, p, m, *_ in issues(BASE, paths))
            for it in pr_issues:
                key = it[:3]
                if seen[key] > 0:
                    seen[key] -= 1
                else:
                    new_issues.append(it)

    verdict = "⚠️ Worse than master: " + ", ".join(regressions) if regressions else "✅ No regression against master"
    lines.append(f"**{verdict}** · advisory, does not block the PR")
    lines.append("")
    lines.append(f"Quality gate on this PR's code (`{PROJECT}`): **{GATE_ICON.get(status, status)}** · "
                 f"[PR scan]({dash}) · [master]({HOST}/dashboard?id={urllib.parse.quote(BASE)})")
    lines.append("")
    lines.append("| Metric | master | this PR | Δ |")
    lines.append("|:--|--:|--:|--:|")
    lines.extend(rows)
    lines.append("")
    if new_issues:
        lines.append(f"<details><summary>{len(new_issues)} issue(s) in changed files that master does not have</summary>")
        lines.append("")
        for rule, path, msg, line, sev, typ in new_issues[:25]:
            loc = f"{path}:{line}" if line else path
            lines.append(f"- `{loc}` {typ.replace('_', ' ').lower()} ({sev.lower()}): {msg} `{rule}`")
        if len(new_issues) > 25:
            lines.append(f"- … and {len(new_issues) - 25} more in the PR scan")
        lines.append("")
        lines.append("</details>")
    else:
        lines.append("No issues in the changed files that master does not already have.")
    if raced:
        lines.append("")
        lines.append("> [!NOTE]\n> Another scan reached the scratch project before this summary was written: the "
                     "measures and issues above may be that scan's. Re-run the job for this PR's own numbers.")
    lines.append("")
    lines.append("<sub>Community Build has no PR analysis: this PR was scanned into the scratch project "
                 "and compared with master's last analysis. sonarqube.int.engp.io is tailnet only.</sub>")
    write(lines)
    print(f"quality gate: {status}; regressions: {regressions or 'none'}; new issues: {len(new_issues)}")


def write(lines):
    with open(OUT, "w") as f:
        f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 - report, never block the PR
        write(["<!-- sonarqube-report -->", "### SonarQube",
               f"Could not read the analysis back from SonarQube: `{type(e).__name__}: {e}`"])
        print(f"::warning::sonar report failed: {e}", file=sys.stderr)
