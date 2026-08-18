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


def test_khong_co_bi_mat_viet_thang_trong_khuon():
    """Repo nay PUBLIC. Mot khoa viet thang vao khuon la mot khoa da lo.

    Cac khoa MCP den tu cau hinh may ca nhan cua nguoi dung, noi chung nam duoi
    dang van ban ro. Cho nay la ranh gioi giua "may ca nhan" va "repo cong khai".
    """
    tho = (ROOT / "opencode.json.template").read_text(encoding="utf-8")
    mau_kha_nghi = ("sk-", "tvly-", "BSA", "EXA_API_KEY\":\" ")
    for m in mau_kha_nghi:
        assert m not in tho, "khuon chua chuoi giong bi mat: %s" % m

    d = json.loads(tho)

    def di(nut, duong=""):
        if isinstance(nut, dict):
            for k, v in nut.items():
                di(v, "%s.%s" % (duong, k))
        elif isinstance(nut, str):
            # Moi gia tri cua truong ten *_KEY / apiKey phai la giu cho, khong
            # duoc la gia tri that.
            if duong.lower().endswith(("api_key", "apikey")):
                assert nut.startswith("{env:"), "%s khong phai giu cho: %s" % (duong, nut[:12])

    di(d)


def test_moi_giu_cho_env_deu_co_trong_khuon_env():
    """Giu cho khong co bien tuong ung -> chuoi rong, khong loi, khong canh bao.

    Da xay ra that voi CLIPROXY_BASE_URL: `GET /config` tra "baseURL":"" tren
    container dang chay trong khi moi phep kiem deu xanh.
    """
    import re

    tho = (ROOT / "opencode.json.template").read_text(encoding="utf-8")
    giu_cho = set(re.findall(r"\{env:([A-Z0-9_]+)\}", tho))
    co = {
        d.split("=", 1)[0].strip()
        for d in (ROOT / ".env.opencode.example").read_text(encoding="utf-8").splitlines()
        if d.strip() and not d.strip().startswith("#") and "=" in d
    }
    thieu = sorted(giu_cho - co)
    assert not thieu, "giu cho khong co trong .env.opencode.example: %s" % thieu


def test_mcp_cuc_bo_chay_duoc_tren_linux():
    """Lenh cua MCP server phai chay duoc trong container Debian.

    Cau hinh goc den tu may Windows va dung `cmd.exe /c npx`. Trong container thi
    khong co cmd.exe — MCP server se khong bao gio khoi dong duoc, va trieu chung
    la agent im lang khong dung duoc tool do chu khong phai mot loi ro rang.
    """
    d = json.loads((ROOT / "opencode.json.template").read_text(encoding="utf-8"))
    for ten, cau_hinh in (d.get("mcp") or {}).items():
        if cau_hinh.get("type") != "local":
            continue
        lenh = cau_hinh.get("command") or []
        assert lenh, "%s thieu command" % ten
        assert lenh[0] != "cmd.exe", "%s dung cmd.exe — khong co trong container Linux" % ten
        assert lenh[0] in ("npx", "node", "bun"), "%s dung lenh la: %s" % (ten, lenh[0])
