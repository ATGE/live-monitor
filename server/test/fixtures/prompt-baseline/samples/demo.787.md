Escribe los PASOS DE VALIDACIÓN MANUAL para que una persona compruebe a mano el cambio del issue #787 ("ci(inferno): US Core nightly red since 2026-08-09 — care_team_role_search hits localhost:8080, asserted-date search does not filter") que está en esta rama (fix/787-inferno-us-core-nightly).
<<diffSection>>
<<serversSection>>

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

Comprobar cada dato es una pregunta independiente: repártelas. Un subagente por pantalla, por endpoint o por identificador que tengas que verificar, y todos a la vez.

REGLA PRINCIPAL: nada genérico. Prohibido escribir marcadores como <URL>, <id>, "TU_ID", "una entidad cualquiera", "el registro que quieras" o "por ejemplo…". Todo dato debe ser real y verificado: si no lo has comprobado, no lo escribas. Antes de redactar, mira el diff y el código para saber qué pantallas y endpoints concretos toca el cambio.

No escribas NADA en GitHub: ni `gh pr comment`, ni `gh pr edit`, ni responder hilos. Estos pasos se los queda el tablero y los lee la persona que valida.

Responde en español y en Markdown. Tu respuesta debe EMPEZAR por la línea "## Qué cambió" — sin preámbulo, sin anunciar lo que vas a hacer, sin cerrar con un resumen. Esta es la estructura y nada más:

## Qué cambió
Dos o tres frases en lenguaje llano, nombrando los archivos concretos (ruta:línea) que cambiaron.

## Preparación
Solo lo imprescindible para empezar, con comandos exactos.

## Pasos
Lista numerada. Cada paso debe ser accionable sin pensar:
- Si es UI: la **URL completa y clicable** que abre esa pantalla exacta (con el id real), qué mirar en ella y, si hay que interactuar, qué botón o campo exacto.
- Si es API: el comando \`curl\` completo, copiable y que funcione tal cual.
Incluye junto a cada paso lo que se ve al ejecutarlo (un fragmento real de la respuesta o de la pantalla).

## Resultado esperado
Qué debe verse si el fix funciona y, en contraste, qué se veía ANTES. Deduce el «antes» leyendo el diff de esta rama contra su rama base (`git diff origin/<<baseBranch>>...HEAD`), NUNCA modificando el worktree: no uses git stash, checkout, reset ni edites archivos.

## Qué NO se probó
Límites concretos de esta validación.

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

Esa línea va **después** del Markdown, la última de todo. El tablero la quita
antes de mostrar los pasos, así que no la anuncies ni la comentes; aquí las
tareas son las comprobaciones que hiciste para escribir estos pasos, y `files`
va vacío porque esta fase no toca archivos.
