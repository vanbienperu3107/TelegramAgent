"""Tien ich dung chung cho test: BO COMMENT truoc khi tim chuoi bi cam.

Vi sao can: mot file giai thich VI SAO no khong duoc chua chuoi X thi ban than no
se chua chuoi X trong comment. Tim chuoi tho se lam file tu to cao minh.

Lop loi nay da xay ra BA lan trong du an:
  1. Buoc CI kiem `pull_request_target` do vi comment giai thich luat cung chua
     chuoi do.
  2. `test_khong_khai_healthcheck` do vi Dockerfile co comment "KHONG khai
     HEALTHCHECK o day".
  3. `test_snapshot_khong_chup_truong_bien_thien` do vi script co comment
     "KHONG chup pg_database_size".

Bai hoc: phep kiem phai doc CAU TRUC (dong lenh, khoi YAML), khong doc VAN BAN.
Ba lan cung mot lop loi la du de tach thanh tien ich dung chung.
"""


def bo_comment_shell(text):
    """Bo dong comment kieu # va phan comment cuoi dong. Giu nguyen so dong."""
    out = []
    for line in text.splitlines():
        stripped = line.lstrip()
        if stripped.startswith("#"):
            out.append("")
            continue
        # Cat phan sau dau # dau tien khong nam trong nhay. Du dung cho muc dich
        # nay: ta chi can biet mot chuoi co xuat hien trong LENH hay khong.
        in_single = in_double = False
        cut = None
        for i, ch in enumerate(line):
            if ch == "'" and not in_double:
                in_single = not in_single
            elif ch == '"' and not in_single:
                in_double = not in_double
            elif ch == "#" and not in_single and not in_double:
                cut = i
                break
        out.append(line[:cut] if cut is not None else line)
    return "\n".join(out)


def bo_comment_yaml(text):
    """YAML dung cung cu phap comment voi shell."""
    return bo_comment_shell(text)


def dong_lenh_dockerfile(text):
    """Chi tra cac dong CHI THI cua Dockerfile, bo comment va dong rong."""
    out = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            out.append(stripped)
    return out
