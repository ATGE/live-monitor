/**
 * The environment rule every prompt that can run commands carries.
 *
 * It used to read "NEVER kill a process or free a port", full stop — which
 * also forbade the agent from stopping the test server it had just started
 * or cleaning up its own background commands, and left it asking permission
 * for things that were plainly its own. The line that matters is not
 * "never", it is *whose*: what you started is yours to stop; what you did
 * not is not, and when you cannot tell, you leave it alone.
 */
const INTRO = '**PROCESOS Y PUERTOS — lo tuyo, sí; lo ajeno, nunca.** '
  + 'Puedes parar y limpiar los procesos que arrancaste TÚ en esta tarea (tus servidores de prueba, tus comandos de fondo, los puertos que abriste). ';

const TAIL = 'Si no sabes quién lo arrancó, no lo toques. '
  + 'Los servidores que levantó el tablero para esta tarea se paran desde el tablero: si necesitas reiniciarlos, dilo en vez de matarlos. '
  + 'Si necesitas levantar algo, usa un puerto libre >18000 y compruébalo antes. '
  // The other half of `waitgate.js`: the gate refuses the background timer,
  // this says what to do instead, so the refusal is not the first the session
  // hears of it. #1390 answered 68 expiring `sleep`s in a row after it had
  // already finished.
  + '**Para esperar a algo tuyo en segundo plano, léelo con BashOutput cuando vayas a usar su resultado**, '
  + 'y si necesitas que termine antes de seguir, lánzalo en primer plano con su `timeout`. '
  + 'Nunca encadenes `sleep` en segundo plano para hacer tiempo: cada uno que vence te interrumpe, '
  + 'y los que dejes pendientes te seguirán interrumpiendo cuando ya hayas terminado.';

// Whose processes share the machine. Only this sentence depends on where the
// session runs: 8080/8090 are Edson's servers on his main checkout, which
// exists on his own machine and nowhere else.
const OTHERS_LOCAL = 'NUNCA toques un proceso que no arrancaste tú: los puertos 8080 y 8090 son los servidores de Edson en su checkout principal, y otros worktrees tienen los suyos. ';
const OTHERS_RUNNER = 'NEVER touch a process you did not start: this machine has no main checkout of Edson\'s, but other worktrees on it have their own servers. ';

export const PROCESS_RULE = INTRO + OTHERS_LOCAL + TAIL;

/**
 * The process rule for the machine a session runs on. Edson's own machine (or
 * no machine at all, the default everywhere) gets `PROCESS_RULE` unchanged; a
 * runner gets the same rule with the 8080/8090 sentence replaced, since there
 * is no main checkout there to protect — only other worktrees.
 */
export function processRuleFor(machine) {
  if (!machine || machine.kind === 'local') return PROCESS_RULE;
  return INTRO + OTHERS_RUNNER + TAIL;
}

/**
 * The heredoc warning, for sessions whose commands go through a Windows shell.
 *
 * The board never touches the text of a Bash tool call — the CLI does. On
 * Windows the CLI wraps the model's command roughly like this:
 *
 *   "C:\Program Files\Git\bin\bash.exe" -c "… && eval '<command>' < /dev/null && pwd -P >| <tmp>"
 *
 * so two quoting passes stack. First the CLI escapes every `'` of the command
 * as `'"'"'` to survive the `eval '…'`; then Windows re-quotes the whole thing
 * into one argv entry. A heredoc body carrying `'`, `'''` or a `\` right
 * before a quote leaves that state machine open, and bash answers «unexpected
 * EOF while looking for matching `'`». Six occurrences on disk, all of them in
 * Windows worktrees and none on Linux, each one a session rediscovering the
 * same workaround at the cost of a tool call and a turn.
 *
 * The rule itself does not explain any of that. Edson's board runs on Windows,
 * so every chat turn pays for this sentence: the error text is what buys
 * recognition, the mechanism is what buys nothing. It stays here, where it is
 * free.
 *
 * This is a sibling of `processRuleFor`, not an extension of it: that one asks
 * local vs runner, this one asks Windows vs the rest, and they are different
 * questions. `platform` is a plain synchronous property on both machine
 * implementations (`machine.js` reads `process.platform`, `runner-client.js`
 * hard-codes `'linux'`), so no call site becomes async. The trailing space
 * lives inside the value, so the sentence that follows the placeholder is not
 * left with a double space when there is nothing to say.
 */
const SHELL_RULE_WIN = '**Windows:** no crees con heredoc (`cat <<EOF`) ficheros cuyo contenido lleve comillas simples (`\'`) o barras invertidas: '
  + 'bash responde «unexpected EOF while looking for matching `\'`» y el fichero sale mutilado o no sale. '
  + 'Escríbelos con la herramienta Write. ';

/**
 * The shell rule for the machine a session runs on. Windows gets the heredoc
 * warning; everything else gets the empty string, because there the heredoc
 * works and the sentence would only be noise. No machine means this process,
 * which is the default everywhere the caller has nothing better to say.
 */
export function shellRuleFor(machine) {
  // A machine that forgot to say its platform is NOT this process: answering
  // with `process.platform` would have a Windows board inject the rule into a
  // session running somewhere else. Unreachable today — both implementations
  // set `platform` — and it fails to the harmless side on purpose.
  if (machine) return machine.platform === 'win32' ? SHELL_RULE_WIN : '';
  return process.platform === 'win32' ? SHELL_RULE_WIN : '';
}

