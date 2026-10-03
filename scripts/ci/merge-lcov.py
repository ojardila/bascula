#!/usr/bin/env python3
"""Merge LCOV files into one, summing hits per line, function and branch.

    merge-lcov.py OUT IN [IN ...]

The SonarQube workflow runs the console's tests in shards (vitest --shard),
each with its own coverage report. A file that two shards load appears in
both; its merged report is the sum, the same figure one run over every test
file would have written. Missing inputs are skipped (a shard that failed
before writing coverage must not cost the others theirs).
"""

import sys
from collections import defaultdict
from pathlib import Path


def merge(paths):
    lines = defaultdict(lambda: defaultdict(int))  # SF -> line -> hits
    fns = defaultdict(dict)  # SF -> name -> first line
    fnhits = defaultdict(lambda: defaultdict(int))  # SF -> name -> hits
    branches = defaultdict(dict)  # SF -> (line, block, branch) -> hits or None
    for path in paths:
        p = Path(path)
        if not p.is_file():
            print(f"skipping missing {path}", file=sys.stderr)
            continue
        sf = None
        for raw in p.read_text().splitlines():
            tag, _, val = raw.partition(":")
            if tag == "SF":
                sf = val
                lines[sf]  # a file with nothing executable still counts
            elif tag == "end_of_record":
                sf = None
            elif sf is None:
                continue
            elif tag == "DA":
                ln, hits = val.split(",")[:2]
                lines[sf][int(ln)] += int(hits)
            elif tag == "FN":
                ln, name = val.split(",", 1)
                fns[sf].setdefault(name, int(ln))
            elif tag == "FNDA":
                hits, name = val.split(",", 1)
                fnhits[sf][name] += int(hits)
            elif tag == "BRDA":
                ln, block, branch, hits = val.split(",")
                key = (int(ln), block, branch)
                old = branches[sf].get(key)
                new = None if hits == "-" else int(hits)
                if old is None:
                    branches[sf][key] = new
                elif new is not None:
                    branches[sf][key] = old + new
    out = []
    for sf in sorted(lines):
        out.append("TN:")
        out.append(f"SF:{sf}")
        for name, ln in sorted(fns[sf].items(), key=lambda kv: kv[1]):
            out.append(f"FN:{ln},{name}")
        for name in fns[sf]:
            out.append(f"FNDA:{fnhits[sf].get(name, 0)},{name}")
        out.append(f"FNF:{len(fns[sf])}")
        out.append(f"FNH:{sum(1 for n in fns[sf] if fnhits[sf].get(n, 0) > 0)}")
        for (ln, block, branch), hits in sorted(branches[sf].items(), key=lambda kv: (kv[0][0], kv[0][1], kv[0][2])):
            out.append(f"BRDA:{ln},{block},{branch},{'-' if hits is None else hits}")
        out.append(f"BRF:{len(branches[sf])}")
        out.append(f"BRH:{sum(1 for h in branches[sf].values() if h)}")
        for ln in sorted(lines[sf]):
            out.append(f"DA:{ln},{lines[sf][ln]}")
        out.append(f"LF:{len(lines[sf])}")
        out.append(f"LH:{sum(1 for h in lines[sf].values() if h > 0)}")
        out.append("end_of_record")
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    Path(sys.argv[1]).write_text(merge(sys.argv[2:]))
