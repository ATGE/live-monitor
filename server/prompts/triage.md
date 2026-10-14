Haz un triage BREVE del issue de GitHub #{{issueNumber}} de este repositorio.

Título: {{issueTitle}}
Labels: {{issueLabels}}

Cuerpo del issue:
{{issueBody}}

{{projectContext}}
Explora el código SOLO lo mínimo necesario para estimar la complejidad (qué módulos toca, cuántos archivos, si hay riesgo arquitectónico). NO implementes nada. Las dependencias las instala el tablero; no las instales tú.
{{parallel}}

Aquí el abanico es casi todo el trabajo: cada módulo sospechoso es una pregunta independiente, y contestarlas a la vez es la diferencia entre un triage de tres minutos y uno de quince.

Clasifica como "simple" (cambio localizado, pocos archivos, bajo riesgo) o "complex" (varios módulos, diseño no obvio, migraciones, o alto riesgo de regresión).
{{workPlan}}
{{qaPlan}}
{{qaAvailable}}
Tu respuesta final son TRES líneas, en este orden, y **la primera de ellas, `TRIAGE_RESULT:`, es la primera línea de tu respuesta final**: el prefijo exacto, en mayúsculas, sin viñeta, sin negritas, sin comillas y sin envolver en un bloque de código, con el JSON en esa misma línea. El tablero la busca por ese prefijo; si no la encuentra, te vuelve a preguntar una vez y el triage se pierde.

TRIAGE_RESULT: {"complexity":"simple|complex","reason":"<una frase, en español>","summary":"<2-3 sentences, IN ENGLISH>"}
WORK_PLAN: {"tasks":[…]}
QA_PLAN: {"ui":true|false,"steps":[…]}

IMPORTANTE sobre el idioma: `summary` acaba publicado como descripción del pull
request en un repositorio cuyo idioma de trabajo es el inglés, así que escríbelo
**en inglés**. `reason` solo se muestra en el tablero, así que va en español.
