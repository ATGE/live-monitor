import './isolate.mjs';   // primero: aisla el directorio de datos
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ALLOWED, renderPrompt } from '../src/prompts.js';
import {
  PROMPT_INVARIANTS,
  BACKSTOP_HEADING,
  backstopBlock,
  invariantText,
  invariantsFor,
  missingInvariants,
  negatedNear,
  validateInvariants,
} from '../src/prompt-invariants.js';

/**
 * El inventario es la red de seguridad de la mudanza del conocimiento, y desde
 * el 2026-09-26 la mudanza está hecha: las plantillas ya no saben de hfs y ese
 * saber viene del `project.md` del repositorio vigilado, que edita otro equipo.
 * Las dos afirmaciones de esta prueba se invirtieron con ese cambio, y esa
 * inversión es justo lo que demuestra que la red existe:
 *
 * 1. Con el descriptor **vacío** —el peor caso: el proyecto no aporta nada— el
 *    respaldo **tiene que disparar**, y con una lista exacta de frases. Antes
 *    del 2026-09-26 esta misma prueba afirmaba lo contrario, porque las frases
 *    seguían en las plantillas.
 * 2. Con el **descriptor fusionado** (PR #1523 de hfs, copiado abajo como
 *    fixture) el respaldo se queda callado, salvo la única frase que el
 *    descriptor no dice. Comprobar las frases contra el descriptor, y no contra
 *    el render de las plantillas, es lo que hace que esta prueba se entere si
 *    el equipo de hfs borra una regla de su lado.
 * 3. Y que **sí dispara** cuando una frase falta, con un proyecto sintético:
 *    una comprobación que solo se ejecuta cuando todo va bien no demuestra nada.
 */

/** Las plantillas que pueden llevar el bloque: las que tienen `{{projectContext}}`. */
const CARRIERS = Object.keys(ALLOWED).filter((name) => ALLOWED[name].includes('projectContext'));

/**
 * Renderiza rellenando con centinelas **solo** lo que la plantilla echa en
 * falta, preguntándoselo al propio `renderPrompt`.
 *
 * Deducirlo del error, y no de una copia a mano de `AUTOMATIC`, es lo que deja
 * los valores automáticos con su texto real: las frases del inventario salen de
 * las plantillas, pero una futura podría venir de un contrato inyectado, y esta
 * prueba tiene que verlo igual que lo ve el pipeline.
 */
function render(name, extra = {}) {
  const vars = { ...extra };
  for (let round = 0; round < 50; round += 1) {
    try {
      return renderPrompt(name, vars);
    } catch (e) {
      const m = /^Faltan variables al render de .*?: (.*)$/.exec(e.message);
      if (!m) throw e;
      for (const missing of m[1].split(', ')) vars[missing] = `<<${missing}>>`;
    }
  }
  throw new Error(`no se pudo completar el render de ${name}`);
}

/** Instala un proyecto sintético en el inventario y lo quita pase lo que pase. */
function withProject(id, byTemplate, fn) {
  PROMPT_INVARIANTS[id] = byTemplate;
  try {
    return fn();
  } finally {
    delete PROMPT_INVARIANTS[id];
  }
}

/* -------------------------------------------------------------------------
 * La forma del inventario
 * ---------------------------------------------------------------------- */

test('la tabla se valida sola y no repite ids', () => {
  assert.ok(validateInvariants() > 0, 'la tabla no declara ninguna frase');
});

test('solo declara plantillas que pueden llevar el bloque', () => {
  assert.deepEqual(CARRIERS, ['triage', 'fix', 'plan-task'],
    'cambió qué plantillas tienen `{{projectContext}}`: revisa dónde se inyecta el respaldo');

  for (const [projectId, byTemplate] of Object.entries(PROMPT_INVARIANTS)) {
    for (const template of Object.keys(byTemplate)) {
      assert.ok(CARRIERS.includes(template),
        `${projectId}.${template}: esa plantilla no tiene \`{{projectContext}}\`, así que el `
        + 'respaldo no tendría dónde entrar y la frase no se repondría nunca');
    }
  }
});

