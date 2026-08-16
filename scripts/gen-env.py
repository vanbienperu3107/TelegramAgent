#!/usr/bin/env python3
"""Sinh HAI file env tren vpn4 tu khuon + bien moi truong. Chay o /opt/opencode.

    python3 scripts/gen-env.py

Ra:
    .env            (chmod 600) — day du, cho telegram-gateway
    .env.opencode   (chmod 600) — DUNG 2 bien, cho opencode-server

Hop dong:
  1. Doc .env.example / .env.opencode.example lam khuon. KHONG liet tay danh sach
     bien: .env co hon 30 bien, liet tay thi sot la chuyen chac chan, va phep kiem
     CI chi so ${VAR:?} nen khong bat duoc phan sot.
  2. Gia tri rong trong khuon -> lay tu bien moi truong cung ten. Thieu -> loi.
  3. Thay moi chuoi giu cho dang __TEN__ ben trong gia tri (vi du DATABASE_URL
     nhung __OPENCODE_PG_PASSWORD__ vao giua chuoi ket noi).
  4. Escape " va \\ theo luat dotenv. KHONG dung toi $: sau khi bo het
     `environment:` khoi compose thi khong con duong noi suy nao, escape $ thanh
     $$ se di thang vao container thanh hai ky tu.
  5. Kiem vong tron: doc lai bang readenv.py, gia tri phai khop nguyen ban.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import readenv  # noqa: E402

TEMPLATES = [(".env.example", ".env"), (".env.opencode.example", ".env.opencode")]


def quote(value):
    """Ghi gia tri theo luat dotenv sao cho readenv.py doc lai dung nguyen ban."""
    if value == "" or any(ch in value for ch in ' \t"\\#\'$'):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return value


def render(template_path, out_path, env):
    lines, values = [], {}
    with open(template_path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.rstrip("\n")
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                lines.append(line)
                continue
            key = stripped.split("=", 1)[0].strip()
            val = stripped.split("=", 1)[1].strip()

            if val == "":
                if key not in env or env[key] == "":
                    raise SystemExit("thieu bien moi truong: %s (can cho %s)" % (key, out_path))
                val = env[key]
            else:
                # Thay chuoi giu cho __TEN__ nam BEN TRONG gia tri.
                while "__" in val:
                    before, _, rest = val.partition("__")
                    name, sep, after = rest.partition("__")
                    if not sep:
                        break
                    if name not in env or env[name] == "":
                        raise SystemExit("thieu bien moi truong: %s (cho giu cho trong %s)" % (name, key))
                    val = before + env[name] + after

            values[key] = val
            lines.append("%s=%s" % (key, quote(val)))

    fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")

    # Kiem vong tron: mot gia tri doc lai khac ban goc nghia la luat escape sai.
    parsed = readenv.parse(out_path)
    for key, want in values.items():
        got = parsed.get(key)
        if got != want:
            raise SystemExit(
                "vong tron hong o %s: %s ghi %r doc lai %r" % (out_path, key, want, got)
            )
    return len(values)


def main():
    env = dict(os.environ)
    for template_path, out_path in TEMPLATES:
        if not os.path.exists(template_path):
            raise SystemExit("khong thay khuon %s (cwd=%s)" % (template_path, os.getcwd()))
        count = render(template_path, out_path, env)
        sys.stderr.write("da ghi %s: %d bien\n" % (out_path, count))
    return 0


if __name__ == "__main__":
    sys.exit(main())
