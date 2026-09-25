#!/usr/bin/env python3
"""Rewrite targetRevision and Harbor image tags in a gitops Application or
ApplicationSet (whose source sits deeper, under spec.template.spec)."""
import os
import re
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(f"usage: {sys.argv[0]} <application.yaml> <vX.Y.Z>")
    path = Path(sys.argv[1])
    v = sys.argv[2]
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", v):
        sys.exit(f"version must look like v1.2.3, got {v!r}")
    s = path.read_text()
    s, n = re.subn(r"(?m)^( +targetRevision:\s*).+$", r"\g<1>" + v, s, count=1)
    if n != 1:
        sys.exit(f"{path}: expected 1 targetRevision line, got {n}")
    s, n = re.subn(
        r"harbor\.int\.engp\.io/bascula/(api|web):v[0-9]+\.[0-9]+\.[0-9]+",
        rf"harbor.int.engp.io/bascula/\1:{v}",
        s,
    )
    if n != 2:
        sys.exit(f"{path}: expected 2 image pins, got {n}")
    path.write_text(s)


if __name__ == "__main__":
    main()
