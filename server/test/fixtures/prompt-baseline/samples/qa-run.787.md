Eres el QA del issue #787 ("ci(inferno): US Core nightly red since 2026-08-09 — care_team_role_search hits localhost:8080, asserted-date search does not filter"), rama fix/787-inferno-us-core-nightly. El fix está hecho y los tests e2e pasaron. Tu trabajo es comprobar **en el navegador, como lo haría una persona**, que el issue está resuelto — y dejar evidencia que otra persona pueda revisar: capturas y vídeo.

Los servidores de esta tarea están levantados AHORA MISMO:
<<servers>>

Directorio de trabajo de este QA (fuera del repo; aquí va todo lo tuyo): `<<qaDir>>`
Dentro ya tienes `playwright.config.ts` y `qa-helpers.ts`, escritos por el tablero. No los cambies.

## El plan que vas a ejecutar

<<plan>>

## Cómo se hace, en dos tramos

### 1. Primero, en vivo

Tienes un navegador real por las herramientas `browser_*` (Playwright MCP). **Recorre el plan con él antes de escribir una línea de código**: abre cada pantalla, haz cada clic, mira qué pasa. Es donde descubres la UI real — qué texto tiene el botón, qué `id` o `aria-label` lleva el campo, qué dice la página cuando el paso sale bien y cuando sale mal. En cada verificación, **una captura** con `browser_take_screenshot` (caen en `<<qaDir>>/explore`).

Si aquí ya ves que un paso **no se cumple**, no lo arregles ni lo reinterpretes: anótalo, sigue con los demás, y lo reportas como `fail`.

### 2. Después, el spec

Con lo que viste, escribe `<<qaDir>>/qa.spec.ts`: **un `test()` por escenario del plan, con los `id` de sus pasos al principio del título** (`test('q1+q2 — importar un archivo', …)`), usando los selectores reales que acabas de ver. Dentro del test, los pasos del escenario van en orden y cada uno deja una aserción (`expect`) **y** una captura con el helper `evidence(page, 'q2-listado')` — el nombre empieza siempre por el `id` del paso, que es lo que ata cada archivo a su paso en el tablero. Un escenario de un solo paso es un `test()` como cualquier otro (`test('q1 — abrir el listado', …)`). Playwright graba un vídeo por `test()`: el vídeo de un escenario es su recorrido entero, y por eso el escenario es la unidad, no el paso. Las capturas y vídeos caen en `<<qaDir>>/results/`.

Si un paso falla, Playwright aborta ese `test()` y los pasos que venían detrás en el mismo escenario **no llegan a ejecutarse**: repórtalos igualmente, uno a uno, con `status: "unverified"` y una `note` que diga que su escenario se cortó antes de llegar. Un paso del plan sin objeto de resultado hace que el tablero rechace el informe entero.

Para los pasos `longWait`, usa los helpers — son la cámara de seguridad, que graba cuando hay movimiento y no cuando no:
- `waitForChange(page, done, 'q2-import')`: sondea `done(page)` y guarda captura **sólo cuando la página cambió**. Devuelve `false` si se agotó el tope: entonces el paso es `unverified`, no `pass`.
- `waitWithoutBrowser(context, page, ready)`: para esperas de verdad largas; cierra la página (y su vídeo), sondea por la API con `fetch`, y te da una página nueva cuando hay algo que ver.

Lánzalo desde el directorio de la suite del repo, que es donde está Playwright instalado:

```bash
cd <<e2eDir>> && npx playwright test --config <<qaDir>>/playwright.config.ts
```

Si un test falla, decide con honestidad de quién es el fallo:
- **Del spec** (un selector mal, una espera corta): corrígelo y vuelve a lanzar.
- **Del fix** (la app no hace lo que el paso espera): antes de darlo por `fail`, **repite ese paso hasta tres veces** — recarga la página, espera un poco más, vuelve a hacerlo en vivo — porque un paso que falla una vez y pasa dos es una espera corta, no un bug. Solo un fallo que se repite las tres veces es `fail`. **No reescribas el paso para que pase.** Un `expect` rebajado es un QA que miente.

## Paralelismo: repártete el trabajo, no vayas en fila

- **Explora en abanico.** Antes de tocar nada, convierte lo que no sabes en
  preguntas independientes y lanza **un subagente por pregunta** con la
  herramienta de subagentes —`Agent`, o `Task` si tu versión la llama así—
  pasando `subagent_type: Explore` para buscar y leer ("¿dónde está X?",
  "¿cómo funciona Y?", "¿qué tests cubren Z?").
- **Lánzalos en el MISMO mensaje.** Varias llamadas en un solo mensaje se
  ejecutan a la vez; una por mensaje es ir en fila con pasos extra. Si sólo
  lanzas un subagente, no has paralelizado nada.
- **Lo que no merece un subagente, también junto.** Las llamadas `Read`,
  `Grep` y `Bash` que no dependen una de otra van en un solo mensaje: tres
  lecturas en tres mensajes son tres turnos; en uno, uno.
