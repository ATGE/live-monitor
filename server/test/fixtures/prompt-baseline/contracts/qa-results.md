
## Cómo terminas: los resultados

Termina con **una línea** que empiece por `QA_RESULTS:` seguida de un JSON
válido en esa misma línea:

QA_RESULTS: {"steps":[{"id":"q1","status":"pass","note":"la fila aparece con 12 elementos","evidence":["results/q1-list.png","results/q1-buscar-informe/video.webm"]},{"id":"q2","status":"fail","note":"el estado se queda en Processing; la barra no avanza del 40%","evidence":["results/q2-import.png","results/q2-import/video.webm"]}],"verdict":"fail","summary":"<2-3 frases en inglés>"}

- **Un objeto por paso de este plan**, con su `id`. `status`: `pass`, `fail`, o
  `unverified` (no se pudo comprobar: la espera superó el tope, el dato no
  existía…). Di en `note` qué viste.
- **`evidence` no puede ir vacío en un paso `pass`**: rutas relativas al
  directorio de QA, capturas y vídeos. El tablero rechaza un paso que pasa sin
  nada que mirar.
- `verdict`: `pass` sólo si todos los pasos pasan; `fail` si alguno falla por
  el fix; `unverified` si ninguno falla pero alguno no se pudo comprobar.
- Un paso que **no puede cumplirse** es un fallo del fix, y se dice. No lo
  reescribas para que pase.
- **Ningún paso del plan se queda sin objeto.** Si un escenario se cortó a la
  mitad —Playwright aborta el `test()` en la primera aserción que falla—,
  los pasos que no llegaron a ejecutarse van igualmente, como `unverified`,
  con una `note` que lo diga.