test('cada entrada dice de dónde salió', () => {
  for (const byTemplate of Object.values(PROMPT_INVARIANTS)) {
    for (const entries of Object.values(byTemplate)) {
      for (const entry of entries) {
        assert.match(entry.source, /\S/, `${entry.id} no cita su origen`);
      }
    }
  }
});

test('un proyecto sin inventario no tiene nada que comprobar', () => {
  assert.deepEqual(invariantsFor('app-b', 'fix'), []);
  assert.deepEqual(invariantsFor('hfs', 'demo'), []);
  // Sin `projectId` manda el proyecto por defecto, que sí tiene entradas.
  assert.ok(invariantsFor(undefined, 'fix').length > 0);
});

/* -------------------------------------------------------------------------
 * Sin descriptor, la red actúa: la mitad que antes afirmaba lo contrario
 * ---------------------------------------------------------------------- */

/**
 * Lo que el respaldo repone cuando el proyecto no aporta NADA, plantilla por
 * plantilla y en orden de declaración.
 *
 * Es una lista literal, no una derivada del inventario, porque las dos cosas
 * que tiene que cazar son justo las que una lista derivada no vería: una frase
 * que vuelve a colarse en una plantilla (dejaría de inyectarse y esta lista se
 * quedaría corta) y una entrada nueva sin sitio en el descriptor.
 */
const SIN_DESCRIPTOR = {
  triage: ['hfs/triage/rust-workspace'],
  fix: [
    'hfs/fix/repo-skills',
    'hfs/fix/fmt-per-crate',
    'hfs/fix/never-fmt-all',
    'hfs/fix/debug-not-release',
    'hfs/fix/r6-specs-dirty',
    'hfs/fix/explicit-staging',
  ],
  'plan-task': ['hfs/plan-task/check-per-crate'],
};

/**
 * Las dos frases que siguen en las plantillas, y por eso no se reponen nunca.
 *
 * La regla del `> nul` es de Windows y de bash, no de hfs: se queda en
 * `fix.md:17` y en `plan-task.md:12`, donde además `parallel.test.mjs` fija la
 * costura alrededor de `{{shellRule}}`. De la línea solo salieron los dos
 * tickets de hfs.
 */
const EN_LA_PLANTILLA = ['hfs/fix/nul-trap', 'hfs/plan-task/nul-trap'];

test('sin descriptor, el respaldo repone las frases que las plantillas soltaron', () => {
  for (const template of CARRIERS) {
    const injected = [];
    // `projectContext: ''` es el peor caso a propósito: el proyecto no aporta
    // NADA. Antes del 2026-09-26 el render seguía llevando todas las frases
    // porque estaban en la plantilla; ya no están, así que aquí se ve la red
    // trabajando, que es la única forma de saber que funciona.
    const text = render(template, {
      projectContext: '',
      projectId: 'hfs',
      onInvariantInjected: (e) => injected.push(e),
    });

    assert.deepEqual(injected.map((e) => e.id), SIN_DESCRIPTOR[template],
      `${template}.md: el respaldo no repuso lo que se esperaba. Si una frase volvió a la `
      + 'plantilla, quítala de esta lista; si dejó de reponerse sin volver a ninguna parte, es '
      + 'una degradación del prompt.');
    assert.ok(text.includes(BACKSTOP_HEADING), `falta la cabecera del bloque en ${template}.md`);
    for (const entry of invariantsFor('hfs', template)) {
      if (!SIN_DESCRIPTOR[template].includes(entry.id)) continue;
      assert.ok(text.includes(invariantText(entry)),
        `${entry.id}: se avisó de la frase pero su texto no entró en el render`);
    }
    assert.equal(typeof text, 'string');
  }
});

test('las frases que siguen en la plantilla no se reponen ni sin descriptor', () => {
  for (const template of CARRIERS) {
    const injected = [];
    render(template, {
      projectContext: '',
      projectId: 'hfs',
      onInvariantInjected: (e) => injected.push(e),
    });
    for (const id of EN_LA_PLANTILLA) {
      const declarada = invariantsFor('hfs', template).some((e) => e.id === id);
      if (!declarada) continue;
      assert.equal(injected.some((e) => e.id === id), false,
        `${id}: se repuso una frase que la plantilla ${template}.md sigue llevando, así que el `
        + 'prompt la lleva dos veces (o la plantilla la perdió y hay que decirlo aquí)');
    }
  }
});

