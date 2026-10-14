# Prints the links to open the board from another device, token included.
# ASCII only (see allow-lan.ps1 for why).
$root = $PSScriptRoot
$cfg = Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json
$port = $cfg.port
$token = $cfg.access.token

function Show-Link($label, $host_) {
  $url = "http://${host_}:${port}/"
  if ($token) { $url += "?token=$token" }
  Write-Host ("  {0,-22} {1}" -f $label, $url)
}

Write-Host ''
Write-Host 'Abre esto en el telefono (el token queda recordado en ese dispositivo):'
Write-Host ''
Show-Link 'en este equipo' 'localhost'

Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object {
    $_.IPAddress -notlike '127.*' -and
    $_.IPAddress -notlike '169.254.*' -and          # link-local: no llegan a ningun sitio
    $_.InterfaceAlias -notlike '*WSL*' -and
    $_.InterfaceAlias -notlike '*Loopback*'
  } |
  ForEach-Object {
    $label = if ($_.InterfaceAlias -like '*Tailscale*') { 'Tailscale' } else { 'red local' }
    Show-Link $label $_.IPAddress
  }

$ts = 'C:\Program Files\Tailscale\tailscale.exe'
if (Test-Path $ts) {
  $name = (& $ts status --json | ConvertFrom-Json).Self.DNSName
  if ($name) { Show-Link 'Tailscale (nombre)' $name.TrimEnd('.') }
} else {
  Write-Host ''
  Write-Host '  Tailscale no esta instalado: para entrar desde fuera de casa, instalalo'
  Write-Host '  en este equipo y en el telefono (https://tailscale.com/download).'
}

if (-not $token) {
  Write-Host ''
  Write-Host 'AVISO: no hay token en config.json. Cualquiera que alcance el puerto' -ForegroundColor Yellow
  Write-Host 'puede ejecutar comandos en esta maquina.' -ForegroundColor Yellow
}
Write-Host ''
