// The install gate: what a triage or advisor session must not run while the
// board installs dependencies itself. Pure — no store, no config.
import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installProblem, INSTALL_GATED_PHASES, SAFE_CONCURRENT } from '../src/installgate.js';

const denied = [
  'npm ci',
  'npm install',
  'npm i',
  'npm add left-pad',
  'npm clean-install',
  'npm install-clean',
  'npm ic',
  'npm.cmd ci',
  '"C:\\Program Files\\nodejs\\npm.cmd" install',
  'npm --prefix web ci',
  'npm -C web install',
  'npm --cache /tmp/c i',
  'cd web && npm ci',
  'cd x; npm install',
  '(npm ci)',
  'npm ci | tail -5',
  'CI=1 npm ci',
  'env CI=1 npm ci',
  'timeout 600 npm ci',
  'bash -c "cd web && npm ci"',
  'bash.exe -c "npm ci"',
  'sh -lc \'npm install\'',
  'pwsh -Command "npm ci"',
  'powershell.exe -NoProfile -Command "cd web; npm install"',
  'cmd /c npm ci',
  'yarn',
  'yarn install',
  'yarn add react',
  'yarn --cwd web install',
  'pnpm install',
  'pnpm i',
  'pnpm add react',
  'pnpm --dir web install',
  'pip install -r requirements.txt',
  'pip3 install foo',
  'python -m pip install -e .',
  'python3 -m pip install foo',
  'py -m pip install foo',
  '".venv\\Scripts\\python.exe" -m pip install -r requirements.txt',
  '.venv/bin/python -m pip install -e .',
  'python -m venv .venv',
  'bundle',
  'bundle install',
  'composer install',
  'time npm ci',
  'sudo npm ci',
  'sudo -u builder npm install',
  'nice -n 5 npm ci',
  'nohup npm ci',
  'xargs npm ci',
  'npx npm ci',
  'corepack pnpm install',
  'time bash -c "npm ci"',
  // Issue #39, Part B: shell keywords and grouping.
  '{ npm ci; }',
  'if true; then npm ci; fi',
  'for d in web; do npm ci; done',
  'while true; do npm ci; done',
  'if npm ci; then echo ok; fi',
  '! npm ci',
  'true && { npm ci; }',
  'f() { npm ci; }',
  // Command substitution and backticks, quoted or not.
  'echo $(npm ci)',
  'x=$(npm ci)',
  'echo `npm ci`',
  'echo "$(npm ci)"',
  'echo "`npm ci`"',
  'FOO=$(pwd) npm ci',
  // Heredocs and here-strings fed to a shell, and a pipe into one.
  'cat <<EOF | sh\nnpm ci\nEOF',
  'bash <<EOF\nnpm ci\nEOF',
  'sh <<<"npm ci"',
  'echo npm ci | sh',
  // Inline code that spells a plain install.
  'node -e "require(\'child_process\').execSync(\'npm ci\')"',
  // Installers that write a dependency tree.
  'npm update',
  'npm up',
  'npm rebuild',
  'npm dedupe',
  'npm prune',
  'npm link',
  'npm install-test',
  'npm exec npm ci',
  'npm x npm ci',
  'npm exec -- npm ci',
  'npx --yes npm@10 ci',
  'yarn upgrade',
  'yarn up',
  'yarn workspaces focus',
  // `yarn --silent` is a bare yarn, which installs in yarn 1: it stays denied.
  'yarn --silent',
  'pnpm update',
  'pnpm remove', 'npm uninstall left-pad', 'yarn remove x', 'bunx npm ci',
  'pnpm up',
  'uv sync',
  'uv pip install x',
  'poetry install',
  'pipenv install',
  'bun install',
  'make install',
  'make -C web install',
  'find . -exec npm ci \\;',
  'find . -name package.json -execdir npm ci {} +',
  'busybox sh -c "npm ci"',
  // CRLF after a line continuation and `$HOME/bin/npm`: the program still reads as npm.
  'npm \\\r\nci',
  '$HOME/bin/npm ci',
  '"$WT/node_modules/.bin/npm" ci',
  // Post-merge review of #37/#38: workspaces, other runners, -c/--call, function, heredoc bodies, quote-aware $(…).
  'yarn workspace web install',
  'yarn workspace web add x',
  'yarn workspaces foreach install',
  'yarn workspaces foreach -A install',
  'pnpm exec npm ci',
  'yarn exec npm ci',
  'bun x npm ci',
  'npm exec -c "npm ci"',
  'npx -c "npm ci"',
  'npm x -c "npm ci"',
  'npm exec --call="npm ci"',
  'function f { npm ci; }; f',
  'function f() { npm ci; }; f',
  'cat <<EOF\n$(npm ci)\nEOF',
  'cat <<EOF\n`npm ci`\nEOF',
  "x=$(echo ')'; npm ci)",
  'echo $(echo ")"; npm ci)',
  'echo "$(echo ")"; npm ci)"',
  // Advisor round 2: apostrophes in heredocs/comments inside $( ), and runner flags.
  'git commit -m "$(cat <<\'EOF\'\nfix: it\'s done\nEOF\n)" && npm ci',
  'echo $(# it\'s\nls); npm ci',
  'x=$(ls # don\'t\n); npm ci',
  'npx -c "npm ci"',
  'yarn workspaces foreach -A exec npm ci',
  'yarn workspaces foreach --include x install',
];

