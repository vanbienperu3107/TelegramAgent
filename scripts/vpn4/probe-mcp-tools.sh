#!/bin/bash
# Do xem MCP server co THUC SU chay trong container khong, va chung cung cap
# nhung tool gi.
#
# Vi sao phai do thay vi tin vao opencode.json: cau hinh chi la LOI KHAI BAO.
# MCP cuc bo chay bang `npx -y <goi>`, tuc phai tai goi tu Internet luc khoi
# dong — trong mot container mem_limit 576m, khong co cache npm, tren mot may o
# Peru. Bat ky buoc nao trong do hong thi OpenCode BO QUA MCP do IM LANG: khong
# loi, khong canh bao, chi la agent khong co tool va tra loi "minh khong lam
# duoc" — dung trieu chung nguoi dung da gap.
#
# Cau hoi cu the can tra loi:
#   1. MCP nao dang song? (context7, exa, tavily)
#   2. Co tool nao TIM ANH khong? (de biet co the tra ve URL anh that hay khong)
set -uo pipefail

ENVFILE=/opt/opencode/.env.opencode
BASE="http://127.0.0.1:4096"

doc_bien() { sed -n "s/^$1=//p" "$ENVFILE" 2>/dev/null | head -1; }
PASS=$(doc_bien OPENCODE_SERVER_PASSWORD)
APIKEY=$(doc_bien CLIPROXY_API_KEY)
EXAKEY=$(doc_bien EXA_API_KEY)
TAVKEY=$(doc_bien TAVILY_API_KEY)
thoat_sed() { printf '%s' "$1" | sed 's/[|&\\]/\\&/g'; }
BIEU="s/khong-doi-gi/khong-doi-gi/"
for k in "$PASS" "$APIKEY" "$EXAKEY" "$TAVKEY"; do
  [ -n "$k" ] && BIEU="$BIEU; s|$(thoat_sed "$k")|***BIMAT***|g"
done

H='-H "Authorization: Basic $(printf "opencode:%s" "$OPENCODE_SERVER_PASSWORD" | base64 -w0)"'
oc() { docker exec opencode-server sh -c "$1"; }

than() {
  echo "########## 1. MCP server dang o trang thai nao ##########"
  oc "curl -sS --max-time 25 $H $BASE/mcp" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
except Exception as e:
    print('khong doc duoc /mcp:', e); raise SystemExit
if isinstance(d, dict):
    for ten, v in d.items():
        if isinstance(v, dict):
            print('%-12s status=%s  loi=%s' % (ten, v.get('status'), str(v.get('error'))[:120]))
        else:
            print('%-12s %s' % (ten, str(v)[:120]))
else:
    print(json.dumps(d)[:800])
"

  echo
  echo "########## 2. Danh sach tool (ke ca tool do MCP cung cap) ##########"
  oc "curl -sS --max-time 25 $H $BASE/experimental/tool/ids" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
except Exception as e:
    print('khong doc duoc:', e); raise SystemExit
ids = d if isinstance(d, list) else d.get('ids', [])
print('tong so tool:', len(ids))
# Tach tool cua MCP ra khoi tool loi cua OpenCode: ten tool MCP co tien to la
# ten server trong opencode.json.
for tien_to in ('context7', 'exa', 'tavily', 'brave'):
    khop = [t for t in ids if str(t).startswith(tien_to)]
    print('  %-10s -> %d tool: %s' % (tien_to, len(khop), ', '.join(map(str, khop[:8]))))
print()
print('--- tool co ve lien quan toi ANH ---')
anh = [t for t in ids if any(k in str(t).lower() for k in ('image', 'photo', 'picture', 'anh'))]
print(anh if anh else 'KHONG CO tool nao co ten lien quan toi anh')
"

  echo
  echo "########## 3. Log khoi dong MCP (20 dong cuoi co chu mcp) ##########"
  docker logs opencode-server 2>&1 | grep -i mcp | tail -20 || echo "khong co dong log nao nhac toi mcp"
}

than 2>&1 | sed "$BIEU"
exit 0
