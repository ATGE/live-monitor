Ronda <<round>> de <<maxRounds>> de cierre de huecos para el issue #551 ("HTS: research terminology UI requirements and build an administrative console"). Esta es la misma sesión del fix, reanudada: ya conoces lo que cambiaste. Rama base: <<baseBranch>>.

Cuerpo del issue:
<<issueBody>>

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

Antes de que se abra el PR, revisa tu propio trabajo y responde dos preguntas:

1. **Evidencia.** ¿Hay pruebas de que el cambio resuelve el problema, o de que la funcionalidad cumple sus objetivos? Cuenta como evidencia un test que falla sin el cambio y pasa con él, un comando que ejecutaste y su salida, o una comprobación equivalente. Si falta evidencia, di cuál falta y cómo conseguirla; si puedes conseguirla tú ahora con un comando acotado, hazlo.
2. **Huecos.** ¿Dejó el cambio huecos? Por ejemplo: casos sin tratar, TODOs o código a medias, afirmaciones que no verificaste, archivos que debían actualizarse y no se actualizaron, documentación que ya no dice la verdad.

Las dos preguntas son independientes: investígalas a la vez (lecturas y comandos en el mismo mensaje), no una detrás de otra. Usa un subagente solo para lo que no tengas ya en contexto: lo que cambiaste y los comandos que corriste ya los conoces. Esta regla gana sobre el recordatorio de arriba, que pide un subagente por pregunta.

Reglas:
- No pidas nada a una persona ni hagas preguntas: si un hueco solo lo puede cerrar una persona (una decisión, un dato, un permiso), márcalo `needsHuman: true` y sigue.
- En esta ronda solo diagnostica: no edites archivos ni hagas commits. Usa herramientas únicamente para verificar evidencia (leer el código, correr un test o un comando acotado).
- **PROCESOS Y PUERTOS — lo tuyo, sí; lo ajeno, nunca.** Puedes parar y limpiar los procesos que arrancaste TÚ en esta tarea (tus servidores de prueba, tus comandos de fondo, los puertos que abriste). NUNCA toques un proceso que no arrancaste tú: los puertos 8080 y 8090 son los servidores de Edson en su checkout principal, y otros worktrees tienen los suyos. Si no sabes quién lo arrancó, no lo toques. Los servidores que levantó el tablero para esta tarea se paran desde el tablero: si necesitas reiniciarlos, dilo en vez de matarlos. Si necesitas levantar algo, usa un puerto libre >18000 y compruébalo antes. **Para esperar a algo tuyo en segundo plano, léelo con BashOutput cuando vayas a usar su resultado**, y si necesitas que termine antes de seguir, lánzalo en primer plano con su `timeout`. Nunca encadenes `sleep` en segundo plano para hacer tiempo: cada uno que vence te interrumpe, y los que dejes pendientes te seguirán interrumpiendo cuando ya hayas terminado. Every server or process you start to verify something, stop it before your final answer.
- Otra trampa: para descartar salida usa `/dev/null`, NUNCA `> nul`. El shell aquí es bash, así que `nul` no es el dispositivo de Windows sino un fichero que se crea en el worktree y que después impide borrarlo.
- No escribas nada en GitHub.
- Sé concreto: cada hueco lleva un resumen de una línea y, si lo sabes, cómo cerrarlo. Si no hay huecos, dilo y deja `gaps` vacío.

<<gapsContract>>
