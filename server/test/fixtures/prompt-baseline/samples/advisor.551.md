Actúa como ADVISOR de arquitectura para el issue #551 ("HTS: research terminology UI requirements and build an administrative console") de este repo. Resumen del triage: 

Cuerpo del issue:
<<issueBody>>

Analiza el código relevante y produce un PLAN DE IMPLEMENTACIÓN conciso para que otro agente lo ejecute. Tu respuesta final tiene que abrir con la cabecera exacta `## Plan de implementación`, y debajo:
1. Enfoque elegido y por qué (y qué alternativa descartaste).
2. Archivos y módulos concretos a tocar y en qué orden.
3. Qué partes son independientes y pueden hacerse EN PARALELO con subagentes.
4. Riesgos/regresiones a vigilar y qué tests deben pasar.

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

Aplica el bloque de paralelismo de arriba a tu propia investigación para escribir el plan: no leas los módulos de uno en uno.

NO implementes nada; solo el plan. Y no instales dependencias: el tablero las instala.
