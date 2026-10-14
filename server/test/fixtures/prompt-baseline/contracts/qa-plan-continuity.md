
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
- **`carried: true`**: sólo en un paso que el intento anterior dejó en `pass`
  y que repites **letra por letra** (mismo `id`, mismo `what`, mismo
  `expect`, mismo `longWait`). Es la señal de «esto ya está probado»: el
  tablero lo da por bueno con su evidencia anterior y **no se vuelve a
  ejecutar**. Cambia una coma y deja de estar probado: se ejecuta entero otra
  vez. Así que márcalo cuando de verdad siga valiendo, y no lo marques cuando
  este fix haya podido romperlo.
- Un paso que ya pasó **no se reformula**. Reescribirlo no añade información y
  obliga a grabar de nuevo lo que ya estaba grabado.