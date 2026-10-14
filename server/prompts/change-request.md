Un revisor ha pedido cambios en el pull request de la tarea #{{issueNumber}} ("{{issueTitle}}"), rama {{branch}}.

IMPORTANTE — lo que NO hay que hacer: el requisito original del issue **ya está implementado y aprobado como trabajo**; no vuelvas a analizarlo ni propongas rehacerlo. Aquí solo se juzga **lo que pide la review**, nada más.

{{changeRequestSection}}

Explora el código SOLO lo mínimo necesario para estimar el esfuerzo de atender esa petición: qué módulos toca, cuántos archivos, si algún punto entra en conflicto con el diseño actual o con otro comentario del propio revisor. NO implementes nada.

Clasifica como "simple" (cambios localizados que siguen la línea de lo ya hecho) o "complex" (varios módulos, decisiones de diseño no obvias, o algún punto que convenga discutir con el revisor antes de tocar).
{{parallel}}

Cada punto de la review es independiente de los demás: investígalos a la vez, no uno detrás de otro.

Tu ÚLTIMA línea debe ser exactamente:
TRIAGE_RESULT: {"complexity":"simple|complex","reason":"<una frase, en español>","summary":"<2-3 sentences, IN ENGLISH>"}

Sobre el idioma: `reason` solo se ve en el tablero, así que va en español. `summary` se escribe **en inglés**, como todo lo que pueda acabar en el repositorio.