/* -------------------------------------------------------------------------
 * Con el descriptor fusionado: la red calla, salvo lo que el descriptor no dice
 * ---------------------------------------------------------------------- */

/**
 * El descriptor fusionado de hfs (`.hfs-monitor/project.md`, PR #1523),
 * **copiado** aquí: sus secciones «Derived» y «Rules», verbatim.
 *
 * Copiado y no leído del checkout a propósito: esa ruta es de esta máquina
 * (`config.json` → `project.repoPath`) y cambia en el runner, así que una
 * prueba que lo leyera se pondría roja —o, peor, verde— según la máquina. Lo
 * que fija este fixture no es el estado del otro repositorio, es el análisis
 * con el que se vaciaron las plantillas: nueve de las diez frases las dice el
 * descriptor, y la décima no.
 *
 * Si el equipo de hfs reescribe estas secciones, esta copia hay que
 * actualizarla a mano; que se quede vieja no rompe nada en producción (la red
 * mira el render de verdad), solo deja de demostrar lo que dice demostrar.
 */
const DESCRIPTOR_FUSIONADO = [
  '## Derived',
  '',
  'These are commands to run against the checkout, not numbers to copy. Writing',
  'the *result* here as fixed text is exactly the mistake this file exists to',
  'prevent — `AGENTS.md` said 17 crates and `CLAUDE.md` said 20 while the',
  'workspace had grown to 22; both had drifted silently. Run the command, use',
  'its output.',
  '',
  '- **Crate count, total:** count directories under `crates/` that contain',
  '  their own `Cargo.toml` (e.g. `ls crates/*/Cargo.toml | wc -l` from a POSIX',
  '  shell, or an equivalent directory listing).',
  '- **Crate count, default build:** count the entries under `[workspace]` →',
  '  `default-members` in the root `Cargo.toml`.',
  '- **Full crate graph, machine-readable:** `cargo metadata --no-deps --offline`',
  '  run from the repository root. This only reads manifests — it does not',
  '  compile anything, so it is safe to run from a worktree without triggering',
  '  the R6-spec trap below.',
  '- **MSRV:** the `rust-version` key under `[workspace.package]` in the root',
  '  `Cargo.toml` (or `rust-toolchain.toml`, if one is added later).',
  '',
  '### Rules',
  '',
  '- **Format the workspace from the main checkout — never run `cargo fmt --all`',
  '  from a worktree, where it fails:** see `CLAUDE.md` → "Windows and worktree',
  '  notes". It is a pre-merge check and CI enforces it as',
  '  `cargo fmt --all -- --check` (`CONTRIBUTING.md` → "Pre-merge checks").',
  '- **When verifying a change, format per crate: run `cargo fmt -p <crate>` for',
  '  each crate you touched** — the form that works from a worktree.',
  '  `cargo fmt -- <path>...` (`CLAUDE.md` → "Windows and worktree notes") is',
  '  equally valid; use whichever names your change more exactly.',
  '- **Verify in debug; do not verify with `--release`:** `cargo check`,',
  '  `cargo test`, `cargo clippy` and `cargo build` without `--release`, which is',
  '  what CI gates on (`.github/workflows/ci.yml`; `--release` appears there only',
  '  in the release-artifact and benchmark jobs). This governs *verifying your',
  '  change* — release builds remain right for shipping binaries and for anyone',
  '  building a server to run, so "not `--release`" is not "never `--release`".',
  '- **Use the repository\'s own skills when the task touches what they cover**',
  '  (`/work-with-ui`, `/work-with-hts`, `/test-hfs`, …) instead of rediscovering',
  '  it: the full list is in `CLAUDE.md` → "Project Skills" (Claude Code, under',
  '  `.claude/skills/`) and `AGENTS.md` → "Project Skills" (Codex, under',
  '  `.agents/skills/`).',
  '- **Discard output with `/dev/null`, never `> nul`:** the shell here is bash on',
  '  Windows too, so `> nul` writes a real file and leaves the worktree',
  '  unremovable ever after (#942, #969) — see `CLAUDE.md` → "Windows and worktree',
  '  notes".',
  '- **Stage explicit paths — never `git add -A` or `git commit -a` in a worktree',
  '  here:** compiling leaves ~3,500 R6 spec files `stat`-dirty even when nothing',
  '  was edited (`CLAUDE.md` → "Windows and worktree notes").',
  ''].join('\n');

