"""check-utf8.py phai bat duoc mojibake — thu ma `grep` KHONG lam duoc.

Bon vong review truoc, cong chong mojibake cua smoke test deu vo hieu:
  - `grep -qv MAU` dao theo tung dong, nen output nhieu dong chi can mot dong
    sach la qua du cac dong khac hong;
  - locale C so theo byte, ma "a-huyen" (C3 A0) va mojibake "A-tilde" (C3 83)
    chung byte dau, nen lop ky tu tieng Viet khop luon file mojibake thuan.

Cac test duoi day chinh la bang chung rang ban thay the lam dung viec.
"""
import pathlib
import subprocess
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "check-utf8.py"


def run(tmp_path, raw_bytes):
    target = tmp_path / "out.txt"
    target.write_bytes(raw_bytes)
    return subprocess.run(
        [sys.executable, str(SCRIPT), str(target)], capture_output=True, text=True
    ).returncode


def test_tieng_viet_dung_thi_qua(tmp_path):
    assert run(tmp_path, "Hôm nay trời nắng đẹp.".encode("utf-8")) == 0


def test_nhieu_dong_van_qua(tmp_path):
    body = "banner dong dau\n\nTrời hôm nay rất đẹp.\n"
    assert run(tmp_path, body.encode("utf-8")) == 0


def test_mojibake_bi_bat(tmp_path):
    """UTF-8 bi doc nham thanh Latin-1 roi ma hoa lai — dung trieu chung su co
    2026-08-02 (OpenCode Desktop gui body 57 MB toan mojibake)."""
    hong = "Trời hôm nay đẹp".encode("utf-8").decode("latin-1").encode("utf-8")
    assert run(tmp_path, hong) != 0


def test_mojibake_lan_giua_dong_sach_van_bi_bat(tmp_path):
    """Day la ca ma `grep -qv` bo sot: co dong sach nen no tra 0."""
    sach = b"dong dau hoan toan sach\n"
    hong = "Trời đẹp".encode("utf-8").decode("latin-1").encode("utf-8")
    assert run(tmp_path, sach + hong) != 0


def test_file_rong_bi_bat(tmp_path):
    assert run(tmp_path, b"") != 0
    assert run(tmp_path, b"   \n\n") != 0


def test_khong_dau_bi_bat(tmp_path):
    """Model tra loi khong dau nghia la co gi do trong duong truyen lam mat dau."""
    assert run(tmp_path, b"Hom nay troi nang dep.\n") != 0


def test_byte_khong_phai_utf8_bi_bat(tmp_path):
    assert run(tmp_path, b"\xff\xfe khong phai utf-8") != 0


@pytest.mark.parametrize("thieu_tham_so", [[], ["a", "b"]])
def test_sai_tham_so_thi_bao_loi(thieu_tham_so):
    proc = subprocess.run(
        [sys.executable, str(SCRIPT)] + thieu_tham_so, capture_output=True, text=True
    )
    assert proc.returncode == 2
