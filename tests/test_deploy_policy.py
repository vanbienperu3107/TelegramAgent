"""Luat L1-L5 cua §37.2.0 phai duoc thi hanh, va bo kiem phai THAT SU bat duoc loi.

Moi luat ra doi sau mot lan deploy do 100% hoac hong im lang. Bon vong review doi
khang cho thay van xuoi khong giu duoc chung: moi ban sua lai lam lech mot cho khac.

Cac test duoi day lam hai viec:
  1. deploy.yml hien tai tuan thu (test_deploy_hien_tai_tuan_thu)
  2. bo kiem KHONG phai binh phong: co mot ca vi pham cho tung luat, va bo kiem
     phai bat duoc — day moi la phan quan trong, vi mot chot chan cho lot con te
     hon khong co chot chan nao
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


def run_checker(workflow_dir):
    """Chay bo kiem tren mot cay repo gia lap."""
    return subprocess.run(
        [sys.executable, str(CHECKER)],
        cwd=workflow_dir, capture_output=True, text=True,
    )


@pytest.fixture
def repo(tmp_path):
    """Cay repo toi thieu: scripts/ + .env*.example + .github/workflows/."""
    (tmp_path / "scripts").mkdir()
    shutil.copy(CHECKER, tmp_path / "scripts" / CHECKER.name)
    for name in (".env.example", ".env.opencode.example"):
        shutil.copy(ROOT / name, tmp_path / name)
    wf = tmp_path / ".github" / "workflows"
    wf.mkdir(parents=True)
    return tmp_path


def write_deploy(repo, steps, extra=""):
    doc = "name: t\non:\n  workflow_dispatch:\njobs:\n  d:\n    runs-on: ubuntu-latest\n    steps:\n"
    (repo / ".github" / "workflows" / "deploy.yml").write_text(doc + steps + extra, encoding="utf-8")


SSH_STEP_OK = """      - name: vpn4
        uses: appleboy/ssh-action@v1.2.0
        with:
          script_stop: true
          envs: GITHUB_RUN_ID,FOO
          script: |
            exec 9>/var/lock/vpn4-deploy
            flock -w 600 9 || exit 1
            cd /opt/opencode
            docker compose ps > /tmp/ps-$GITHUB_RUN_ID.txt
            echo "$FOO"
        env:
          FOO: bar
          GITHUB_RUN_ID: x