/**
 * La única frase que el descriptor fusionado NO dice, y que por eso se inyecta
 * en cada render de `plan-task`.
 *
 * El descriptor manda verificar en debug y nombra `cargo check`, pero no dice
 * nada de acotar la comprobación al paquete que tocaste, que en un workspace de
 * 22 crates es todo el asunto. Aceptar la inyección es más barato que aflojar
 * la sonda hasta que un `cargo check` suelto la dé por cubierta: eso diría que
 * la regla está mientras la sesión no lee nada del alcance. Cuando la regla
 * llegue al descriptor, esta lista se queda vacía sola.
 */
const SIN_COBERTURA = ['hfs/plan-task/check-per-crate'];

test('el descriptor fusionado lleva, una por una, las frases que las plantillas soltaron', () => {
  for (const template of CARRIERS) {
    const faltan = missingInvariants(DESCRIPTOR_FUSIONADO, { projectId: 'hfs', template })
      .map((e) => e.id);
    for (const entry of invariantsFor('hfs', template)) {
      const cubierta = !faltan.includes(entry.id);
      assert.equal(cubierta, !SIN_COBERTURA.includes(entry.id),
        `${entry.id}: el descriptor fusionado ${cubierta ? 'sí' : 'no'} cubre «${entry.phrase}» `
        + `y se esperaba lo contrario (origen: ${entry.source})`);
    }
  }
});

test('con el descriptor fusionado solo se repone lo que el descriptor no dice', () => {
  for (const template of CARRIERS) {
    const injected = [];
    const text = render(template, {
      projectContext: DESCRIPTOR_FUSIONADO,
      projectId: 'hfs',
      onInvariantInjected: (e) => injected.push(e),
    });
    const esperado = invariantsFor('hfs', template)
      .filter((e) => SIN_COBERTURA.includes(e.id))
      .map((e) => e.id);

    assert.deepEqual(injected.map((e) => e.id), esperado,
      `${template}.md: con el descriptor real el respaldo tiene que estar casi callado; `
      + 'cada inyección de más es una línea duplicada en cada render y una entrada de log '
      + 'que enseña a ignorar el log.');
    assert.equal(text.includes(BACKSTOP_HEADING), esperado.length > 0,
      `${template}.md: la cabecera del bloque no cuadra con lo que se repuso`);
  }
});

/* -------------------------------------------------------------------------
 * El caso falseado: la frase falta y el respaldo actúa
 * ---------------------------------------------------------------------- */

const GHOST = {
  id: 'sintetico/fix/frase-fantasma',
  phrase: 'NUNCA-APARECE-EN-NINGUNA-PLANTILLA',
  source: 'server/test/prompt-invariants.test.mjs',
  text: 'Reglas inventadas para la prueba: no toques el generador.',
};

test('si la frase falta, se inyecta el bloque y avisa el callback', () => {
  withProject('sintetico', { fix: [GHOST] }, () => {
    const injected = [];
    const text = render('fix', {
      projectContext: 'MARCA-DEL-DESCRIPTOR\n',
      projectId: 'sintetico',
      onInvariantInjected: (e) => injected.push(e),
    });

    assert.deepEqual(injected, [{ id: GHOST.id, phrase: GHOST.phrase, source: GHOST.source }],
      'el callback tiene que disparar una vez por frase repuesta, con {id, phrase, source}');
    assert.ok(text.includes(BACKSTOP_HEADING), 'falta la cabecera del bloque');
    assert.ok(text.includes(GHOST.text), 'se inyectó la sonda en vez de la instrucción');
    assert.equal(typeof text, 'string', 'el tipo de retorno no cambia');
  });
});

