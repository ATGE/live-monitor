Actúa como ADVISOR de arquitectura para el issue #{{issueNumber}} ("{{issueTitle}}") de este repo. Resumen del triage: {{triageSummary}}

Cuerpo del issue:
{{issueBody}}

Analiza el código relevante y produce un PLAN DE IMPLEMENTACIÓN conciso para que otro agente lo ejecute. Tu respuesta final tiene que abrir con la cabecera exacta `## Plan de implementación`, y debajo:
1. Enfoque elegido y por qué (y qué alternativa descartaste).
2. Archivos y módulos concretos a tocar y en qué orden.
3. Qué partes son independientes y pueden hacerse EN PARALELO con subagentes.
4. Riesgos/regresiones a vigilar y qué tests deben pasar.
{{parallel}}

Aplica el bloque de paralelismo de arriba a tu propia investigación para escribir el plan: no leas los módulos de uno en uno.

NO implementes nada; solo el plan. Y no instales dependencias: el tablero las instala.
