#!/usr/bin/env python3
"""Thi hanh nam luat L1-L5 cua Telegram.md §37.2.0 tren cac workflow deploy.

    python3 scripts/check-deploy-policy.py

Nam luat nay khong phai loi khuyen: moi luat ra doi sau mot lan deploy do 100%
hoac hong im lang, va bon vong review doi khang cho thay VAN XUOI khong giu duoc
chung — moi ban sua lai lam lech mot cho khac. File nay bien chung thanh phep
kiem chay trong vai giay.

  L1  Moi lenh mot dong trong `script:` cua ssh-action; khong heredoc, khong
      khoi if/else nhieu dong.
  L2  Moi step la mot shell rieng: bien va thu muc lam viec khong song qua step.
  L3  Moi lenh phai co bang chung ton tai dung noi no chay.
  L4  Doi may thuc thi thi ra lai: file ghi o dau, doc o dau, nguon moi $VAR,
      dong bang chung cho may do.
  L5  Them tao tac moi thi liet du moi muc sinh/doc/kiem/quay lui no.
"""
import pathlib
import re
import sys

import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"

SSH_ACTION = "appleboy/ssh-action"

# Bien do runner cap san, khong can khai trong env:.
BUILTIN = {
    "GITHUB_OUTPUT", "GITHUB_ENV", "GITHUB_STEP_SUMMARY", "GITHUB_WORKSPACE",
    "GITHUB_RUN_ID", "GITHUB_SHA", "GITHUB_REF_NAME", "HOME", "PATH", "RUNNER_OS",
}


def steps_of(doc):
    for job in (doc.get("jobs") or {}).values():
        for step in job.get("steps") or []:
            yield step