"""


def test_deploy_hien_tai_tuan_thu():
    """deploy.yml that trong repo phai qua duoc bo kiem."""
    proc = subprocess.run(
        [sys.executable, str(CHECKER)], cwd=ROOT, capture_output=True, text=True
    )
    assert proc.returncode == 0, proc.stderr


def test_ca_hop_le_thi_qua(repo):
    write_deploy(repo, SSH_STEP_OK)
    assert run_checker(repo).returncode == 0, run_checker(repo).stderr


# ─── L1: khong heredoc, khong if/else nhieu dong ─────────────────────────────

def test_l1_bat_heredoc(repo):
    """ssh-action chen mot dong kiem exit code sau MOI dong script; dong do roi
    thang vao than heredoc va lam hong noi dung."""
    write_deploy(repo, SSH_STEP_OK.replace(
        'echo "$FOO"', 'cat > f <<EOF\nnoi dung\nEOF'))
    proc = run_checker(repo)
    assert proc.returncode != 0
    assert "heredoc" in proc.stderr


def test_l1_bat_if_else_nhieu_dong(repo):
    """Sau dong `else`, $? van la ket qua cua dieu kien if (=1 khi sai) -> script
    thoat 1 vo co va CHET IM LANG. Da lam deploy hong 5 lan lien tiep."""
    write_deploy(repo, SSH_STEP_OK.replace(
        'echo "$FOO"', 'if test -f x; then\n              echo co\n            else\n              echo khong\n            fi'))
    proc = run_checker(repo)
    assert proc.returncode != 0
    assert "if/else" in proc.stderr


# ─── L2: step la shell rieng ────────────────────────────────────────────────

def test_l2_bat_thieu_cd(repo):
    """Shell cua step khoi dong o $HOME. Thieu `cd` thi `docker compose ps` tra
    "no configuration file provided" va deploy do 100%."""
    write_deploy(repo, SSH_STEP_OK.replace("            cd /opt/opencode\n", ""))
    proc = run_checker(repo)
    assert proc.returncode != 0
    assert "cd /opt/opencode" in proc.stderr


def test_l2_bat_thieu_flock(repo):
    write_deploy(repo, SSH_STEP_OK.replace(
        "            exec 9>/var/lock/vpn4-deploy\n            flock -w 600 9 || exit 1\n", ""))
    proc = run_checker(repo)
    assert proc.returncode != 0
    assert "flock" in proc.stderr


# ─── L4: hai tang env cua ssh-action ────────────────────────────────────────

def test_l4_bat_envs_thieu_env(repo):
    """`envs:` CHI LA BO CHON TEN. Gia tri phai den tu `env:` cua chinh step.
    Khai ten trong envs: ma khong dinh nghia trong env: = bien RONG o dau ben kia,
    khong mot canh bao nao."""
    write_deploy(repo, SSH_STEP_OK.replace("        env:\n          FOO: bar\n", "        env:\n"))
    proc = run_checker(repo)
    assert proc.returncode != 0
    assert "FOO" in proc.stderr


def test_l4_bat_bien_khong_co_nguon(repo):
    write_deploy(repo, SSH_STEP_OK.replace('echo "$FOO"', 'echo "$KHONG_CO_NGUON"'))
    proc = run_checker(repo)
    assert proc.returncode != 0
    assert "KHONG_CO_NGUON" in proc.stderr


def test_l4_bat_thieu_script_stop(repo):
    write_deploy(repo, SSH_STEP_OK.replace("          script_stop: true\n", ""))
    proc = run_checker(repo)
    assert proc.returncode != 0
    assert "script_stop" in proc.stderr


# ─── L3/L4: mot chuoi format, ten file tam mang run id ──────────────────────

def test_l3_bat_hai_chuoi_format_inspect_khac_nhau(repo):
    """Bat bien nay ra doi vi mot lan: buoc chup baseline dung 3 truong con step
    do nguong dung 2 truong, nen `diff` luon khac rong -> MOI lan deploy, ke ca
    100% xanh, deu ket thuc bang viec go sach stack vua dung."""
    step = SSH_STEP_OK.replace(
        "docker compose ps > /tmp/ps-$GITHUB_RUN_ID.txt",
        "docker inspect -f '{{.Name}} {{.RestartCount}}' derper > /tmp/a-$GITHUB_RUN_ID.txt\n"
        "            docker inspect -f '{{.Name}} {{.RestartCount}} {{.State.StartedAt}}' derper > /tmp/b-$GITHUB_RUN_ID.txt")
    write_deploy(repo, step)
    proc = run_checker(repo)
    assert proc.returncode != 0
    assert "format" in proc.stderr


def test_l4_bat_ten_file_tam_co_dinh(repo):
    """Ten co dinh song qua cac lan deploy: buoc chup hong thi step sau so voi
    ANH CUA LAN TRUOC va cho phan quyet AC-21 gia."""
    write_deploy(repo, SSH_STEP_OK.replace("/tmp/ps-$GITHUB_RUN_ID.txt", "/tmp/ps.txt"))
    proc = run_checker(repo)
    assert proc.returncode != 0
    assert "GITHUB_RUN_ID" in proc.stderr


# ─── L5: secret phai duoc khai ──────────────────────────────────────────────

def test_l5_bat_secret_khong_khai(repo):
    step = SSH_STEP_OK.replace("          FOO: bar", "          FOO: ${{ secrets.BIEN_LA }}")
    write_deploy(repo, step)
    proc = run_checker(repo)
    assert proc.returncode != 0
    assert "BIEN_LA" in proc.stderr


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
    assert "danger" in ids
    assert "baseline" in ids
    assert "vpn6" in ids


def test_step_go_stack_khong_dung_failure_tran(deploy):
    """`if: failure()` tran se go nguyen mot stack dang chay tot khi buoc 5 do o
    muc RAM 250 MB, hoac khi buoc 5d hong vi ly do vat nhu scp."""
    for step in deploy["jobs"]["deploy"]["steps"]:
        if step.get("name", "").startswith("Huy deploy"):
            assert "steps.danger.outputs.danger" in step["if"]
            return
    pytest.fail("khong thay step huy deploy")


def test_khong_dung_capture_stdout(deploy):
    """Tuy chon do khong ton tai o @v1.2.0 (chi co tu v1.2.1). Khai mot input la
    chi sinh warning, con outputs.stdout se la chuoi RONG."""
    # Bo comment truoc khi tim: chinh deploy.yml co comment giai thich vi sao
    # KHONG dung tuy chon nay, nen tim chuoi tho lam file tu to cao minh. Day la
    # lan thu ba lop loi nay xuat hien, nen no da thanh tien ich dung chung.
    text = bo_comment_yaml(DEPLOY.read_text(encoding="utf-8"))
    assert "capture_stdout" not in text


def test_khong_dung_run_number_cho_tag(deploy):
    """run_number dem RIENG cho tung workflow. Hau qua te nhat khong phai "tag
    khong ton tai" ma la "tag trung so tinh co" -> pull thanh cong, deploy xanh,
    nhung trien khai dung mot build khac."""
    text = bo_comment_yaml(DEPLOY.read_text(encoding="utf-8"))
    assert "run_number" not in text