// What it cannot read in the places that hide the answer is refused too, with
// a text that says how to rephrase.
const unreadable = [
  'bash -c "$CMD"',
  '$CMD x',
  '$(echo npm) ci',
  '"$(which npm)" ci',
  'npm $SUB',
  'ls | sh',
  'git diff | bash',
  'bash <<EOF\n$X\nEOF',
];

const allowed = [
  'yarn --version',
  'yarn --help',
  'yarn -v',
  'time cargo build',
  'sudo ls',
  'npx tsc --noEmit',
  'time git status',
  'npm run build',
  'npm test',
  'npm ls',
  'npm view react version',
  'npm run install',
  'npm --prefix web run build',
  'yarn build',
  'yarn --cwd web test',
  'pnpm run build',
  'pip list',
  'pip freeze',
  'python -m pytest',
  'python -m pip list',
  'bundle exec rspec',
  'composer show',
  'cargo fetch',
  'cargo build',
  'cargo check',
  'cargo test --no-run',
  'git status',
  'git log --oneline -5',
  'ls node_modules',
  'echo npm ci',
  'grep "npm install" README.md',
  'cat package.json | head',
  '',
  '   ',
  // Help, version and dry-run only print.
  'bundle --version',
  'bundle -v',
  'bundle -V',
  'npm install --dry-run',
  'npm ci --dry-run',
  'npm install -h',
  'pip install --help',
  'python -m pip install --help',
  'python -m venv --help',
  'pnpm install --help',
  'composer install --dry-run',
  'uv sync --help',
  // Variables and substitutions in ordinary places are readable enough.
  'ls "$WT"',
  'x=$(git rev-parse HEAD)',
  'echo $(git rev-parse HEAD)',
  'echo "$(date)"',
  'git -C "$WT" log --oneline -3',
  '$WT/node_modules/.bin/tsc --noEmit',
  'npm --prefix "$WT" run build',
  'npm --prefix "$WT" test',
  // Keywords and heredocs that carry no install.
  'if true; then echo ok; fi',
  'for d in web; do ls "$d"; done',
  '{ git status; }',
  '! git diff --quiet',
  'cat <<EOF\nnpm ci\nEOF',
  'cat <<EOF | head\nnpm ci\nEOF',
  'bash script.sh',
  'bash',
  'echo npm ci | grep ci',
  'node -e "console.log(1)"',
  'node script.js',
  'python -c "print(1)"',
  'find . -name "*.js"',
  'find . -exec grep -l x {} +',
  'npm exec tsc',
  'npx --yes tsc@5 --noEmit',
  'make test',
  'uv run pytest',
  'yarn workspace web test',
  'yarn workspace web run build',
  'yarn workspaces foreach -A run build',
  'yarn workspaces list',
  'yarn workspace web',
  'pnpm exec tsc',
  'yarn exec tsc',
  'bun x tsc',
  'npm exec -c "tsc --noEmit"',
  'npx -c "ls"',
  'function f { ls; }; f',
  "cat <<'EOF'\n$(npm ci)\nEOF",
  'cat <<"EOF"\n$(npm ci)\nEOF',
  'cat <<EOF\n$(git status)\nEOF',
  "x=$(echo ')'; git status)",
  'echo $(echo ")"; git status)',
  'git commit -m "$(cat <<\'EOF\'\nfix: it\'s done\nEOF\n)"',
  'gh pr create --body "$(cat <<\'EOF\'\nDon\'t merge (yet)\nEOF\n)"',
  'npx eslint -c "$CFG" src',
  'pnpm exec eslint -c $CFG .',
  'npm exec -- tsc -c "$X"',
  'npx tool -c "$(cat cfg)"',
  'yarn workspaces foreach --include install run build',
  'yarn workspaces foreach -j 2 run build',
];

