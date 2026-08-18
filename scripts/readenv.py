#!/usr/bin/env python3
"""Doc DUNG MOT bien tu mot file env, theo luat dotenv cua Docker Compose.

    python3 scripts/readenv.py .env HEALTH_PORT

Vi sao ton tai: buoc verify tren vpn4 tung dung `source .env` bang shell. Lam vay
thi .env bi HAI bo phan tich khac nhau doc — shell cua ssh-action va env_file cua
compose — va khong ton tai quy tac escape thoa ca hai (dang '\\'' la phep noi chuoi
cua shell, dotenv khong hieu; nguoc lai `$` bi shell noi suy con dotenv thi khong).
Doc bang script nay de chi con MOT cach hieu file env.

In gia tri ra stdout, khong kem newline thua. Bien khong ton tai -> in rong,
exit 1 (nguoi goi tu quyet dinh coi la loi hay khong).
"""
import sys


def parse(path):
    """Tra ve dict theo luat dotenv cua compose-go.

    Luat toi thieu ma ta thuc su dung:
      - bo qua dong rong va dong bat dau bang #
      - KEY=VALUE, tach o dau '=' DAU TIEN
      - gia tri boc nhay kep -> bo nhay, giai escape \\" va \\\\
      - gia tri boc nhay don -> bo nhay, KHONG giai escape (nghia den)
      - khong boc nhay -> lay nguyen van, cat khoang trang hai dau
      - KHONG noi suy $ (env_file cua compose khong noi suy)
    """
    out = {}
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip()
            if len(val) >= 2 and val[0] == val[-1] == '"':
                val = val[1:-1].replace('\\"', '"').replace("\\\\", "\\")
            elif len(val) >= 2 and val[0] == val[-1] == "'":
                val = val[1:-1]
            out[key] = val
    return out


def main(argv):
    if len(argv) != 3:
        sys.stderr.write("dung: readenv.py <file> <TEN_BIEN>\n")
        return 2
    path, name = argv[1], argv[2]
    try:
        value = parse(path).get(name)
    except OSError as exc:
        sys.stderr.write("khong doc duoc %s: %s\n" % (path, exc))
        return 1
    if value is None:
        return 1
    sys.stdout.write(value)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
