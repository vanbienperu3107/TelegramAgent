#!/usr/bin/env python3
"""Kiem mot file la tieng Viet UTF-8 nguyen ven, khong phai mojibake.

    python3 scripts/check-utf8.py /tmp/smoke.txt

Vi sao khong dung grep — hai ly do, ca hai deu tung lam phep kiem nay vo hieu:

  (a) `grep -qv MAU` dao theo TUNG DONG. No tra 0 khi co it nhat mot dong khong
      khop, nen output nhieu dong (banner + noi dung) chi can mot dong sach la qua
      du cac dong khac toan mojibake. "Ca file khong chua" phai la `! grep -q`.

  (b) Shell cua ssh-action khong dat LANG -> locale C -> bracket expression hieu
      theo BYTE. Ky tu "a-huyen" la C3 A0 con mojibake "A-tilde" la C3 83: chung
      byte dau. Lop ky tu tieng Viet vi vay khop luon ca file mojibake thuan.

Script nay lam o tang KY TU: decode utf-8 strict, roi khang dinh tren codepoint.
"""
import sys
import unicodedata

# Dau hieu mojibake: byte UTF-8 bi doc nham thanh Latin-1 roi ma hoa lai.
MOJIBAKE = ("Ã", "â", "Â")


def check(path):
    with open(path, "rb") as fh:
        raw = fh.read()

    if not raw.strip():
        return "file rong"

    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        return "khong phai UTF-8 hop le: %s" % exc

    if any(marker in text for marker in MOJIBAKE):
        return "co dau hieu mojibake (UTF-8 bi decode nham Latin-1 roi ma hoa lai)"

    # Chu Viet co dau: ky tu ngoai ASCII thuoc bang chu cai Latin.
    has_vietnamese = any(
        ord(ch) > 127 and unicodedata.category(ch) in ("Ll", "Lu") for ch in text
    )
    if not has_vietnamese:
        return "khong tim thay ky tu tieng Viet co dau — model co the tra loi khong dau"

    return None


def main(argv):
    if len(argv) != 2:
        sys.stderr.write("dung: check-utf8.py <file>\n")
        return 2
    problem = check(argv[1])
    if problem:
        sys.stderr.write("check-utf8: %s\n" % problem)
        return 1
    sys.stderr.write("check-utf8: OK\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
