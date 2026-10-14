Escribe los PASOS DE VALIDACIÓN MANUAL para que una persona compruebe a mano el cambio del issue #{{issueNumber}} ("{{issueTitle}}") que está en esta rama ({{branch}}).
{{diffSection}}
{{serversSection}}
{{parallel}}

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
Qué debe verse si el fix funciona y, en contraste, qué se veía ANTES. Deduce el «antes» leyendo el diff de esta rama contra su rama base (`git diff origin/{{baseBranch}}...HEAD`), NUNCA modificando el worktree: no uses git stash, checkout, reset ni edites archivos.

## Qué NO se probó
Límites concretos de esta validación.
{{workPlan}}

Esa línea va **después** del Markdown, la última de todo. El tablero la quita
antes de mostrar los pasos, así que no la anuncies ni la comentes; aquí las
tareas son las comprobaciones que hiciste para escribir estos pasos, y `files`
va vacío porque esta fase no toca archivos.