/**
 * `/tmp` on the dev box is a RAM disk, and a session that treats it as scratch
 * eventually kills itself.
 *
 * Measured, not guessed: on `runner-1`, `/tmp` is a 46 GB tmpfs. Two tasks
 * left 11 GB (`/tmp/v1390`) and 8.6 GB (`/tmp/hfs-1391-bin`) of cargo output
 * and server data there — 21 GB of *RAM* on a 23 GB box. Memory filled, 13 GB
 * went to swap, and the cgroup OOM killer started firing (`oom_kill 4` in
 * `user-1000.slice`). When what it takes is the runner's own node, systemd
 * restarts the unit, and the restart SIGTERMs the whole cgroup — which is
 * every `claude` session on that machine. Three chats died with code 143
 * before anyone looked at `free -h`.
 *
 * The runner also sets `TMPDIR` (see `remote/hfsmon-runner.service`), which
 * covers the tools that ask; this sentence covers the paths a model writes by
 * hand, which is where all 21 GB came from. A prompt asks and does not
 * guarantee — but there is nothing to structurally forbid here without taking
 * `/tmp` away from the things that legitimately use it for a few kilobytes.
 */
const TMP_RULE_RUNNER = '**En esta máquina `/tmp` es un disco en RAM.** '
  + 'Nada grande va ahí: ni `target/` ni `node_modules/`, ni binarios compilados, ni los datos de un servidor que levantes, ni volcados. '
  + 'Usa `$HOME` (por ejemplo `$HOME/tmp/<lo-tuyo>`) y bórralo al terminar. '
  + 'Llenar `/tmp` aquí no da «disco lleno»: agota la memoria y el kernel empieza a matar procesos, el tuyo incluido. ';

/**
 * The tmp rule for the machine a session runs on. Only a runner gets it: the
 * laptop's `/tmp` is a normal directory on disk, where the sentence would be
 * false as well as useless. Same shape as `shellRuleFor`, and the trailing
 * space lives in the value for the same reason.
 */
export function tmpRuleFor(machine) {
  return machine && machine.kind === 'runner' ? TMP_RULE_RUNNER : '';
}

/**
 * The language rule every prompt whose output can reach GitHub carries.
 *
 * PR #1445: the bug was fixed, and then the session published the evidence
 * comment with `gh pr comment` in Spanish — the language of the conversation —
 * on a repository whose working language is English. The task instructions did
 * ask for English, but only named the commit message and the PR body; comments
 * were not on that list, so the model did the reasonable thing and answered in
 * the language it was being spoken to. The fix was fine; the one artifact a
 * stranger would ever read was not.
 *
 * Hence an enumeration instead of a principle. "Everything that ends up on
 * GitHub" is read as "commits and the PR body" unless the sentence itself
 * spells out comments, issue comments and review replies — and unless it says
 * out loud that these very instructions being in Spanish changes nothing.
 *
 * Every phase that carries it pays for it on every turn, so it is one sentence:
 * the enumeration is what does the work, and a second sentence restating the
 * headline would be the part nobody reads.
 */
export const GITHUB_LANGUAGE_RULE = '**TODO LO QUE ACABE EN GITHUB VA EN INGLÉS:** '
  + 'mensajes de commit, título y cuerpo del PR, comentarios de PR o de issue y respuestas a hilos de review '
  + '— aunque estas instrucciones y la conversación estén en español.';

/**
 * The same rule plus what to do about text already published — for the one
 * kind of session that is allowed to write to GitHub.
 *
 * The other half of #1445: fixing it meant EDITING the Spanish comment, and
 * the first instinct is to publish a second one with the English version. Two
 * comments saying the same thing in two languages is worse than the original
 * mistake, and it cannot be undone from a prompt afterwards. So the rule
 * carries the recovery, and it carries the ownership check first: editing
 * someone else's comment is not a correction, it is a rewrite of what another
 * person said.
 *
 * "Whatever you published in this session" was the wrong criterion and it was
 * the first one written here: the Spanish comment of #1445 was published by the
 * fix session, and the chat that corrected it was a later one that had
 * published nothing. So the question is not who typed it, it is whose account
 * it came from — and the agent does not know which account it acts as, which is
 * why the rule spends a second command (`gh api user --jq .login`) on asking.
 *
 * The commands are pinned, not illustrative. `gh api` has no `--body-file`
 * flag — the `@` prefix in `-F body=@<fichero>` is what makes it read the file,
 * and a body typed inline dies on the first backtick or newline. `ghgate.js`
 * parses these same shapes, so the two are worth keeping in step; nothing
 * enforces them on the model today, and a prompt asks but does not guarantee.
 * The review-thread endpoint is a different path (`pulls/comments`) on purpose:
 * `issues/comments` answers 404 for a thread comment, which reads like a
 * permissions problem and sends the session looking in the wrong place.
 */
export const GITHUB_PUBLISH_RULE = `${GITHUB_LANGUAGE_RULE} `
  + 'Si algo ya publicado hay que corregirlo y salió de la cuenta con la que actúas, se EDITA: '
  + 'NUNCA publiques un segundo comentario repitiendo lo mismo en otro idioma. '
  + 'Compara el autor (`gh api repos/<owner>/<repo>/issues/comments/<id> --jq \'.user.login\'`) con tu cuenta (`gh api user --jq .login`): '
  + 'si coinciden, edita con `gh api -X PATCH repos/<owner>/<repo>/issues/comments/<id> -F body=@<fichero>` '
  + '(`gh api` no acepta `--body-file`); si no coinciden, no lo toques. '
  + 'Para un comentario de un hilo de review el endpoint es otro: `repos/<owner>/<repo>/pulls/comments/<id>`.';
