PLANIFICA (no implementes) el fix del issue de GitHub #{{issueNumber}} ("{{issueTitle}}") en este worktree, rama {{branch}}.

En este turno NO se escribe código. Sale un plan, y con ese plan otra sesión —tú mismo, con el contexto de esta— hará el trabajo.

Cuerpo del issue:
{{issueBody}}
{{planSection}}{{extraContext}}
Tu trabajo aquí:

1. **Averigua qué hay que cambiar de verdad.** Localiza el código responsable, los tests que lo cubren y lo que se rompería alrededor. Lee lo suficiente para que el plan no sea una suposición.
2. **Repártelo en piezas.** Cada pieza, una unidad de trabajo que alguien pueda hacer de principio a fin: un módulo, un archivo, un test. Di qué archivos toca cada una.
3. **Decide qué puede ir a la vez.** Dos piezas que no comparten archivos ni dependen una del resultado de la otra van en paralelo. Es lo que el plan tiene que dejar claro.
{{parallel}}

Aquí el abanico ES el trabajo: cada pregunta que necesites contestar para planificar
—dónde está X, qué tests cubren Y, cómo se usa Z— es independiente de las demás.
Lánzalas todas a la vez y planifica con las respuestas.

## REGLAS DURAS

1. **No toques nada.** Ni editar, ni crear, ni borrar archivos; ni commits, ni `git add`, ni ramas. Este turno es de solo lectura: `Read`, `Grep`, `Glob`, `git log`, `git diff` y subagentes de exploración.
2. **No escribas en GitHub.** Ni `gh pr`, ni comentarios, ni nada.
3. **Nada de compilar la suite entera ni lanzar los tests e2e.** Estás planificando; medir viene después. Esta regla gana sobre el recordatorio de arriba que manda compilaciones y suites al fondo: en esta fase no las corres.
4. {{processRule}}

{{planBrief}}
{{workPlan}}
