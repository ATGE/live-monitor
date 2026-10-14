Haz un triage BREVE del issue de GitHub #787 de este repositorio.

Título: ci(inferno): US Core nightly red since 2026-08-09 — care_team_role_search hits localhost:8080, asserted-date search does not filter
Labels: bug, testing, ci

Cuerpo del issue:
<<issueBody>>

<<projectContext>>
El tablero repone estas instrucciones porque no aparecen en el contexto que aporta el proyecto:
- Este repositorio es un workspace de crates de Rust: la unidad de trabajo es el crate, así que estimar la complejidad es, sobre todo, decir qué crates toca el issue. Cuántos hay y cómo se llaman se cuenta en el repositorio, no se copia de aquí.

Explora el código SOLO lo mínimo necesario para estimar la complejidad (qué módulos toca, cuántos archivos, si hay riesgo arquitectónico). NO implementes nada. Las dependencias las instala el tablero; no las instales tú.

## Paralelismo: repártete el trabajo, no vayas en fila

- **Explora en abanico.** Antes de tocar nada, convierte lo que no sabes en
  preguntas independientes y lanza **un subagente por pregunta** con la
  herramienta de subagentes —`Agent`, o `Task` si tu versión la llama así—
  pasando `subagent_type: Explore` para buscar y leer ("¿dónde está X?",
  "¿cómo funciona Y?", "¿qué tests cubren Z?").
- **Lánzalos en el MISMO mensaje.** Varias llamadas en un solo mensaje se
  ejecutan a la vez; una por mensaje es ir en fila con pasos extra. Si sólo
  lanzas un subagente, no has paralelizado nada.
- **Lo que no merece un subagente, también junto.** Las llamadas `Read`,
  `Grep` y `Bash` que no dependen una de otra van en un solo mensaje: tres
  lecturas en tres mensajes son tres turnos; en uno, uno.
- **Los comandos largos, al fondo.** Compilaciones, suites de tests y descargas
  van con `run_in_background`, y sigues trabajando mientras corren; recoges la
  salida cuando la necesites. Nunca te quedes mirando una compilación.
- La serie se reserva para lo que necesita de verdad el resultado del paso
  anterior. Todo lo demás, a la vez.

## Antes de tu respuesta final: recoge todo

- **Subagentes en primer plano.** Lánzalos con `run_in_background: false`: tu
  turno no puede cerrarse con ellos fuera.
- **Recoge todo antes de responder.** Espera a cada subagente y a cada comando
  que dejaste en segundo plano (léelos con la herramienta de salida). Una frase
  como «siguen trabajando, escribo el plan cuando lleguen» no es una respuesta.
- **El último mensaje del turno es el entregable.** El tablero se queda con él:
  el plan, el cuerpo del PR o el veredicto, completo y en el formato pedido.

Aquí el abanico es casi todo el trabajo: cada módulo sospechoso es una pregunta independiente, y contestarlas a la vez es la diferencia entre un triage de tres minutos y uno de quince.

Clasifica como "simple" (cambio localizado, pocos archivos, bajo riesgo) o "complex" (varios módulos, diseño no obvio, migraciones, o alto riesgo de regresión).

## Antes de terminar: el WORK_PLAN

Tu turno debe incluir, al final, **una línea** que empiece por `WORK_PLAN:` seguida
de un JSON válido en esa misma línea, sin bloque de código:

WORK_PLAN: {"tasks":[{"id":"t1","what":"qué hace esta pieza","files":["src/config/loader.py"],"dependsOn":[],"check":"python -m mypy src/config"},{"id":"t2","what":"otra pieza","files":["tests/config/test_loader.py"],"dependsOn":["t1"],"check":"cd tests && python -m pytest config/test_loader.py"}]}

Ese plan describe **el trabajo de esta fase**, repartido en piezas:

- **`dependsOn: []` significa «esto puede ir a la vez que las demás».** Pon un id
  ahí sólo si de verdad necesitas el resultado de esa pieza para empezar la tuya.
  Encadenar por costumbre convierte el plan en una fila.
- **`files`**: los archivos que esa pieza va a tocar, en rutas relativas a la raíz
  del repositorio. Dos tareas que puedan ir a la vez **no pueden compartir un
  archivo**: el tablero lo comprueba y te devuelve el plan si se solapan. Si dos
  piezas necesitan el mismo archivo, o las encadenas con `dependsOn` o las juntas
  en una sola.
