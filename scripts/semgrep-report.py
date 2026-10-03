#!/usr/bin/env python3
"""Summarise a Semgrep JSON report for the job summary and the PR comment.

Run by .github/workflows/semgrep.yml after `semgrep scan --json-output`.
Counts the findings by severity and lists them, the ones in the files the PR
touches first. Writes `error`, `warning`, `info` and `total` to
$GITHUB_OUTPUT so the workflow can decide whether to fail; this script
itself always exits 0 unless the report is missing.

Environment: REPORT (semgrep JSON, default semgrep.json), OUT (markdown,
default semgrep-report.md), CHANGED_FILES (optional: a file with one
repo-relative path per line), GITHUB_REPOSITORY, GITHUB_SHA, FAIL_ON
(text for the footer: the severity that fails the job, or empty).
"""

import json
import os
from collections import Counter

REPORT = os.environ.get("REPORT", "semgrep.json")
OUT = os.environ.get("OUT", "semgrep-report.md")
CHANGED = os.environ.get("CHANGED_FILES", "")
REPO = os.environ.get("GITHUB_REPOSITORY", "")
SHA = os.environ.get("REPORT_SHA") or os.environ.get("GITHUB_SHA", "")
FAIL_ON = os.environ.get("FAIL_ON", "")
MARKER = "<!-- semgrep-report -->"
MAX_ROWS = 50
ORDER = {"ERROR": 0, "WARNING": 1, "INFO": 2}
ICON = {"ERROR": "🔴", "WARNING": "🟠", "INFO": "🔵"}
# Newer rules use CRITICAL/HIGH/MEDIUM/LOW; fold them into the classic three.
LEVEL = {"CRITICAL": "ERROR", "HIGH": "ERROR", "MEDIUM": "WARNING", "LOW": "INFO"}


def level(r):
    sev = r["extra"].get("severity", "INFO").upper()
    return LEVEL.get(sev, sev if sev in ORDER else "INFO")


def link(path, line):
    if REPO and SHA:
        return f"[`{path}:{line}`](https://github.com/{REPO}/blob/{SHA}/{path}#L{line})"
    return f"`{path}:{line}`"


def row(r):
    sev = level(r)
    rule = r["check_id"].rsplit(".", 1)[-1]
    msg = " ".join(r["extra"].get("message", "").split())
    if len(msg) > 140:
        msg = msg[:137] + "..."
    msg = msg.replace("|", "\\|")
    return f"| {ICON.get(sev, '')} {sev} | `{rule}` | {link(r['path'], r['start']['line'])} | {msg} |"


def table(results):
    lines = ["| Severity | Rule | Where | Message |", "|---|---|---|---|"]
    lines += [row(r) for r in results[:MAX_ROWS]]
    if len(results) > MAX_ROWS:
        lines.append(f"\n…and {len(results) - MAX_ROWS} more (see the code scanning tab).")
    return lines


def main():
    with open(REPORT, encoding="utf-8") as f:
        data = json.load(f)
    results = sorted(
        data.get("results", []),
        key=lambda r: (ORDER[level(r)], r["path"], r["start"]["line"]),
    )
    counts = Counter(level(r) for r in results)
    errors = [e for e in data.get("errors", []) if e.get("level") == "error"]

    out = [MARKER, "## Semgrep (Community Edition)", ""]
    out.append(
        f"**{len(results)}** findings: "
        + ", ".join(f"{ICON[s]} {counts.get(s, 0)} {s.lower()}" for s in ("ERROR", "WARNING", "INFO"))
    )
    out.append("")

    if CHANGED and os.path.exists(CHANGED):
        with open(CHANGED, encoding="utf-8") as f:
            changed = {l.strip() for l in f if l.strip()}
        mine = [r for r in results if r["path"] in changed]
        out.append(f"### In the files this PR touches ({len(mine)})")
        out.append("")
        out += table(mine) if mine else ["None. 🎉"]
        out.append("")
        rest = [r for r in results if r["path"] not in changed]
        if rest:
            out += [f"<details><summary>Elsewhere in the repo ({len(rest)})</summary>", ""]
            out += table(rest)
            out += ["", "</details>", ""]
    elif results:
        out += table(results) + [""]

    if errors:
        out.append(f"⚠️ Semgrep reported {len(errors)} scan errors (files it could not parse); see the job log.")
        out.append("")
    gate = f"fails on {FAIL_ON} findings" if FAIL_ON else "advisory, it does not fail the PR"
    out.append(
        f"<sub>Rulesets: p/default, p/golang, p/typescript, p/react, p/secrets, p/owasp-top-ten, "
        f"p/dockerfile, p/kubernetes, p/github-actions. This check {gate}. A false positive gets "
        f"`// nosemgrep: <rule-id>` with a one-line reason; generated code is in .semgrepignore.</sub>"
    )

    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")

    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        with open(gh_out, "a", encoding="utf-8") as f:
            f.write(f"error={counts.get('ERROR', 0)}\n")
            f.write(f"warning={counts.get('WARNING', 0)}\n")
            f.write(f"info={counts.get('INFO', 0)}\n")
            f.write(f"total={len(results)}\n")
    print(f"semgrep: {len(results)} findings {dict(counts)}")


if __name__ == "__main__":
    main()
