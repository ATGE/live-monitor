{{text}}
{{siblings}}{{handoff}}
{{parallel}}

[El tablero le muestra a la persona, en vivo, cada llamada de tus subagentes y de tus comandos en segundo plano. No le digas que no se ven, y no gastes herramientas en vigilarlos solo para contarle qué hacen.]

[{{githubPublishRule}}]

[Si concluyes que el issue NO necesita ningún cambio, termina ese turno con una sola línea:
CLOSABLE: {"reason":"completed|not_planned|duplicate","why":"<una frase en inglés>","duplicateOf":<número|null>}
Es una señal para la persona, no una acción: el tablero solo sugiere el botón «Cerrar issue»; no cierra nada por su cuenta. No la emitas «por si acaso»: si dudas, no la pongas.]

{{machineNote}}[Reglas del entorno: {{processRule}} Every server or process you start to measure or test, stop it before your final answer. If it must stay alive for what comes next, say so in the answer with its port and how to stop it. Para la suite e2e {{e2ePortEnv}}=<puerto libre> con CI=1. {{tmpRule}}{{shellRule}}Para descartar salida usa `/dev/null`, NUNCA `> nul`: aquí el shell es bash y eso crea un fichero llamado `nul` que deja el worktree imposible de borrar.]{{attachments}}
