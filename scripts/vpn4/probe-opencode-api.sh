#!/bin/bash
# Do be mat API cua opencode-server DANG CHAY tren vpn4.
#
# Plan (§17.2) ghi 8 endpoint la "?" va cam viet Event Processor truoc khi co mau
# su kien that. Script nay tra loi tung cau hoi do bang cach hoi chinh server,
# thay vi doan tu tai lieu.
#
# XAC THUC: lan do dau tien tra 401 tren MOI duong dan, ke ca /doc va /global/health.
# Mat khau nam san trong bien moi truong cua chinh container (env_file .env.opencode),
# nen ta tham chieu $OPENCODE_SERVER_PASSWORD BEN TRONG container thay vi truyen qua
# tham so `docker exec` — tham so hien trong `ps` cua host.
#
# LOC BI MAT: moi thu script in ra deu di thang vao artifact cua repo PUBLIC, nen
# TOAN BO dau ra chay qua bo loc thay hai bi mat bang ***.
set -uo pipefail   # KHONG dung -e: muc dich la thu tung endpoint, ke ca cai hong

ENVFILE=/opt/opencode/.env.opencode
BASE="http://127.0.0.1:4096"

# Doc bi mat CHI de lam bo loc — khong bao gio truyen chung vao lenh curl.
doc_bien() { sed -n "s/^$1=//p" "$ENVFILE" 2>/dev/null | head -1; }
PASS=$(doc_bien OPENCODE_SERVER_PASSWORD)
APIKEY=$(doc_bien CLIPROXY_API_KEY)

thoat_sed() { printf '%s' "$1" | sed 's/[|&\\]/\\&/g'; }
BIEU="s/khong-doi-gi/khong-doi-gi/"
if [ -n "$PASS" ];   then BIEU="$BIEU; s|$(thoat_sed "$PASS")|***MATKHAU***|g"; fi
if [ -n "$APIKEY" ]; then BIEU="$BIEU; s|$(thoat_sed "$APIKEY")|***APIKEY***|g"; fi

# Chay curl BEN TRONG container, tu doc mat khau tu env cua chinh no.
oc() { docker exec opencode-server sh -c "$1"; }

than() {
  # Cach xac thuc chua biet — thu ca ba, giu cach nao ra 200.
  #
  # NHAN phai la ten cach, khong phai ten tieu de. Ban dau cho nay in
  # "${c%%:*}", tuc phan truoc dau hai cham — nen ca Bearer lan Basic deu hien
  # thanh dong "Authorization" giong het nhau, va nguoi doc log ket luan nham la
  # Bearer chay duoc. Mot ban ghi khong phan biet duoc hai ket qua khac nhau thi
  # te hon la khong ghi gi.
  local CACH="" muc ten ma c TEN_CACH=""
  for muc in 'bearer|Authorization: Bearer $OPENCODE_SERVER_PASSWORD' \
             'basic|Authorization: Basic $(printf "opencode:%s" "$OPENCODE_SERVER_PASSWORD" | base64 -w0)' \
             'tieu-de-rieng|x-opencode-password: $OPENCODE_SERVER_PASSWORD'; do
    ten=${muc%%|*}
    c=${muc#*|}
    ma=$(oc "curl -sS -o /dev/null -w '%{http_code}' --max-time 8 -H \"$c\" $BASE/global/health")
    echo "thu cach '$ten' -> HTTP $ma"
    if [ "$ma" = "200" ] && [ -z "$CACH" ]; then CACH="$c"; TEN_CACH="$ten"; fi
  done
  if [ -z "$CACH" ]; then
    echo "!! KHONG cach nao ra 200 — dung lai, khong doan tiep."
    return 1
  fi
  echo "==> CACH XAC THUC DUNG: $TEN_CACH"
  local H="-H \"$CACH\""

  hoi() {
    local ten="$1" method="$2" duong_dan="$3" body="${4:-}"
    echo "--- $ten: $method $duong_dan"
    if [ -n "$body" ]; then
      oc "curl -sS -o /tmp/r.json -w 'HTTP %{http_code}\n' --max-time 20 $H -X $method -H 'Content-Type: application/json' -d '$body' $BASE$duong_dan; head -c 900 /tmp/r.json"
    else
      oc "curl -sS -o /tmp/r.json -w 'HTTP %{http_code}\n' --max-time 20 $H -X $method $BASE$duong_dan; head -c 900 /tmp/r.json"
    fi
    echo
  }

  echo "########## 1. Dac ta OpenAPI ##########"
  oc "curl -sS --max-time 20 $H $BASE/doc > /tmp/opencode-openapi.json; wc -c < /tmp/opencode-openapi.json"
  echo "--- danh sach duong dan trong OpenAPI ---"
  oc "cat /tmp/opencode-openapi.json" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
except Exception as e:
    print('khong doc duoc:', e); raise SystemExit
for duong_dan, muc in sorted((d.get('paths') or {}).items()):
    for m in muc:
        if m in ('get','post','put','delete','patch'):
            print('%-6s %s' % (m.upper(), duong_dan))
" 2>&1

  echo "########## 2. Provider va model ##########"
  hoi "config" GET /config
  hoi "providers" GET /config/providers

  echo "########## 3. Agent — cau hoi con treo cua muc 13 ##########"
  hoi "agent" GET /agent

  echo "########## 4. Session ##########"
  hoi "liet session" GET /session
  echo "--- tao mot session thu ---"
  oc "curl -sS -o /tmp/ses.json -w 'HTTP %{http_code}\n' --max-time 20 $H -X POST -H 'Content-Type: application/json' -d '{}' $BASE/session; head -c 500 /tmp/ses.json"
  echo

  echo "########## 5. Luong su kien — CO REPLAY KHONG ##########"
  # Chup 10 giay tren mot ket noi MOI. Neu server gui lai su kien cu khi noi lai
  # thi se thay ngay o day; do la cau hoi quyet dinh cach viet Event Processor.
  oc "timeout 10 curl -sN --max-time 10 $H $BASE/event > /tmp/ev1.jsonl 2>/dev/null; wc -l < /tmp/ev1.jsonl"
  echo "--- dau file su kien ---"
  oc "head -c 1200 /tmp/ev1.jsonl"
  echo
  echo "--- noi lai lan hai: co phat lai su kien cu khong ---"
  oc "timeout 6 curl -sN --max-time 6 $H $BASE/event > /tmp/ev2.jsonl 2>/dev/null; wc -l < /tmp/ev2.jsonl; head -c 400 /tmp/ev2.jsonl"
  echo

  echo "########## xong ##########"
}

than 2>&1 | sed "$BIEU"

# Hai file de workflow tai ve. Cung phai loc — /doc va luong su kien deu co the
# nhac lai cau hinh.
docker exec opencode-server cat /tmp/opencode-openapi.json 2>/dev/null | sed "$BIEU" > /tmp/opencode-openapi.json
docker exec opencode-server cat /tmp/ev1.jsonl 2>/dev/null | sed "$BIEU" > /tmp/opencode-events.jsonl
exit 0
