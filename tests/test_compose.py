"""Bat bien cua docker-compose.yml — day la ban thi hanh cua Telegram.md §37.3.

Ly do ton tai: bon vong review doi khang lien tiep deu tim ra loi trong dac ta
compose/CI viet bang van xuoi, va moi ban sua lai de ra mot loi cung hang. Van
xuoi thi khong ai chay duoc. Cac phep kiem duoi day chay trong 30 giay va bat
dung lop loi do.

Moi test o day tuong ung mot dong trong bang §37.3 cua Telegram.md.
"""
import pathlib

import pytest
import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
COMPOSE = ROOT / "docker-compose.yml"

# Ba service cua stack. Danh sach dong: them service moi phai sua test.
SERVICES = {"telegram-gateway", "opencode-server", "pg-tunnel"}

# Mount bi cam tuyet doi. `/` cho agent xoa may; docker.sock cho no quyen docker
# tren chinh may dang chay DERP relay; deployHeadscale chua token OAuth
# Claude/Codex — mat la phai dang nhap lai toan bo.
FORBIDDEN_MOUNTS = ("/:", "/var/run/docker.sock", "/opt/deployHeadscale")


@pytest.fixture(scope="module")
def compose():
    return yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def services(compose):
    return compose["services"]


def test_du_ba_service(services):
    assert set(services) == SERVICES


def test_opencode_server_khong_publish_cong(services):
    """vpn4 mo 3 cong ra Internet va chay DERP relay cua ca fleet. OpenCode la
    tien trinh duoc phep chay bash va sua file — lo no ra ngoai la trao shell
    tren may ha tang cho bat ky ai."""
    assert "ports" not in services["opencode-server"]


def test_khong_service_nao_publish_cong(services):
    """Gateway goi RA Telegram bang long polling, tunnel chi noi ra ngoai.
    Khong service nao can cong vao."""
    for name, spec in services.items():
        assert "ports" not in spec, "%s khong duoc publish cong" % name


def test_moi_service_co_mem_limit(services):
    """vpn4 chi co 1968 MB. Service khong dat mem_limit se lay het RAM may, va
    kernel duoc quyen chon derper lam nan nhan."""
    for name, spec in services.items():
        assert "mem_limit" in spec, "%s thieu mem_limit" % name


def test_moi_service_co_oom_score_adj(services):
    """Quy tac 'hy sinh OpenCode truoc derper' chi la loi noi neu khong co dong
    cau hinh nao thi hanh: kernel chon nan nhan theo RSS toan cuc."""
    for name, spec in services.items():
        assert "oom_score_adj" in spec, "%s thieu oom_score_adj" % name


def test_thu_tu_uu_tien_oom_dung_chieu(services):
    """Cao hon = bi giet truoc. OpenCode (nang nhat, de thay the nhat) phai cao
    nhat; tunnel thap nhat vi mat no la mat DB."""
    adj = {n: s["oom_score_adj"] for n, s in services.items()}
    assert adj["opencode-server"] > adj["telegram-gateway"] > adj["pg-tunnel"]


def test_tong_ngan_sach_ram_khong_vuot_900mb(services):
    """Rang buoc §0.6: tong stack <= 900 MB. vpn4 con ~1275 MB kha dung va
    cliproxy co tran 1 GB."""
    total = 0
    for spec in services.values():
        raw = str(spec["mem_limit"]).lower().rstrip("b")
        total += int(raw[:-1]) * (1024 if raw.endswith("g") else 1)
    assert total <= 900, "tong mem_limit %d MB vuot tran 900 MB" % total


def test_moi_service_gioi_han_log(services):
    """derp-backend tren vpn6 tung phinh 2.5 GB log; doc log lon lam nghen
    Postgres va dashboard tra 500. vpn4 khong co daemon.json nen phai khai o
    tung service."""
    for name, spec in services.items():
        opts = spec.get("logging", {}).get("options", {})
        assert opts.get("max-size"), "%s thieu logging.max-size" % name
        assert opts.get("max-file"), "%s thieu logging.max-file" % name


def test_khong_mount_cam(services):
    for name, spec in services.items():
        for vol in spec.get("volumes", []):
            for bad in FORBIDDEN_MOUNTS:
                assert bad not in vol, "%s mount cam: %s" % (name, vol)


def test_opencode_va_tunnel_khong_chung_mang(services):
    """Phat bieu 'opencode-server khong o db_net' la CHUA DU: dua pg-tunnel vao
    opencode_net cung cho hai service chung mang ma van qua phep kiem do. Bat
    bien that la GIAO cua hai tap mang phai RONG — neu khong, agent (chay bash
    tuy y) nhin thay cong 5433 dan thang toi Postgres cua headscale."""
    a = set(services["opencode-server"]["networks"])
    b = set(services["pg-tunnel"]["networks"])
    assert not (a & b), "opencode-server va pg-tunnel chung mang: %s" % (a & b)


