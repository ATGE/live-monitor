Ronda {{round}} de {{maxRounds}} de cierre de huecos para el issue #{{issueNumber}} ("{{issueTitle}}"). Esta es la misma sesión del fix, reanudada: ya conoces lo que cambiaste. Rama base: {{baseBranch}}.

Cuerpo del issue:
{{issueBody}}

Instrucciones de trabajo:
{{parallel}}

Antes de que se abra el PR, revisa tu propio trabajo y responde dos preguntas:

1. **Evidencia.** ¿Hay pruebas de que el cambio resuelve el problema, o de que la funcionalidad cumple sus objetivos? Cuenta como evidencia un test que falla sin el cambio y pasa con él, un comando que ejecutaste y su salida, o una comprobación equivalente. Si falta evidencia, di cuál falta y cómo conseguirla; si puedes conseguirla tú ahora con un comando acotado, hazlo.
2. **Huecos.** ¿Dejó el cambio huecos? Por ejemplo: casos sin tratar, TODOs o código a medias, afirmaciones que no verificaste, archivos que debían actualizarse y no se actualizaron, documentación que ya no dice la verdad.

Las dos preguntas son independientes: investígalas a la vez (lecturas y comandos en el mismo mensaje), no una detrás de otra. Usa un subagente solo para lo que no tengas ya en contexto: lo que cambiaste y los comandos que corriste ya los conoces. Esta regla gana sobre el recordatorio de arriba, que pide un subagente por pregunta.

Reglas:
- No pidas nada a una persona ni hagas preguntas: si un hueco solo lo puede cerrar una persona (una decisión, un dato, un permiso), márcalo `needsHuman: true` y sigue.
- En esta ronda solo diagnostica: no edites archivos ni hagas commits. Usa herramientas únicamente para verificar evidencia (leer el código, correr un test o un comando acotado).
- {{processRule}} Every server or process you start to verify something, stop it before your final answer.
- {{shellRule}}Otra trampa: para descartar salida usa `/dev/null`, NUNCA `> nul`. El shell aquí es bash, así que `nul` no es el dispositivo de Windows sino un fichero que se crea en el worktree y que después impide borrarlo.
- No escribas nada en GitHub.
- Sé concreto: cada hueco lleva un resumen de una línea y, si lo sabes, cómo cerrarlo. Si no hay huecos, dilo y deja `gaps` vacío.

{{gapsContract}}
