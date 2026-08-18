"""Luat L1-L5 cua §37.2.0 phai duoc thi hanh, va bo kiem phai THAT SU bat duoc loi.

Moi luat ra doi sau mot lan deploy do 100% hoac hong im lang. Bon vong review doi
khang cho thay van xuoi khong giu duoc chung: moi ban sua lai lam lech mot cho khac.

Cac test duoi day lam hai viec:
  1. deploy.yml that trong repo tuan thu (test_deploy_hien_tai_tuan_thu)
  2. bo kiem KHONG phai binh phong: co mot ca VI PHAM cho tung luat, va bo kiem
     phai bat duoc — day moi la phan quan trong, vi mot chot chan cho lot con te
     hon khong co chot chan nao

Fixture duoc dung bang cach SINH YAML TU DICT, khong phai thay chuoi trong van ban.
Ban dau cac test nay dung `.replace()` de tao ca vi pham, va ca 10 test do: thay
chuoi ben trong mot block scalar (`script: |`) lam mat thut le, nen dong duoc chen
roi ra ngoai khoi script va bo kiem khong thay gi de bat. CI bat duoc dieu do.
"""
import pathlib
import shutil
import subprocess
import sys

import pytest
import yaml

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from helpers import bo_comment_yaml  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
CHECKER = ROOT / "scripts" / "check-deploy-policy.py"
DEPLOY = ROOT / ".github" / "workflows" / "deploy.yml"

# Script hop le: co flock, co cd, moi lenh mot dong, file tam mang run id.
SCRIPT_OK = "\n".join([
    "exec 9>/var/lock/vpn4-deploy",
    "flock -w 600 9 || exit 1",
    "cd /opt/opencode",
    "docker compose ps > /tmp/ps-$GITHUB_RUN_ID.txt",
    'echo "$FOO"',
])


def ssh_step(script=SCRIPT_OK, envs="GITHUB_RUN_ID,FOO", env=None, script_stop=True):
    """Mot step ssh-action hop le, cho phep doi tung phan de tao ca vi pham."""
    with_block = {"script": script, "script_stop": script_stop}
    if envs is not None:
        with_block["envs"] = envs
    return {
        "name": "vpn4",
        "uses": "appleboy/ssh-action@v1.2.0",
        "with": with_block,
        "env": {"FOO": "bar", "GITHUB_RUN_ID": "x"} if env is None else env,
    }


def write_deploy(repo, steps):
    doc = {
        "name": "t",
        "on": {"workflow_dispatch": None},
        "jobs": {"d": {"runs-on": "ubuntu-latest", "steps": steps}},
    }
    target = repo / ".github" / "workflows" / "deploy.yml"
    target.write_text(yaml.safe_dump(doc, sort_keys=False), encoding="utf-8")


def run_checker(repo):
    return subprocess.run(
        [sys.executable, str(repo / "scripts" / CHECKER.name)],
        cwd=repo, capture_output=True, text=True,
    )


@pytest.fixture
def repo(tmp_path):
    """Cay repo toi thieu: scripts/ + .env*.example + .github/workflows/."""
    (tmp_path / "scripts").mkdir()
    shutil.copy(CHECKER, tmp_path / "scripts" / CHECKER.name)
    for name in (".env.example", ".env.opencode.example"):
        shutil.copy(ROOT / name, tmp_path / name)
    (tmp_path / ".github" / "workflows").mkdir(parents=True)
    return tmp_path


# ─── bo kiem chay dung tren deploy.yml that ─────────────────────────────────

def test_deploy_hien_tai_tuan_thu():
    proc = subprocess.run(
        [sys.executable, str(CHECKER)], cwd=ROOT, capture_output=True, text=True
    )
    assert proc.returncode == 0, proc.stderr


def test_ca_hop_le_thi_qua(repo):
    write_deploy(repo, [ssh_step()])
    proc = run_checker(repo)
    assert proc.returncode == 0, proc.stderr


# ─── L1: khong heredoc, khong if/else nhieu dong ─────────────────────────────

def test_l1_bat_heredoc(repo):
    """ssh-action chen mot dong kiem exit code sau MOI dong script; dong do roi
    thang vao than heredoc va lam hong noi dung."""
    script = SCRIPT_OK + "\ncat > f <<EOF\nnoi dung\nEOF"
    write_deploy(repo, [ssh_step(script=script)])
    proc = run_checker(repo)
    assert proc.returncode != 0
    assert "heredoc" in proc.stderr


