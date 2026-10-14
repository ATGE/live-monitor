// What a triage or advisor session may not run while the board installs the
// project's dependencies itself.
//
// During the overlap the board runs `prepareDependencies` next to the triage.
// `npm ci` deletes `node_modules` first, so a session that installs by hand at
// the same time races the board over a half-written tree. A prompt sentence asks
// the session not to; this is the mechanism that does not depend on it asking.
//
// The criterion is "writes a dependency tree inside the worktree"
// (`node_modules`, `.venv`, `vendor`). `cargo fetch` only fills cargo's global
// cache under cargo's own lock, and `cargo build` does it implicitly, so it
// stays allowed. `e2e.installCommand` is free text and cannot be listed here: a
// project whose install is its own script is not covered.
//
// The line it draws: a cooperative model typing a normal install in a normal
// shell construct (`&&`, a pipe, `if … then`, `$(…)`, `bash -c`, a heredoc fed
// to a shell). It is a guard against a mistake, not against an adversary. What
// it cannot read it refuses, but only in the narrow places where the answer to
// "does this install?" is hidden: a program or subcommand that is a variable or
// a substitution, and a shell that reads its commands from stdin. Variables in
// ordinary arguments (`ls "$WT"`) are fine.
//
// Pure on purpose: it reads no store and no config, because a gate that can
// throw on a project lookup is a gate with a hole in it.

import { parse, base, lineReadings } from './ghgate.js';

/** The stages that never install: the board does it for them. */
export const INSTALL_GATED_PHASES = ['triage', 'advisor'];

/** Commands `autodetectDependencies` runs that this gate deliberately lets through. */
export const SAFE_CONCURRENT = ['cargo fetch'];

const DENIAL =
  'Este comando no se ejecuta. El tablero está instalando (o ya instaló) las dependencias del proyecto por su'
  + ' cuenta, y una instalación a mano a la vez pisaría `node_modules` o el entorno a medias. No instales'
  + ' nada en esta fase: si falta una dependencia, dilo en tu respuesta y sigue con lo que puedas leer del código.';

const UNREADABLE =
  'Este comando no se ejecuta: en esta fase no se instala nada (el tablero lo hace por su cuenta) y no he podido'
  + ' leer qué ejecuta, porque el programa o el subcomando viene de una variable o de una sustitución, o un shell'
  + ' lee sus órdenes de la entrada estándar. Reescríbelo como una orden simple, con el programa y el subcomando'
  + ' escritos a mano, sin `$(…)` ni variables en ellos y sin tuberías hacia un shell. Si solo querías leer, usa'
  + ' `cat`, `grep` o `ls`; si falta una dependencia, dilo en tu respuesta.';

const INSTALL = 'install';
const UNREADABLE_V = 'unreadable';
const MAX_WRAPPER_CHAIN = 32;
// Total re-readings (lines and command words) one `installProblem` call may spend. The chain cap bounds
// depth, not breadth: every unknown wrapper flag opens a second reading, so a long run of them is exponential.
const MAX_WORK = 5000;
// One unit of work; false once the call's budget is gone (the caller then answers unreadable).
const spend = (budget) => --budget.left >= 0;
const MAX_DEPTH = 4;
const MAX_ALTS = 8;

/** The worse of two verdicts: an install beats an unreadable line beats nothing. */
const worse = (a, b) => (a === INSTALL || b === INSTALL ? INSTALL : (a ?? b ?? null));

/** Flags whose next word is a value, per tool, so `npm --prefix web ci` finds `ci`. */
const VALUE_FLAGS = {
  npm: new Set(['--prefix', '-C', '--cache', '-w', '--workspace', '--registry', '--userconfig', '--loglevel']),
  yarn: new Set(['--cwd', '--cache-folder', '--modules-folder', '--use-yarnrc']),
  pnpm: new Set(['-C', '--dir', '--filter', '-F', '--workspace-dir', '--store-dir', '--reporter']),
  pip: new Set(['--cache-dir', '--python', '--log', '--proxy', '--retries', '--timeout', '--index-url', '-i']),
  uv: new Set(['--directory', '--project', '-p', '--python']),
  poetry: new Set(['-C', '--directory', '-P', '--project']),
};

/** GNU make: options whose next word is a value; `-j`/`-l` take an optional number; a dry run
 * (`-n`, `--just-print`, `--recon`, `--dry-run`) and `-q` / `--question` are allowed
 * as a deliberate trade-off, though GNU make still RUNS recipe lines that start with `+` or
 * contain `$(MAKE)` under `-n`: whether `make -n install` installs depends on the project's Makefile. */
