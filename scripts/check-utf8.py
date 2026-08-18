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


def la_mojibake(text):
    """Phep thu VONG TRON, khong phai danh sach dau hieu.

    Mojibake = byte UTF-8 bi doc nham thanh Latin-1 roi ma hoa lai. Vay neu ma
    hoa nguoc chuoi ve Latin-1 roi giai ma bang UTF-8 MA THANH CONG, thi chuoi
    dang xet von la UTF-8 bi hong.

    Truoc day cho nay dung mot danh sach dau hieu co dinh, va CI bat duoc ngay
    lan chay dau tien: chuoi "Troi dep" (co dau) khi hong khong sinh ra ky tu
    nao trong danh sach do nen mojibake lot qua. Danh sach dau hieu luon thieu
    mot truong hop nao do; phep thu vong tron thi khong.
    """
    try:
        khoi_phuc = text.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return False
    return khoi_phuc != text


def check(path):
    with open(path, "rb") as fh:
        raw = fh.read()

    if not raw.strip():
        return "file rong"

    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        return "khong phai UTF-8 hop le: %s" % exc

    if la_mojibake(text):
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
