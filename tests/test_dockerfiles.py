"""Bat bien cua ba Dockerfile — nhung dieu neu sai se lam deploy do hoac OOM.

Khong build image o day (CI build o workflow rieng); test o day kiem cac tinh chat
doc duoc tu van ban, moi tinh chat gan voi mot rui ro cu the da biet.
"""
import pathlib
import re
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from helpers import dong_lenh_dockerfile  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCKER = ROOT / "docker"

GATEWAY = DOCKER / "Dockerfile.gateway"
OPENCODE = DOCKER / "Dockerfile.opencode-server"
TUNNEL = DOCKER / "Dockerfile.pg-tunnel"
ALL = [GATEWAY, OPENCODE, TUNNEL]


@pytest.mark.parametrize("path", ALL, ids=lambda p: p.name)
def test_ton_tai(path):
    assert path.exists()


@pytest.mark.parametrize("path", ALL, ids=lambda p: p.name)
def test_khong_dung_tag_troi_cho_base_image(path):
    """`FROM node:latest` lam build khong tai lap duoc."""
    for m in re.finditer(r"^FROM\s+(\S+)", path.read_text(encoding="utf-8"), re.M):
        image = m.group(1)
        assert not image.endswith(":latest"), "%s dung tag troi" % image
        assert ":" in image or image.startswith("$"), "%s khong ghim tag" % image


@pytest.mark.parametrize("path", ALL, ids=lambda p: p.name)
def test_khong_khai_healthcheck(path):
    """docker-compose.yml la ban dinh nghia duy nhat cua healthcheck; hai noi khai
    thi mot noi se lech.

    Kiem CHI THI chu khong kiem van ban: mot Dockerfile giai thich vi sao no khong
    khai HEALTHCHECK thi comment cua no chua dung chuoi do, va phep kiem se lam
    file tu to cao minh. Day la lan thu hai lop loi nay xuat hien (lan dau: buoc
    CI kiem pull_request_target).
    """
    for line in dong_lenh_dockerfile(path.read_text(encoding="utf-8")):
        assert not line.upper().startswith("HEALTHCHECK"), line


# ─── gateway ─────────────────────────────────────────────────────────────────

def test_gateway_chay_bang_user_khong_phai_root():
    assert re.search(r"^USER node$", GATEWAY.read_text(encoding="utf-8"), re.M)


def test_gateway_gioi_han_heap_duoi_mem_limit():
    """V8 khong biet gi ve cgroup: khong dat --max-old-space-size thi no cu lon toi
    khi kernel OOM-kill giua task. Tran heap phai THAP HON mem_limit 256m."""
    m = re.search(r"--max-old-space-size=(\d+)", GATEWAY.read_text(encoding="utf-8"))
    assert m, "thieu --max-old-space-size"
    assert int(m.group(1)) < 256


def test_gateway_kiem_ca_index_va_migrate_khi_build():
    """Buoc 4 cua deploy chay `--entrypoint node telegram-gateway dist/migrate.js`.
    Build chi sinh index.js la deploy do dung o buoc migration."""
    text = GATEWAY.read_text(encoding="utf-8")
    assert "test -f dist/index.js" in text
    assert "test -f dist/db/migrate.js" in text


def test_gateway_co_sync_models():
    """Buoc 4 chay no bang `docker run --rm --entrypoint node` tren image nay."""
    assert "scripts/sync-models.cjs" in GATEWAY.read_text(encoding="utf-8")


def test_gateway_khong_keo_devdependencies_vao_runtime():
    assert "--omit=dev" in GATEWAY.read_text(encoding="utf-8")


# ─── opencode-server ─────────────────────────────────────────────────────────

def test_opencode_dung_glibc_khong_dung_alpine():
    """Goi `opencode-ai` cai binary bien dich bang Bun; alpine dung musl chu khong
    phai glibc. Day la lop loi rat pho bien, va Milestone 0 khong nen dot thoi gian
    debug musl — image lon hon ~80 MB trong khi vpn4 con 33 GB dia."""
    froms = [
        line for line in dong_lenh_dockerfile(OPENCODE.read_text(encoding="utf-8"))
        if line.upper().startswith("FROM")
    ]
    assert froms
    for line in froms:
        assert "alpine" not in line, line
    assert any("bookworm" in line for line in froms)


def test_opencode_ghim_phien_ban_qua_build_arg():
    text = OPENCODE.read_text(encoding="utf-8")
    assert "ARG OPENCODE_VERSION" in text
    assert 'opencode-ai@${OPENCODE_VERSION}' in text


def test_opencode_co_du_cong_cu_cua_agent():
    """Thieu chung thi moi tool cua agent deu loi."""
    text = OPENCODE.read_text(encoding="utf-8")
    for tool in ("git", "openssh-client", "ripgrep", "ca-certificates", "tini"):
        assert tool in text, "thieu %s" % tool


def test_opencode_dung_tini():
    """Tien trinh con (bash tool, git) khong thanh zombie khi agent huy task giua
    chung."""
    assert 'ENTRYPOINT ["/usr/bin/tini"' in OPENCODE.read_text(encoding="utf-8")


def test_opencode_tao_thu_muc_cau_hinh_truoc():
    """compose bind-mount mot FILE vao trong thu muc do; thu muc phai ton tai
    truoc, neu khong Docker tao no thanh thu muc thuoc root."""
    text = OPENCODE.read_text(encoding="utf-8")
    assert "mkdir -p /home/node/.config/opencode" in text


def test_opencode_khai_safe_directory_cho_workspace():
    """workspace duoc clone bang root tren host roi chown 1000; git tu choi lam
    viec trong repo thuoc user khac ("dubious ownership")."""
    assert "safe.directory /workspace" in OPENCODE.read_text(encoding="utf-8")


def test_opencode_co_verify_script_o_duong_dan_tuyet_doi():
    assert "/opt/verify-opencode-config.cjs" in OPENCODE.read_text(encoding="utf-8")


def test_opencode_chay_bang_user_node():
    assert re.search(r"^USER node$", OPENCODE.read_text(encoding="utf-8"), re.M)


# ─── pg-tunnel ───────────────────────────────────────────────────────────────

def test_tunnel_co_du_bon_goi():
    """postgresql-client la bat buoc: buoc verify chay `psql` TRONG container nay,
    vi image gateway khong co psql va host vpn4 cung khong co."""
    text = TUNNEL.read_text(encoding="utf-8")
    for pkg in ("autossh", "openssh-client", "netcat-openbsd", "postgresql-client"):
        assert pkg in text, "thieu %s" % pkg
