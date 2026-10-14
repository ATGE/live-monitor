Tu tarea `{{taskId}}` del plan **falló** (intento {{attempt}}): {{where}}.

Salida del fallo:
```
{{output}}
```
{{hint}}
Antes de tocar nada, **analiza por qué falló**: lee la salida entera, localiza la causa en el código, y di en dos frases qué pasó. Si la estrategia que seguiste no sirve, **cambia de estrategia** en vez de repetir lo mismo con retoques. Luego corrige, verifica lo tuyo, y termina con el resumen de siempre. Las mismas reglas: solo tus archivos, sin commit.

Si el fallo viene del plan (la comprobación mal escrita, una tarea que falta) y no del código, propón el cambio con `mcp__plan__propose_change` en vez de rodearlo.
{{parallel}}
