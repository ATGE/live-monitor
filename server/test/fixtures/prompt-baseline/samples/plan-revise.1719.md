The person reviewed the plan you proposed and asks for changes:

<<feedback>>

Redo the plan with those changes. You already read the code for the first version: keep what still holds, and read again only what the changes require you to check.

This turn is still planning only, with the same hard rules as before:

1. **Touch nothing.** No editing, creating or deleting files; no commits, no `git add`, no branches.
2. **Do not write to GitHub.**
3. **Do not build the whole suite or run the e2e tests.** This rule wins over the reminder below about sending builds and suites to the background: in this phase you do not run them at all.
4. **PROCESOS Y PUERTOS — lo tuyo, sí; lo ajeno, nunca.** Puedes parar y limpiar los procesos que arrancaste TÚ en esta tarea (tus servidores de prueba, tus comandos de fondo, los puertos que abriste). NUNCA toques un proceso que no arrancaste tú: los puertos 8080 y 8090 son los servidores de Edson en su checkout principal, y otros worktrees tienen los suyos. Si no sabes quién lo arrancó, no lo toques. Los servidores que levantó el tablero para esta tarea se paran desde el tablero: si necesitas reiniciarlos, dilo en vez de matarlos. Si necesitas levantar algo, usa un puerto libre >18000 y compruébalo antes. **Para esperar a algo tuyo en segundo plano, léelo con BashOutput cuando vayas a usar su resultado**, y si necesitas que termine antes de seguir, lánzalo en primer plano con su `timeout`. Nunca encadenes `sleep` en segundo plano para hacer tiempo: cada uno que vence te interrumpe, y los que dejes pendientes te seguirán interrumpiendo cuando ya hayas terminado.

The plan you end with replaces the previous one entirely: list every task again, not only the ones that changed — and it opens with the same brief as the first one, rewritten for this version, saying in its last line what changed from the previous plan and why.

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

## Antes del WORK_PLAN: el resumen de un vistazo

Tu respuesta debe **empezar** por una sección con esta cabecera exacta:

## De un vistazo

Debajo, entre 3 y 5 frases que un desarrollador entienda **sin abrir el código**:

- **qué pasa hoy** — el comportamiento que está mal, visto desde fuera;
- **qué pasará después del cambio** — el comportamiento nuevo, también visto desde fuera;
- **dónde se toca** — en una frase: qué parte del sistema (el servidor REST, la UI,
  el validador…), no la lista de archivos.

Escríbelo en prosa. **No vale** que la explicación sea una lista de rutas ni de
nombres de función: `loader.py`, `render_report()` y `tests/e2e` no le dicen
nada a quien tiene que aprobar el plan. Si sólo sabes decir qué archivos tocas,
todavía no sabes qué estás arreglando.

Lo que escribas **antes** de esa cabecera no llega a quien aprueba el plan, así
que no dejes ahí nada que haga falta. La tabla de tareas va después, en la línea
`WORK_PLAN:`; el resumen no la repite.

## Antes de terminar: el WORK_PLAN

Tu turno debe incluir, al final, **una línea** que empiece por `WORK_PLAN:` seguida
de un JSON válido en esa misma línea, sin bloque de código:

WORK_PLAN: {"tasks":[{"id":"t1","what":"qué hace esta pieza","files":["src/config/loader.py"],"dependsOn":[],"check":"python -m mypy src/config"},{"id":"t2","what":"otra pieza","files":["tests/config/test_loader.py"],"dependsOn":["t1"],"check":"cd tests && python -m pytest config/test_loader.py"}]}

Ese plan describe **el trabajo de esta fase**, repartido en piezas:

- **`dependsOn: []` significa «esto puede ir a la vez que las demás».** Pon un id
  ahí sólo si de verdad necesitas el resultado de esa pieza para empezar la tuya.
  Encadenar por costumbre convierte el plan en una fila.
- **`files`**: los archivos que esa pieza va a tocar, en rutas relativas a la raíz
  del repositorio. Dos tareas que puedan ir a la vez **no pueden compartir un
  archivo**: el tablero lo comprueba y te devuelve el plan si se solapan. Si dos
  piezas necesitan el mismo archivo, o las encadenas con `dependsOn` o las juntas
  en una sola.
- **`check`** (opcional): una línea de **bash** (Git Bash en Windows) — el mismo
  shell que tu herramienta Bash, así que `VAR=valor comando`, `&&` y `cd` valen —
  que corre en la raíz del worktree sin nada que sólo tenga tu sesión, y que
  demuestra que la pieza quedó bien — la comprobación rápida del módulo que
  tocaste (compilar, tipos, lint), un test concreto, un `curl`. El tablero lo
  ejecuta al terminar la pieza y no la da por hecha si falla. Que sea rápido y
  suyo: no la suite entera.
- **Si el trabajo es una sola cosa, declara una sola tarea.** No infles el plan:
  el tablero compara lo que declaras con lo que ejecutas, y cinco tareas
  «paralelas» hechas una detrás de otra se registran como incumplimiento.
