#!/usr/bin/env bash
# Read-only Ubuntu/Incus troubleshooting. No sudo, no sysctl changes.
set -uo pipefail
printf '=== SYSTEM ===\n'
. /etc/os-release 2>/dev/null || true
printf 'OS=%s %s\n' "${ID:-unknown}" "${VERSION_ID:-unknown}"
uname -r
printf '\n=== CODEX ===\n'
codex --version || true
printf '\n=== BUBBLEWRAP ===\n'
if command -v bwrap >/dev/null 2>&1; then
  command -v bwrap
  bwrap --version
else
  echo 'BWRAP_NOT_ON_PATH (install bubblewrap and apparmor-profiles inside dev-vm)'
fi
printf '\n=== NAMESPACE / APPARMOR ===\n'
for key in kernel.unprivileged_userns_clone user.max_user_namespaces kernel.apparmor_restrict_unprivileged_userns; do
  sysctl "$key" 2>/dev/null || true
done
if [[ -r /proc/self/attr/current ]]; then
  printf 'CURRENT_APPARMOR_PROFILE='
  cat /proc/self/attr/current
fi
printf '\n=== USER NAMESPACE (read-only) ===\n'
if unshare -Ur /bin/true; then echo 'UNSHARE_USERNS=PASS'; else echo 'UNSHARE_USERNS=BLOCKED_FOR_UNCONFINED_PROCESS (expected even with a scoped Bubblewrap profile)'; fi
printf '\n=== CODEX SANDBOX (read-only) ===\n'
if codex sandbox linux /bin/true; then
  echo 'CODEX_SANDBOX=PASS'
else
  rc=$?
  echo "CODEX_SANDBOX=FAIL EXIT_CODE=$rc"
fi
printf '\n=== APPARMOR PROFILE SOURCES ===\n'
for file in /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict; do
  if [[ -f "$file" ]]; then echo "FOUND $file"; else echo "MISSING $file"; fi
done
printf '\n=== INSTALLED PACKAGES / PROFILE CONFLICT CHECK ===\n'
for pkg in bubblewrap apparmor-profiles apparmor-utils; do
  dpkg-query -W -f='${Package}=${Status} ${Version}\n' "$pkg" 2>/dev/null || echo "NOT_INSTALLED $pkg"
done
for p in /etc/apparmor.d/bwrap /etc/apparmor.d/usr.bin.bwrap; do
  if [[ -e "$p" ]]; then echo "OTHER_BWRAP_PROFILE_PRESENT $p (review before installing another profile)"; fi
done
printf '\nNOTE: a raw unshare -Ur may still fail even when the profiled bwrap command succeeds.\n'
printf 'NOTE: test Codex sandbox directly, and keep kernel.apparmor_restrict_unprivileged_userns=1.\n'