def test_l1_bat_if_else_nhieu_dong(repo):
    """Sau dong `else`, $? van la ket qua cua dieu kien if (=1 khi sai) -> script
    thoat 1 vo co va CHET IM LANG. Da lam deploy hong 5 lan lien tiep."""
    script = SCRIPT_OK + "\nif test -f x; then\n  echo co\nelse\n  echo khong\nfi"
    write_deploy(repo, [ssh_step(script=script)])
    proc = run_checker(repo)
    assert proc.returncode != 0
    assert "if/else" in proc.stderr


# ─── L2: step la mot shell rieng ────────────────────────────────────────────

def test_l2_bat_thieu_cd(repo):
    """Shell cua step khoi dong o $HOME. Thieu `cd` thi `docker compose ps` tra
    "no configuration file provided" va deploy do 100%."""
    script = SCRIPT_OK.replace("cd /opt/opencode\n", "")
    write_deploy(repo, [ssh_step(script=script)])
    proc = run_checker(repo)
    assert proc.returncode != 0
    assert "cd /opt/opencode" in proc.stderr


def test_l2_bat_thieu_flock(repo):
    script = "\n".join(l for l in SCRIPT_OK.splitlines() if "flock" not in l and "exec 9" not in l)
    write_deploy(repo, [ssh_step(script=script)])
    proc = run_checker(repo)
    assert proc.returncode != 0
    assert "flock" in proc.stderr


# ─── L4: hai tang env cua ssh-action ────────────────────────────────────────

def test_l4_bat_envs_thieu_env(repo):
    """`envs:` CHI LA BO CHON TEN. Gia tri phai den tu `env:` cua chinh step.
    Khai ten trong envs: ma khong dinh nghia trong env: = bien RONG o dau ben kia,
    khong mot canh bao nao."""
    write_deploy(repo, [ssh_step(env={"GITHUB_RUN_ID": "x"})])
    proc = run_checker(repo)
    assert proc.returncode != 0
    assert "FOO" in proc.stderr


def test_l4_bat_bien_khong_co_nguon(repo):
    script = SCRIPT_OK.replace('echo "$FOO"', 'echo "$KHONG_CO_NGUON"')
    write_deploy(repo, [ssh_step(script=script)])
    proc = run_checker(repo)
    assert proc.returncode != 0
    assert "KHONG_CO_NGUON" in proc.stderr


def test_l4_bat_thieu_script_stop(repo):
    write_deploy(repo, [ssh_step(script_stop=None)])
    proc = run_checker(repo)
    assert proc.returncode != 0
    assert "script_stop" in proc.stderr


# ─── L3/L4: mot chuoi format, ten file tam mang run id ──────────────────────

def test_l3_bat_hai_chuoi_format_inspect_khac_nhau(repo):
    """Bat bien nay ra doi vi mot lan: buoc chup baseline dung 3 truong con step
    do nguong dung 2 truong, nen `diff` luon khac rong -> MOI lan deploy, ke ca
    100% xanh, deu ket thuc bang viec go sach stack vua dung."""
    script = "\n".join([
        SCRIPT_OK,
        "docker inspect -f '{{.Name}} {{.RestartCount}}' derper > /tmp/a-$GITHUB_RUN_ID.txt",
        "docker inspect -f '{{.Name}} {{.RestartCount}} {{.State.StartedAt}}' derper > /tmp/b-$GITHUB_RUN_ID.txt",
    ])
    write_deploy(repo, [ssh_step(script=script)])
    proc = run_checker(repo)
    assert proc.returncode != 0
    assert "format" in proc.stderr


def test_l4_bat_ten_file_tam_co_dinh(repo):
    """Ten co dinh song qua cac lan deploy: buoc chup hong thi step sau so voi
    ANH CUA LAN TRUOC va cho phan quyet AC-21 gia."""
    script = SCRIPT_OK.replace("/tmp/ps-$GITHUB_RUN_ID.txt", "/tmp/ps.txt")
    write_deploy(repo, [ssh_step(script=script)])
    proc = run_checker(repo)
    assert proc.returncode != 0
    assert "GITHUB_RUN_ID" in proc.stderr


# ─── L5: secret phai duoc khai ──────────────────────────────────────────────

def test_l5_bat_secret_khong_khai(repo):
    step = ssh_step(env={"FOO": "${{ secrets.BIEN_LA }}", "GITHUB_RUN_ID": "x"})
    write_deploy(repo, [step])
    proc = run_checker(repo)
    assert proc.returncode != 0
    assert "BIEN_LA" in proc.stderr


