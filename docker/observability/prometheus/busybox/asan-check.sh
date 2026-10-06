#!/bin/sh
set -eu
export LC_ALL=C SOURCE_DATE_EPOCH=1778630400
export ASAN_OPTIONS=detect_leaks=0:halt_on_error=1:abort_on_error=0
ulimit -c 0
report_failure() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    printf 'ASAN verification failed (exit %s).\n' "$status" >&2
    for log in /out/busybox/asan-configure.log /out/busybox/asan-build.log /out/busybox/asan-results.txt; do
      if [ -f "$log" ]; then
        printf '%s\n' "--- $log (tail) ---" >&2
        tail -n 160 "$log" >&2
      fi
    done
    for log in /out/busybox/baseline-*.err /out/busybox/patched-*.err; do
      if [ -f "$log" ]; then
        printf '%s\n' "--- $log ---" >&2
        cat "$log" >&2
      fi
    done
  fi
  exit "$status"
}
trap report_failure EXIT
mkdir /work/asan
tar -xjf /work/busybox.tar.bz2 -C /work/asan --strip-components=1
cd /work/asan
patch --batch --fuzz=0 -p1 < /patches/no-cbq.patch
cp /out/busybox/config .config
sed -i 's/^# CONFIG_DEBUG is not set/CONFIG_DEBUG=y/' .config
make oldconfig > /out/busybox/asan-configure.log
compile() {
  make -j2 EXTRA_CFLAGS='-O1 -g -fsanitize=address -fno-omit-frame-pointer -fno-pie' EXTRA_LDFLAGS='-fsanitize=address -no-pie' busybox >> /out/busybox/asan-build.log 2>&1
}
compile
# The vulnerable tree has no exception cleanup helper. This source invariant
# complements the runtime reproducer because the disclosure can stay inside an
# addressable stack allocation and therefore need not trip ASAN.
! grep -q 'restore_handler_expandarg' shell/ash.c
cat > /work/awk-uaf.awk <<'EOF'
BEGIN {
  r=sprintf("%01024d",0)
  s="a"
  sub((r="a"),r,s)
}
EOF
cat > /work/ash-ifs.sh <<'EOF'
M='AAAAAAAAAAAAAAAAA'
q00() {
<<000;echo
${D?$M$M$M$M$M$M}
000
}
q00
EOF
cat > /work/ash-recursion.sh <<'EOF'
f() { f; }
f
EOF
run_case() {
  phase=$1
  name=$2
  applet=$3
  input=$4
  set +e
  if [ "$applet" = awk ]; then
    timeout 20 ./busybox "$applet" -f "$input" > "/out/busybox/$phase-$name.out" 2> "/out/busybox/$phase-$name.err"
  else
    timeout 20 ./busybox "$applet" "$input" > "/out/busybox/$phase-$name.out" 2> "/out/busybox/$phase-$name.err"
  fi
  status=$?
  set -e
  printf '%s %s exit=%s\n' "$phase" "$name" "$status" >> /out/busybox/asan-results.txt
  test "$status" -ne 124
  if [ "$phase" = baseline ]; then
    case "$name" in
      awk-uaf|ash-recursion)
        test "$status" -ne 0
        grep -q 'ERROR: AddressSanitizer:' "/out/busybox/$phase-$name.err"
        ;;
      # The IFS defect is an out-of-bounds disclosure from still-addressable
      # stack storage, so ASAN does not reliably classify it. Exercise the
      # upstream reproducer in both trees and verify the source fix separately.
      ash-ifs) test "$status" -eq 0 ;;
    esac
  else
    ! grep -q 'AddressSanitizer' "/out/busybox/$phase-$name.err"
    case "$name" in
      awk-uaf) test "$status" -eq 0 ;;
      ash-ifs) test "$status" -eq 0 ;;
      ash-recursion) test "$status" -eq 2; grep -q 'function recursion limit exceeded' "/out/busybox/$phase-$name.err" ;;
    esac
  fi
}
run_case baseline awk-uaf awk /work/awk-uaf.awk
run_case baseline ash-ifs ash /work/ash-ifs.sh
run_case baseline ash-recursion ash /work/ash-recursion.sh
for name in awk-sub-uaf ash-ifs-cleanup ash-recursion-limit; do
  patch --batch --fuzz=0 -p1 < "/patches/$name.patch"
done
# One helper definition and three exception-path call sites are required by the
# upstream IFS cleanup fix; fuzzed or partial application is already forbidden.
test "$(grep -c 'restore_handler_expandarg' shell/ash.c)" -eq 4
compile
run_case patched awk-uaf awk /work/awk-uaf.awk
run_case patched ash-ifs ash /work/ash-ifs.sh
run_case patched ash-recursion ash /work/ash-recursion.sh
cp /asan-check.sh /out/busybox/
cp /work/awk-uaf.awk /work/ash-ifs.sh /work/ash-recursion.sh /out/busybox/
printf 'PASS: two sanitizer regressions plus the ash IFS source fix and reproducer were verified\n'
