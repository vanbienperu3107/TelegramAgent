"""snapshot-vpn4.sh — anh chup de chung minh AC-21.

Su co that da sinh ra script nay: deploy.yml tu viet lenh `docker inspect` voi
DANH SACH CUNG 8 container. Giua hai lan deploy, `ts-vpn4` bi go khoi vpn4, va
`docker inspect` tra "no such object" lam deploy do ngay buoc dau. Ha tang co
doi; phep kiem phai chiu duoc dieu do.
"""
import pathlib
import re
import shutil
import subprocess
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from helpers import bo_comment_shell  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
SNAPSHOT = ROOT / "scripts" / "vpn4" / "snapshot-vpn4.sh"
DEPLOY = ROOT / ".github" / "workflows" / "deploy.yml"

STACK = ("opencode-gateway", "opencode-server", "opencode-pg-tunnel")


def test_ton_tai_va_co_shebang():
    assert SNAPSHOT.exists()
    assert SNAPSHOT.read_text(encoding="utf-8").startswith("#!/bin/bash")


def test_dung_set_euo_pipefail():
    assert re.search(r"^set -euo pipefail$", SNAPSHOT.read_text(encoding="utf-8"), re.M)


@pytest.mark.skipif(shutil.which("bash") is None, reason="khong co bash")
def test_cu_phap_hop_le():
    proc = subprocess.run(["bash", "-n", str(SNAPSHOT)], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr


def test_khong_dung_danh_sach_container_cung():
    """Day la bat bien chinh. Danh sach cung bien mot thay doi vo hai cua nguoi
    khac — go mot container khong lien quan — thanh su co cua minh."""
    text = bo_comment_shell(SNAPSHOT.read_text(encoding="utf-8"))
    for ten in ("derper", "edge-nginx", "caddy-edge", "cliproxy", "vpn-gw", "ts-vpn4"):
        assert ten not in text, "script liet cung ten container: %s" % ten


def test_loai_tru_dung_ba_container_cua_stack_nay():
    """Ba container nay MOI xuat hien o lan deploy dau, nen de trong anh chup se
    lam `diff` khac rong mot cach hop le nhung vo ich."""
    text = SNAPSHOT.read_text(encoding="utf-8")
    for ten in STACK:
        assert ten in text, "thieu loai tru cho %s" % ten


def test_co_sap_xep_de_thu_tu_on_dinh():
    """`docker ps` khong bao dam thu tu. Khong sap xep thi `diff` khac rong chi vi
    thu tu doi, va AC-21 bao dong gia."""
    assert re.search(r"\bsort\b", bo_comment_shell(SNAPSHOT.read_text(encoding="utf-8")))


def test_deploy_khong_con_lenh_inspect_tho():
    """Mot ban dinh nghia duy nhat cho chuoi format. Truoc day bon cho tu viet
    lay, va co lan buoc chup dung 3 truong con step do nguong dung 2, khien
    `diff` luon khac rong va MOI lan deploy deu tu go stack vua dung xong."""
    assert "docker inspect -f" not in bo_comment_shell(DEPLOY.read_text(encoding="utf-8"))


def test_deploy_goi_script_o_du_bon_cho():
    """Truoc (buoc 2), sau (buoc 5), do nguong nguy hiem, va go stack."""
    text = bo_comment_shell(DEPLOY.read_text(encoding="utf-8"))
    assert text.count("snapshot-vpn4.sh") == 4


def test_repo_duoc_clone_truoc_khi_goi_script():
    """Script nam TRONG repo, nen buoc chup baseline phai clone truoc — o lan
    deploy dau tien /opt/opencode chua ton tai."""
    text = DEPLOY.read_text(encoding="utf-8")
    i_clone = text.index("git clone https://github.com/vanbienperu3107/TelegramAgent.git")
    i_chup = text.index("snapshot-vpn4.sh > /tmp/baseline-")
    assert i_clone < i_chup
