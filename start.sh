#!/usr/bin/env bash
# Linux native launcher. Run with: bash start.sh
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$ROOT/.hfs-monitor.pid"
LOG="$ROOT/hfs-monitor.log"
ERR="$ROOT/hfs-monitor.err.log"
cd "$ROOT"

is_board_pid() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  [[ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" == "$ROOT/server" ]] || return 1
  tr '\0' ' ' < "/proc/$pid/cmdline" | grep -Eq '(^|[ /])src/index\.js([[:space:]]|$)'
}

if [[ -f "$PID_FILE" ]]; then
  old="$(cat "$PID_FILE")"
  if is_board_pid "$old"; then
    echo "Live Monitor ya esta activo (PID $old)."
    exit 1
  fi
  echo "Eliminando PID obsoleto de Live Monitor."
  rm -f "$PID_FILE"
fi

command -v node >/dev/null || { echo "Falta Node.js" >&2; exit 1; }
command -v npm >/dev/null || { echo "Falta npm" >&2; exit 1; }
if [[ ! -d server/node_modules ]]; then
  echo "Instalando dependencias del servidor..."
  npm ci --prefix server
fi
if [[ ! -d web/node_modules ]]; then
  echo "Instalando dependencias web..."
  npm ci --prefix web
fi
if [[ ! -f web/dist/index.html ]]; then
  echo "Compilando frontend..."
  npm run build --prefix web
fi

# Do not inherit incidental npm/Claude SDK variables from a parent agent.
while IFS='=' read -r name _; do
  case "$name" in npm_*|INIT_CWD|CLAUDECODE|CLAUDE_CODE_*|ANTHROPIC_*) unset "$name" ;; esac
done < <(env)
export HFSMON_BIND_HOST="${HFSMON_BIND_HOST:-127.0.0.1}"
echo "Iniciando Live Monitor en ${HFSMON_BIND_HOST} (puerto configurado)..."
(
  cd "$ROOT/server"
  nohup node src/index.js >>"$LOG" 2>>"$ERR" </dev/null &
  echo $! >"$PID_FILE"
)
pid="$(cat "$PID_FILE")"
for _ in {1..60}; do
  if ! is_board_pid "$pid"; then
    echo "El servidor termino durante el arranque. Errores:" >&2
    tail -n 30 "$ERR" >&2 || true
    rm -f "$PID_FILE"
    exit 1
  fi
  if grep -q 'hfs-monitor escuchando en' "$LOG" 2>/dev/null; then
    # Do not trust old log lines from a previous start: verify the local HTTP port.
    port="$(node -e 'const fs=require("fs"),path=require("path");let c=JSON.parse(fs.readFileSync("config.json"));let p="config.local.json";if(fs.existsSync(p)){let x=JSON.parse(fs.readFileSync(p));if(x.port!=null)c.port=x.port;}console.log(c.port)' 2>/dev/null)" || port=7420
    if command -v curl >/dev/null && curl --noproxy '*' -fsS -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then
      echo "Live Monitor activo (PID $pid): http://127.0.0.1:$port"
      exit 0
    fi
  fi
  sleep 0.5
done
echo "Proceso activo (PID $pid), pero no respondio en localhost. Revisa $ERR y $LOG." >&2
exit 1
