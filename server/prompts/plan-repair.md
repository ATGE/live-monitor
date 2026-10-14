Tu tarea `{{taskId}}` del plan ({{what}}) **falló la misma comprobación dos veces con la misma salida, y los archivos no cambiaron entre un intento y otro**. Reintentar el código tal cual no lo arregla: algo más está mal.

Comprobación actual del tablero (se ejecuta con bash, desde la raíz del worktree):
```
{{check}}
```

Salida del último fallo:
```
{{output}}
```
Tus archivos: {{files}}
{{hint}}
Analiza de quién es el fallo:

- **Del código**: corrígelo ahora, en tus archivos, y verifica lo tuyo. El tablero vuelve a ejecutar la comprobación al terminar este turno.
- **Del plan**: la línea de comprobación no sirve en este entorno (bash, raíz del worktree), o falta un trabajo que no es tuyo. Entonces llama a `mcp__plan__propose_change` con el motivo y, según el caso, la `check` nueva de esta tarea o `newTasks` que dependan de ella. La persona decide; nada cambia sin su sí, y la herramienta te dice si se aplicó.

No pidas a la persona que edite nada a mano, y no escribas prompts para otras sesiones.

Reglas: solo tus archivos, sin commit. {{processRule}} {{tmpRule}}{{shellRule}}Para descartar salida usa `/dev/null`, nunca `> nul`.
{{parallel}}

Termina con un párrafo corto que diga qué concluiste.
