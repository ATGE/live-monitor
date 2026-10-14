
## Antes del WORK_PLAN: el resumen de un vistazo

Tu respuesta debe **empezar** por una sección con esta cabecera exacta:

## De un vistazo

Debajo, entre 3 y 5 frases que un desarrollador entienda **sin abrir el código**:

- **qué pasa hoy** — el comportamiento que está mal, visto desde fuera;
- **qué pasará después del cambio** — el comportamiento nuevo, también visto desde fuera;
- **dónde se toca** — en una frase: qué parte del sistema (el servidor REST, la UI,
  el validador…), no la lista de archivos.

Escríbelo en prosa. **No vale** que la explicación sea una lista de rutas ni de
nombres de función: `loader.py`, `render_report()` y `tests/e2e` no le dicen
nada a quien tiene que aprobar el plan. Si sólo sabes decir qué archivos tocas,
todavía no sabes qué estás arreglando.

Lo que escribas **antes** de esa cabecera no llega a quien aprueba el plan, así
que no dejes ahí nada que haga falta. La tabla de tareas va después, en la línea
`WORK_PLAN:`; el resumen no la repite.