test('el bloque va pegado a {{projectContext}}, no al final del render', () => {
  withProject('sintetico', { fix: [GHOST] }, () => {
    const vars = { projectContext: 'MARCA-DEL-DESCRIPTOR\n' };
    // Mismo render, mismas variables: lo único que cambia es el proyecto. La
    // línea base es un proyecto SIN inventario, no `hfs`: desde el 2026-09-26 el
    // render de hfs repone seis frases y ya no sirve de referencia limpia.
    const sin = render('fix', { ...vars, projectId: 'proyecto-sin-inventario' });
    const con = render('fix', { ...vars, projectId: 'sintetico' });

    // Con función, no con cadena: un `$` en el bloque cambiaría de significado.
    const esperado = sin.replace('MARCA-DEL-DESCRIPTOR\n', () => `MARCA-DEL-DESCRIPTOR\n${backstopBlock([GHOST])}`);
    assert.equal(con, esperado,
      'el respaldo tiene que entrar DENTRO del valor de `{{projectContext}}` y no cambiar ni un byte '
      + 'del resto del render');
    assert.ok(con.indexOf(BACKSTOP_HEADING) < con.indexOf('Instrucciones de trabajo'),
      'el bloque quedó después del sitio del descriptor');
  });
});

test('solo se repone lo que falta, no el inventario entero', () => {
  const presente = {
    id: 'sintetico/plan-task/presente',
    // Una frase que la plantilla sigue llevando: `cargo check -p` ya no sirve
    // para esto, salió de `plan-task.md` el 2026-09-26.
    phrase: 'Toca solo tus archivos',
    source: 'server/prompts/plan-task.md:9',
    text: 'no debería hacer falta reponer esto',
  };
  const ausente = { ...GHOST, id: 'sintetico/plan-task/ausente' };

  withProject('sintetico', { 'plan-task': [presente, ausente] }, () => {
    const injected = [];
    const text = render('plan-task', {
      projectContext: '',
      projectId: 'sintetico',
      onInvariantInjected: (e) => injected.push(e),
    });

    assert.deepEqual(injected.map((e) => e.id), [ausente.id]);
    assert.equal(text.includes(presente.text), false, 'se repuso una frase que ya estaba');
    assert.ok(text.includes(ausente.text));
  });
});

test('una plantilla sin {{projectContext}} nunca recibe el bloque', () => {
  // `handoff` se compara byte a byte en `handoff.test.mjs`, y `qa-run` se
  // renderiza en `qa.test.mjs`: aunque alguien declare entradas para ellas, no
  // hay dónde inyectarlas, y eso es estructural, no una promesa sobre la tabla.
  withProject('sintetico', { handoff: [GHOST], 'qa-run': [GHOST] }, () => {
    for (const template of ['handoff', 'qa-run']) {
      const injected = [];
      const text = render(template, { projectId: 'sintetico', onInvariantInjected: (e) => injected.push(e) });
      assert.deepEqual(injected, [], `${template} no puede recibir el respaldo`);
      assert.equal(text.includes(BACKSTOP_HEADING), false);
    }
  });
});

test('un callback que revienta no le cuesta el prompt a la fase', () => {
  withProject('sintetico', { fix: [GHOST] }, () => {
    const text = render('fix', {
      projectContext: '',
      projectId: 'sintetico',
      onInvariantInjected: () => { throw new Error('el log de la tarea falló'); },
    });
    assert.ok(text.includes(GHOST.text), 'el texto repuesto es lo importante; el aviso es el informe');
  });
});

test('sin callback tampoco se cae', () => {
  withProject('sintetico', { fix: [GHOST] }, () => {
    const text = render('fix', { projectContext: '', projectId: 'sintetico' });
    assert.ok(text.includes(GHOST.text));
  });
});

/* -------------------------------------------------------------------------
 * La polaridad: una subcadena no distingue una orden de su contraria
 * ---------------------------------------------------------------------- */

/**
 * Un descriptor que solo **recomienda** `cargo fmt --all`, sintético.
 *
 * No es el descriptor de hfs: el fusionado empieza por prohibir el comando
 * desde un worktree y luego nombra el check de CI, así que ahí la prohibición
 * sí está. Este es el caso que la sonda tiene que sobrevivir: un descriptor
 * —este, o el de hfs después de una limpieza que se lleve la mitad que
 * prohíbe— donde la única mención del comando lo recomienda. Justo la subcadena
 * que la entrada `hfs/fix/never-fmt-all` usaba como sonda para prohibirlo.
 */