def test_mang_edge_la_external(compose):
    """Mang `edge` do stack edge-vpn4 so huu (cliproxy nam tren do). Dat
    external de compose khong bao gio tao hay xoa no."""
    assert compose["networks"]["edge"].get("external") is True


def test_khong_dung_tag_troi(services):
    """Tag troi lam deploy khong tai lap duoc va rollback vo nghia."""
    for name, spec in services.items():
        image = spec["image"]
        assert not image.endswith((":latest", ":stable")), "%s dung tag troi" % name


def test_bien_bat_buoc_deu_co_dau_hoi(services):
    """Moi ${VAR} trong compose phai la ${VAR:?} — thieu bien thi dung ngay,
    khong de chuoi rong troi vao trong roi hong o cho kho truy hon."""
    text = COMPOSE.read_text(encoding="utf-8")
    import re

    for match in re.finditer(r"\$\{([A-Z_][A-Z0-9_]*)(:?[?-]?)", text):
        name, mark = match.group(1), match.group(2)
        assert mark.startswith(":?"), "%s thieu :? trong compose" % name


def test_opencode_server_khong_dung_chung_env_voi_gateway(services):
    """Dung chung .env se do TELEGRAM_BOT_TOKEN va OPENCODE_PG_PASSWORD vao
    container ma agent co quyen `read` — no doc /proc/self/environ la co token
    bot, gui tin gia danh bot, vo hieu AC-02 va AC-11."""
    assert services["opencode-server"]["env_file"] == ".env.opencode"
    assert services["telegram-gateway"]["env_file"] == ".env"


def test_opencode_server_khong_co_environment_roi(services):
    """`environment:` bo trong la `environment: null` trong YAML — mot hinh dang
    chua ai do hanh vi. Da bo han khoa nay."""
    assert "environment" not in services["opencode-server"]


def test_moi_env_file_co_khuon_trong_repo(services):
    """Bat bien chong dung lop loi da xay ra: .env.opencode tung duoc compose
    tham chieu 5 cho ma khong buoc nao sinh ra no -> deploy hong 100%."""
    for name, spec in services.items():
        env_file = spec.get("env_file")
        if env_file:
            assert (ROOT / (env_file + ".example")).exists(), (
                "%s dung %s nhung khong co %s.example trong repo"
                % (name, env_file, env_file)
            )


def test_agent_lam_viec_dung_trong_thu_muc_project(compose):
    """`working_dir` phai la thu muc PROJECT, khong phai thu muc cha.

    `POST /session` khong co truong thu muc — da doi chieu voi dac ta da tai ve.
    Phien thua ke `working_dir` cua tien trinh server, nen day la cho duy nhat
    quyet dinh agent lam viec o dau.

    De `/workspace` thi agent nhin thay `opencode-sandbox/` nhu mot thu muc con va
    lam viec o TREN no mot cap. Khong co loi nao, khong co canh bao nao — chi la
    viec chon project tro thanh trang tri, va nguoi dung khong hieu vi sao agent
    khong thay file cua ho.
    """
    wd = compose["services"]["opencode-server"]["working_dir"]
    assert "DEFAULT_PROJECT_PATH" in wd, "working_dir phai lay tu DEFAULT_PROJECT_PATH"
    assert wd != "/workspace", "thu muc cha thi viec chon project chi la trang tri"


def test_working_dir_la_bien_bat_buoc(compose):
    """Thieu bien -> compose phai TU CHOI, khong duoc lang le dung mac dinh."""
    wd = compose["services"]["opencode-server"]["working_dir"]
    assert ":?" in wd, "phai dung dang ${VAR:?...} de compose tu choi khi thieu"


def test_du_lieu_opencode_duoc_giu_qua_deploy(services, compose):
    """Phien cua OpenCode phai song sot qua `--force-recreate`.

    Khong co volume nay thi MOI LAN DEPLOY xoa sach moi phien: buoc 4 chay
    `up -d --force-recreate opencode-server`, container moi khong con he thong
    tep cu. Bang `opencode_sessions` cua bot van tro toi chung, nen cau hoi tiep
    theo tra HTTP 404 "Session not found" — dung loi nguoi dung gap 2026-08-18.

    Quyen bam "cho phep vinh vien" cung nam trong thu muc do. Mat no nghia la
    phai duyet lai tu dau sau moi lan deploy, va loi hua "vinh vien" o nhan nut
    thanh sai.
    """
    mounts = services["opencode-server"].get("volumes", [])
    assert any(
        "/home/node/.local/share/opencode" in m for m in mounts
    ), "opencode-server phai gan volume cho thu muc du lieu"
    assert "opencode_data" in (compose.get("volumes") or {}), "phai khai volume opencode_data"


def test_volume_co_ten_tuong_minh(compose):
    """Khong de compose tu dat ten theo thu muc trien khai: doi thu muc la mat het
    phien, va trieu chung se giong het loi 404 o tren."""
    assert (compose["volumes"]["opencode_data"] or {}).get("name") == "opencode_data"
