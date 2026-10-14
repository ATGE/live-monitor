Implementa el fix completo para el issue de GitHub #{{issueNumber}} ("{{issueTitle}}") en este worktree, rama {{branch}}.

Cuerpo del issue:
{{issueBody}}
{{planSection}}{{extraContext}}{{workPlanSection}}
{{projectContext}}
Instrucciones de trabajo:
{{parallel}}

Instrucciones del resto del trabajo:
- Respeta el CLAUDE.md del repositorio y usa las skills que declare (`/<nombre-de-skill>`) cuando apliquen.
- Verifica lo que tocaste con las comprobaciones que declare el proyecto: formatea, pasa el linter y corre los tests de lo que cambiaste, acotado a los módulos que tocaste en vez de a todo el repositorio. Lanza juntos, en el mismo mensaje y con `run_in_background`, solo los comandos que no compartan candado ni escriban los mismos archivos: la comprobación de formato en modo comprobación (sin reescribir), el linter sin su opción de arreglo automático y los tests. Si dos de ellos compiten por el mismo directorio de compilación, no ganas nada lanzándolos a la vez: córrelos uno tras otro. Si el formateador tiene que escribir, córrelo primero y solo sobre tus archivos. Lee la salida de cada uno con la herramienta de salida y espera a todos antes de responder.
- {{processRule}} Every server or process you start to measure or test, stop it before your final answer. If it must stay alive for what comes next, say so in the answer with its port and how to stop it.{{e2eRule}}
- Solo si el repositorio está en blanco (ningún manifiesto de dependencias ni de build en la raíz), el orquestador de la sesión crea primero ese manifiesto, con sus scripts, e instala las dependencias él mismo UNA sola vez antes de lanzar subagentes. Ningún subagente instala nada: dos instalaciones a la vez corrompen el directorio de dependencias. Después de esa instalación, los subagentes ya pueden correr el build, los tipos y los tests.
- {{tmpRule}}
- {{shellRule}}Otra trampa: para descartar salida usa `/dev/null`, NUNCA `> nul`. El shell aquí es bash, así que `nul` no es el dispositivo de Windows sino un fichero que se crea en el worktree y que después impide borrarlo.
- **Tu turno es toda tu sesión.** Cuando respondes por última vez, el proceso termina y **todo lo que dejaste en segundo plano muere con él**: una compilación o unos tests lanzados con run_in_background que no has esperado no van a terminar, y un «commitearé cuando pasen» no llegará nunca. Antes de tu respuesta final, espera a que terminen tus comandos de fondo (léelos con la herramienta de salida) y **haz el commit**. Terminar sin commit es, para el tablero, un fix fallido.
- {{githubRule}}
- Al terminar, crea UN commit con formato Conventional Commits (feat:/fix: con scope si ayuda) cuyo cuerpo incluya "Closes #{{issueNumber}}". Stagea SOLO tus paths explícitos, nunca el árbol entero. NO escribas NADA en GitHub: ni push, ni PR, ni comentarios, ni responder a hilos de review, ni `gh pr edit`. El orquestador es el único que toca GitHub.
- Termina con un resumen corto de qué cambiaste y qué verificaciones corriste.