// A wrapper only passes the line on: a later word that merely names an installer
// is an argument of the wrapped program, not the program.
const wrapperMentions = [
  'command -v yarn',
  'command -V yarn',
  'command -v bundle || echo no-bundler',
  'command -v yarn >/dev/null && echo has-yarn',
  'command -pv npm',
  'git ls-files | xargs grep -l yarn',
  'xargs -a files grep -c yarn',
  'git ls-files | xargs grep -ln bundle',
  'xargs -I {} grep -l pnpm {}',
  'xargs -n1 -P4 grep -c npm',
  'env CI=1 grep -c yarn file',
  'sudo -u builder grep -l bundle Gemfile',
  'nice -n 5 grep -c yarn x',
  'time grep -c pip requirements.txt',
  'nohup grep -c make log',
];

const wrapperInstalls = [
  'command npm install',
  'command -p npm ci',
  'xargs npm ci',
  'xargs -n1 npm i',
  'xargs -I {} npm i {}',
  'xargs -a files -n 1 npm ci',
  'echo web | xargs -I{} npm --prefix {} ci',
  'env CI=1 npm ci',
  'env -i npm ci',
  'env -u FOO npm ci',
  'nice npm ci',
  'nice -n 5 npm ci',
  'ionice -c 3 npm ci',
  'sudo npm install',
  'sudo -u builder npm install',
  'time npm ci',
  'time -p npm ci',
  'nohup npm ci',
  'timeout 60 npm ci',
  'exec npm ci',
  'stdbuf -oL npm ci',
  'setsid npm ci',
  'find . -exec npm ci \;',
  'sudo env CI=1 xargs -n1 npm i',
];

for (const command of wrapperMentions) {
  test(`allows a wrapper that only mentions an installer: ${command}`, () => {
    assert.equal(installProblem(command), null);
  });
}

for (const command of wrapperInstalls) {
  test(`denies a wrapper around an installer: ${command}`, () => {
    const problem = installProblem(command);
    assert.equal(typeof problem, 'string', `expected a denial for ${command}`);
    assert.doesNotMatch(problem, /Reescríbelo/);
  });
}

for (const command of denied) {
  test(`denies: ${command}`, () => {
    const problem = installProblem(command);
    assert.equal(typeof problem, 'string', `expected a denial for ${command}`);
    assert.ok(problem.length > 20);
  });
}

for (const command of unreadable) {
  test(`refuses as unreadable: ${JSON.stringify(command)}`, () => {
    const problem = installProblem(command);
    assert.equal(typeof problem, 'string', `expected a refusal for ${command}`);
    assert.match(problem, /Reescríbelo/, 'it says how to rephrase');
  });
}

test('an install is denied with the install text, not the rephrase one', () => {
  assert.doesNotMatch(installProblem('echo $(npm ci)'), /Reescríbelo/);
  assert.doesNotMatch(installProblem('if true; then npm ci; fi'), /Reescríbelo/);
});

for (const command of allowed) {
  test(`allows: ${JSON.stringify(command)}`, () => {
    assert.equal(installProblem(command), null);
  });
}

test('the denial says the board is installing and the session must not', () => {
  assert.match(installProblem('npm ci'), /tablero/);
  assert.match(installProblem('npm ci'), /instal/);
});

