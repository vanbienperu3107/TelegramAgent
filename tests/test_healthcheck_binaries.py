"""Lenh dung trong healthcheck phai CO THAT trong image tuong ung.

Day la luat L3 ("moi lenh phai co bang chung ton tai dung noi no chay") duoc thi
hanh bang may cho rieng healthcheck — va la mot bai hoc tra gia:

  healthcheck cua opencode-server dung `wget`, nhung image cua no la
  node:22-bookworm-slim, khong co san wget lan curl. Container chay tot, log ghi
  "opencode server listening on 4096", nhung healthcheck bao -1 voi
  "executable file not found in $PATH" -> container mai mai `unhealthy` ->
  telegram-gateway co `condition: service_healthy` nen KHONG BAO GIO khoi dong.

  Cai bay o cho: gateway va pg-tunnel dung alpine, ma busybox cua alpine co san
  wget va nc — nen hai cai do chay tot va lam nguoi viet tuong `wget` la thu
  luon co. Debian slim thi khong.
"""
import pathlib
import re

import pytest
import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
COMPOSE = ROOT / "docker-compose.yml"
DOCKER = ROOT / "docker"

# Anh xa service -> Dockerfile. Danh sach dong: them service moi phai sua test.
IMAGE_CUA = {
    "telegram-gateway": DOCKER / "Dockerfile.gateway",
    "opencode-server": DOCKER / "Dockerfile.opencode-server",
    "pg-tunnel": DOCKER / "Dockerfile.pg-tunnel",
}

# busybox cua alpine cung cap san nhung lenh nay; Debian slim thi KHONG.
BUSYBOX_CO_SAN = {"wget", "nc", "sh", "test", "cat"}

# Luon co trong moi image ta dung.
LUON_CO = {"node"}


def base_image(dockerfile: pathlib.Path) -> str:
    text = dockerfile.read_text(encoding="utf-8")
    froms = re.findall(r"^FROM\s+(\S+)", text, re.M)
    return froms[-1] if froms else ""


def lenh_cua_healthcheck(spec) -> str | None:
    """Lay ten chuong trinh chay trong healthcheck, hoac None neu khong co."""
    test = (spec.get("healthcheck") or {}).get("test")
    if not test:
        return None
    if isinstance(test, str):
        return test.split()[0]
    if test and test[0] in ("CMD", "CMD-SHELL"):
        phan = test[1:]
        return phan[0].split()[0] if phan else None
    return test[0] if test else None


@pytest.fixture(scope="module")
def services():
    return yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]


def test_moi_service_deu_co_healthcheck(services):
    for ten, spec in services.items():
        assert "healthcheck" in spec, "%s thieu healthcheck" % ten


@pytest.mark.parametrize("ten", sorted(IMAGE_CUA))
def test_lenh_healthcheck_co_that_trong_image(services, ten):
    lenh = lenh_cua_healthcheck(services[ten])
    assert lenh, "%s: khong doc duoc lenh healthcheck" % ten

    if lenh in LUON_CO:
        return

    dockerfile = IMAGE_CUA[ten]
    base = base_image(dockerfile)
    noi_dung = dockerfile.read_text(encoding="utf-8")

    if "alpine" in base and lenh in BUSYBOX_CO_SAN:
        return  # busybox cung cap san

    # Voi moi truong hop con lai, Dockerfile PHAI cai tuong minh.
    assert re.search(r"\b%s\b" % re.escape(lenh), noi_dung), (
        "%s: healthcheck dung `%s` nhung %s (base %s) khong cai no. "
        "Container se mai mai unhealthy, va service phu thuoc no se khong bao gio "
        "khoi dong." % (ten, lenh, dockerfile.name, base)
    )


def test_healthcheck_opencode_server_khong_dung_co_f_cua_curl(services):
    """`curl -f` tra khac 0 khi gap 401. Chua do duoc /global/health co doi xac
    thuc hay khong, nen healthcheck chi duoc khang dinh "server tra loi", con
    tinh dung dan cua xac thuc co phep thu rieng o buoc 5 cua deploy."""
    test = services["opencode-server"]["healthcheck"]["test"]
    assert "-f" not in test and "--fail" not in test