- **`check`** (opcional): una línea de **bash** (Git Bash en Windows) — el mismo
  shell que tu herramienta Bash, así que `VAR=valor comando`, `&&` y `cd` valen —
  que corre en la raíz del worktree sin nada que sólo tenga tu sesión, y que
  demuestra que la pieza quedó bien — la comprobación rápida del módulo que
  tocaste (compilar, tipos, lint), un test concreto, un `curl`. El tablero lo
  ejecuta al terminar la pieza y no la da por hecha si falla. Que sea rápido y
  suyo: no la suite entera.
- **Si el trabajo es una sola cosa, declara una sola tarea.** No infles el plan:
  el tablero compara lo que declaras con lo que ejecutas, y cinco tareas
  «paralelas» hechas una detrás de otra se registran como incumplimiento.

## El plan de Browser QA

Termina también con **una línea** que empiece por `QA_PLAN:` seguida de un
JSON válido en esa misma línea, sin bloque de código:

QA_PLAN: {"ui":true,"steps":[{"id":"q1","scenario":"Importar y revisar informes","what":"Abrir /items y buscar 'informe-mensual'","expect":"la fila «Informe mensual» aparece con su recuento"},{"id":"q2","scenario":"Importar y revisar informes","what":"Lanzar la importación de un archivo pequeño","expect":"la barra llega a 100% y el estado pasa a Completed","longWait":true}]}

Ese plan describe **lo que un QA haría en el navegador para comprobar este issue**:

- **`ui`**: `true` si el issue toca algo que una persona ve o hace en el
  navegador (una pantalla, un botón, un mensaje, un listado). `false` si es
  puramente de API, persistencia o CLI — entonces `steps` va vacío y la fase
  se salta.
- Cada paso, **en lenguaje de usuario**: qué pantalla, qué clic, qué se escribe;
  y en `expect`, **qué debe verse** para dar el paso por bueno. Nada de
  selectores CSS aquí: eso se descubre en el navegador.
- **Compón, no enumeres.** Lo que es condición previa de otro paso —entrar,
  navegar hasta la pantalla, crear el dato— va DENTRO del paso que lo necesita,
  no como un paso propio. «Abrir /items y buscar "informe-mensual"» es **un**
  paso, no dos. Un paso es una comprobación con su `expect`, no un clic; y una
  precondición repetida en cinco pasos es cinco vídeos del mismo login.
- **Escenarios: como mucho 3.** Un escenario es un
  recorrido de usuario de principio a fin, y se ejecuta como un solo test que
  graba un solo vídeo. Marca cada paso con `scenario`: el mismo texto exacto
  en todos los pasos del escenario, y sus pasos **seguidos** en la lista — una
  etiqueta que reaparece después de otra se rechaza. Elige los pocos
  recorridos que prueban lo que el issue cambió; el tope de 30 pasos
  sigue contando todos los escenarios juntos.
- **`longWait: true`** en los pasos que esperan a un proceso (un import, un
  export, una indexación). Y para esos, elige el **dato más pequeño** que
  demuestre lo mismo: diez recursos, no un millón. Un QA no mira una barra de
  progreso tres horas.
- Entre 1 y 30 pasos. Pocos y verificables valen más que muchos vagos.

Tu respuesta final son TRES líneas, en este orden, y **la primera de ellas, `TRIAGE_RESULT:`, es la primera línea de tu respuesta final**: el prefijo exacto, en mayúsculas, sin viñeta, sin negritas, sin comillas y sin envolver en un bloque de código, con el JSON en esa misma línea. El tablero la busca por ese prefijo; si no la encuentra, te vuelve a preguntar una vez y el triage se pierde.

TRIAGE_RESULT: {"complexity":"simple|complex","reason":"<una frase, en español>","summary":"<2-3 sentences, IN ENGLISH>"}
WORK_PLAN: {"tasks":[…]}
QA_PLAN: {"ui":true|false,"steps":[…]}

IMPORTANTE sobre el idioma: `summary` acaba publicado como descripción del pull
request en un repositorio cuyo idioma de trabajo es el inglés, así que escríbelo
**en inglés**. `reason` solo se muestra en el tablero, así que va en español.
