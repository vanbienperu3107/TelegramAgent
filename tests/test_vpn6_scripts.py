"""Ba script chay `sudo` tren vpn6 — may giu headscale cua ca fleet.

Chung khong the chay trong CI (can derp-postgres that), nen test o day kiem BAT
BIEN VAN BAN: nhung tinh chat ma neu sai se lam tunnel chet vinh vien, lam AC-21
do 100%, hoac lam control plane mat DB.
"""
import pathlib
import re
import shutil
import subprocess

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
VPN6 = ROOT / "scripts" / "vpn6"

CREATE = VPN6 / "create-opencode-db.sh"
PERMITOPEN = VPN6 / "update-permitopen.sh"
SNAPSHOT = VPN6 / "snapshot-vpn6.sh"
ALL = [CREATE, PERMITOPEN, SNAPSHOT]

bash_only = pytest.mark.skipif(shutil.which("bash") is None, reason="khong co bash")


@pytest.mark.parametrize("path", ALL, ids=lambda p: p.name)
def test_ton_tai_va_co_shebang(path):
    assert path.exists()
    assert path.read_text(encoding="utf-8").startswith("#!/bin/bash")


@pytest.mark.parametrize("path", ALL, ids=lambda p: p.name)
def test_dung_set_euo_pipefail(path):
    """Chay bang sudo tren may giu headscale: mot lenh loi ma script chay tiep la
    khong chap nhan duoc."""
    assert re.search(r"^set -euo pipefail$", path.read_text(encoding="utf-8"), re.M)


