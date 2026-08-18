"""opencode.json.template va verify-opencode-config.cjs — ban thi hanh cua §12.1, §27.

Lop loi ma cac test nay chan: OpenCode BO QUA khoa permission khong hop le thay vi
bao loi. Bon ten bia (`write`, `search`, `apply_patch`, `external`) tung nam trong
dac ta; mot ten bia lam agent chay theo mac dinh cua OpenCode ma khong ai biet, va
"mac dinh" co the la allow.
"""
import json
import re
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
    """13 khoa loi phai co DU. Khoa THEM chi duoc la glob cua tool MCP.

    Truoc day phep kiem la dang thuc tuyet doi. No dung khi chua co MCP, nhung
    quyen cua tool MCP (`context7_*`, `exa_*`...) la khoa hop le ma OpenCode
    hieu — cam chung nghia la khong dung duoc MCP nao. Doi lai la khong duoc:
    dang thuc tuyet doi cung chan viec BO SOT mot khoa loi, va do moi la thu
    nguy hiem. Nen giu ca hai: du 13, va moi khoa them phai co hinh dang glob.
    """
    khoa = set(template["permission"])
    thieu = VALID_KEYS - khoa
    assert not thieu, "thieu khoa permission loi: %s" % sorted(thieu)
    for them in sorted(khoa - VALID_KEYS):
        assert re.fullmatch(r"[a-z0-9_]+_\*", them), (
            "khoa permission la: %s (chi chap nhan glob cua tool MCP)" % them
        )


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


def test_duong_ra_internet_la_quyet_dinh_TUONG_MINH(template):
    """`bash: ask` KHONG chan duoc duong ra Internet: agent co tool webfetch va
    websearch rieng, chay khong can shell.

    Nguoi dung da chon "allow" cho webfetch/websearch ngay 2026-08-18 de cac MCP
    tim kiem chay tron. Danh doi da biet va da noi ro: agent goi duoc URL tuy y
    ma khong hoi, tuc no co the mang noi dung workspace ra ngoai.

    Phep kiem nay khong con khang dinh "phai hoi" — no khang dinh gia tri la MOT
    TRONG CAC GIA TRI DA CAN NHAC, de mot lan sua tay vo tinh khong am tham noi
    rong them. `external_directory` van phai hoi: no la duong ra khoi workspace,
    khac han duong ra Internet.
    """
    for key in ("webfetch", "websearch"):
        assert template["permission"][key] in ("ask", "allow")
    assert template["permission"]["external_directory"] == "ask"


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


def _mcp_cuc_bo():
    d = json.loads((ROOT / "opencode.json.template").read_text(encoding="utf-8"))
    return {
        ten: ch
        for ten, ch in (d.get("mcp") or {}).items()
        if ch.get("type") == "local"
    }


def test_mcp_cuc_bo_chay_duoc_tren_linux():
    """Lenh cua MCP server phai chay duoc trong container Debian.

    Cau hinh goc den tu may Windows va dung `cmd.exe /c npx`. Trong container thi
    khong co cmd.exe — MCP server se khong bao gio khoi dong duoc, va trieu chung
    la agent im lang khong dung duoc tool do chu khong phai mot loi ro rang.
    """
    for ten, cau_hinh in _mcp_cuc_bo().items():
        lenh = cau_hinh.get("command") or []
        assert lenh, "%s thieu command" % ten
        assert lenh[0] != "cmd.exe", "%s dung cmd.exe — khong co trong container Linux" % ten


def test_mcp_dang_BAT_phai_dung_binary_cai_san_trong_image():
    """MCP dang bat KHONG duoc `npx -y` tai goi luc chay.

    Do duoc 2026-08-18 tren server that: ca context7 lan exa deu
    `status=failed, Operation timed out after 15000ms`. `npx -y` phai tai goi tu
    registry MOI LAN container khoi dong — khong cache npm, may o Peru — va
    OpenCode nuot loi do IM LANG: khong log, khong canh bao, agent chi khong co
    tool va tra loi "minh khong lam duoc".

    MCP dang TAT thi duoc phep giu npx: no khong khoi dong nen khong the timeout,
    va bat len la mot quyet dinh tuong minh se keo theo viec cai goi vao image.
    """
    for ten, cau_hinh in _mcp_cuc_bo().items():
        if not cau_hinh.get("enabled"):
            continue
        lenh = cau_hinh.get("command") or []
        assert lenh[0] != "npx", (
            "%s dang bat ma van dung npx — se tai goi luc khoi dong va timeout. "
            "Cai goi trong Dockerfile.opencode-server roi goi thang binary." % ten
        )


def test_binary_cua_mcp_dang_bat_deu_duoc_cai_trong_dockerfile():
    """Moi binary MCP duoc goi phai co lenh cai tuong ung trong Dockerfile.

    Thieu thi container khoi dong len va MCP chet voi "command not found" — lai
    la mot loi OpenCode nuot im lang. Dockerfile co `command -v` de build DUNG
    NGAY neu ten binary khac ten goi, nhung phep kiem nay bat truoc mot buoc: khai
    trong cau hinh ma quen cai han.
    """
    docker = (ROOT / "docker" / "Dockerfile.opencode-server").read_text(encoding="utf-8")
    for ten, cau_hinh in _mcp_cuc_bo().items():
        if not cau_hinh.get("enabled"):
            continue
        binary = (cau_hinh.get("command") or [""])[0]
        assert "command -v %s" % binary in docker, (
            "Dockerfile thieu `command -v %s` — khai MCP %s ma quen cai binary" % (binary, ten)
        )


def test_timeout_mcp_du_rong():
    """15000ms la nguong DA DO THAY LA KHONG DU.

    Gio khong con tai goi luc chay nen 15s that ra du, nhung mot MCP khoi dong
    cham hon du kien thi chi cham — con timeout thi CHET IM LANG. Danh doi khong
    can nhac.
    """
    for ten, cau_hinh in _mcp_cuc_bo().items():
        t = cau_hinh.get("timeout")
        assert t is None or t >= 30000, "%s timeout %s qua ngan" % (ten, t)