const DESCRIPTOR_PRE_MERGE = [
  '- **Build/test commands:** see `CLAUDE.md` → "Environment Setup" and',
  '  `CONTRIBUTING.md` → "Pre-merge checks" (`cargo fmt --all`,',
  '  `cargo clippy --all-targets --all-features -- -D warnings` with the',
  '  documented allow-list, `cargo test`).',
  '',
].join('\n');

test('el descriptor que RECOMIENDA `cargo fmt --all` no tapa la prohibición', () => {
  // El render lleva la recomendación del descriptor y ninguna prohibición: es
  // lo que queda cuando la plantilla ya no dice nada del comando (2026-09-26) y
  // el descriptor solo lo nombra como check de CI.
  //
  // Se renderiza con un proyecto SIN inventario y se pregunta por el de `hfs`
  // aparte: pedir las dos cosas a la vez mide el render YA REPARADO, donde el
  // bloque repuesto niega el comando y la sonda se da por cubierta a sí misma.
  const texto = render('fix', { projectContext: DESCRIPTOR_PRE_MERGE, projectId: 'proyecto-sin-inventario' });
  assert.ok(texto.includes('cargo fmt --all'),
    'el fixture tiene que conservar la subcadena en su sentido contrario: sin eso esta prueba no '
    + 'comprueba nada');

  const faltan = missingInvariants(texto, { projectId: 'hfs', template: 'fix' }).map((e) => e.id);
  assert.ok(faltan.includes('hfs/fix/never-fmt-all'),
    'con la sonda por subcadena la recomendación del descriptor daba por cubierta la prohibición, '
    + 'y la sesión acababa leyendo que corra `cargo fmt --all` desde un worktree');
  assert.ok(faltan.includes('hfs/fix/fmt-per-crate'),
    'este descriptor tampoco dice el formateo por crate, así que también hay que reponerlo');
});

test('la sonda negada acepta una familia de redacciones, no un texto exacto', () => {
  const probe = negatedNear('cargo fmt --all');
  // El descriptor se está reescribiendo en inglés ahora mismo: si la sonda
  // atara las palabras exactas, el día de la fusión repondría duplicados.
  for (const covered of [
    'NUNCA `cargo fmt --all` desde un worktree.',
    'Never run `cargo fmt --all` from a worktree here.',
    'Do not use `cargo fmt --all` in a worktree.',
    "Don't run cargo fmt --all from a worktree.",
    'Formatea por crate, sin `cargo fmt --all`.',
    'no uses cargo fmt --all aquí',
    // La negación puede caer al otro lado, y a dos líneas de distancia.
    'Running `cargo fmt --all` from a worktree on Windows\n  breaks with "filename too long".',
    '`cargo fmt --all` revienta en Windows.',
  ]) {
    assert.ok(probe.test(covered), `debería contar como cubierta: ${JSON.stringify(covered)}`);
  }

  for (const uncovered of [
    '`CONTRIBUTING.md` → "Pre-merge checks" (`cargo fmt --all`, `cargo test`).',
    'Run cargo fmt --all before opening the PR.',
    // La negación existe, pero es de otra frase y queda lejos.
    `never stage everything.${' '.repeat(80)}cargo fmt --all`,
  ]) {
    assert.equal(probe.test(uncovered), false, `no debería contar como cubierta: ${JSON.stringify(uncovered)}`);
  }
});

test('la sonda no arrastra estado entre llamadas', () => {
  // Dos veces el mismo texto tiene que dar dos veces lo mismo: es lo que se
  // pierde con las banderas `g`/`y` (ver `data-dir.test.mjs:41`).
  for (const entry of invariantsFor('hfs', 'fix')) {
    if (!entry.pattern) continue;
    const texto = invariantText(entry);
    assert.equal(entry.pattern.test(texto), entry.pattern.test(texto),
      `${entry.id}: la sonda responde distinto en dos llamadas seguidas`);
  }
});

