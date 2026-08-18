#!/bin/bash
# Do be mat API cua opencode-server DANG CHAY tren vpn4.
#
# Plan (§17.2) ghi 8 endpoint la "?" va cam viet Event Processor truoc khi co mau
# su kien that. Script nay tra loi tung cau hoi do bang cach hoi chinh server,
# thay vi doan tu tai lieu.
#
# Chay trong container opencode-server (co curl tu ban vá healthcheck). Ghi ket
# qua ra /tmp de workflow tai ve lam artifact.
set -uo pipefail   # KHONG dung -e: muc dich la thu tung endpoint, ke ca cai hong

OC="docker exec opencode-server"
BASE="http://127.0.0.1:4096"

hoi() {
  local ten="$1" method="$2" duong_dan="$3" body="${4:-}"
  echo "--- $ten: $method $duong_dan"
  if [ -n "$body" ]; then
    $OC curl -sS -o /tmp/r.json -w 'HTTP %{http_code}\n' --max-time 10 \
      -X "$method" -H 'Content-Type: application/json' -d "$body" "$BASE$duong_dan"
  else
    $OC curl -sS -o /tmp/r.json -w 'HTTP %{http_code}\n' --max-time 10 \
      -X "$method" "$BASE$duong_dan"
  fi
  $OC head -c 600 /tmp/r.json
  echo
}

echo "########## 1. Endpoint co doi xac thuc khong ##########"
hoi "health" GET /global/health

echo "########## 2. Dac ta OpenAPI ##########"
$OC curl -sS --max-time 15 "$BASE/doc" > /tmp/opencode-openapi.json 2>/dev/null
echo "kich thuoc /doc: $(stat -c %s /tmp/opencode-openapi.json 2>/dev/null || echo 0) byte"
echo "--- danh sach duong dan trong OpenAPI ---"
python3 -c "
import json
try:
    d = json.load(open('/tmp/opencode-openapi.json'))
except Exception as e:
    print('khong doc duoc:', e); raise SystemExit
for duong_dan, muc in sorted((d.get('paths') or {}).items()):
    for m in muc:
        if m in ('get','post','put','delete','patch'):
            print('%-6s %s' % (m.upper(), duong_dan))
" 2>&1

echo "########## 3. Provider va model ##########"
hoi "config" GET /config
hoi "providers" GET /config/providers

echo "########## 4. Agent — cau hoi con treo cua §13 ##########"
hoi "agent" GET /agent
hoi "config-agent" GET /config/agent

echo "########## 5. Session ##########"
hoi "liet session" GET /session
echo "--- tao mot session thu ---"
$OC curl -sS -o /tmp/ses.json -w 'HTTP %{http_code}\n' --max-time 15 \
  -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/session"
$OC head -c 400 /tmp/ses.json
echo

echo "########## 6. Luong su kien — CO REPLAY KHONG ##########"
# Chup 8 giay. Neu stream gui lai su kien cu khi noi lai thi se thay o day.
$OC timeout 8 curl -sN --max-time 8 "$BASE/global/event" > /tmp/opencode-events.jsonl 2>/dev/null
echo "so dong su kien bat duoc: $($OC wc -l < /tmp/opencode-events.jsonl 2>/dev/null || echo 0)"
echo "--- 5 dong dau ---"
$OC head -c 800 /tmp/opencode-events.jsonl
echo

echo "########## 7. Cac endpoint §17.1 khang dinh la co ##########"
for p in /session /global/event /global/health /doc; do
  echo -n "$p -> "
  $OC curl -sS -o /dev/null -w '%{http_code}\n' --max-time 5 "$BASE$p"
done

echo "########## xong ##########"
