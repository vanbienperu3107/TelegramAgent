#!/bin/bash
# Anh chup trang thai vpn6 de chung minh AC-21: "khong dung vao ha tang dang chay".
#
# Cai vao /usr/local/bin/ tren vpn6, chay qua sudoers whitelist. KHONG nhan tham so.
# Deploy chay no HAI lan (truoc va sau) roi `diff`.
#
# NGUYEN TAC: chi chup TRUONG TINH. Chup truong bien thien la lam `diff` LUON khac
# rong -> buoc 5b do -> tieu chi huy deploy go luon stack vua dung xong. Cu the:
#
#   KHONG chup pg_database_size    — DB derp nhan telemetry ca fleet moi 3 giay
#   KHONG chup so connection       — 3 pgweb + derp-backend mo/dong lien tuc
#   KHONG chup derp-backend        — dashboard-watchtower tu cap nhat no; mot lan
#                                    update roi vao cua so ~20 phut giua hai lan
#                                    chup se bao "da dung ha tang" trong khi stack
#                                    nay khong lam gi
#
# Nguoc lai phai chup datacl va rolconfig: bước 3 co y doi chung (REVOKE TEMP,
# ALTER ROLE), nen khong chup thi AC-21 mu voi dung hanh dong nguy hiem nhat ma
# deploy thuc hien.
set -euo pipefail

PGC="docker exec -i derp-postgres psql -tA -U derp -d postgres"

echo "### container (chi cai KHONG do watchtower quan)"
docker inspect -f '{{.Name}} {{.RestartCount}} {{.State.StartedAt}}' headscale derp-postgres

echo "### so bang public cua hai DB khong duoc dung toi"
for db in derp headscale; do
  n=$(docker exec -i derp-postgres psql -tA -U derp -d "$db" \
        -c "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
  echo "$db pg_tables=$n"
done

echo "### danh sach database (loc bo cai cua du an nay)"
$PGC -c "SELECT datname FROM pg_database WHERE datistemplate=false AND datname <> 'opencode_remote' ORDER BY 1"

echo "### danh sach role (loc bo cai cua du an nay)"
$PGC -c "SELECT rolname FROM pg_roles WHERE rolcanlogin AND rolname <> 'opencode' ORDER BY 1"

echo "### ACL cua hai DB dung chung — CHI grant cho role CO TEN"
# Bo muc cua PUBLIC (muc bat dau bang "="): do CHINH LA thu buoc 3 co y doi
# (REVOKE TEMP ... FROM PUBLIC), nen de no trong `diff` thi lan deploy dau tien
# luon do — va da do that. Bat bien that su can giu la "grant cho cac role CO
# TEN khong duoc doi": derp=CTc, headscale=CTc, tailnet_rw=CTc. Chinh chung moi
# la thu cac dich vu dang chay dua vao; PUBLIC thi khong ai dua vao (da do
# 2026-08-18, xem §0.2).
$PGC -c "SELECT datname || ' acl=' || COALESCE((SELECT string_agg(a, ',' ORDER BY a) FROM unnest(datacl) AS a WHERE a NOT LIKE '=%'),'NULL') FROM pg_database WHERE datname IN ('derp','headscale') ORDER BY 1"

echo "### rolconnlimit/rolconfig cua cac role hien huu (KHONG gom opencode)"
$PGC -c "SELECT rolname || ' connlimit=' || rolconnlimit || ' config=' || COALESCE(array_to_string(rolconfig,','),'NULL') FROM pg_roles WHERE rolcanlogin AND rolname <> 'opencode' ORDER BY 1"
