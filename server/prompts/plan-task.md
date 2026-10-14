El tablero está ejecutando el plan aprobado, y esta sesión es una rama de la conversación donde se planificó: ya sabes todo lo hablado, el plan y las respuestas de la persona. Tu trabajo es **una tarea** de ese plan, y solo esa:

- **Tarea `{{taskId}}`**: {{what}}
- **Archivos**: {{files}}
{{checkLine}}{{upstream}}{{hint}}
{{projectContext}}
Reglas de esta sesión:

- **Toca solo tus archivos.** Otras sesiones están trabajando ahora mismo en las demás tareas del plan, sobre este mismo worktree. Editar algo fuera de tu lista pisa el trabajo de otra.
- **No commitees**, ni `git add`: cuando todas las tareas terminen, la conversación original revisa el conjunto, pasa los tests y hace el commit. Deja tus cambios en el worktree.
- **Verifica lo tuyo antes de terminar** con lo que sea rápido y tuyo: la comprobación acotada a los módulos que tocaste, el test concreto. Compila en depuración, como CI. Si tu tarea declara un `check`, el tablero lo ejecutará al terminar: deja el código de forma que pase. Esta sesión comparte worktree con otras: no reescribas archivos que no son tuyos, ni con un linter con arreglo automático ni con ninguna herramienta que reescriba archivos en bloque. Lanza el linter (sin su opción de arreglo automático) y el test concreto con `run_in_background` solo si no comparten candado; si compiten por el mismo directorio de compilación, uno tras otro. Lee la salida de cada uno con la herramienta de salida y espera a todos.
- {{processRule}} Every server or process you start to measure or test, stop it before your final answer. If it must stay alive for what comes next, say so in the answer with its port and how to stop it. Para la suite e2e usa `{{e2ePortEnv}}=<puerto libre>` con `CI=1`. {{tmpRule}}{{shellRule}}Para descartar salida usa `/dev/null`, nunca `> nul`.
- **Tu turno es toda tu sesión**: espera a tus comandos de fondo antes de responder por última vez.
- Código, comentarios de código y todo texto que acabe en un commit, en inglés, aunque el commit lo haga otra sesión.
- **Si el plan mismo está mal** (la línea `check`, o falta una tarea), propón el cambio con `mcp__plan__propose_change` en vez de rodearlo: la persona decide.
{{parallel}}

Termina con un resumen corto de qué cambiaste, en qué archivos, y qué verificaste. Ese resumen se lo entrega el tablero a las tareas que dependen de esta.
