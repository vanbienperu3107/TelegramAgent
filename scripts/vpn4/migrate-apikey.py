#!/usr/bin/env python3
"""Doi apiKey cua provider.cliproxy trong opencode.json sang dang {file:...}.

    python3 scripts/vpn4/migrate-apikey.py /opt/opencode/opencode.json

Vi sao can mot buoc rieng thay vi doi moi khuon: deploy lay CHINH
/opt/opencode/opencode.json lam khuon khi file do da co khoi `permission` (agent
duoc phep tu sua config global). Nen sua opencode.json.template trong repo
KHONG bao gio toi duoc server — dung cai bay da dinh ngay 2026-09-12 voi khoa
`model`. Buoc nay vietlai truc tiep file dang chay.

Idempotent: chay lai tren file da doi thi khong ghi gi va thoat 0. File chua ton
tai / khong parse duoc cung thoat 0 — deploy se tu sinh lai tu khuon o buoc sau.
"""
import json
import sys

DICH = "{file:/run/secrets/cliproxy-key}"


def migrate(path):
    try:
        with open(path, encoding="utf-8") as fh:
            cfg = json.load(fh)
    except (OSError, ValueError) as err:
        sys.stderr.write("migrate-apikey: bo qua %s (%s)\n" % (path, err))
        return 0

    opts = (((cfg.get("provider") or {}).get("cliproxy") or {}).get("options"))
    if not isinstance(opts, dict):
        sys.stderr.write("migrate-apikey: %s khong co provider.cliproxy.options\n" % path)
        return 0

    cu = opts.get("apiKey")
    if cu == DICH:
        sys.stderr.write("migrate-apikey: %s da dung {file:...}, khong sua\n" % path)
        return 0

    opts["apiKey"] = DICH
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")
    # KHONG in gia tri cu: neu ai do tung viet khoa that vao day thi no se ra log
    # cua GitHub Actions, va log do khong xoa duoc.
    sys.stderr.write("migrate-apikey: %s da doi apiKey sang {file:...}\n" % path)
    return 0


def main(argv):
    if len(argv) < 2:
        sys.stderr.write("dung: migrate-apikey.py <duong-dan-opencode.json>\n")
        return 2
    return migrate(argv[1])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