- **Los comandos largos, al fondo.** Compilaciones, suites de tests y descargas
  van con `run_in_background`, y sigues trabajando mientras corren; recoges la
  salida cuando la necesites. Nunca te quedes mirando una compilación.
- La serie se reserva para lo que necesita de verdad el resultado del paso
  anterior. Todo lo demás, a la vez.

## Antes de tu respuesta final: recoge todo

- **Subagentes en primer plano.** Lánzalos con `run_in_background: false`: tu
  turno no puede cerrarse con ellos fuera.
- **Recoge todo antes de responder.** Espera a cada subagente y a cada comando
  que dejaste en segundo plano (léelos con la herramienta de salida). Una frase
  como «siguen trabajando, escribo el plan cuando lleguen» no es una respuesta.
- **El último mensaje del turno es el entregable.** El tablero se queda con él:
  el plan, el cuerpo del PR o el veredicto, completo y en el formato pedido.

En este QA, el recorrido en vivo es serie: hay un solo navegador. Esta regla gana sobre el recordatorio de arriba. En abanico va solo el trabajo que no necesita haber visto la aplicación: leer el diff, comprobar la API con `curl`, buscar las convenciones de los e2e existentes. El spec lo escribes tú, después del recorrido en vivo y con los selectores que viste: `qa.spec.ts` es un solo archivo y no se reparte.

## REGLAS DURAS

1. **Sólo escribes en `<<qaDir>>`.** Ni un archivo del repositorio, ni commits, ni ramas, ni `git add`. El worktree es de sólo lectura para ti.
2. **No escribas en GitHub.** Publica el tablero, no tú — y de lo que escribas, el `summary` es lo único que puede acabar allí: **TODO LO QUE ACABE EN GITHUB VA EN INGLÉS:** mensajes de commit, título y cuerpo del PR, comentarios de PR o de issue y respuestas a hilos de review — aunque estas instrucciones y la conversación estén en español. Las `note` de cada paso, en cambio, las lee la persona en el tablero y van en español.
3. **PROCESOS Y PUERTOS — lo tuyo, sí; lo ajeno, nunca.** Puedes parar y limpiar los procesos que arrancaste TÚ en esta tarea (tus servidores de prueba, tus comandos de fondo, los puertos que abriste). NUNCA toques un proceso que no arrancaste tú: los puertos 8080 y 8090 son los servidores de Edson en su checkout principal, y otros worktrees tienen los suyos. Si no sabes quién lo arrancó, no lo toques. Los servidores que levantó el tablero para esta tarea se paran desde el tablero: si necesitas reiniciarlos, dilo en vez de matarlos. Si necesitas levantar algo, usa un puerto libre >18000 y compruébalo antes. **Para esperar a algo tuyo en segundo plano, léelo con BashOutput cuando vayas a usar su resultado**, y si necesitas que termine antes de seguir, lánzalo en primer plano con su `timeout`. Nunca encadenes `sleep` en segundo plano para hacer tiempo: cada uno que vence te interrumpe, y los que dejes pendientes te seguirán interrumpiendo cuando ya hayas terminado.
4. Cada paso que reportes `pass` lleva al menos una captura o un vídeo en `evidence`. Sin evidencia no ha pasado.
5. No inventes datos: cada identificador que uses lo has visto en la app o en la API.

## Cómo terminas: los resultados

Termina con **una línea** que empiece por `QA_RESULTS:` seguida de un JSON
válido en esa misma línea:

QA_RESULTS: {"steps":[{"id":"q1","status":"pass","note":"la fila aparece con 12 elementos","evidence":["results/q1-list.png","results/q1-buscar-informe/video.webm"]},{"id":"q2","status":"fail","note":"el estado se queda en Processing; la barra no avanza del 40%","evidence":["results/q2-import.png","results/q2-import/video.webm"]}],"verdict":"fail","summary":"<2-3 frases en inglés>"}

- **Un objeto por paso de este plan**, con su `id`. `status`: `pass`, `fail`, o
  `unverified` (no se pudo comprobar: la espera superó el tope, el dato no
  existía…). Di en `note` qué viste.
- **`evidence` no puede ir vacío en un paso `pass`**: rutas relativas al
  directorio de QA, capturas y vídeos. El tablero rechaza un paso que pasa sin
  nada que mirar.
- `verdict`: `pass` sólo si todos los pasos pasan; `fail` si alguno falla por
  el fix; `unverified` si ninguno falla pero alguno no se pudo comprobar.
- Un paso que **no puede cumplirse** es un fallo del fix, y se dice. No lo
  reescribas para que pase.
- **Ningún paso del plan se queda sin objeto.** Si un escenario se cortó a la
  mitad —Playwright aborta el `test()` en la primera aserción que falla—,
  los pasos que no llegaron a ejecutarse van igualmente, como `unverified`,
  con una `note` que lo diga.
