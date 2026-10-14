Implementa el fix completo para el issue de GitHub #1719 ("ui(search-parameters): detail panel values not aligned with badge indent (URL, Name, Status, FHIRPath expression)") en este worktree, rama fix/1719-ui-search-parameters-detail-panel.

Cuerpo del issue:
<<issueBody>>
<<planSection>><<extraContext>><<workPlanSection>>
<<projectContext>>
El tablero repone estas instrucciones porque no aparecen en el contexto que aporta el proyecto:
- Respeta el `CLAUDE.md` del repositorio y usa sus skills (`/work-with-ui`, `/work-with-hts`, `/test-hfs`…) cuando apliquen.
- Formatea por crate: `cargo fmt -p <crate>` por cada crate que hayas tocado.
- NUNCA `cargo fmt --all` desde un worktree: revienta en Windows con «filename or extension is too long».
- Compila en DEBUG, como el resto del proyecto y como CI (`cargo test`, `cargo clippy`, `cargo build` sin `--release`). `--release` tarda mucho más y no aporta nada aquí.
- Trampa conocida: compilar deja ~3.500 ficheros de specs R6 sucios solo en stat (el `git diff` sale vacío). Por eso el staging explícito.
- Stagea SOLO tus paths explícitos: nunca `git add -A` ni `git commit -a`, por lo de los specs R6.

Instrucciones de trabajo:

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
- **Editar en paralelo, sólo en archivos distintos.** Los subagentes comparten
  este worktree: dos escribiendo el mismo archivo se pisan y gana el último sin
  avisar a nadie. Reparte por archivo o por módulo; si dos cambios dependen de
  verdad uno del otro, hazlos tú, en serie.
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

Instrucciones del resto del trabajo:
- Respeta el CLAUDE.md del repositorio y usa las skills que declare (`/<nombre-de-skill>`) cuando apliquen.
- Verifica lo que tocaste con las comprobaciones que declare el proyecto: formatea, pasa el linter y corre los tests de lo que cambiaste, acotado a los módulos que tocaste en vez de a todo el repositorio. Lanza juntos, en el mismo mensaje y con `run_in_background`, solo los comandos que no compartan candado ni escriban los mismos archivos: la comprobación de formato en modo comprobación (sin reescribir), el linter sin su opción de arreglo automático y los tests. Si dos de ellos compiten por el mismo directorio de compilación, no ganas nada lanzándolos a la vez: córrelos uno tras otro. Si el formateador tiene que escribir, córrelo primero y solo sobre tus archivos. Lee la salida de cada uno con la herramienta de salida y espera a todos antes de responder.
- **PROCESOS Y PUERTOS — lo tuyo, sí; lo ajeno, nunca.** Puedes parar y limpiar los procesos que arrancaste TÚ en esta tarea (tus servidores de prueba, tus comandos de fondo, los puertos que abriste). NUNCA toques un proceso que no arrancaste tú: los puertos 8080 y 8090 son los servidores de Edson en su checkout principal, y otros worktrees tienen los suyos. Si no sabes quién lo arrancó, no lo toques. Los servidores que levantó el tablero para esta tarea se paran desde el tablero: si necesitas reiniciarlos, dilo en vez de matarlos. Si necesitas levantar algo, usa un puerto libre >18000 y compruébalo antes. **Para esperar a algo tuyo en segundo plano, léelo con BashOutput cuando vayas a usar su resultado**, y si necesitas que termine antes de seguir, lánzalo en primer plano con su `timeout`. Nunca encadenes `sleep` en segundo plano para hacer tiempo: cada uno que vence te interrumpe, y los que dejes pendientes te seguirán interrumpiendo cuando ya hayas terminado. Every server or process you start to measure or test, stop it before your final answer. If it must stay alive for what comes next, say so in the answer with its port and how to stop it. Para la suite e2e usa `<<e2ePortEnv>>=<puerto libre>` junto con `CI=1`, que es como la lanza el orquestador.
- Solo si el repositorio está en blanco (ningún manifiesto de dependencias ni de build en la raíz), el orquestador de la sesión crea primero ese manifiesto, con sus scripts, e instala las dependencias él mismo UNA sola vez antes de lanzar subagentes. Ningún subagente instala nada: dos instalaciones a la vez corrompen el directorio de dependencias. Después de esa instalación, los subagentes ya pueden correr el build, los tipos y los tests.
- 
- Otra trampa: para descartar salida usa `/dev/null`, NUNCA `> nul`. El shell aquí es bash, así que `nul` no es el dispositivo de Windows sino un fichero que se crea en el worktree y que después impide borrarlo.
- **Tu turno es toda tu sesión.** Cuando respondes por última vez, el proceso termina y **todo lo que dejaste en segundo plano muere con él**: una compilación o unos tests lanzados con run_in_background que no has esperado no van a terminar, y un «commitearé cuando pasen» no llegará nunca. Antes de tu respuesta final, espera a que terminen tus comandos de fondo (léelos con la herramienta de salida) y **haz el commit**. Terminar sin commit es, para el tablero, un fix fallido.
- **TODO LO QUE ACABE EN GITHUB VA EN INGLÉS:** mensajes de commit, título y cuerpo del PR, comentarios de PR o de issue y respuestas a hilos de review — aunque estas instrucciones y la conversación estén en español.
- Al terminar, crea UN commit con formato Conventional Commits (feat:/fix: con scope si ayuda) cuyo cuerpo incluya "Closes #1719". Stagea SOLO tus paths explícitos, nunca el árbol entero. NO escribas NADA en GitHub: ni push, ni PR, ni comentarios, ni responder a hilos de review, ni `gh pr edit`. El orquestador es el único que toca GitHub.
- Termina con un resumen corto de qué cambiaste y qué verificaciones corriste.
