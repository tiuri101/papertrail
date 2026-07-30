#!/usr/bin/env python3
"""Lightweight structural quality audit for environments without optional linters."""

from __future__ import annotations

import ast
from pathlib import Path

ROOTS = [Path("backend/app"), Path("backend/tests")]
MAX_FUNCTION_LINES = 100
MAX_MODULE_LINES = 350
MAX_LINE_LENGTH = 140


def main() -> int:
    findings: list[str] = []
    fatal: list[str] = []
    modules = 0
    for root in ROOTS:
        for path in root.rglob("*.py"):
            modules += 1
            source = path.read_text(encoding="utf-8")
            lines = source.splitlines()
            try:
                tree = ast.parse(source, filename=str(path))
            except SyntaxError as exc:
                fatal.append(f"{path}: syntax error: {exc}")
                continue
            if len(lines) > MAX_MODULE_LINES:
                findings.append(f"{path}: module has {len(lines)} lines")
            for number, line in enumerate(lines, start=1):
                if len(line) > MAX_LINE_LENGTH:
                    findings.append(
                        f"{path}:{number}: line has {len(line)} characters"
                    )
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    if node.end_lineno is None:
                        continue
                    length = node.end_lineno - node.lineno + 1
                    if length > MAX_FUNCTION_LINES:
                        findings.append(
                            f"{path}:{node.lineno}: {node.name} has {length} lines"
                        )
    print(f"Audited {modules} Python modules.")
    if findings:
        print("Maintainability observations:")
        for finding in findings:
            print(f"- {finding}")
    else:
        print("No configured structural code-smell thresholds were exceeded.")
    if fatal:
        print("Fatal findings:")
        for finding in fatal:
            print(f"- {finding}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