@bash_only
@pytest.mark.parametrize("path", ALL, ids=lambda p: p.name)
def test_cu_phap_bash_hop_le(path):
    proc = subprocess.run(["bash", "-n", str(path)], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr


@pytest.mark.parametrize("path", ALL, ids=lambda p: p.name)
def test_khong_nhan_tham_so_tu_ngoai(path):
    """Sudoers whitelist chi cho phep chay dung ba script nay. Neu chung nhan
    tham so thi whitelist khong con y nghia — nguoi goi truyen gi cung duoc."""
    text = path.read_text(encoding="utf-8")
    assert not re.search(r"\$\{?[1-9]\}?", text), "script nhan tham so vi tri"
    assert '"$@"' not in text


# ─── create-opencode-db.sh ───────────────────────────────────────────────────

def test_create_doc_mat_khau_qua_stdin_khong_qua_dong_lenh():
    """Dong lenh hien trong `ps`. Hardcode trong script thi tao ban sao thu hai
    va khong xoay duoc credential."""
    text = CREATE.read_text(encoding="utf-8")
    assert "IFS= read -r PASS" in text
    assert "|| true" in text, "read thieu `|| true` se chet khi stdin khong co newline cuoi"


def test_create_luon_alter_role_password():
    """Idempotent phai theo GIA TRI, khong theo su ton tai. Thieu dieu nay thi doi
    secret xong role van giu mat khau cu -> gateway 28P01, va xoay credential DB
    cua mot repo CONG KHAI thanh bat kha thi."""
    assert "ALTER ROLE opencode PASSWORD" in CREATE.read_text(encoding="utf-8")


def test_create_do_datacl_truoc_khi_doi_quyen():
    """Cau "khong dung quyen cua dich vu nao dang chay" phai co bang chung, va
    bang chung phai lay TRUOC khi doi."""
    text = CREATE.read_text(encoding="utf-8")
    i_do = text.index("datacl")
    i_revoke = text.index("REVOKE TEMP")
    assert i_do < i_revoke, "phai do datacl TRUOC khi REVOKE"


def test_create_siet_du_bon_gioi_han():
    """CONNECT keo theo TEMP, va temp_file_limit mac dinh la KHONG GIOI HAN: mot
    cau CREATE TEMP TABLE AS SELECT generate_series(1,1e10) du lam day dia vpn6
    -> PostgreSQL dung ghi -> HEADSCALE MAT DB."""
    text = CREATE.read_text(encoding="utf-8")
    assert "REVOKE TEMP ON DATABASE derp, headscale FROM PUBLIC" in text
    assert "temp_file_limit" in text
    assert "statement_timeout" in text
    assert "idle_session_timeout" in text


def test_create_connection_limit_du_cho_deploy():
    """Dem consumer that: pool gateway CU 4 (PG_IDLE_TIMEOUT_S=0 nen khong nha) +
    pool gateway MOI 4 + migrate 1 + psql verify 1 = 10. Dat 6 la tu bop co
    deploy bang "too many connections"."""
    m = re.search(r"CONNECTION LIMIT (\d+)", CREATE.read_text(encoding="utf-8"))
    assert m and int(m.group(1)) >= 10


def test_create_idle_session_timeout_du_dai():
    """PG_IDLE_TIMEOUT_S=0 co y giu ket noi am de tranh tra gia bat tay 307 ms.
    Timeout ngan hon nhip dung that cua mot bot ca nhan se giet sach pool, va
    truy van ke tiep ton ~1228 ms -> vuot ngan sach 1000 ms cua AC-18."""
    m = re.search(r"idle_session_timeout = '(\d+)min'", CREATE.read_text(encoding="utf-8"))
    assert m and int(m.group(1)) >= 30


# ─── update-permitopen.sh ────────────────────────────────────────────────────

def test_permitopen_validate_truoc_khi_ghi():
    """Ghi truoc khi validate la hong vinh vien: `docker inspect` tra rong
    (container doi ten, daemon ban) se ghi permitopen=":5432" -> tunnel chet."""
    text = PERMITOPEN.read_text(encoding="utf-8")
    i_validate = text.index("grep -qE '^([0-9]{1,3}")
    i_ghi = text.index('printf \'%s %s\\n\'')
    assert i_validate < i_ghi


def test_permitopen_co_port_forwarding_tuong_minh():
    """`restrict` BAO GOM no-port-forwarding, va `permitopen` chi LOC dich chu
    khong bat lai quyen. Thieu port-forwarding thi tunnel khong bao gio mo — va
    trieu chung giong het loi sai IP hoac sai host key, rat kho truy."""
    text = PERMITOPEN.read_text(encoding="utf-8")
    assert "restrict,port-forwarding,permitopen=" in text


def test_permitopen_loc_theo_ten_mang():
    """`.NetworkSettings.IPAddress` tra rong khi container o mang tuy chinh, va
    `range .Networks` khong loc se lay mang dau tien theo thu tu ngau nhien."""
    text = PERMITOPEN.read_text(encoding="utf-8")
    assert "dashboard-vn_dashnet" in text
    assert "index .NetworkSettings.Networks" in text


def test_permitopen_sao_luu_co_hau_to_ngay():
    """Khong co hau to ngay thi ban tot da bi de mat tu lan chay truoc."""
    assert 'bak-$(date' in PERMITOPEN.read_text(encoding="utf-8")


def test_permitopen_in_dung_mot_dong_dinh_dang_co_dinh():
    text = PERMITOPEN.read_text(encoding="utf-8")
    assert "printf 'PG_REMOTE_HOST=%s\\n'" in text


# ─── snapshot-vpn6.sh ────────────────────────────────────────────────────────

def test_snapshot_khong_chup_truong_bien_thien():
    """Chup truong bien thien la lam `diff` LUON khac rong -> buoc 5b do -> tieu
    chi huy deploy go luon stack vua dung xong. DB derp nhan telemetry ca fleet
    moi 3 giay."""
    text = SNAPSHOT.read_text(encoding="utf-8")
    assert "pg_database_size" not in text
    assert "pg_stat_activity" not in text


def test_snapshot_khong_chup_derp_backend():
    """dashboard-watchtower tu cap nhat derp-backend; mot lan update roi vao cua
    so ~20 phut giua hai lan chup se bao "da dung ha tang" trong khi stack nay
    khong lam gi."""
    text = SNAPSHOT.read_text(encoding="utf-8")
    m = re.search(r"docker inspect[^\n]*", text)
    assert m and "derp-backend" not in m.group(0)


def test_snapshot_chup_datacl_va_rolconfig():
    """Buoc 3 CO Y doi hai thu nay (REVOKE TEMP, ALTER ROLE). Khong chup thi
    AC-21 mu voi dung hanh dong nguy hiem nhat ma deploy thuc hien."""
    text = SNAPSHOT.read_text(encoding="utf-8")
    assert "datacl" in text
    assert "rolconfig" in text


def test_snapshot_loc_bo_tao_tac_cua_du_an_nay():
    """DB va role moi la thay doi HOP LE — de chung trong `diff` thi lan deploy
    dau tien luon do."""
    text = SNAPSHOT.read_text(encoding="utf-8")
    assert "datname <> 'opencode_remote'" in text
    assert "rolname <> 'opencode'" in text
