#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$ROOT/.hfs-monitor.pid"
if [[ ! -f "$PID_FILE" ]]; then echo "Live Monitor no tiene PID registrado."; exit 0; fi
pid="$(cat "$PID_FILE")"
if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]] || ! kill -0 "$pid" 2>/dev/null; then
  echo "Eliminando PID obsoleto."; rm -f "$PID_FILE"; exit 0
fi
if [[ ! -r "/proc/$pid/cmdline" ]] || [[ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" != "$ROOT/server" ]] ||
   ! tr '\0' ' ' < "/proc/$pid/cmdline" | grep -Eq '(^|[ /])src/index\.js([[:space:]]|$)'; then
  echo "PID $pid no corresponde a Live Monitor; no se detiene ningun proceso." >&2
  exit 1
fi
kill -TERM "$pid"
for _ in {1..40}; do
  if ! kill -0 "$pid" 2>/dev/null || [[ "$(ps -o stat= -p "$pid" 2>/dev/null | xargs)" == Z* ]]; then
    rm -f "$PID_FILE"
    echo "Live Monitor detenido ($pid)."
    exit 0
  fi
  sleep 0.25
done
echo "PID $pid no termino a tiempo; no se enviara SIGKILL automaticamente." >&2
exit 1