# ─── L4: bien dung o `docker run -e` phai duoc export ───────────────────────

def test_bat_docker_run_e_khong_export(repo):
    """`docker run -e TEN` (khong co `=`) chi lay duoc bien DA EXPORT. Phep gan
    tran chi tao bien shell, va `[ -n "$VAR" ]` van PASS — nen chot chan khong
    bat duoc, container im lang chay thieu bien.

    Luat nay tung duoc viet vao §37.3 nhung KHONG duoc thi hanh, va no lot ngay
    o lan deploy that dau tien: CLIPROXY_BASE_URL co trong .env nhung khong ai
    export, nen sync-models.cjs chet voi "thieu bien moi truong".
    """
    script = SCRIPT_OK + "\nBIEN=$(cat x)\ndocker run --rm -e BIEN alpine env"
    write_deploy(repo, [ssh_step(script=script)])
    proc = run_checker(repo)
    assert proc.returncode != 0
    assert "BIEN" in proc.stderr


def test_cho_qua_khi_da_export(repo):
    script = SCRIPT_OK + "\nBIEN=$(cat x)\nexport BIEN\ndocker run --rm -e BIEN alpine env"
    write_deploy(repo, [ssh_step(script=script)])
    assert run_checker(repo).returncode == 0


def test_cho_qua_khi_bien_den_tu_envs(repo):
    """Bien di qua `envs:` cua ssh-action thi da duoc export san."""
    script = SCRIPT_OK + "\ndocker run --rm -e FOO alpine env"
    write_deploy(repo, [ssh_step(script=script)])
    assert run_checker(repo).returncode == 0


# ─── deploy.yml that: cac bat bien ve noi dung ──────────────────────────────

@pytest.fixture(scope="module")
def deploy():
    return yaml.safe_load(DEPLOY.read_text(encoding="utf-8"))


def test_deploy_chi_workflow_dispatch(deploy):
    """Repo PUBLIC giu SSH_KEY = root tren may chay DERP relay cua ca fleet."""
    on = deploy.get("on", deploy.get(True))
    assert set(on) == {"workflow_dispatch"}


def test_deploy_co_concurrency_group_dung(deploy):
    """Cung host vpn4 voi cac stack cua repo deployHeadscale."""
    assert deploy["concurrency"]["group"] == "deploy-vpn4-host"
    assert deploy["concurrency"]["cancel-in-progress"] is False


def test_step_danger_ton_tai(deploy):
    """Bieu thuc tro toi step khong ton tai thi GitHub Actions tra chuoi rong va
    KHONG bao loi -> dieu kien luon false va ca co che huy thanh ma chet."""
    ids = {s.get("id") for s in deploy["jobs"]["deploy"]["steps"]}
    assert {"danger", "baseline", "vpn6"} <= ids


def test_step_go_stack_khong_dung_failure_tran(deploy):
    """`if: failure()` tran se go nguyen mot stack dang chay tot khi buoc 5 do o
    muc RAM 250 MB, hoac khi buoc 5d hong vi ly do vat nhu scp."""
    for step in deploy["jobs"]["deploy"]["steps"]:
        if str(step.get("name", "")).startswith("Huy deploy"):
            assert "steps.danger.outputs.danger" in step["if"]
            return
    pytest.fail("khong thay step huy deploy")


def test_khong_dung_capture_stdout():
    """Tuy chon do khong ton tai o @v1.2.0 (chi co tu v1.2.1). Khai mot input la
    chi sinh warning, con outputs.stdout se la chuoi RONG.

    Bo comment truoc khi tim: chinh deploy.yml co comment giai thich vi sao KHONG
    dung tuy chon nay — day la lan thu ba lop loi tu-to-cao xuat hien, nen no da
    thanh tien ich dung chung o helpers.py.
    """
    assert "capture_stdout" not in bo_comment_yaml(DEPLOY.read_text(encoding="utf-8"))


def test_khong_dung_run_number_cho_tag():
    """run_number dem RIENG cho tung workflow. Hau qua te nhat khong phai "tag
    khong ton tai" ma la "tag trung so tinh co" -> pull thanh cong, deploy xanh,
    nhung trien khai dung mot build khac."""
    assert "run_number" not in bo_comment_yaml(DEPLOY.read_text(encoding="utf-8"))
