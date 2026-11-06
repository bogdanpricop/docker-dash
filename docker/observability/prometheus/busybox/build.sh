#!/bin/sh
set -eu
export SOURCE_DATE_EPOCH=1778630400 LC_ALL=C
mkdir -p /out/busybox /work
report_failure() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    printf 'BusyBox build verification failed (exit %s).\n' "$status" >&2
    for log in /out/busybox/configure.log /out/busybox/build.log \
      /out/busybox/regression.log /out/busybox/libc-capabilities.log \
      /out/busybox/awk-known-bug-skip.diff /out/busybox/awk-tests.log; do
      if [ -f "$log" ]; then
        printf '%s\n' "--- $log (tail) ---" >&2
        tail -n 160 "$log" >&2
      fi
    done
  fi
  exit "$status"
}
trap report_failure EXIT
cd /work
curl --fail --location --retry 3 -o busybox.tar.bz2 https://busybox.net/downloads/busybox-1.38.0.tar.bz2
echo '34f9ea6ff8636f2c9241153b9114eefa9e65674a45318ae1ef95bb5f31c53bb2  busybox.tar.bz2' | sha256sum -c -
tar -xjf busybox.tar.bz2
cd busybox-1.38.0
cat > /tmp/patches.sha256 <<'EOF'
8451446ee0c7128f3eaca0322f113dadc11d1c05f616f6543a77908648f50785  /patches/no-cbq.patch
07101903fbcd902e2a5559c181fd65966f8984b8c32f2603316f8e6cc72e726a  /patches/wget-request-target.patch
744e2d821611f6e9cedd0570200594d42376c28d999e75f2152e74f192fb6343  /patches/awk-sub-uaf.patch
76193a331c1b43d583a45a607013687a2608240bcbe92a9af67f0ea749271f71  /patches/ash-ifs-cleanup.patch
467613365c18524a107ea17586220ab327e6b8140a47990df73fc3e5d0d0f973  /patches/ash-recursion-limit.patch
3c1bb891789eaa8cae6c19df15455e72bf7ab9c43c65bba453493ebc551e2ec0  /patches/awk-wordmatch-test-skip.patch
EOF
sha256sum -c /tmp/patches.sha256
for name in no-cbq wget-request-target awk-sub-uaf ash-ifs-cleanup ash-recursion-limit awk-wordmatch-test-skip; do
  patch --batch --fuzz=0 -p1 < "/patches/$name.patch"
done
if [ "${BUSYBOX_REFERENCE_PROFILE:-prometheus}" = grafana ]; then
  # Reuse Alpine 3.24's exact package configuration so replacing BusyBox does
  # not add or remove applets from the official Grafana image.
  echo '65b29f6085cd79ab5f032d7e4299534a86c3efad240e78c16186a19bf847fcca  /alpine-3.24.config' | sha256sum -c -
  cp /alpine-3.24.config .config
  # BusyBox 1.38 adds applets that were not present in Alpine's 1.37 config.
  # Keep them disabled so the runtime command surface remains byte-for-byte
  # comparable by applet name with the official Grafana image.
  for key in CONFIG_LSBLK CONFIG_SHA384SUM CONFIG_SSL_SERVER CONFIG_UUIDGEN CONFIG_VMSTAT; do
    sed -i -e "s/^$key=.*/# $key is not set/" .config
    grep -q "^# $key is not set$" .config || echo "# $key is not set" >> .config
  done
  : > /out/busybox/configure.log
else
  # Match Docker Official Images' glibc BusyBox configuration.
  make defconfig > /out/busybox/configure.log
  for setting in CONFIG_AR=y CONFIG_FEATURE_AR_CREATE=y CONFIG_FEATURE_AR_LONG_FILENAMES=y CONFIG_LAST_SUPPORTED_WCHAR=0 CONFIG_INOTIFYD=y; do
    key=${setting%=*}
    sed -i -e "s/^$key=.*/$setting/" -e "s/^# $key is not set/$setting/" .config
    grep -qx "$setting" .config
  done