test('una `pattern` mal formada revienta al validar, no en producción', () => {
  const base = { id: 'x/fix/p', phrase: 'cargo fmt --all', source: 'x' };
  const conPattern = (pattern) => ({ x: { fix: [{ ...base, pattern, text: 'NUNCA `cargo fmt --all`.' }] } });

  assert.throws(() => validateInvariants(conPattern('cargo fmt --all')), /debe ser una RegExp/);
  assert.throws(() => validateInvariants(conPattern(/never[\s\S]{0,60}cargo fmt --all/g)), /'g' ni 'y'/);
  assert.throws(() => validateInvariants(conPattern(/never[\s\S]{0,60}cargo fmt --all/y)), /'g' ni 'y'/);

  // La comprobación estructural: el bloque que se inyecta tiene que satisfacer
  // su propia sonda, o repondría para siempre algo que no tapa el hueco.
  assert.throws(
    () => validateInvariants({
      x: {
        fix: [{
          ...base,
          pattern: negatedNear('cargo fmt --all'),
          text: 'Formatea con `cargo fmt --all` antes del PR.',
        }],
      },
    }),
    /no satisface su propia sonda/);

  // Y una bien formada pasa.
  assert.equal(validateInvariants(conPattern(negatedNear('cargo fmt --all'))), 1);
});

test('las entradas que lo necesitan llevan `pattern`, y las demás no', () => {
  const conSonda = [];
  for (const byTemplate of Object.values(PROMPT_INVARIANTS)) {
    for (const entries of Object.values(byTemplate)) {
      for (const entry of entries) if (entry.pattern) conSonda.push(entry.id);
    }
  }
  assert.deepEqual(conSonda.sort(), [
    'hfs/fix/debug-not-release',
    'hfs/fix/explicit-staging',
    'hfs/fix/never-fmt-all',
    'hfs/fix/r6-specs-dirty',
    'hfs/triage/rust-workspace',
  ], 'una `pattern` es para dos casos y solo esos: la subcadena aparece en los dos sentidos '
    + '(las tres de `fix`) o el descriptor dice lo mismo con otras palabras —«specs R6» y '
    + '«workspace Rust» son orden español y el descriptor está en inglés—. En las demás no '
    + 'aporta y sí puede fallar');
});

/* -------------------------------------------------------------------------
 * Las piezas sueltas
 * ---------------------------------------------------------------------- */

test('missingInvariants mira el texto completo, no el descriptor', () => {
  // Una frase de la parte genérica de `fix.md`, que no se mudó a ninguna parte:
  // lo que se comprueba aquí es de dónde se lee, no qué dice.
  const entry = { id: 'x/fix/a', phrase: 'Conventional Commits', source: 'x' };
  withProject('sintetico', { fix: [entry] }, () => {
    // El descriptor de hfs CITA el CLAUDE.md en vez de copiar las trampas: si
    // la comprobación fuera contra él, esta frase saldría «ausente» y el
    // respaldo duplicaría lo que `fix.md` ya dice.
    const soloDescriptor = 'Ver `CLAUDE.md` para las convenciones de commit.';
    assert.equal(missingInvariants(soloDescriptor, { projectId: 'sintetico', template: 'fix' }).length, 1);

    const renderCompleto = render('fix', { projectContext: soloDescriptor, projectId: 'hfs' });
    assert.deepEqual(missingInvariants(renderCompleto, { projectId: 'sintetico', template: 'fix' }), []);
  });
});

test('la comparación no se rompe con saltos de línea de Windows', () => {
  const entry = { id: 'x/fix/crlf', phrase: 'una frase de prueba', source: 'x' };
  withProject('sintetico', { fix: [entry] }, () => {
    const texto = 'linea\r\nuna frase de prueba\r\nfin';
    assert.deepEqual(missingInvariants(texto, { projectId: 'sintetico', template: 'fix' }), []);
  });
});

test('el bloque vacío es la cadena vacía, y cada entrada es una línea', () => {
  assert.equal(backstopBlock([]), '');
  const block = backstopBlock([GHOST, { id: 'b', phrase: 'p', source: 's' }]);
  assert.ok(block.startsWith(`\n${BACKSTOP_HEADING}\n`));
  assert.ok(block.endsWith('\n'));
  assert.ok(block.includes(`- ${GHOST.text}`));
  // Sin `text`, la sonda se inyecta tal cual: mejor una línea corta que nada.
  assert.equal(invariantText({ id: 'b', phrase: 'p', source: 's' }), 'p');
  assert.ok(block.includes('\n- p\n'));
});
