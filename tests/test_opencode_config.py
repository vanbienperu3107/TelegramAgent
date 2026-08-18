"""opencode.json.template va verify-opencode-config.cjs — ban thi hanh cua §12.1, §27.

Lop loi ma cac test nay chan: OpenCode BO QUA khoa permission khong hop le thay vi
bao loi. Bon ten bia (`write`, `search`, `apply_patch`, `external`) tung nam trong
dac ta; mot ten bia lam agent chay theo mac dinh cua OpenCode ma khong ai biet, va
"mac dinh" co the la allow.
"""
import json
import pathlib
import shutil
import subprocess

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "opencode.json.template"
VERIFY = ROOT / "scripts" / "verify-opencode-config.cjs"

VALID_KEYS = {
    "read", "edit", "glob", "grep", "bash", "task", "skill", "lsp",
    "question", "webfetch", "websearch", "external_directory", "doom_loop",
}
# Bon ten tung xuat hien trong dac ta ma KHONG ton tai trong OpenCode.
TEN_BIA = ["write", "search", "apply_patch", "external"]

node = pytest.mark.skipif(shutil.which("node") is None, reason="khong co node")


@pytest.fixture(scope="module")
def template():
    return json.loads(TEMPLATE.read_text(encoding="utf-8"))


def test_template_la_json_hop_le(template):
    assert isinstance(template, dict)


def test_du_13_khoa_permission(template):
    assert set(template["permission"]) == VALID_KEYS


def test_khong_co_ten_khoa_bia(template):
    for ten in TEN_BIA:
        assert ten not in template["permission"], "%s khong ton tai trong OpenCode" % ten


def test_lsp_la_deny(template):
    """Ngan sach RAM 512 MB cua opencode-server dung tren khoa nay:
    typescript-language-server ton 150-400 MB trong CUNG cgroup."""
    assert template["permission"]["lsp"] == "deny"


def test_co_khoi_lsp_tat_server(template):
    """permission.lsp la quyen cua TOOL; khoi `lsp` moi la cong tac tat SERVER.
    Hai thu khac nhau — dat mot cai khong thay the cai kia."""
    assert template["lsp"]["typescript"]["disabled"] is True


def test_duong_ra_internet_deu_phai_hoi(template):
    """`bash: ask` KHONG chan duoc duong ra Internet: agent co tool webfetch va
    websearch rieng, chay khong can shell."""
    for key in ("webfetch", "websearch", "external_directory"):
        assert template["permission"][key] == "ask"


def test_bash_map_co_du_mau_deny(template):
    """`docker *: deny` la co y — may nay chay DERP relay cua ca fleet."""
    bash = template["permission"]["bash"]
    assert bash["*"] == "ask"
    for pattern in ("rm *", "sudo *", "systemctl *", "docker *", "kubectl *",
                    "git push*", "git reset --hard*"):
        assert bash[pattern] == "deny", "%s phai la deny" % pattern


def test_provider_dung_bien_moi_truong_khong_hardcode_key(template):
    opts = template["provider"]["cliproxy"]["options"]
    assert opts["apiKey"] == "{env:CLIPROXY_API_KEY}"
    assert opts["baseURL"] == "{env:CLIPROXY_BASE_URL}"


def test_models_de_rong_cho_sync_models_dien(template):
    assert template["provider"]["cliproxy"]["models"] == {}


# ─── verify-opencode-config.cjs ────────────────────────────────────────────────

def _run_verify(tmp_path, cfg):
    target = tmp_path / "opencode.json"
    target.write_text(json.dumps(cfg), encoding="utf-8")
    return subprocess.run(
        ["node", str(VERIFY), str(target)], capture_output=True, text=True
    )


def _cfg_hop_le():
    cfg = json.loads(TEMPLATE.read_text(encoding="utf-8"))
    cfg["provider"]["cliproxy"]["models"] = {"claude-opus-5": {"name": "Claude Opus 5"}}
    return cfg


@node
def test_verify_qua_voi_cau_hinh_hop_le(tmp_path):
    proc = _run_verify(tmp_path, _cfg_hop_le())
    assert proc.returncode == 0, proc.stderr


@node
def test_verify_bat_models_rong(tmp_path):
    """models rong nghia la sync-models.cjs khong goi duoc model nao — deploy
    khong duoc coi la thanh cong."""
    cfg = _cfg_hop_le()
    cfg["provider"]["cliproxy"]["models"] = {}
    assert _run_verify(tmp_path, cfg).returncode != 0


@node
@pytest.mark.parametrize("ten", TEN_BIA)
def test_verify_bat_ten_khoa_bia(tmp_path, ten):
    cfg = _cfg_hop_le()
    cfg["permission"][ten] = "allow"
    proc = _run_verify(tmp_path, cfg)
    assert proc.returncode != 0
    assert ten in proc.stderr


@node
def test_verify_bat_thieu_khoa(tmp_path):
    cfg = _cfg_hop_le()
    del cfg["permission"]["skill"]
    proc = _run_verify(tmp_path, cfg)
    assert proc.returncode != 0
    assert "skill" in proc.stderr


@node
def test_verify_bat_lsp_khong_deny(tmp_path):
    cfg = _cfg_hop_le()
    cfg["permission"]["lsp"] = "allow"
    assert _run_verify(tmp_path, cfg).returncode != 0


@node
def test_verify_bat_map_bash_bi_danh_roi(tmp_path):
    """Day la lop loi that: mot regression lam roi map deny se qua duoc phep kiem
    chi so bash["*"], va `docker compose down derper` tut tu deny xuong mot nut bam."""
    cfg = _cfg_hop_le()
    del cfg["permission"]["bash"]["docker *"]
    proc = _run_verify(tmp_path, cfg)
    assert proc.returncode != 0
    assert "docker *" in proc.stderr


@node
def test_verify_bat_mau_bash_la(tmp_path):
    cfg = _cfg_hop_le()
    cfg["permission"]["bash"]["curl *"] = "allow"
    proc = _run_verify(tmp_path, cfg)
    assert proc.returncode != 0
    assert "curl *" in proc.stderr


@node
def test_verify_bat_json_hong(tmp_path):
    target = tmp_path / "opencode.json"
    target.write_text("{ khong phai json", encoding="utf-8")
    assert subprocess.run(["node", str(VERIFY), str(target)]).returncode != 0


@node
def test_verify_bat_file_rong(tmp_path):
    """`printf '{}' > opencode.json` o buoc 4 tao file hop le nhung khong co
    models — phai bi bat, khong duoc coi la dat."""
    assert _run_verify(tmp_path, {}).returncode != 0
