#!/bin/sh
set -eu
binary=$1
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

test "$("$binary" awk 'BEGIN { s="abc abc"; gsub(/abc/,"ok",s); print s }')" = 'ok ok'
"$binary" awk 'BEGIN { r=sprintf("%01024d",0); s="a"; sub((r="a"),r,s); if (length(s) < 1) exit 1 }'
test "$("$binary" ash -c 'f() { if [ "$1" -eq 0 ]; then echo ok; else f "$(( $1 - 1 ))"; fi; }; f 20')" = 'ok'
set +e
timeout 15 "$binary" ash -c 'f() { f; }; f' > "$scratch/recursion.out" 2> "$scratch/recursion.err"
status=$?
set -e
test "$status" -eq 2
grep -q 'function recursion limit exceeded' "$scratch/recursion.err"
test "$("$binary" ash -c 'x="one two"; set -- $x; printf "%s:%s" "$1" "$2"')" = 'one:two'

# CVE-2025-60876: raw controls or spaces in the request target must never
# reach the HTTP request line. Exercise the built wget applet against a real
# local listener so the proof covers URL parsing and request serialization.
unset http_proxy HTTP_PROXY https_proxy HTTPS_PROXY no_proxy NO_PROXY
base_port=$((18000 + ($$ % 1000)))
capture_request() {
  port=$1
  url=$2
  output=$3
  (printf 'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n' \
    | "$binary" nc -l -p "$port" > "$output") &
  listener=$!
  sleep 1
  "$binary" wget -q -O /dev/null "$url"
  wait "$listener"
}
capture_request "$base_port" "http://127.0.0.1:$base_port/foo bar" "$scratch/space.request"
tr -d '\r' < "$scratch/space.request" | grep -qx 'GET /foo%20bar HTTP/1.1'
newline_path=$(printf 'x\r\nEvil: injected')
capture_request "$((base_port + 1))" "http://127.0.0.1:$((base_port + 1))/$newline_path" "$scratch/control.request"
tr -d '\r' < "$scratch/control.request" | grep -qx 'GET /x%0D%0AEvil:%20injected HTTP/1.1'
! grep -q '^Evil:' "$scratch/control.request"

printf 'PASS: substitution, bounded recursion, shell word splitting and wget request-target encoding\n'
