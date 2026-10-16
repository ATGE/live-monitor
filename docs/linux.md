# Live Monitor on Ubuntu / Kubuntu

This is a **native Linux** board setup, not a container and not the future Codex provider integration.

## Prerequisites

- Node.js 22+ (Vite 8 requires a recent Node 20.19+ or Node 22.12+; Node 22 LTS is recommended).
- npm, git, GitHub CLI (`gh`).
- Claude Code login is required **to execute Claude-backed tasks**, not to display the web board. The existing poller may still inspect GitHub at startup; do not connect production projects during the initial pilot.
- Linux with `/proc` mounted (Ubuntu/Kubuntu).

## Setup and start

```bash
git clone https://github.com/ATGE/live-monitor.git
cd live-monitor
# Once the PR is merged, these scripts will be on main.
npm ci --prefix server
npm ci --prefix web
npm run build --prefix web
cp config.local.example.json config.local.json
```

Edit `config.local.json` to provide Linux paths, for example:

```json
{
  "project": {
    "repoPath": "/home/YOU/dev/test-repo",
    "worktreeRoot": "/home/YOU/dev/test-worktrees"
  },
  "access": { "token": "replace-with-a-random-token" }
}
```

Generate a strong token using `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. The overlay is ignored by Git; never commit credentials. Point at an expendable test repository to begin with, **not Kovar production**. The default `config.json` has no GitHub repository, so configure the project/repository before using issue polling.

```bash
bash start.sh
# http://127.0.0.1:7420
bash stop.sh
bash restart.sh
tail -f hfs-monitor.log hfs-monitor.err.log
```

The first start installs missing dependencies and builds the frontend if absent. To rebuild after frontend changes, run `npm run build --prefix web` before restart. To run in the foreground instead, use `HFSMON_BIND_HOST=127.0.0.1 node server/src/index.js` after installation and build.

## Access/security

On Linux the application defaults to **127.0.0.1** binding, even when `access.token` is unset. Unlike Windows' historical bind, the Linux board is not exposed on LAN/Tailscale by default. `HFSMON_BIND_HOST` can explicitly override the binding; setting it to `0.0.0.0` is **unsafe without authentication and a restrictive firewall**. A direct local process can still access powerful board features; run as an unprivileged user.

This is a limited Linux pilot, not a complete security redesign or isolation boundary. Current UI features such as in-board restart and the SDK upgrade handoff are Windows-centric and should remain unsupported here.

## Verification

```bash
curl --noproxy '*' -I http://127.0.0.1:7420/
ss -ltnp | grep ':7420'
npm test
```

For a complete agent end-to-end task, sign into `gh` and the official `claude` CLI and configure a **test** project and assignment. The Codex integration will be delivered separately.