const MAKE_VALUE_LONG = new Set(['--directory', '--file', '--makefile', '--include-dir', '--old-file', '--assume-old', '--what-if', '--assume-new', '--new-file', '--eval']);
const MAKE_VALUE_SHORT = new Set(['C', 'f', 'I', 'o', 'W', 'E']);
const MAKE_NUMBER_LONG = new Set(['--jobs', '--load-average', '--max-load']);
const MAKE_DRY_LONG = new Set(['--just-print', '--recon', '--dry-run', '--question']);

/**
 * The tools with subcommands. `installs` are the ones that write a dependency
 * tree, `runs` hand the rest of the line to another program (`npm exec npm ci`),
 * `next` are subcommands whose own subcommand decides (`yarn workspaces focus`,
 * `uv pip install`), `bare` means that no subcommand at all installs.
 */
const TOOLS = {
  npm: {
    flags: VALUE_FLAGS.npm,
    installs: new Set([
      'ci', 'install', 'i', 'add', 'clean-install', 'install-clean', 'ic', 'isntall',
      'update', 'up', 'upgrade', 'rebuild', 'rb', 'dedupe', 'ddp', 'prune', 'link', 'ln',
      'install-test', 'it', 'cit', 'install-ci-test', 'uninstall', 'remove', 'rm', 'un', 'unlink',
    ]),
    runs: new Set(['exec', 'x']),
  },
  yarn: {
    flags: VALUE_FLAGS.yarn,
    installs: new Set(['install', 'add', 'upgrade', 'up', 'dedupe', 'link', 'remove']),
    next: { workspaces: new Set(['focus']) },
    runs: new Set(['exec', 'dlx']),
    // A bare `yarn` is `yarn install` in yarn 1, so `yarn --silent` stays denied.
    bare: true,
  },
  pnpm: {
    flags: VALUE_FLAGS.pnpm,
    installs: new Set(['install', 'i', 'add', 'update', 'up', 'upgrade', 'rebuild', 'rb', 'prune', 'dedupe', 'link', 'ln', 'remove', 'rm', 'uninstall', 'un']),
    runs: new Set(['exec', 'dlx']),
    // For pnpm `-c` is the boolean `--shell-mode`: the words after it are one shell line.
    shellMode: true,
  },
  bundle: { flags: null, installs: new Set(['install']), bare: true },
  bundler: { flags: null, installs: new Set(['install']), bare: true },
  composer: { flags: null, installs: new Set(['install', 'update', 'require']) },
  uv: { flags: VALUE_FLAGS.uv, installs: new Set(['sync', 'add', 'venv']), next: { pip: new Set(['install', 'sync']) } },
  poetry: { flags: VALUE_FLAGS.poetry, installs: new Set(['install', 'add', 'update', 'sync']) },
  pipenv: { flags: null, installs: new Set(['install', 'sync', 'update']) },
  bun: { flags: null, installs: new Set(['install', 'i', 'add', 'update', 'link']), runs: new Set(['x']) },
};

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const WINDOWS_SHELLS = new Set(['pwsh', 'powershell', 'cmd']);

/** `yarn workspaces foreach` flags whose next word is a value, not the command. */
const FOREACH_VALUE_FLAGS = new Set(['--include', '--exclude', '-j', '--jobs', '--from', '--since']);

/** Flags that only print: nothing is installed under them. `-v`/`-V` count only with no subcommand. */
const QUIET_FLAG = /^(?:--help|-h|--version|--dry-run)$/;
const VERSION_FLAG = /^-[vV]$/;

/** `npm.cmd`, `bash.exe`, `C:\x\pnpm.CMD`, `npm@10` → `npm`, `bash`, `pnpm`, `npm`. */
const nameOf = (value) => base(value).replace(/\.(?:cmd|exe|bat|ps1)$/, '').replace(/@[\w.^~*-]+$/, '');

/** First positional word after skipping flags (and the values of the ones that take one). */
function subcommandOf(words, valueFlags) {
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i].value;
    if (!w.startsWith('-')) return { sub: w, at: i };
    if (!w.includes('=') && valueFlags?.has(w)) i += 1;
  }
  return { sub: null, at: -1 };
}

const isQuiet = (args) => args.some((w) => QUIET_FLAG.test(w.value));

/** `pip …` arguments: is the subcommand `install`? */
function pipVerdict(args) {
  const { sub, at } = subcommandOf(args, VALUE_FLAGS.pip);
  if (at >= 0 && args[at].unsafe) return UNREADABLE_V;
  return sub === 'install' && !isQuiet(args) ? INSTALL : null;
}

