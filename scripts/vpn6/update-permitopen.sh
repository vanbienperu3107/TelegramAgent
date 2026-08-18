#!/bin/bash
# Cap nhat authorized_keys cua user `pgtunnel` cho dung IP hien tai cua container
# derp-postgres, roi in ra DUNG MOT DONG `PG_REMOTE_HOST=<ip>`.
#
# Cai vao /usr/local/bin/ tren vpn6, chay qua sudoers whitelist. KHONG nhan tham
# so tu ngoai: no tu doc IP. Cap `docker inspect` truc tiep cho user deploy la
# khong can thiet, nen khong cap.
#
# TRINH TU BAT BUOC: doc -> validate -> thoat neu sai -> sao luu -> ghi -> in.
# Ghi truoc khi validate la hong vinh vien: `docker inspect` tra rong (container
# doi ten, daemon ban) se ghi permitopen=":5432" va tunnel chet, con ban .bak
# khong co hau to ngay thi ban tot da bi de mat tu lan chay truoc.
set -euo pipefail

KEYS=/home/pgtunnel/.ssh/authorized_keys
NET=dashboard-vn_dashnet
CONTAINER=derp-postgres

echo "==> [1/5] Doc IP container trong dung mang $NET" >&2
# LOC THEO TEN MANG. `.NetworkSettings.IPAddress` tra rong khi container o mang
# tuy chinh, va `range .Networks` khong loc se lay mang dau tien theo thu tu
# ngau nhien — derp-postgres co the duoc gan them mang khac bat cu luc nao.
IP=$(docker inspect "$CONTAINER" \
  --format "{{ with index .NetworkSettings.Networks \"$NET\" }}{{ .IPAddress }}{{ end }}")

echo "==> [2/5] Validate dinh dang IPv4" >&2
if ! printf '%s' "$IP" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
  echo "loi: IP khong hop le: '$IP' (container/mang doi ten? daemon ban?)" >&2
  exit 1
fi

echo "==> [3/5] Sao luu authorized_keys kem hau to ngay" >&2
[ -f "$KEYS" ] || { echo "loi: khong thay $KEYS — user pgtunnel chua duoc tao?" >&2; exit 1; }
install -m 600 -o pgtunnel -g pgtunnel "$KEYS" "$KEYS.bak-$(date +%F-%H%M%S)"

echo "==> [4/5] Ghi permitopen moi" >&2
# `restrict` KHONG duoc dung mot minh: no bao gom no-port-forwarding, va
# `permitopen` chi LOC dich chu khong bat lai quyen. Phai co port-forwarding
# tuong minh, neu khong tunnel khong bao gio mo — va trieu chung lai giong het
# loi sai IP hoac sai host key, rat kho truy.
KEY_PART=$(awk '{ for (i=1; i<=NF; i++) if ($i ~ /^(ssh|ecdsa)-/) { $1=""; print substr($0, index($0,$i)); exit } }' "$KEYS")
[ -n "$KEY_PART" ] || { echo "loi: khong tach duoc phan khoa cong khai tu $KEYS" >&2; exit 1; }

OPTS="restrict,port-forwarding,permitopen=\"$IP:5432\",command=\"/bin/false\""
printf '%s %s\n' "$OPTS" "$KEY_PART" > "$KEYS.new"
install -m 600 -o pgtunnel -g pgtunnel "$KEYS.new" "$KEYS"
rm -f "$KEYS.new"

echo "==> [5/5] In ket qua cho workflow doc lai" >&2
# DUNG MOT DONG, dung dinh dang. Buoc 3 cua deploy dung `grep -oE` de vua trich
# vua validate; sai dinh dang thi grep tra rong va step do ngay tai runner.
printf 'PG_REMOTE_HOST=%s\n' "$IP"
