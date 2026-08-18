#!/bin/bash
# Tao DB opencode_remote + role opencode tren derp-postgres (vpn6), va siet role do.
#
# Cai vao /usr/local/bin/ tren vpn6, chay qua sudoers whitelist:
#   <SSH_USER_VPN6> ALL=(root) NOPASSWD: /usr/local/bin/create-opencode-db.sh
#
# KHONG nhan tham so. Mat khau doc qua STDIN — khong qua dong lenh (dong lenh
# hien trong `ps`), khong hardcode trong file nay (ban sao thu hai khong xoay duoc).
#
#   printf '%s\n' "$OPENCODE_PG_PASSWORD" | sudo /usr/local/bin/create-opencode-db.sh
#
# LUON chay ALTER ROLE ... PASSWORD, khong chi tao-neu-chua-co: idempotent phai
# theo GIA TRI, khong theo su ton tai. Thieu dieu nay thi doi secret xong role van
# giu mat khau cu -> gateway 28P01, va xoay credential DB cua mot repo CONG KHAI
# tro thanh bat kha thi theo dung quy trinh da viet.
set -euo pipefail

PGC="docker exec -i derp-postgres psql -v ON_ERROR_STOP=1 -U derp"

# `|| true` de thieu newline cuoi khong giet script (read tra exit 1 khi gap EOF
# ma chua co newline). Kiem rong ngay sau moi la chot chan that.
IFS= read -r PASS || true
[ -n "${PASS:-}" ] || { echo "loi: khong nhan duoc mat khau qua stdin" >&2; exit 1; }

echo "==> [1/4] Do datacl TRUOC khi doi quyen (ghi vao §0.2 cua Telegram.md)"
$PGC -d postgres -c \
  "SELECT datname, pg_get_userbyid(datdba) AS owner, datacl FROM pg_database WHERE datname IN ('derp','headscale');"

echo "==> [2/4] Tao role + DB neu chua co"
$PGC -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='opencode'" | grep -q 1 \
  || $PGC -d postgres -c "CREATE ROLE opencode LOGIN"
$PGC -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='opencode_remote'" | grep -q 1 \
  || $PGC -d postgres -c "CREATE DATABASE opencode_remote OWNER opencode"

echo "==> [3/4] Dat mat khau (LUON chay, de xoay duoc credential)"
# Mat khau di qua bien cua psql, khong qua dong lenh -> khong vao `ps`.
printf '%s\n' "\\set pass '$PASS'" "ALTER ROLE opencode PASSWORD :'pass';" \
  | $PGC -d postgres -q

echo "==> [4/4] Siet role opencode"
# CONNECT keo theo TEMP, va temp_file_limit mac dinh la KHONG GIOI HAN. Mot cau
# CREATE TEMP TABLE AS SELECT generate_series(1,1e10) du lam day dia vpn6
# (dang dung 46%/48 GB) -> PostgreSQL dung ghi -> HEADSCALE MAT DB -> control
# plane cua ca fleet chet. Day la duong pha hoai KHONG can doc duoc bang nao.
$PGC -d postgres -c "REVOKE TEMP ON DATABASE derp, headscale FROM PUBLIC;"
$PGC -d postgres -c "REVOKE ALL ON DATABASE opencode_remote FROM PUBLIC;"
# 10 chu khong phai 6: dem consumer that cua duong deploy — pool gateway CU van
# chay (PG_IDLE_TIMEOUT_S=0 nen khong nha) 4, pool gateway MOI 4, migrate 1,
# psql verify 1. Dat 6 la tu bop co deploy bang "too many connections".
$PGC -d postgres -c "ALTER ROLE opencode CONNECTION LIMIT 10;"
$PGC -d postgres -c "ALTER ROLE opencode SET temp_file_limit = '64MB';"
$PGC -d postgres -c "ALTER ROLE opencode SET statement_timeout = '8s';"
$PGC -d postgres -c "ALTER ROLE opencode SET idle_in_transaction_session_timeout = '30s';"
# 30min chu khong phai 10min: PG_IDLE_TIMEOUT_S=0 co y giu ket noi am de tranh
# tra gia bat tay 307 ms. Timeout ngan hon nhip dung that cua mot bot ca nhan se
# giet sach pool, va truy van ke tiep ton ~1228 ms -> vuot ngan sach AC-18.
$PGC -d postgres -c "ALTER ROLE opencode SET idle_session_timeout = '30min';"

echo "==> xong"