/**
 * Programs that run the next command. `parse` also peels some of them for the
 * GitHub gate, by a shorter table; this gate reads `rawWords` and peels them all itself.
 */
const RUNNERS = new Set(['time', 'sudo', 'doas', 'nice', 'ionice', 'nohup', 'xargs', 'npx', 'bunx', 'corepack', 'command', 'builtin', 'exec', 'stdbuf', 'setsid', 'busybox', 'timeout', 'env', 'flock', 'chroot', 'strace', 'watch']);

/** `su -c "npm ci"`, `script -qc "npm ci" /dev/null`: a `-c` / `--command` value is a shell line. */
const LINE_RUNNERS = new Set(['su', 'script']);

/** Words that open a compound command and run nothing themselves. */
const LEADING_KEYWORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '{', '!']);

/** `NAME=value` words, shell keywords and `function NAME` in front of a command run nothing. */
function peelLeading(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (!w.unsafe && w.value === 'function') { i += 2; continue; }
    if (/^[A-Za-z_]\w*=/.test(w.value) || (!w.unsafe && LEADING_KEYWORDS.has(w.value))) { i += 1; continue; }
    break;
  }
  return i ? words.slice(i) : words;
}

/** Inline code (`node -e`, `python -c`…) is opaque; only a plain install spelled inside it is caught. */
const INLINE_PROGRAM = /^(?:node|nodejs|python[\d.]*|py|pythonw|perl|ruby)$/;
const INLINE_FLAG = /^(?:-e|-p|-c|-pe|-ne|-ce|--eval|--print)$/;
const LOOKS_LIKE_INSTALL = /(?:^|[\s;&|('"`{])(?:(?:npm|pnpm)(?:\.cmd)?\s+(?:\S+\s+)*?(?:ci|install|i|add)|yarn(?:\.cmd)?\s+(?:install|add)|pip3?\s+install)(?:\s|$|[;&|)'"`}])/;

/** `node /usr/lib/node_modules/npm/bin/npm-cli.js ci`: the script is the tool. */
const NODE_TOOL_SCRIPT = /^(npm|npx|yarn|pnpm)(?:-cli|-\d[\w.]*)?\.[cm]?js$/;

function nodeScriptVerdict(args, depth, ext) {
  const at = args.findIndex((w) => NODE_TOOL_SCRIPT.test(base(w.value)));
  if (at < 0) return null;
  const tool = base(args[at].value).match(NODE_TOOL_SCRIPT)[1];
  return wordsVerdict([{ value: tool, unsafe: false }, ...args.slice(at + 1)], depth, ext);
}

/** GNU make: a read of every target, not only the first, so `-j` cannot swallow `install`. */
function makeVerdict(args) {
  const isNumber = (w) => Boolean(w) && (w.unsafe || /^\d*$/.test(w.value));
  let dry = isQuiet(args) || args.some((w) => VERSION_FLAG.test(w.value));
  let out = null;
  let ended = false;
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i];
    const v = w.value;
    if (!ended && v === '--') { ended = true; continue; }
    if (!ended && v.length > 1 && v.startsWith('-')) {
      if (v.startsWith('--')) {
        const name = v.split('=')[0];
        if (MAKE_DRY_LONG.has(name)) dry = true;
        else if (!v.includes('=')) {
          if (MAKE_VALUE_LONG.has(name)) i += 1;
          else if (MAKE_NUMBER_LONG.has(name) && isNumber(args[i + 1])) i += 1;
        }
        continue;
      }
      for (let c = 1; c < v.length; c += 1) {
        const f = v[c];
        if (f === 'n' || f === 'q') dry = true;
        if (MAKE_VALUE_SHORT.has(f)) { if (c === v.length - 1) i += 1; break; }
        if (f === 'j' || f === 'l') { if (c === v.length - 1 && isNumber(args[i + 1])) i += 1; break; }
      }
      continue;
    }
    if (!w.unsafe && /^[A-Za-z_][\w.]*=/.test(v)) continue;
    if (w.unsafe && (!v || /[$`(]/.test(v))) out = worse(out, UNREADABLE_V);
    else if (v === 'install') return dry ? null : INSTALL;
  }
  return dry ? null : out;
}

function inlineVerdict(args) {
  const at = args.findIndex((w) => INLINE_FLAG.test(w.value));
  if (at < 0) return null;
  const code = args.slice(at + 1).map((w) => w.value).join(' ');
  return LOOKS_LIKE_INSTALL.test(code) ? INSTALL : null;
}

/** The text a pipe hands to the next command, when it can be read: a heredoc, or what `echo` prints. */
function pipeTextOf(prev) {
  if (!prev) return null;
  if (typeof prev.heredocBody === 'string') return prev.heredocBody;
  const name = nameOf(prev.words[0]?.value);
  // `printf "npm ci\n" | sh`: the `\n` the shell would print is a line break.
  if (name === 'echo' || name === 'printf') return prev.words.slice(1).map((w) => w.value).join(' ').replace(/\\n/g, '\n');
  return null;
}

/** A shell: with `-c` its argument is a command line; without, it reads a script or stdin. */
function shellVerdict(program, args, depth, ext) {
  const flag = args.findIndex((w) => /^(?:-[a-z]*c|-command|\/[ck])$/i.test(w.value));
  if (flag >= 0) {
    const rest = args.slice(flag + 1);
    if (depth >= 3) return rest.length ? UNREADABLE_V : null;
    // The raw values are read again, unsafe ones included: `-c "$CMD"` then
    // falls to the unreadable program, and `-c "x=$(npm ci)"` to its inside.
    return rest.length ? linesVerdict(rest.map((w) => w.value).join(' '), depth + 1, ext.chain, ext.budget) : null;
  }
  if (!SHELLS.has(program)) return null;
  // `sh -s x` reads its commands from stdin and keeps `x` for `$1`; a script name without `-s` is a file.
  const firstPositional = args.findIndex((w) => !w.value.startsWith('-'));
  const flags = firstPositional < 0 ? args : args.slice(0, firstPositional);
  const stdin = flags.some((w) => /^-[A-Za-z]*s[A-Za-z]*$/.test(w.value));
  if (firstPositional >= 0 && !stdin) return null;
  // No `-c` and no script: the shell reads its commands from stdin.
  const text = typeof ext.heredocBody === 'string' ? ext.heredocBody : (ext.pipedIn ? ext.pipeText : null);
  if (typeof text === 'string') return depth >= 3 ? UNREADABLE_V : linesVerdict(text, depth + 1, ext.chain, ext.budget);
  return ext.pipedIn || ext.heredoc || ext.stdinFrom ? UNREADABLE_V : null;
}

/**
 * `npm exec -c "npm ci"`, `npx --call=…`: the value of -c / --call is a command
 * line the tool hands to a shell, so it is read again as one.
 */
function callVerdict(args, depth, ext) {
  let out = null;
  // Only the tool's own flags count: after the first positional word or a `--`
  // the rest belongs to the program being run (`npx eslint -c cfg`).
  for (let k = 0; k < args.length; k += 1) {
    const v = args[k].value;
    if (v === '--' || !v.startsWith('-')) break;
    let line = null;
    if (v === '-c' || v === '--call') { line = args[k + 1]?.value ?? null; k += 1; }
    else if (v.startsWith('--call=')) line = v.slice(7);
    else if (v === '-p' || v === '--package') k += 1;
    if (line) out = worse(out, depth >= 3 ? UNREADABLE_V : linesVerdict(line, depth + 1, ext.chain, ext.budget));
  }
  return out;
}

/**
 * pnpm `exec -c` / `dlx -c` (`--shell-mode`): the flag is boolean and every word
 * after the tool's own flags is one shell line. Same reading as `callVerdict`,
 * for the tool where `-c` takes no value.
 */
function shellModeVerdict(args, depth, flags, ext) {
  for (let k = 0; k < args.length; k += 1) {
    const v = args[k].value;
    if (v === '--' || !v.startsWith('-')) break;
    if (v === '--shell-mode' || /^-[a-z]*c$/.test(v)) {
      const line = args.slice(k + 1).map((w) => w.value).join(' ');
      if (!line) return null;
      return depth >= 3 ? UNREADABLE_V : linesVerdict(line, depth + 1, ext.chain, ext.budget);
    }
    if (!v.includes('=') && flags?.has(v)) k += 1;
  }
  return undefined; // no shell-mode flag: the words are a program, not a line
}

/** `su -c "npm ci"`, `script -qc "npm ci" /dev/null`: the value of `-c` / `--command` is a shell line. */
function commandFlagVerdict(args, depth, ext) {
  let out = null;
  for (let k = 0; k < args.length; k += 1) {
    const v = args[k].value;
    let line = null;
    if (v === '--command' || /^-[A-Za-z]*c$/.test(v)) { line = args[k + 1]?.value ?? null; k += 1; }
    else if (v.startsWith('--command=')) line = v.slice(10);
    if (line) out = worse(out, depth >= 3 ? UNREADABLE_V : linesVerdict(line, depth + 1, ext.chain, ext.budget));
  }
  return out;
}

/**
 * Per wrapper: the options whose next word is a value (not the program), and
 * whether a leading duration word comes first (`timeout 60 npm ci`). A wrapper
 * not listed here (the generic `exec` shape of `npm exec`, `npx`, `yarn dlx`) only
 * knows the package and call flags.
 */
const WRAPPER_VALUE_FLAGS = {
  time: ['-f', '--format', '-o', '--output'],
  // `-h` is in neither table: a bare `-h` is help in current sudo and the host in older ones, so both are read.
  sudo: ['-u', '-g', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t', '--user', '--group', '--host', '--prompt', '--chdir', '--chroot'],
  doas: ['-u', '-C'],
  nice: ['-n', '--adjustment'],
  ionice: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata', '--pid', '--pgid', '--uid'],
  nohup: [],
  // GNU `-i`/`--replace`, `--eof`, `--max-lines` (and env `--default-signal`) take an optional value
  // attached with `=`, never the next word: they are in BOOLEAN_FLAGS.
  xargs: ['-I', '-n', '-P', '-L', '-s', '-E', '-d', '-a', '-J', '--replace-str', '--max-args', '--max-procs', '--max-chars', '--delimiter', '--arg-file', '--process-slot-var'],
  npx: ['-p', '--package', '-c', '--call'],
  bunx: ['-p', '--package'],
  corepack: [],
  command: [],
  builtin: [],
  exec: ['-a'],
  stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
  setsid: [],
  busybox: [],
  timeout: ['-k', '-s', '--kill-after', '--signal'],
  env: ['-u', '-C', '-S', '-P', '-a', '--argv0', '--unset', '--chdir', '--split-string'],
  flock: ['-w', '--timeout', '-E', '--conflict-exit-code', '-c', '--command'],
  chroot: ['--userspec', '--groups'],
  strace: ['-o', '-e', '-p', '-s', '-u', '-E', '-a', '-I', '-P', '-S', '-O', '-b', '-X', '-U'],
  watch: ['-n', '--interval', '-q', '--equexit'],
  // pnpm `exec`/`dlx`: `-c` is `--shell-mode`, a boolean (see `shellModeVerdict`).
  'pnpm-exec': ['-p', '--package'],
};

/** Value flags whose value is a shell line, per wrapper: read again as one. */
const LINE_FLAGS = {
  env: new Set(['-S', '--split-string']),
  flock: new Set(['-c', '--command']),
};

/** Wrappers whose first non-option word is not the program: `timeout 60 …`, `flock FILE …`, `chroot ROOT …`. */
const LEADING_POSITIONAL = { timeout: 1, flock: 1, chroot: 1 };

/** Wrappers that hand all their words to `sh -c` as one line: `watch -n 1 npm ci`. */
const JOINS_LINE = new Set(['watch']);
/**
 * Flags known to take no value. A flag in neither table may take one, so the word
 * after it is read both as the program and as that value (see `wrappedAt`).
 */
const BOOLEAN_FLAGS = {
  xargs: ['-0', '-r', '-t', '-p', '-x', '-o', '--null', '--no-run-if-empty', '--verbose', '--interactive', '--exit', '--open-tty', '--replace', '--eof', '--max-lines'],
  sudo: ['-E', '-H', '-n', '-S', '-k', '-K', '-b', '-i', '-s', '-A', '-B', '-e', '-l', '-v', '-V', '--preserve-env', '--login', '--shell', '--non-interactive', '--stdin', '--background'],
  doas: ['-n', '-s'],
  // GNU env's `--block-signal`, `--ignore-signal` and `--default-signal` take an optional value attached with `=`.
  env: ['-i', '-0', '-v', '--ignore-environment', '--null', '--debug', '--default-signal', '--block-signal', '--ignore-signal', '--list-signal-handling'],
  timeout: ['-v', '--foreground', '--preserve-status', '--verbose'],
  time: ['-p', '-v', '-a', '-q', '--portability', '--verbose', '--append', '--quiet'],
  exec: ['-c', '-l'],
  flock: ['-s', '-x', '-u', '-n', '-o', '-F', '--shared', '--exclusive', '--unlock', '--nonblock', '--nonblocking', '--close', '--no-fork', '--verbose'],
  chroot: ['--skip-chdir'],
  strace: ['-f', '-ff', '-c', '-C', '-d', '-D', '-i', '-k', '-n', '-r', '-t', '-tt', '-ttt', '-T', '-v', '-x', '-xx', '-y', '-yy', '-w', '-q', '-qq', '-F', '-z', '-Z'],
  watch: ['-b', '-c', '-d', '-e', '-g', '-p', '-r', '-t', '-w', '-x', '--beep', '--color', '--differences', '--errexit', '--chgexit', '--precise', '--no-rerun', '--no-title', '--no-wrap', '--exec'],
  'pnpm-exec': ['-c', '--shell-mode', '-r', '--recursive', '--parallel', '--sequential', '--bail', '--no-bail'],
};
const GENERIC_VALUE_FLAGS = ['-p', '--package', '-c', '--call'];
/** xargs `-i`, `-e`, `-l` take an OPTIONAL value, attached: the rest of a cluster after them belongs to them. */
const OPTIONAL_ATTACHED = { xargs: new Set(['i', 'e', 'l']) };
const SKIPS_ASSIGNMENTS = new Set(['env', 'sudo', 'doas']);

/** `command -v x`, `command -V x`, `-pv`: lookups that only print. */
const COMMAND_LOOKUP = /^-[pvV]*[vV][pvV]*$/;

/**
 * Where the wrapped program starts in a wrapper's arguments: past the wrapper's
 * own options (and their values), `NAME=value` words and a `timeout` duration.
 * Whatever follows that program is its arguments, never another program.
 */
function wrappedAt(wrapper, args, extraFlags, lines, info) {
  const valueFlags = new Set([...(WRAPPER_VALUE_FLAGS[wrapper] ?? GENERIC_VALUE_FLAGS), ...(extraFlags ?? [])]);
  const attached = OPTIONAL_ATTACHED[wrapper];
  // `env -S`/`--split-string` carry a command line: collected for the caller to read again.
  const note = (flag, value) => { if (lines && LINE_FLAGS[wrapper]?.has(flag) && value) lines.push(value); };
  const bools = new Set(BOOLEAN_FLAGS[wrapper] ?? []);
  let leading = LEADING_POSITIONAL[wrapper] ?? 0;
  let unknown = false; // the word just before is a flag in no table, written without `=`
  let ended = false; // past `--`: the wrapper's own options are over
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i].value;
    if (w === '--' && !ended) { ended = true; unknown = false; continue; }
    if (!ended && w.length > 1 && w.startsWith('-')) {
      unknown = false;
      if (w.startsWith('--') || w.includes('=')) {
        const eq = w.indexOf('=');
        if (eq > 0) note(w.slice(0, eq), w.slice(eq + 1));
        else if (valueFlags.has(w)) { note(w, args[i + 1]?.value); i += 1; }
        else unknown = !bools.has(w);
        continue;
      }
      // A short cluster `-xyz`: letters are plain flags up to the first one that
      // takes a value; that value is the rest of the cluster, or else the next word.
      for (let c = 1; c < w.length; c += 1) {
        if (attached?.has(w[c])) break;
        if (!valueFlags.has('-' + w[c])) { if (!bools.has('-' + w[c])) unknown = true; continue; }
        unknown = false;
        if (c < w.length - 1) note('-' + w[c], w.slice(c + 1));
        else { note('-' + w[c], args[i + 1]?.value); i += 1; }
        break;
      }
      continue;
    }
    if (SKIPS_ASSIGNMENTS.has(wrapper) && /^[A-Za-z_]\w*=/.test(w)) { unknown = false; continue; }
    if (leading > 0) { leading -= 1; unknown = false; continue; }
    // An unrecognised flag may have taken this word as its value: the first word after it
    // that is not a flag is another candidate (and so on, while more unrecognised flags follow).
    if (unknown && info) {
      info.alts = [];
      let pending = false;
      for (let j = i + 1; j < args.length; j += 1) {
        const x = args[j].value;
        if (x.length > 1 && x.startsWith('-')) {
          if (x.includes('=') || bools.has(x)) pending = false;
          else if (valueFlags.has(x)) { j += 1; pending = false; }
          else pending = true;
          continue;
        }
        if (SKIPS_ASSIGNMENTS.has(wrapper) && /^[A-Za-z_]\w*=/.test(x)) continue;
        // More candidates than the cap: ignoring the rest would fail open.
        if (info.alts.length >= MAX_ALTS) { info.overflow = true; break; }
        info.alts.push(j);
        if (!pending) break;
        pending = false;
      }
    }
    return i;
  }
  return -1;
}

/** What a wrapper runs: its own options skipped, then the next word judged as any command. */
function runnerVerdict(wrapper, args, depth, ext, toolFlags) {
  // A chain of wrappers re-slices the rest at every link: past this many, refuse as unreadable.
  const chain = (ext.chain ?? 0) + 1;
  if (chain > MAX_WRAPPER_CHAIN) return UNREADABLE_V;
  ext = { ...ext, chain };
  if (wrapper === 'command') {
    const lead = args.findIndex((w) => !w.value.startsWith('-'));
    if ((lead < 0 ? args : args.slice(0, lead)).some((w) => COMMAND_LOOKUP.test(w.value))) return null;
  }
  const lines = [];
  const info = {};
  const at = wrappedAt(wrapper, args, toolFlags ?? (wrapper === 'npx' ? VALUE_FLAGS.npm : null), lines, info);
  let out = null;
  for (const line of lines) out = worse(out, depth >= 3 ? UNREADABLE_V : linesVerdict(line, depth + 1, chain, ext.budget));
  if (out === INSTALL) return out;
  // `watch -n 1 npm ci` hands its words to `sh -c` joined: read them as one line,
  // and only that way (one reading, not two) while the depth allows it.
  const asLine = JOINS_LINE.has(wrapper) && at >= 0 && at < args.length && depth < 3;
  if (asLine) {
    out = worse(out, linesVerdict(args.slice(at).map((w) => w.value).join(' '), depth + 1, chain, ext.budget));
    if (out === INSTALL) return out;
  } else {
    // Same depth: a chain of wrappers does not spend the depth budget, but the length cap above bounds it.
    out = worse(out, at >= 0 && at < args.length ? wordsVerdict(args.slice(at), depth, ext) : null);
  }
  if (info.overflow) out = worse(out, UNREADABLE_V);
  for (const alt of info.alts ?? []) {
    if (out === INSTALL) break;
    out = worse(out, wordsVerdict(args.slice(alt), depth, ext));
  }
  return out;
}

function wordsVerdict(rawWords, depth, ext) {
  if (!spend(ext.budget)) return UNREADABLE_V;
  // Assignments, keywords (`{`, `!`, `then`…) and `function NAME` run nothing; wrappers are peeled below.
  const words = peelLeading(rawWords);
  const first = words[0];
  if (!first) return null;
  const program = nameOf(first.value);
  const args = words.slice(1);
  // `$HOME/bin/npm` reads as `npm`; `$CMD`, `$(which npm)` and `` `x` `` do not read at all.
  if (first.unsafe && (!program || /[$`(]/.test(program))) return UNREADABLE_V;
  if (!program) return null;

  if (RUNNERS.has(program)) {
    const called = program === 'npx' ? callVerdict(args, depth, ext) : null;
    return called === INSTALL ? called : worse(called, runnerVerdict(program, args, depth, ext));
  }
  if (LINE_RUNNERS.has(program)) return commandFlagVerdict(args, depth, ext);
  // `coproc npm ci` and `coproc NAME { npm ci; }`: the name is optional.
  // Read once: a name only precedes a `{ … }` group, never a simple command.
  if (program === 'coproc') {
    const chain = (ext.chain ?? 0) + 1;
    if (chain > MAX_WRAPPER_CHAIN) return UNREADABLE_V;
    return wordsVerdict(args[1]?.value === '{' ? args.slice(1) : args, depth, { ...ext, chain });
  }
  if (program === 'make') return makeVerdict(args);

  if (program === 'find') {
    let out = null;
    args.forEach((w, k) => {
      if (!/^-(?:exec|execdir|ok|okdir)$/.test(w.value)) return;
      if (depth >= 3) { out = worse(out, UNREADABLE_V); return; }
      let end = args.findIndex((x, j) => j > k && (x.value === ';' || x.value === '+'));
      if (end < 0) end = args.length;
      out = worse(out, wordsVerdict(args.slice(k + 1, end), depth + 1, ext));
    });
    return out;
  }

  // Own keys only: a program called `constructor` or `toString` is not a tool.
  const spec = Object.hasOwn(TOOLS, program) ? TOOLS[program] : null;
  if (spec) {
    const { sub, at } = subcommandOf(args, spec.flags);
    if (at >= 0 && args[at].unsafe) return UNREADABLE_V;
    if (sub === null) {
      if (!spec.bare) return null;
      return isQuiet(args) || args.some((w) => VERSION_FLAG.test(w.value)) ? null : INSTALL;
    }
    if (isQuiet(args)) return null;
    if (spec.runs?.has(sub)) {
      const rest = args.slice(at + 1);
      if (spec.shellMode) {
        const shell = shellModeVerdict(rest, depth, spec.flags, ext);
        // With the flag, the words are one shell line and that reading covers them all.
        return shell !== undefined ? shell : runnerVerdict('pnpm-exec', rest, depth, ext, spec.flags);
      }
      const called = callVerdict(rest, depth, ext);
      return called === INSTALL ? called : worse(called, runnerVerdict('exec-tool', rest, depth, ext, spec.flags));
    }
    if (program === 'yarn' && (sub === 'workspace' || sub === 'workspaces') && depth >= 3) return UNREADABLE_V;
    if (program === 'yarn') {
      // `yarn workspace web add x` is `yarn add x` run inside the workspace named
      // by the next word; `yarn workspaces foreach -A install` runs it in each.
      if (sub === 'workspace') return args.length <= at + 2 ? null : wordsVerdict([first, ...args.slice(at + 2)], depth + 1, ext);
      if (sub === 'workspaces' && subcommandOf(args.slice(at + 1), spec.flags).sub === 'foreach') {
        const tail = args.slice(at + 2);
        let k = 0;
        while (k < tail.length && tail[k].value.startsWith('-')) k += FOREACH_VALUE_FLAGS.has(tail[k].value) ? 2 : 1;
        const verb = tail[k];
        if (!verb) return null;
        if (verb.unsafe) return UNREADABLE_V;
        if (spec.installs.has(verb.value)) return INSTALL;
        return verb.value === 'exec' ? runnerVerdict('exec-tool', tail.slice(k + 1), depth, ext, spec.flags) : null;
      }
    }
    if (spec.installs.has(sub)) return INSTALL;
    const follow = spec.next && Object.hasOwn(spec.next, sub) ? spec.next[sub] : null;
    if (follow) return follow.has(subcommandOf(args.slice(at + 1), spec.flags).sub) ? INSTALL : null;
    return null;
  }

  if (/^pip[\d.]*$/.test(program)) return pipVerdict(args);
  if (/^(?:python[\d.]*|py|pythonw)$/.test(program)) {
    const m = args.findIndex((w) => w.value === '-m');
    const mod = m >= 0 ? args[m + 1]?.value : null;
    if (mod === 'venv') return isQuiet(args) ? null : INSTALL;
    if (mod === 'pip') return pipVerdict(args.slice(m + 2));
    return inlineVerdict(args);
  }
  if (INLINE_PROGRAM.test(program)) {
    const inline = inlineVerdict(args);
    return inline === INSTALL || !/^node(?:js)?$/.test(program) ? inline : worse(inline, nodeScriptVerdict(args, depth, ext));
  }

  if (SHELLS.has(program) || WINDOWS_SHELLS.has(program)) return shellVerdict(program, args, depth, ext);
  return null;
}

/** One command from `parse`: what is inside its substitutions, then the command itself. */
function commandVerdict(cmd, prev, depth, chain, budget) {
  let out = null;
  for (const sub of cmd.subs ?? []) out = worse(out, linesVerdict(sub, depth + 1, chain, budget));
  if (out === INSTALL) return out;
  const ext = {
    chain,
    budget,
    heredoc: cmd.heredoc,
    heredocBody: cmd.heredocBody,
    pipedIn: cmd.pipedIn,
    stdinFrom: cmd.stdinFrom,
    pipeText: cmd.pipedIn ? pipeTextOf(prev) : null,
  };
  // `rawWords`: the command before `parse` peeled its own short table of wrappers; ours is complete.
  return worse(out, wordsVerdict(cmd.rawWords ?? cmd.words, depth, ext));
}

/** A line, under every reading a shell could give it (see `lineReadings`): the worst verdict stands. */
function linesVerdict(command, depth, chain = 0, budget) {
  if (depth > MAX_DEPTH || !spend(budget)) return UNREADABLE_V;
  let out = null;
  for (const reading of lineReadings(command)) {
    const cmds = parse(command, 0, reading);
    cmds.forEach((cmd, k) => { out = worse(out, commandVerdict(cmd, cmds[k - 1], depth, chain, budget)); });
    if (out === INSTALL) break;
  }
  return out;
}

/**
 * A Spanish denial text when `command` installs dependencies into the worktree,
 * or when it cannot be read well enough to tell; null when it is fine. Never
 * throws: a line that breaks the reader is refused as unreadable, because the
 * hook around the gate fails open.
 */
export function installProblem(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  try {
    const verdict = linesVerdict(command, 0, 0, { left: MAX_WORK });
    if (verdict === INSTALL) return DENIAL;
    return verdict === UNREADABLE_V ? UNREADABLE : null;
  } catch {
    return LOOKS_LIKE_INSTALL.test(command) ? DENIAL : UNREADABLE;
  }
}
