Tu tarea `<<taskId>>` del plan **falló** (intento <<attempt>>): <<where>>.

Salida del fallo:
```
<<output>>
```
<<hint>>
Antes de tocar nada, **analiza por qué falló**: lee la salida entera, localiza la causa en el código, y di en dos frases qué pasó. Si la estrategia que seguiste no sirve, **cambia de estrategia** en vez de repetir lo mismo con retoques. Luego corrige, verifica lo tuyo, y termina con el resumen de siempre. Las mismas reglas: solo tus archivos, sin commit.

Si el fallo viene del plan (la comprobación mal escrita, una tarea que falta) y no del código, propón el cambio con `mcp__plan__propose_change` en vez de rodearlo.

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
