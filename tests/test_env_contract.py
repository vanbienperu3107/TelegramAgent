"""Hop dong sinh/doc file env — ban thi hanh cua Telegram.md §6, §6.2, §37.2.

Lop loi ma cac test nay chan, ca ba deu tung xay ra that trong dac ta:
  - gia tri co ky tu dac biet bi bien dang giua luc ghi va luc doc
  - chuoi giu cho __TEN__ nam GIUA mot gia tri khong duoc thay
  - .env.opencode chua nhieu hon 2 bien, tuc do secret vao container agent
"""
import os
import pathlib
import subprocess
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

import readenv  # noqa: E402

# Bi mat that co the chua bat ky ky tu nao: CLIPROXY_API_KEY den tu repo khac,
# ta khong duoc chon bo ky tu cua no.
TRICKY = [
    "don-gian-123",
    "co $ o giua",
    "$bat-dau-bang-dola",
    'co "nhay kep"',
    "co 'nhay don'",
    "co\\dau-cheo-nguoc",
    "co khoang trang",
    "co#thang#dau",
    "ket-thuc-bang-dola$",
]


def _gen(tmp_path, env_extra):
    """Chay gen-env.py trong mot thu muc tam co day du khuon."""
    for name in (".env.example", ".env.opencode.example"):
        (tmp_path / name).write_text((ROOT / name).read_text(encoding="utf-8"), encoding="utf-8")
    env = dict(os.environ)
    env.update(env_extra)
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "gen-env.py")],
        cwd=tmp_path, env=env, capture_output=True, text=True,
    )
    return proc


def _base_env():
    """Gia tri toi thieu cho moi bien de trong trong hai khuon."""
    out = {}
    for name in (".env.example", ".env.opencode.example"):
        for line in (ROOT / name).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and line.endswith("="):
                out[line[:-1]] = "gia-tri-mac-dinh"
    return out


@pytest.mark.parametrize("value", TRICKY)
def test_gia_tri_di_qua_vong_tron_nguyen_ven(tmp_path, value):
    """Ghi bang gen-env.py roi doc lai bang readenv.py phai ra dung ban goc.
    gen-env.py tu kiem vong tron nen sai la no exit khac 0."""
    env = _base_env()
    env["CLIPROXY_API_KEY"] = value
    proc = _gen(tmp_path, env)
    assert proc.returncode == 0, proc.stderr
    assert readenv.parse(tmp_path / ".env")["CLIPROXY_API_KEY"] == value
    assert readenv.parse(tmp_path / ".env.opencode")["CLIPROXY_API_KEY"] == value


def test_cho_giu_cho_trong_gia_tri_duoc_thay(tmp_path):
    """DATABASE_URL nhung __OPENCODE_PG_PASSWORD__ vao GIUA chuoi ket noi. Thay
    theo tung khoa la khong du. Bo sot thi Gateway ket noi bang mat khau
    literal '__OPENCODE_PG_PASSWORD__' -> loi 28P01, trong khi buoc verify dung
    PGPASSWORD rieng nen VAN XANH: deploy xanh, bot chet."""
    env = _base_env()
    env["OPENCODE_PG_PASSWORD"] = "mat-khau-that"
    proc = _gen(tmp_path, env)
    assert proc.returncode == 0, proc.stderr
    url = readenv.parse(tmp_path / ".env")["DATABASE_URL"]
    assert "mat-khau-that" in url
    assert "__" not in url


def test_khong_con_cho_giu_cho_nao_trong_file_sinh_ra(tmp_path):
    proc = _gen(tmp_path, _base_env())
    assert proc.returncode == 0, proc.stderr
    for name in (".env", ".env.opencode"):
        for key, val in readenv.parse(tmp_path / name).items():
            assert "__" not in val, "%s con cho giu cho: %s=%s" % (name, key, val)


def test_moi_bien_trong_khuon_deu_co_mat_trong_file_sinh_ra(tmp_path):
    """Hop dong la 'doc khuon', khong phai 'liet tay danh sach bien' — .env co
    hon 30 bien, liet tay thi sot la chuyen chac chan."""
    proc = _gen(tmp_path, _base_env())
    assert proc.returncode == 0, proc.stderr
    for tpl, out in ((".env.example", ".env"), (".env.opencode.example", ".env.opencode")):
        want = {
            line.split("=", 1)[0].strip()
            for line in (ROOT / tpl).read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.strip().startswith("#") and "=" in line
        }
        assert want <= set(readenv.parse(tmp_path / out))


def test_env_opencode_chi_co_dung_hai_bien(tmp_path):
    """Bat bien an ninh, khong phai quy uoc: moi bien thua o day la mot bi mat
    ma agent doc duoc qua /proc/self/environ."""
    proc = _gen(tmp_path, _base_env())
    assert proc.returncode == 0, proc.stderr
    assert set(readenv.parse(tmp_path / ".env.opencode")) == {
        "CLIPROXY_API_KEY",
        "OPENCODE_SERVER_PASSWORD",
    }


def test_env_opencode_khong_chua_bi_mat_cua_gateway(tmp_path):
    proc = _gen(tmp_path, _base_env())
    assert proc.returncode == 0, proc.stderr
    got = set(readenv.parse(tmp_path / ".env.opencode"))
    for cam in ("TELEGRAM_BOT_TOKEN", "DATABASE_URL", "OPENCODE_PG_PASSWORD"):
        assert cam not in got


def test_thieu_bien_moi_truong_thi_bao_loi_som(tmp_path):
    """Fail-fast tren runner re hon nhieu so voi hong o giua buoc 4, sau khi da
    doi trang thai vpn6."""
    env = _base_env()
    del env["TELEGRAM_BOT_TOKEN"]
    proc = _gen(tmp_path, env)
    assert proc.returncode != 0
    assert "TELEGRAM_BOT_TOKEN" in proc.stderr


def test_file_sinh_ra_chi_chu_so_huu_doc_duoc(tmp_path):
    """.env chua token bot va mat khau DB. cp tran dung umask -> 644."""
    if os.name == "nt":
        pytest.skip("quyen POSIX khong co y nghia tren Windows")
    proc = _gen(tmp_path, _base_env())
    assert proc.returncode == 0, proc.stderr
    for name in (".env", ".env.opencode"):
        assert oct((tmp_path / name).stat().st_mode & 0o777) == "0o600"