fi
sed -i 's/^CONFIG_FEATURE_SYNC_FANCY=.*/# CONFIG_FEATURE_SYNC_FANCY is not set/' .config
if [ "${BUSYBOX_STATIC:-0}" = 1 ]; then
  sed -i 's/^# CONFIG_STATIC is not set/CONFIG_STATIC=y/' .config
fi
if [ "${BUSYBOX_REFERENCE_PROFILE:-prometheus}" = grafana ]; then
  yes '' | make oldconfig >> /out/busybox/configure.log
else
  make oldconfig >> /out/busybox/configure.log
fi
make -j2 busybox > /out/busybox/build.log 2>&1
gcc --version > /out/busybox/compiler.txt
readelf -l busybox > /out/busybox/elf-program-headers.txt
if [ "${BUSYBOX_STATIC:-0}" = 1 ]; then
  ! grep -q INTERP /out/busybox/elf-program-headers.txt
fi
./busybox --list > /out/busybox/applets.txt
/reference/busybox --list > /out/busybox/upstream-applets.txt
sort -o /out/busybox/applets.txt /out/busybox/applets.txt
sort -o /out/busybox/upstream-applets.txt /out/busybox/upstream-applets.txt
diff -u /out/busybox/upstream-applets.txt /out/busybox/applets.txt
cp busybox /out/busybox.bin
cp .config /out/busybox/config
cp LICENSE /out/busybox/LICENSE
cp /patches/*.patch /out/busybox/
cp /patches.json /out/busybox/patches.json
if [ "${BUSYBOX_REFERENCE_PROFILE:-prometheus}" = grafana ]; then
  cp /alpine-3.24.config /out/busybox/alpine-3.24.config
fi
cp /build-busybox.sh /out/busybox/build.sh
cp /regression.sh /out/busybox/regression.sh
cp /work/busybox.tar.bz2 /out/busybox/source-1.38.0.tar.bz2
sha256sum busybox > /out/busybox/binary.sha256
# Basic recursion, command substitution and text processing remain available.
sh /regression.sh "$PWD/busybox" > /out/busybox/regression.log 2>&1
# Run the upstream AWK suite against the patched full configuration.
cat > /tmp/check-reg-startend.c <<'EOF'
#include <regex.h>
#ifndef REG_STARTEND
#error REG_STARTEND is unavailable
#endif
int main(void) { return 0; }
EOF
wordmatch="$(./busybox awk 'BEGIN { a="abc"; gsub(/\<b*/,"",a); print a }')"
if gcc -Werror -c /tmp/check-reg-startend.c -o /tmp/check-reg-startend.o \
    > /out/busybox/libc-capabilities.log 2>&1; then
  printf 'REG_STARTEND=available; wordmatch=%s\n' "$wordmatch" >> /out/busybox/libc-capabilities.log
  printf 'AWK suite capability: REG_STARTEND=available wordmatch=%s\n' "$wordmatch"
  test "$wordmatch" = abc
  ./runtest -v awk > /out/busybox/awk-tests.log 2>&1
else
  # BusyBox upstream documents this one word-boundary substitution test as a
  # known limitation on libc implementations without the non-POSIX BSD
  # REG_STARTEND extension. musl deliberately lacks it. Skip only that named
  # upstream case and record both the capability result and actual behaviour;
  # every other AWK test and all security reproducers still run.
  printf 'REG_STARTEND=unavailable; wordmatch=%s; skipped upstream known-bug case SKIP_KNOWN_BUG_AWK_WORDMATCH\n' \
    "$wordmatch" >> /out/busybox/libc-capabilities.log
  printf 'AWK suite capability: REG_STARTEND=unavailable wordmatch=%s\n' "$wordmatch"
  test "$wordmatch" = ac
  export SKIP_KNOWN_BUG_AWK_WORDMATCH=1
  ./runtest -v awk > /out/busybox/awk-tests.log 2>&1
fi
printf 'BusyBox security rebuild and applet compatibility checks passed.\n'