def assigned_names(script):
    """Ten bien duoc GAN trong chinh script (ke ca trong vong for/while)."""
    out = set()
    for m in re.finditer(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=", script, re.M):
        out.add(m.group(1))
    for m in re.finditer(r"\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b", script):
        out.add(m.group(1))
    return out


def used_names(script):
    """Ten bien duoc DOC trong script: $VAR va ${VAR...}."""
    out = set()
    for m in re.finditer(r"\$\{([A-Za-z_][A-Za-z0-9_]*)[:\-}]", script):
        out.add(m.group(1))
    for m in re.finditer(r"\$([A-Za-z_][A-Za-z0-9_]*)", script):
        out.add(m.group(1))
    return out


def check_l1(name, step, script, loi):
    """Khong heredoc, khong if/else nhieu dong.

    ssh-action chen mot dong kiem exit code sau MOI dong script. Dong do roi thang
    vao than heredoc va lam hong noi dung. Voi khoi if/else, sau dong `else` thi
    $? van la ket qua cua dieu kien if (=1 khi sai) -> script thoat 1 vo co va
    CHET IM LANG, khong log loi. Da lam deploy hong 5 lan lien tiep o du an khac.
    """
    if re.search(r"<<-?\s*['\"]?\w+", script):
        loi.append("%s: %s dung heredoc trong script cua ssh-action" % (name, step))
    if re.search(r"^\s*else\s*$", script, re.M):
        loi.append("%s: %s dung khoi if/else nhieu dong trong ssh-action" % (name, step))


def check_l2(name, step, script, loi):
    """Step vao vpn4 phai tu khai thu muc lam viec va tu lay khoa flock.

    Moi step la mot shell rieng, khoi dong o $HOME. `cd` cua step truoc khong
    song sang step sau — thieu no thi `docker compose ps` tra
    "no configuration file provided" va deploy do 100%.
    """
    needs_cd = re.search(r"\bdocker compose\b", script) and "-f " not in script
    if needs_cd and not re.search(r"^\s*cd\s+/opt/opencode", script, re.M):
        loi.append("%s: %s goi `docker compose` ma khong `cd /opt/opencode`" % (name, step))
    if re.search(r"\bdocker (compose|inspect|run)\b", script) and "flock" not in script:
        loi.append("%s: %s dung docker tren vpn4 ma khong lay khoa flock" % (name, step))


def check_l4_env(name, label, script, step, loi):
    """Hai tang env cua ssh-action.

    `envs:` CHI LA BO CHON TEN — no noi "chuyen tiep cac bien nay sang may xa".
    GIA TRI van phai den tu khoi `env:` cua chinh step. Khai ten trong `envs:` ma
    khong dinh nghia trong `env:` = bien rong o dau ben kia, khong canh bao.

    Quy uoc tham so, dung nhat quan o moi ham trong file nay: `label` la ten step
    (chuoi, chi de bao loi), `step` la dict de doc `env:`/`with:`. Ban dau hai cai
    nay bi trao cho nhau o ca hai ham va CI bat duoc ca hai lan.
    """
    forwarded = {
        n.strip()
        for n in ((step.get("with") or {}).get("envs") or "").split(",")
        if n.strip()
    }
    defined = set(step.get("env") or {})
    for var in sorted(forwarded - defined):
        loi.append("%s: %s khai '%s' trong envs: nhung khong dinh nghia trong env:" % (name, label, var))

    used = used_names(script) - assigned_names(script) - BUILTIN
    for var in sorted(used - forwarded - defined):
        loi.append("%s: %s doc $%s ma bien nay khong co nguon gia tri nao" % (name, label, var))


def check_l4_run(name, label, script, step, loi):
    """Step `run:` tren runner: moi $VAR phai co nguon.

    Chu y thu tu tham so: `label` la ten step (chuoi) de bao loi, `step` la dict
    de doc `env:`. Ban dau hai cai nay bi trao cho nhau va CI bat duoc ngay —
    AttributeError: 'str' object has no attribute 'get'.
    """
    used = used_names(script) - assigned_names(script) - BUILTIN
    defined = set(step.get("env") or {})
    for var in sorted(used - defined):
        loi.append("%s: %s (run) doc $%s ma khong co trong env: cua step" % (name, label, var))


def moi_script(doc):
    """Gop noi dung script cua MOI step lai, doc tu cau truc da phan tich.

    KHONG quet van ban tho cua file YAML: `yaml.safe_dump` co the boc scalar bang
    nhay kep, escape ky tu, hoac ngat dong o cot 80 — luc do mot chuoi lenh bi cat
    thanh hai va bieu thuc chinh quy khong con khop dung. Doc cau truc thi mien
    nhiem voi moi cach trinh bay. Day la cung mot bai hoc voi lop loi tu-to-cao
    o tests/helpers.py: dung cau truc, dung van ban.
    """
    parts = []
    for step in steps_of(doc):
        if step.get("uses", "").startswith(SSH_ACTION):
            parts.append((step.get("with") or {}).get("script") or "")
        elif "run" in step:
            parts.append(step["run"])
    return "\n".join(parts)


def check_l3_inspect(name, doc_text, loi):
    """Moi `docker inspect -f` dung CUNG mot chuoi format.

    Bat bien nay ra doi vi mot lan: buoc chup baseline dung 3 truong con step do
    nguong dung 2 truong, nen `diff` luon khac rong -> MOI lan deploy, ke ca 100%
    xanh, deu ket thuc bang viec go sach stack vua dung.
    """
    fmts = set(re.findall(r"docker inspect -f\s+'([^']+)'", doc_text))
    if len(fmts) > 1:
        loi.append("%s: co %d chuoi format `docker inspect` khac nhau: %s"
                   % (name, len(fmts), " | ".join(sorted(fmts))))


def check_l4_tmpfile(name, doc_text, loi):
    """File tam phai mang $GITHUB_RUN_ID.

    Ten co dinh song qua cac lan deploy: buoc chup hong thi step sau so voi ANH
    CUA LAN TRUOC va cho phan quyet AC-21 gia — xanh gia hoac do gia, ca hai deu te.
    """
    for m in re.finditer(r"/tmp/([A-Za-z0-9_.-]+)\.txt", doc_text):
        if "GITHUB_RUN_ID" not in m.group(1):
            loi.append("%s: file tam /tmp/%s.txt dung ten co dinh, thieu $GITHUB_RUN_ID"
                       % (name, m.group(1)))


def check_l5_secrets_declared(name, doc_text, loi):
    """Secret dung trong workflow phai co dong trong .env.example hoac bang §6.3.

    Kiem gian: chi canh bao khi mot secret duoc tham chieu ma ten cua no khong
    xuat hien o bat ky khuon env nao va cung khong phai secret ha tang da biet.
    """
    known = {
        "SSH_HOST_VPN4", "SSH_HOST_VPN6", "SSH_USER", "SSH_USER_VPN6", "SSH_KEY",
        "SSH_PORT", "SSH_KEY_VPN6_B64", "VPN6_HOST_KEY_B64", "VPN4_HOST_KEY_B64",
        "PG_TUNNEL_KEY_B64", "GHCR_TOKEN", "GITHUB_TOKEN",
    }
    tpl = ""
    for f in (".env.example", ".env.opencode.example"):
        p = ROOT / f
        if p.exists():
            tpl += p.read_text(encoding="utf-8")
    for m in re.finditer(r"secrets\.([A-Z_][A-Z0-9_]*)", doc_text):
        var = m.group(1)
        if var not in known and var not in tpl:
            loi.append("%s: dung secrets.%s ma khong khai o .env*.example hay bang secret" % (name, var))


def main():
    loi = []
    files = sorted(WORKFLOWS.glob("deploy*.yml"))
    if not files:
        sys.stderr.write("khong thay workflow deploy nao — bo qua\n")
        return 0

    for path in files:
        name = path.name
        text = path.read_text(encoding="utf-8")
        doc = yaml.safe_load(text) or {}

        scripts = moi_script(doc)
        check_l3_inspect(name, scripts, loi)
        check_l4_tmpfile(name, scripts, loi)
        # Tham chieu secret nam trong khoi `env:`, khong nam trong script — cai nay
        # doc van ban file la dung cho.
        check_l5_secrets_declared(name, text, loi)

        for step in steps_of(doc):
            label = step.get("name") or step.get("id") or "<step khong ten>"
            if step.get("uses", "").startswith(SSH_ACTION):
                script = (step.get("with") or {}).get("script") or ""
                check_l1(name, label, script, loi)
                check_l2(name, label, script, loi)
                check_l4_env(name, label, script, step, loi)
                if (step.get("with") or {}).get("script_stop") is not True:
                    loi.append("%s: %s thieu script_stop: true" % (name, label))
            elif "run" in step:
                check_l4_run(name, label, step["run"], step, loi)

    if loi:
        for dong in loi:
            sys.stderr.write("::error::%s\n" % dong)
        return 1

    sys.stderr.write("OK: %d workflow deploy tuan thu L1-L5\n" % len(files))
    return 0


if __name__ == "__main__":
    sys.exit(main())
