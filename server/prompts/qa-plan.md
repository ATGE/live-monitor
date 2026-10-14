PLANIFICA (no ejecutes) la comprobación en navegador del issue #{{issueNumber}} ("{{issueTitle}}"), rama {{branch}}. El fix ya está hecho y los tests e2e ya pasaron; ahora toca lo que haría un QA humano delante de la app para dar el issue por resuelto.

Cuerpo del issue:
{{issueBody}}

Lo que el triage propuso antes de que existiera el fix (confírmalo, córtalo o cámbialo con lo que ahora sabes):
{{initialPlan}}

Lo que un intento anterior de este mismo Browser QA ya comprobó (y lo que no):
{{previousAttempt}}

Lo que el fix cambió de verdad:
```
{{diffStat}}
```

Cómo fueron los tests e2e (la cola de su salida):
```
{{e2eTail}}
```

{{stackSection}}

Tu trabajo aquí:

1. **Lee el diff** de los archivos de UI que tocó el fix (`git diff origin/{{baseBranch}}...HEAD -- <ruta>`) para saber qué pantallas y qué textos concretos existen ahora. No adivines nombres de botones que puedes leer en una plantilla.
2. **Escribe el plan refinado**, agrupado en escenarios: quédate con los pocos recorridos que prueban lo que el issue cambió y marca cada paso con su `scenario` (el contrato de abajo explica el formato y el tope). Los pasos, en lenguaje de usuario, con la URL real de cada pantalla (los servidores están arriba: úsalos con curl para confirmar que la ruta existe y qué datos hay), el dato concreto que se usa, y en `expect` lo que debe verse — el texto exacto, el número, el estado.
3. **No vuelvas a pedir lo ya probado.** Un paso que el intento anterior dio por `pass` y que el diff de esta ronda no puede haber roto se copia **literal** —mismo `id`, mismo `what`, mismo `expect`— y se marca `carried: true`: no se ejecutará otra vez, se reutiliza su evidencia. Si este fix pudo romperlo, no lo marques: se comprobará entero. Lo peor que puedes hacer es reescribir con otras palabras un paso que ya pasó: el QA vuelve a grabarlo de cero para demostrar exactamente lo mismo.
4. **Datos pequeños.** Si un paso espera a un proceso (import, export, indexación), elige el dato más pequeño que demuestre lo mismo y márcalo `longWait: true`. Nadie mira una barra tres horas.
{{parallel}}

Cada pantalla o endpoint que necesites confirmar es una pregunta independiente: lánzalas a la vez.

## REGLAS DURAS

1. **No toques nada.** Ni archivos, ni commits, ni ramas. Sólo lectura, `git diff`, `git log` y `curl` a los servidores de esta tarea.
2. **No escribas en GitHub.**
3. {{processRule}}
{{qaPlan}}
