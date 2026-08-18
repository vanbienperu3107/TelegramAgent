#!/bin/bash
# Chup LUONG SU KIEN THAT trong luc mot prompt dang chay.
#
# Plan §17.2 cam viet Event Processor truoc khi co file mau nay, va cam co ly do:
# dac ta liet 135 lop su kien, trong do ~30 lop bat dau bang SyncEventSessionNext*.
# Doc danh sach do khong tra loi duoc cau hoi thuc su can: mot luot hoi-dap binh
# thuong PHAT RA nhung su kien nao, theo THU TU nao, va co du du lieu de dung lai
# man hinh tien do khong.
#
# Vong do truoc chi bat duoc `server.connected` vi luc do khong co gi dang chay.
# Lan nay: mo luong TRUOC, roi moi tao phien va gui prompt.
#
# LOC BI MAT: dau ra vao artifact cua repo PUBLIC.
set -uo pipefail

ENVFILE=/opt/opencode/.env.opencode
BASE="http://127.0.0.1:4096"
RA=/tmp/opencode-events-live.jsonl

doc_bien() { sed -n "s/^$1=//p" "$ENVFILE" 2>/dev/null | head -1; }
PASS=$(doc_bien OPENCODE_SERVER_PASSWORD)
APIKEY=$(doc_bien CLIPROXY_API_KEY)
thoat_sed() { printf '%s' "$1" | sed 's/[|&\\]/\\&/g'; }
BIEU="s/khong-doi-gi/khong-doi-gi/"
if [ -n "$PASS" ];   then BIEU="$BIEU; s|$(thoat_sed "$PASS")|***MATKHAU***|g"; fi
if [ -n "$APIKEY" ]; then BIEU="$BIEU; s|$(thoat_sed "$APIKEY")|***APIKEY***|g"; fi

# HTTP Basic, KHONG phai Bearer. Vong do truoc da thu ca ba cach va chi Basic ra
# 200 — nhung ban ghi in nhan bang phan truoc dau hai cham cua tieu de, nen ca
# Bearer lan Basic deu hien thanh dong "Authorization" va nhin y het nhau. Doc
# nham dong do sang Bearer la ly do vong nay tra 401 o lan chay dau. Nhan da duoc
# sua trong probe-opencode-api.sh.
H='-H "Authorization: Basic $(printf "opencode:%s" "$OPENCODE_SERVER_PASSWORD" | base64 -w0)"'
oc() { docker exec opencode-server sh -c "$1"; }

than() {
  # 1. Mo luong TRUOC khi co viec gi xay ra. Neu mo sau thi khong biet duoc su
  #    kien nao bi mat va su kien nao chi don gian chua toi.
  docker exec opencode-server sh -c \
    "timeout 150 curl -sN --max-time 150 $H $BASE/event > $RA 2>/dev/null" &
  local bg=$!
  sleep 3

  # 2. Tao phien.
  local ses
  ses=$(oc "curl -sS --max-time 20 $H -X POST -H 'Content-Type: application/json' -d '{}' $BASE/session" \
        | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
  echo "phien: $ses"

  # 3. Mot cau hoi doi agent PHAI dung tool — chi tra loi bang van la khong du:
  #    ta can thay ca chuoi tool.called/progress/success de biet man hinh tien do
  #    dung duoc gi. `parts` la truong bat buoc duy nhat theo dac ta.
  local than_json
  than_json='{"model":{"providerID":"cliproxy","modelID":"claude-opus-5"},"agent":"build","parts":[{"type":"text","text":"Liet ke cac file trong thu muc hien tai roi noi ngan gon co bao nhieu file. Tra loi bang tieng Viet co dau."}]}'
  echo "--- POST prompt_async ---"
  oc "curl -sS -o /tmp/pr.json -w 'HTTP %{http_code}\n' --max-time 30 $H -X POST -H 'Content-Type: application/json' -d '$than_json' $BASE/session/$ses/prompt_async; head -c 400 /tmp/pr.json"
  echo

  # 4. TU DUYET moi yeu cau quyen. Khong co buoc nay thi luot chay ket o cua duyet
  #    va ta khong bao gio thay TIN HIEU KET THUC — dung cai ma bo dieu phoi su
  #    kien can nhat de biet khi nao ngung cap nhat man hinh tien do.
  #    Tra loi 'once' chu khong 'always': 'always' ghi vao cau hinh quyen cua
  #    server va lam thay doi trang thai ngoai pham vi phep do.
  local vong=0
  while [ "$vong" -lt 28 ]; do
    vong=$((vong + 1))
    oc "curl -sS --max-time 10 $H $BASE/permission" > /tmp/perm.json 2>/dev/null
    python3 - "$ses" <<'PY' > /tmp/perm-ids.txt 2>/dev/null || true
import json, sys
try:
    ds = json.load(open('/tmp/perm.json'))
except Exception:
    raise SystemExit
for p in ds if isinstance(ds, list) else []:
    if p.get('sessionID') == sys.argv[1]:
        print(p['id'])
PY
    while read -r pid; do
      [ -n "$pid" ] || continue
      echo "duyet quyen $pid"
      oc "curl -sS -o /dev/null -w 'tra loi quyen: HTTP %{http_code}\n' --max-time 10 $H -X POST -H 'Content-Type: application/json' -d '{\"response\":\"once\"}' $BASE/session/$ses/permissions/$pid"
    done < /tmp/perm-ids.txt
    sleep 3
  done

  # 5. Doi luong dong lai (timeout 90 het han).
  wait "$bg" 2>/dev/null

  echo "########## THONG KE SU KIEN ##########"
  oc "cat $RA" | sed "$BIEU" | python3 -c "
import json,sys,collections
dem = collections.Counter()
thu_tu = []
tong = 0
for dong in sys.stdin:
    dong = dong.strip()
    if not dong.startswith('data: '):
        continue
    tong += 1
    try:
        ev = json.loads(dong[6:])
    except Exception:
        continue
    t = ev.get('type', '?')
    dem[t] += 1
    if not thu_tu or thu_tu[-1] != t:
        thu_tu.append(t)
print('tong so su kien:', tong)
print()
print('--- theo loai (so lan) ---')
for t, n in dem.most_common():
    print('%5d  %s' % (n, t))
print()
print('--- THU TU xuat hien (da gop lan lien tiep) ---')
for t in thu_tu:
    print(' ', t)
"
  echo
  echo "########## PHIEN SAU KHI CHAY: co bao nhieu message ##########"
  oc "curl -sS --max-time 20 $H $BASE/session/$ses/message" | sed "$BIEU" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
except Exception as e:
    print('khong doc duoc:', e); raise SystemExit
print('so message:', len(d))
for m in d:
    info = m.get('info', m)
    parts = m.get('parts', [])
    print('-', info.get('role'), '| so part:', len(parts),
          '| loai part:', sorted({p.get('type') for p in parts}))
"
  echo
  echo "########## /session/{id}/diff sau luot chay ##########"
  oc "curl -sS -o /tmp/df.json -w 'HTTP %{http_code}\n' --max-time 20 $H $BASE/session/$ses/diff; head -c 300 /tmp/df.json"
  echo
  echo "########## xong ##########"
}

than 2>&1 | sed "$BIEU"

# File mau de dua vao docs/. Day la thu §17.2 doi.
docker exec opencode-server cat "$RA" 2>/dev/null | sed "$BIEU" > /tmp/opencode-events-live.jsonl
exit 0
