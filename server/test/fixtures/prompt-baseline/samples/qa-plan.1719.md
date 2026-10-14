PLANIFICA (no ejecutes) la comprobación en navegador del issue #1719 ("ui(search-parameters): detail panel values not aligned with badge indent (URL, Name, Status, FHIRPath expression)"), rama fix/1719-ui-search-parameters-detail-panel. El fix ya está hecho y los tests e2e ya pasaron; ahora toca lo que haría un QA humano delante de la app para dar el issue por resuelto.

Cuerpo del issue:
<<issueBody>>

Lo que el triage propuso antes de que existiera el fix (confírmalo, córtalo o cámbialo con lo que ahora sabes):
<<initialPlan>>

Lo que un intento anterior de este mismo Browser QA ya comprobó (y lo que no):


Lo que el fix cambió de verdad:
```
<<diffStat>>
```

Cómo fueron los tests e2e (la cola de su salida):
```
<<e2eTail>>
```

<<stackSection>>

Tu trabajo aquí:

1. **Lee el diff** de los archivos de UI que tocó el fix (`git diff origin/<<baseBranch>>...HEAD -- <ruta>`) para saber qué pantallas y qué textos concretos existen ahora. No adivines nombres de botones que puedes leer en una plantilla.
2. **Escribe el plan refinado**, agrupado en escenarios: quédate con los pocos recorridos que prueban lo que el issue cambió y marca cada paso con su `scenario` (el contrato de abajo explica el formato y el tope). Los pasos, en lenguaje de usuario, con la URL real de cada pantalla (los servidores están arriba: úsalos con curl para confirmar que la ruta existe y qué datos hay), el dato concreto que se usa, y en `expect` lo que debe verse — el texto exacto, el número, el estado.
3. **No vuelvas a pedir lo ya probado.** Un paso que el intento anterior dio por `pass` y que el diff de esta ronda no puede haber roto se copia **literal** —mismo `id`, mismo `what`, mismo `expect`— y se marca `carried: true`: no se ejecutará otra vez, se reutiliza su evidencia. Si este fix pudo romperlo, no lo marques: se comprobará entero. Lo peor que puedes hacer es reescribir con otras palabras un paso que ya pasó: el QA vuelve a grabarlo de cero para demostrar exactamente lo mismo.
4. **Datos pequeños.** Si un paso espera a un proceso (import, export, indexación), elige el dato más pequeño que demuestre lo mismo y márcalo `longWait: true`. Nadie mira una barra tres horas.

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

Cada pantalla o endpoint que necesites confirmar es una pregunta independiente: lánzalas a la vez.

## REGLAS DURAS

1. **No toques nada.** Ni archivos, ni commits, ni ramas. Sólo lectura, `git diff`, `git log` y `curl` a los servidores de esta tarea.
2. **No escribas en GitHub.**
3. **PROCESOS Y PUERTOS — lo tuyo, sí; lo ajeno, nunca.** Puedes parar y limpiar los procesos que arrancaste TÚ en esta tarea (tus servidores de prueba, tus comandos de fondo, los puertos que abriste). NUNCA toques un proceso que no arrancaste tú: los puertos 8080 y 8090 son los servidores de Edson en su checkout principal, y otros worktrees tienen los suyos. Si no sabes quién lo arrancó, no lo toques. Los servidores que levantó el tablero para esta tarea se paran desde el tablero: si necesitas reiniciarlos, dilo en vez de matarlos. Si necesitas levantar algo, usa un puerto libre >18000 y compruébalo antes. **Para esperar a algo tuyo en segundo plano, léelo con BashOutput cuando vayas a usar su resultado**, y si necesitas que termine antes de seguir, lánzalo en primer plano con su `timeout`. Nunca encadenes `sleep` en segundo plano para hacer tiempo: cada uno que vence te interrumpe, y los que dejes pendientes te seguirán interrumpiendo cuando ya hayas terminado.

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
