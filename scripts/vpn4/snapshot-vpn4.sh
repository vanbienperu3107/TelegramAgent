#!/bin/bash
# Anh chup trang thai container tren vpn4, de chung minh AC-21: deploy khong
# lam restart bat ky dich vu nao dang chay.
#
# Chay o CA BON cho trong deploy.yml: buoc 2 (truoc), buoc 5 (sau), step do
# nguong nguy hiem, va step go stack. Mot ban dinh nghia duy nhat cho chuoi
# format — truoc day bon cho tu viet lay, va co lan buoc chup dung 3 truong con
# step do nguong dung 2, khien `diff` luon khac rong va MOI lan deploy deu tu go
# stack vua dung xong.
#
# CHUP MOI CONTAINER DANG CHAY, TRU stack cua chinh du an nay — khong dung danh
# sach cung. Ly do la mot su co that: danh sach cung liet `ts-vpn4`, nhung
# container do bi go khoi vpn4 giua hai lan deploy, va `docker inspect` tra
# "no such object" lam deploy do ngay buoc dau. Ha tang co doi; phep kiem phai
# chiu duoc dieu do. Cach nay con manh hon: no bat duoc ca container moi xuat
# hien hoac bien mat, khong chi cai ta nho liet ra.
set -euo pipefail

# Ba container cua stack nay: chung MOI xuat hien trong lan deploy dau tien, nen
# de trong anh chup se lam `diff` khac rong mot cach hop le nhung vo ich.
LOAI_TRU='^(opencode-gateway|opencode-server|opencode-pg-tunnel)$'

docker ps --format '{{.Names}}' \
  | grep -vE "$LOAI_TRU" \
  | sort \
  | while read -r ten; do
      docker inspect -f '{{.Name}} {{.RestartCount}} {{.State.StartedAt}}' "$ten"
    done
