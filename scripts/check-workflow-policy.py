#!/usr/bin/env python3
"""Luat trigger workflow cho mot repo PUBLIC giu khoa root cua may ha tang.

    python3 scripts/check-workflow-policy.py

Boi canh: secret cua repo nay gom SSH_KEY (= root tren vpn4, may chay DERP relay
cua ca fleet), PG_TUNNEL_KEY_B64, va TELEGRAM_BOT_TOKEN. Mot workflow chay ma
cua PR den tu fork VOI secret day du la du de mat tat ca.

Hai luat:
  1. Cam `pull_request_target` tuyet doi.
  2. Workflow co trigger `pull_request` khong duoc tham chieu `secrets.*`
     (ngoai `secrets.GITHUB_TOKEN` do runner cap, khong phai cua ta).
"""
import pathlib
import re
import sys

import yaml

WORKFLOWS = pathlib.Path(__file__).resolve().parent.parent / ".github" / "workflows"
SECRET_REF = re.compile(r"secrets\.([A-Z_][A-Z0-9_]*)")


def triggers(doc):
    """Lay danh sach trigger. Chu y: YAML doc `on:` khong nhay thanh True."""
    raw = doc.get("on", doc.get(True))
    if isinstance(raw, str):
        return {raw}
    if isinstance(raw, list):
        return set(raw)
    if isinstance(raw, dict):
        return set(raw)
    return set()


def main():
    loi = []
    for path in sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml")):
        text = path.read_text(encoding="utf-8")
        doc = yaml.safe_load(text) or {}
        names = triggers(doc)

        if "pull_request_target" in names:
            loi.append("%s: dung pull_request_target" % path.name)

        if "pull_request" in names:
            dung = {m for m in SECRET_REF.findall(text) if m != "GITHUB_TOKEN"}
            if dung:
                loi.append(
                    "%s: co trigger pull_request nhung dung secret %s"
                    % (path.name, ", ".join(sorted(dung)))
                )

        if not names:
            loi.append("%s: khong khai `on:` tuong minh" % path.name)

    if loi:
        for dong in loi:
            sys.stderr.write("::error::%s\n" % dong)
        return 1

    sys.stderr.write("OK: %d workflow tuan thu luat trigger\n" % len(list(WORKFLOWS.glob("*.y*ml"))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
