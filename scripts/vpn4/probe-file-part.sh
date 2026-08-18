#!/bin/bash
# Do XEM khi agent "tao hinh anh mo ta", message tra ve co FilePart that hay
# chi la van ban co nhac toi anh (URL/markdown) ma Gateway khong render duoc.
#
# Ly do can do thay vi doan: nguoi dung bao "cho xin hinh anh mo ta" -> bot tra
# loi mot cau caption roi KHONG CO GI KHAC hien ra. Hai gia thuyet khac nhau doi
# hai cach sua khac nhau:
#   A. OpenCode tra ve mot FilePart (type:"file") va Gateway dang bo qua no khi
#      ghep vanTraLoiCuoi (chi loc type==='text') -> phai them duong gui anh.
#   B. Khong co FilePart nao ca — model chi mo ta bang loi, khong the tao anh that
#      (moi model cua ta khai modalities.output = ["text"]) -> day la loi PROMPT/
#      UX (agent hua ho), khong phai loi Gateway thieu tinh nang.
set -uo pipefail

ENVFILE=/opt/opencode/.env.opencode
BASE="http://127.0.0.1:4096"

doc_bien() { sed -n "s/^$1=//p" "$ENVFILE" 2>/dev/null | head -1; }
PASS=$(doc_bien OPENCODE_SERVER_PASSWORD)
APIKEY=$(doc_bien CLIPROXY_API_KEY)
thoat_sed() { printf '%s' "$1" | sed 's/[|&\\]/\\&/g'; }
BIEU="s/khong-doi-gi/khong-doi-gi/"
if [ -n "$PASS" ];   then BIEU="$BIEU; s|$(thoat_sed "$PASS")|***MATKHAU***|g"; fi
if [ -n "$APIKEY" ]; then BIEU="$BIEU; s|$(thoat_sed "$APIKEY")|***APIKEY***|g"; fi

H='-H "Authorization: Basic $(printf "opencode:%s" "$OPENCODE_SERVER_PASSWORD" | base64 -w0)"'
oc() { docker exec opencode-server sh -c "$1"; }

than() {
  local ses
  ses=$(oc "curl -sS --max-time 20 $H -X POST -H 'Content-Type: application/json' -d '{}' $BASE/session" \
        | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
  echo "phien do: $ses"

  # DUNG CAU HOI CUA NGUOI DUNG, khong doi chu — do la cach duy nhat tai lap
  # dung hanh vi ho gap, thay vi doan mot cau khac roi ket luan tren mot tinh
  # huong khac.
  local than_json
  than_json='{"model":{"providerID":"cliproxy","modelID":"claude-sonnet-5"},"agent":"build","parts":[{"type":"text","text":"Cho xin hinh anh mo ta mot vai loai trai cay ngot o Peru."}]}'
  oc "curl -sS -o /tmp/pr.json -w 'HTTP %{http_code}\n' --max-time 30 $H -X POST -H 'Content-Type: application/json' -d '$than_json' $BASE/session/$ses/prompt_async"

  # Doi + tu duyet, giong pattern cua probe-opencode-events.sh.
  local vong=0
  while [ "$vong" -lt 40 ]; do
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
      oc "curl -sS -o /dev/null -w 'duyet quyen: HTTP %{http_code}\n' --max-time 10 $H -X POST -H 'Content-Type: application/json' -d '{\"response\":\"once\"}' $BASE/session/$ses/permissions/$pid"
    done < /tmp/perm-ids.txt

    local status
    status=$(oc "curl -sS --max-time 10 $H $BASE/session/$ses" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print((d.get('status') or {}).get('type',''))
except Exception:
    print('')
")
    [ "$status" = "idle" ] && break
    sleep 3
  done

  echo "########## TOAN BO parts cua tin nhan cuoi (RAW, khong tom tat) ##########"
  oc "curl -sS --max-time 20 $H $BASE/session/$ses/message" | python3 -c "
import json,sys
d = json.load(sys.stdin)
if not d:
    print('KHONG CO message nao'); raise SystemExit
cuoi = d[-1]
print('role:', (cuoi.get('info') or {}).get('role'))
for p in cuoi.get('parts', []):
    t = p.get('type')
    if t == 'file':
        print('--- FILE PART ---')
        print(' mime    :', p.get('mime'))
        print(' filename:', p.get('filename'))
        print(' url     :', (p.get('url') or '')[:200])
        print(' source  :', json.dumps(p.get('source'))[:300])
    elif t == 'text':
        print('--- TEXT PART (', len(p.get('text','')), 'ky tu ) ---')
        print(' ', p.get('text','')[:600])
    else:
        print('--- part loai', t, '---')
"
  echo
  echo "########## co endpoint tao anh nao trong dac ta khong ##########"
  oc "curl -sS --max-time 20 $H $BASE/doc" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p,m in d.get('paths',{}).items():
    if 'image' in p.lower() or 'generate' in p.lower():
        print(list(m.keys()), p)
"
}

than 2>&1 | sed "$BIEU"
exit 0