test('the gated stages are triage and advisor, nothing else', () => {
  assert.deepEqual([...INSTALL_GATED_PHASES], ['triage', 'advisor']);
  assert.ok(!INSTALL_GATED_PHASES.includes('fix'));
});

test('a thing that is not a string never throws', () => {
  for (const v of [undefined, null, 42, {}]) assert.equal(installProblem(v), null);
});

test('every command autodetectDependencies runs is denied or listed as safe', () => {
  const src = readFileSync(new URL('../src/pipeline.js', import.meta.url), 'utf8');
  const start = src.indexOf('async function autodetectDependencies');
  assert.ok(start > 0, 'autodetectDependencies is in pipeline.js');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  // The literal command strings: `commands: ['x']`, `push(\`${a} -m venv ..\`)` and the pip pair.
  const found = [
    ...[...body.matchAll(/commands: \['([^']+)'\]/g)].map((m) => m[1]),
    ...[...body.matchAll(/`\$\{(basePython|venvPython)\} (-m [^`]+)`/g)].map((m) => `python ${m[2]}`),
  ];
  assert.ok(found.length >= 4, `found the commands: ${found.join(' | ')}`);
  for (const command of found) {
    const ok = installProblem(command) !== null || SAFE_CONCURRENT.includes(command);
    assert.ok(ok, `autodetect runs «${command}» and the gate neither denies nor lists it`);
  }
});

test('cargo fetch is the only listed safe command and it is allowed', () => {
  assert.deepEqual([...SAFE_CONCURRENT], ['cargo fetch']);
  assert.equal(installProblem('cargo fetch'), null);
});

for (const command of ['if command -v yarn; then echo y; fi', 'command -pv bundle', 'sudo command -v yarn', 'timeout 5 xargs grep -l yarn']) {
  test(`allows a lookup or mention behind a wrapper: ${command}`, () => {
    assert.equal(installProblem(command), null);
  });
}

for (const command of ['sudo nice nohup timeout 5 npm ci', 'xargs -J % npm ci', 'sudo env CI=1 xargs -n1 npm i']) {
  test(`still denies a long wrapper chain: ${command}`, () => {
    assert.equal(typeof installProblem(command), 'string');
  });
}

// Combined short flags whose last letter takes a value, tool exec forms with the
// tool's own value flags, and `env -S` read again as a command line.
const clusterDenied = [
  'sudo -iu root npm ci', 'sudo -Eu root npm ci', 'sudo -Hu deploy yarn install', 'sudo -nu root pnpm i',
  'doas -su root npm ci', 'nohup sudo -iu root npm ci', 'xargs -rn 1 npm ci', 'xargs -tI {} npm i {}',
  'xargs -i npm ci', 'xargs -n1 npm ci', 'env -iC web npm ci', 'timeout -vk 1 5 npm ci', 'env -P /bin npm ci',
  'npx --registry x npm ci', 'npx --prefix web npm ci', 'npx -w web npm ci', 'npx --cache /tmp/c npm ci',
  'npx --loglevel silent npm ci', 'npm exec -w web npm ci', 'npm exec --workspace web npm ci',
  'npm exec --prefix web npm ci', 'pnpm exec --filter web npm ci', 'yarn workspaces foreach -A exec --cwd x npm ci',
  'xargs --process-slot-var V npm ci', 'env -S "npm ci"', 'env --split-string="npm ci"', 'env -S"npm ci"',
  'npx -c "npm ci"', 'npm exec --call="npm ci"', 'yarn workspace web add x', 'yarn workspaces foreach -A install',
  'yarn workspaces foreach -A exec npm ci', 'npm uninstall x', 'pnpm remove x', 'yarn remove x',
];
for (const command of clusterDenied) {
  test(`denies a cluster, exec-form or split-string install: ${command}`, () => {
    assert.equal(typeof installProblem(command), 'string');
  });
}

const clusterAllowed = [
  'bunx foo', 'command -v yarn', 'command -v bundle || echo no', 'git ls-files | xargs grep -l yarn',
  'xargs -a files grep -c yarn', 'sudo -u npm ci', 'xargs -n npm ci', 'sudo -iu root ls', 'xargs -rn 1 wc -l',
  'env -S "git status"', 'npx --registry x eslint .', 'npm exec -w web eslint .',
];
for (const command of clusterAllowed) {
  test(`allows a cluster or exec form that runs something harmless: ${command}`, () => {
    assert.equal(installProblem(command), null);
  });
}

// A wrapper flag missing from the tables may take a value: judge both readings.
const unknownFlagDenied = [
  'npx --omit dev npm ci', 'npx --tag x npm ci', 'npx --node-options x npm ci', 'npm exec --include dev npm ci',
  'doas -a style npm ci', 'sudo -c cls npm ci', 'env -a x npm ci', 'env --argv0 x npm ci',
];
for (const command of unknownFlagDenied) {
  test(`denies an install behind an unrecognised wrapper flag: ${command}`, () => {
    assert.equal(typeof installProblem(command), 'string');
  });
}

const unknownFlagAllowed = [
  'command -v yarn', 'command -v bundle || echo no-bundler', 'git ls-files | xargs grep -l yarn', 'xargs -a files grep -c yarn',
  'xargs grep -ln bundle', 'sudo -u deploy ls', 'sudo -u npm ci', 'xargs -n npm ci', 'env FOO=1 ls', 'timeout 5 git status',
  'env -a x ls', 'xargs -0 grep -l yarn', 'xargs -r wc -l',
];
for (const command of unknownFlagAllowed) {
  test(`allows a harmless command behind wrapper flags: ${command}`, () => {
    assert.equal(installProblem(command), null);
  });
}

test('a long whitespace-free line of assignment-like text is read in linear time', () => {
  for (const unit of ["'a=", ';a=', '(a=']) {
    const line = unit.repeat(Math.ceil(100000 / unit.length)).slice(0, 100000) + ' npm ci';
    const t0 = performance.now();
    const verdict = installProblem(line);
    const ms = performance.now() - t0;
    console.log(`adversarial ${JSON.stringify(unit)}: ${ms.toFixed(1)} ms`);
    assert.ok(ms < 500, `${JSON.stringify(unit)} took ${ms} ms`);
    assert.equal(typeof verdict, 'string');
  }
});

const wrapperRegressions = [
  // an unrecognised value flag followed by another flag
  'sudo -c x -E npm ci', 'doas -a style -n npm ci', 'xargs -R 5 -0 yarn install',
  // optional-attached GNU long options take no next word
  'env --default-signal npm ci', 'xargs --eof npm ci', 'xargs --max-lines npm ci', 'xargs --replace npm ci',
  // `--` ends the options but timeout's duration still comes first
  'timeout -- 5 npm ci', 'timeout -k 5 -- 10 npm ci', 'timeout --signal KILL -- 5 npm ci',
  // NAME=value words after `--`
  'env -- FOO=1 npm ci', 'sudo -- FOO=1 npm ci', 'sudo env -- FOO=1 npm ci',
];
for (const command of wrapperRegressions) {
  test(`denies an install behind wrapper options: ${command}`, () => {
    assert.equal(typeof installProblem(command), 'string');
  });
}

test('long wrapper chains are read in bounded time and still refused', () => {
  for (const unit of ['sudo ', 'timeout 1 ', 'a=b env ']) {
    const line = unit.repeat(Math.ceil(100000 / unit.length)).slice(0, 100000) + ' npm ci';
    const t0 = performance.now();
    const verdict = installProblem(line);
    const ms = performance.now() - t0;
    console.log(`chain ${JSON.stringify(unit)}: ${ms.toFixed(1)} ms`);
    assert.ok(ms < 500, `${JSON.stringify(unit)} took ${ms} ms`);
    assert.equal(typeof verdict, 'string');
  }
});

// A NAME=value word after an unrecognised flag's value must still be skipped for env, sudo and doas
// (the assignment pattern once lost its backslash and the real program behind it was never read).
for (const command of ['sudo -c x FOO=1 npm ci', 'doas -a style FOO=1 npm ci', 'sudo -c x -E FOO=1 npm ci']) {
  test(`denies an install behind an assignment after an unknown flag's value: ${command}`, () => {
    assert.equal(typeof installProblem(command), 'string');
  });
}
for (const command of ['sudo -c x FOO=1 ls', 'env -- FOO=1 ls']) {
  test(`allows a read-only command behind an assignment: ${command}`, () => {
    assert.equal(installProblem(command), null);
  });
}

// Part B of #42: the gate peels wrappers itself, from `rawWords`, with its own complete table.
const wrapperChainDenied = [
  'nohup env -iC web npm ci',
  'time env -iC web npm ci',
  'command env -iC web npm ci',
  'builtin command npm ci',
  '{ env -iC web npm ci; }',
  '! timeout -vk 1 5 npm ci',
  '/usr/bin/env -iC web npm ci',
  '\\env -iC web npm ci',
  '"env" -iC web npm ci',
  'ENV -iC web npm ci',
  'time -f %e npm ci',
  'time -o f npm ci',
  'exec -cla x npm ci',
  'nohup env -S "npm ci"',
  'nice env -S "npm ci"',
  'stdbuf --output L npm ci',
  'a=b nohup nice -n 5 time -p npm ci',
];
for (const command of wrapperChainDenied) {
  test(`denies an install behind a wrapper chain: ${JSON.stringify(command)}`, () => {
    assert.equal(typeof installProblem(command), 'string', `expected a denial for ${command}`);
  });
}

// Part C: a backslash before a CRLF is a continuation for one shell and a literal for another.
test('a backslash before CRLF is judged under both readings', () => {
  assert.equal(typeof installProblem('echo x \\\r\nnpm ci'), 'string', 'CRLF: the second line runs on Linux');
  assert.equal(installProblem('echo x \\\nnpm ci'), null, 'LF: the lines join, and echo only prints npm ci');
  assert.equal(installProblem('echo x \\\r\nls'), null);
  assert.equal(installProblem('echo x \\\nls'), null);
});

// Part E: sudo -h is help or a host, make dry runs, pnpm -c is boolean, the cheap extra runners.
const extraDenied = [
  'sudo -h npm ci',
  'sudo -h host npm ci',
  'pnpm exec -c npm ci',
  'pnpm dlx -c npm ci',
  'pnpm exec -c "npm ci"',
  'make -j install',
  'make -j4 install',
  'make build install',
  'make VAR=1 install',
  'env --block-signal=INT npm ci',
  'env --ignore-signal npm ci',
  'env --list-signal-handling npm ci',
  'su -c "npm ci"',
  'su user -c "npm ci"',
  'script -qc "npm ci" /dev/null',
  'flock /tmp/l npm ci',
  'flock -w 5 /tmp/l npm ci',
  'flock /tmp/l -c "npm ci"',
  'watch -n 1 npm ci',
  'watch "npm ci"',
  'chroot / npm ci',
  'strace -f npm ci',
  'strace -o /tmp/x -f npm ci',
  'node /usr/lib/node_modules/npm/bin/npm-cli.js ci',
  'coproc npm ci',
  'coproc NAME { npm ci; }',
  'perl -e "system(q{npm ci})"',
  'printf "npm ci\\n" | sh',
  'function f { npm ci; }; f',
];
for (const command of extraDenied) {
  test(`denies: ${JSON.stringify(command)}`, () => {
    assert.equal(typeof installProblem(command), 'string', `expected a denial for ${command}`);
  });
}
const extraUnreadable = ['sh -s < install.sh', 'sh -s x < install.sh', 'echo npm ci | sh -s x'];
for (const command of extraUnreadable) {
  test(`refuses a shell reading stdin as unreadable: ${JSON.stringify(command)}`, () => {
    const problem = installProblem(command);
    assert.equal(typeof problem, 'string');
  });
}
const extraAllowed = [
  'make -n install',
  'make --dry-run install',
  'make --just-print install',
  'make -j4 test',
  'make -j $(nproc) test',
  'make -C web build',
  'sudo -h',
  'sudo --help',
  'pnpm exec eslint -c cfg .',
  'flock /tmp/l ls',
  'watch -n 1 ls',
  'su -c "ls"',
  'chroot / ls',
  'strace -f ls',
  'node script.js',
  'command -v yarn',
  'nohup command -v yarn',
  'if command -v yarn; then echo yes; fi',
  'constructor ci',
  'toString install',
  'bash script.sh',
];
for (const command of extraAllowed) {
  test(`allows: ${JSON.stringify(command)}`, () => {
    assert.equal(installProblem(command), null);
  });
}

test('a program or subcommand named like an Object.prototype key is not a tool', () => {
  assert.equal(installProblem('npm constructor'), null);
  assert.equal(installProblem('uv constructor'), null);
});

// A line that re-reads its own words as a new line must stay linear: the wrapper
// chain budget is carried across every re-read, not restarted at each one.
const slowLines = {
  'coproc x60': 'coproc '.repeat(60) + 'npm ci',
  'watch x200': 'watch '.repeat(200) + 'npm ci',
  'pnpm exec -c x150': 'pnpm exec -c '.repeat(150) + 'npm ci',
  'pnpm dlx -c x60': 'pnpm dlx -c '.repeat(60) + 'npm ci',
};
for (const [name, line] of Object.entries(slowLines)) {
  test(`a long chain stays fast and refused: ${name}`, () => {
    const t0 = performance.now();
    const verdict = installProblem(line);
    const ms = performance.now() - t0;
    console.log(`# ${name}: ${ms.toFixed(1)} ms`);
    assert.notEqual(verdict, null);
    assert.ok(ms < 500, `${name} took ${ms.toFixed(0)} ms`);
  });
}

test('more unknown-flag candidates than the cap fail closed', () => {
  assert.notEqual(installProblem('sudo ' + '-h a '.repeat(8) + 'npm ci'), null);
  assert.notEqual(installProblem('sudo ' + '-h a '.repeat(9) + 'npm ci'), null);
  assert.notEqual(installProblem('sudo ' + '-h a '.repeat(12) + 'npm ci'), null);
});

// A work budget per call: every unknown wrapper flag opens a second reading, so a long run of them was
// exponential. The budget makes the worst case a fast, fail-closed answer.
const BUDGET_WRAPPERS = ['nice -Z ', 'time -Z ', 'nohup -Z ', 'sudo -Z ', 'env -Z ', 'xargs -Z '];
const timed = (line) => {
  const t0 = performance.now();
  const verdict = installProblem(line);
  const ms = performance.now() - t0;
  console.log(`# ${line.slice(0, 24).trim()}... (${line.length} chars): ${ms.toFixed(1)} ms`);
  return { verdict, ms };
};
for (const wrapper of BUDGET_WRAPPERS) {
  test(`repeated unknown flags stay fast: ${wrapper}`, { timeout: 5000 }, () => {
    const tenKb = wrapper.repeat(Math.ceil(10240 / wrapper.length)) + 'ls';
    for (const line of [wrapper.repeat(22) + 'ls', wrapper.repeat(40) + 'ls', tenKb]) {
      const { ms } = timed(line);
      assert.ok(ms < 500, `${wrapper.trim()} x${line.length} chars took ${ms.toFixed(0)} ms`);
    }
  });
  test(`repeated unknown flags before an install are refused, fast: ${wrapper}`, { timeout: 5000 }, () => {
    const { verdict, ms } = timed(wrapper.repeat(40) + 'npm ci');
    assert.notEqual(verdict, null);
    assert.ok(ms < 500, `${wrapper.trim()} took ${ms.toFixed(0)} ms`);
  });
  test(`a short line keeps its verdict: ${wrapper}`, { timeout: 5000 }, () => {
    assert.equal(installProblem(`${wrapper}ls`), null);
    assert.equal(installProblem(`${wrapper}npm ci`), installProblem('npm ci'));
  });
}

test('the work budget is per call: the same adversarial line gives the same verdict every time', { timeout: 5000 }, () => {
  for (const line of [BUDGET_WRAPPERS[0].repeat(40) + 'ls', BUDGET_WRAPPERS[3].repeat(40) + 'npm ci']) {
    const first = installProblem(line);
    assert.notEqual(first, null);
    assert.equal(installProblem(line), first);
    assert.equal(installProblem('ls -la'), null);
    assert.equal(installProblem(line), first);
  }
});
