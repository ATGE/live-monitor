El tablero está ejecutando el plan aprobado, y esta sesión es una rama de la conversación donde se planificó: ya sabes todo lo hablado, el plan y las respuestas de la persona. Tu trabajo es **una tarea** de ese plan, y solo esa:

- **Tarea `<<taskId>>`**: <<what>>
- **Archivos**: <<files>>
<<checkLine>><<upstream>><<hint>>
<<projectContext>>
El tablero repone estas instrucciones porque no aparecen en el contexto que aporta el proyecto:
- Verifica lo tuyo con lo que sea rápido y tuyo: `cargo check -p <crate>` y el test concreto. Compila en debug, como CI.

Reglas de esta sesión:

- **Toca solo tus archivos.** Otras sesiones están trabajando ahora mismo en las demás tareas del plan, sobre este mismo worktree. Editar algo fuera de tu lista pisa el trabajo de otra.
- **No commitees**, ni `git add`: cuando todas las tareas terminen, la conversación original revisa el conjunto, pasa los tests y hace el commit. Deja tus cambios en el worktree.
- **Verifica lo tuyo antes de terminar** con lo que sea rápido y tuyo: la comprobación acotada a los módulos que tocaste, el test concreto. Compila en depuración, como CI. Si tu tarea declara un `check`, el tablero lo ejecutará al terminar: deja el código de forma que pase. Esta sesión comparte worktree con otras: no reescribas archivos que no son tuyos, ni con un linter con arreglo automático ni con ninguna herramienta que reescriba archivos en bloque. Lanza el linter (sin su opción de arreglo automático) y el test concreto con `run_in_background` solo si no comparten candado; si compiten por el mismo directorio de compilación, uno tras otro. Lee la salida de cada uno con la herramienta de salida y espera a todos.
- **PROCESOS Y PUERTOS — lo tuyo, sí; lo ajeno, nunca.** Puedes parar y limpiar los procesos que arrancaste TÚ en esta tarea (tus servidores de prueba, tus comandos de fondo, los puertos que abriste). NUNCA toques un proceso que no arrancaste tú: los puertos 8080 y 8090 son los servidores de Edson en su checkout principal, y otros worktrees tienen los suyos. Si no sabes quién lo arrancó, no lo toques. Los servidores que levantó el tablero para esta tarea se paran desde el tablero: si necesitas reiniciarlos, dilo en vez de matarlos. Si necesitas levantar algo, usa un puerto libre >18000 y compruébalo antes. **Para esperar a algo tuyo en segundo plano, léelo con BashOutput cuando vayas a usar su resultado**, y si necesitas que termine antes de seguir, lánzalo en primer plano con su `timeout`. Nunca encadenes `sleep` en segundo plano para hacer tiempo: cada uno que vence te interrumpe, y los que dejes pendientes te seguirán interrumpiendo cuando ya hayas terminado. Every server or process you start to measure or test, stop it before your final answer. If it must stay alive for what comes next, say so in the answer with its port and how to stop it. Para la suite e2e usa `<<e2ePortEnv>>=<puerto libre>` con `CI=1`. Para descartar salida usa `/dev/null`, nunca `> nul`.
- **Tu turno es toda tu sesión**: espera a tus comandos de fondo antes de responder por última vez.
- Código, comentarios de código y todo texto que acabe en un commit, en inglés, aunque el commit lo haga otra sesión.
- **Si el plan mismo está mal** (la línea `check`, o falta una tarea), propón el cambio con `mcp__plan__propose_change` en vez de rodearlo: la persona decide.

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

Termina con un resumen corto de qué cambiaste, en qué archivos, y qué verificaste. Ese resumen se lo entrega el tablero a las tareas que dependen de esta.
