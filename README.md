# Sistema de Gestión Universitaria — TPO Ingeniería de Datos II (UADE) — Grupo 10

Aplicación Node.js con **persistencia políglota**: cada motor guarda el tipo de dato para el que es más fuerte.

| Motor | Qué guarda | Por qué |
|---|---|---|
| **MongoDB** | Catálogo (estudiantes, planes, materias con sus comisiones, mesas, docentes) y `saga_log` | Documentos flexibles: cada entidad se lee completa en una sola consulta |
| **Neo4j** | Planes y correlatividades (`(:Materia)-[:REQUIERE]->(:Materia)`) | Recorre cadenas de correlativas de cualquier largo sin JOIN |
| **Cassandra** | Inscripciones a cursada, inscripciones a mesa y calificaciones | Escritura masiva y lectura por partición ya ordenada (una tabla por consulta) |
| **Redis** | Cupo disponible en tiempo real de comisiones y mesas | Operaciones atómicas en memoria: el cupo nunca se sobrepasa |

Las operaciones que tocan varios motores se coordinan con el **patrón Saga** (`src/saga/runner.js`): cada paso tiene su compensación y queda registrado en `saga_log` (MongoDB).

---

## 1. Requisitos

- **Docker Desktop** (con Docker Compose), abierto y corriendo.
- **Node.js 18 o superior** (probado con Node 22).
- Unos **3 GB de RAM libres** para los cuatro contenedores (Cassandra es el más pesado).
- Puertos libres: `27017` (MongoDB), `6379` (Redis), `7474` y `7687` (Neo4j), `9042` (Cassandra).

---

## 2. Puesta en marcha (paso a paso)

Todos los comandos se corren en una terminal **parada en la carpeta del proyecto**.

### Paso 1 — Clonar e instalar dependencias

```bash
git clone https://github.com/marcosrodriguez00/SistemaUniversitarioUADEGrupo10.git
cd SistemaUniversitarioUADEGrupo10
npm install
```

### Paso 2 — Crear el archivo `.env`

El `.env` no se sube al repositorio. Se crea copiando el de ejemplo:

```bash
# Windows (PowerShell)
copy .env.example .env

# macOS / Linux
cp .env.example .env
```

No hace falta editarlo: ya apunta a los contenedores del `docker-compose.yml`.

### Paso 3 — Levantar las bases de datos

```bash
docker compose up -d
```

Esto descarga las imágenes (solo la primera vez) y levanta 4 contenedores: `mongo`, `redis`, `neo4j` y `cassandra`.

**Cassandra tarda entre 1 y 2 minutos en arrancar.** Para saber si ya está lista:

```bash
docker compose ps
```

Esperar a que `cassandra` diga **`(healthy)`**. Si se corre lo siguiente antes, falla la conexión a Cassandra; en ese caso, esperar y volver a correrlo.

### Paso 4 — Verificar la conexión a los 4 motores

```bash
npm run check
```

Resultado esperado:

```
✔ MongoDB: OK
✔ Redis: OK
✔ Neo4j: OK
✔ Cassandra: OK
```

### Paso 5 — Cargar los datos de prueba

```bash
npm run seed
```

- Crea el keyspace y las tablas de Cassandra, las colecciones e índices de MongoDB y las restricciones de Neo4j (lo mismo que `npm run init`).
- **Borra todo** lo que haya en los 4 motores y carga datos nuevos.
- Es reproducible (semilla fija 42): siempre genera los mismos datos, unos 5000 estudiantes con su historia académica, 2 planes (`PLAN-INF` y `PLAN-LSI`), 50 materias, comisiones, mesas, docentes y los alumnos de demostración `A-DEMO-01` a `A-DEMO-14`.
- Tarda unos minutos. Se puede volver a correr cuando se quiera dejar todo como al principio.

Listo: el sistema queda funcionando.

---

## 3. Ejecutar el sistema

### Menú interactivo (recomendado)

```bash
npm run cli
```

Muestra un menú numerado con todos los problemas. Para cada uno pide los datos (con listas para elegir alumno, materia, comisión o mesa) y, en las operaciones con saga, pregunta si se quiere **provocar una falla** en algún paso para ver el rollback.

### Por línea de comandos

Formato: `npm run cli -- <comando> [--parametro valor]`. Si no se pasan parámetros, se usan los IDs de demostración.

| Comando | Qué hace | Ejemplo |
|---|---|---|
| `demo` | Muestra los IDs de demostración del seed | `npm run cli -- demo` |
| `p1` | Carga un plan de estudios desde un JSON | `npm run cli -- p1 --archivo src/seed/plan-ejemplo.json` |
| `p2` | Inscripción a cursada | `npm run cli -- p2 --alumno A-DEMO-01 --comision COM-015-2026-2-1` |
| `p3` | Cambio de comisión | `npm run cli -- p3 --alumno A-DEMO-11 --origen COM-015-2026-2-2 --destino COM-015-2026-2-3` |
| `p4` | Carga de calificaciones (parcial por comisión o final por mesa) | `npm run cli -- p4 --tipo parcial --comision COM-015-2026-2-2 --docente D0001 --notas A-DEMO-11:7,A-DEMO-14:3` |
| `p5` | Inscripción a mesa de final | `npm run cli -- p5 --alumno A-DEMO-13 --mesa MESA-015-2026-12-10` |
| `p6` | Trayectoria académica de un alumno | `npm run cli -- p6 --alumno A-DEMO-01` |
| `p7` | Qué puede cursar un alumno / qué destraba una materia / cadena más larga | `npm run cli -- p7 --alumno A-DEMO-01` · `npm run cli -- p7 --materia MAT-011` · `npm run cli -- p7 --cadena` |
| `p8` | Rectificación de una nota (o `--trazabilidad` para solo consultar) | `npm run cli -- p8 --alumno A-DEMO-14 --materia MAT-011 --nota 2` |
| `estado-cupo` | Compara el cupo de Redis con `cupo_maximo` (Mongo) − inscriptos (Cassandra) | `npm run cli -- estado-cupo --comision COM-015-2026-2-1` |
| `operacion` | Muestra el `saga_log` de una operación | `npm run cli -- operacion --operacion OP-...` |
| `concurrencia` | N alumnos compiten en paralelo por el último lugar de una comisión | `npm run cli -- concurrencia --n 10` |
| `recuperar` | Retoma y deshace las sagas que quedaron a medias | `npm run cli -- recuperar` |

**Nota:** hay que dejar el `--` después de `npm run cli`; si no, npm se queda con los parámetros.

### Escenarios de falla (rollback de la saga)

Agregando `--fail-at <paso>` la operación falla a propósito en ese paso. La salida muestra el estado **antes y después** en Redis y Cassandra (tienen que quedar iguales) y el `saga_log` con las compensaciones aplicadas.

| Comando | Pasos disponibles para `--fail-at` |
|---|---|
| `p1` | `correlatividad-medio`, `habilitar` |
| `p2` | `reservar-cupo`, `registrar-inscripcion` |
| `p3` | `reservar-destino`, `liberar-origen`, `mover-inscripcion` |
| `p5` | `reservar-cupo`, `registrar-inscripcion` |
| `p8` | `rectificar`, `marcado-medio` |

Ejemplo:

```bash
npm run cli -- p2 --alumno A-DEMO-01 --comision COM-015-2026-2-1 --fail-at registrar-inscripcion
```

**Idempotencia:** en `p2` se puede reintentar la misma operación con `--operacion OP-...` (el ID que devolvió la primera ejecución): no se inscribe dos veces.

---

## 4. Ver las bases de datos

Hay dos formas: desde la consola de cada contenedor (Docker Desktop o terminal) o desde la interfaz web de Neo4j.

### Opción A — Docker Desktop

1. Abrir Docker Desktop → **Containers**.
2. Desplegar el proyecto `sistemauniversitariouadegrupo10`.
3. Hacer clic en el contenedor (por ejemplo `cassandra-1`) → pestaña **Exec**.
4. Escribir el comando de la consola de ese motor (tabla de abajo).

### Opción B — Terminal

Desde la carpeta del proyecto:

| Motor | Comando para abrir la consola | Lenguaje |
|---|---|---|
| Cassandra | `docker compose exec cassandra cqlsh` | CQL |
| MongoDB | `docker compose exec mongo mongosh universidad` | MQL (mongosh) |
| Redis | `docker compose exec redis redis-cli` | Comandos de Redis |
| Neo4j | `docker compose exec neo4j cypher-shell -u neo4j -p <contraseña>` | Cypher |

La contraseña de Neo4j es la de `NEO4J_PASSWORD` en `.env.example` (la misma que `NEO4J_AUTH` en `docker-compose.yml`).

### Neo4j Browser (grafo visual)

Abrir **http://localhost:7474** en Chrome, conectar con `neo4j://localhost:7687`, usuario `neo4j` y la contraseña de arriba. Para ver el plan con sus correlativas:

```cypher
MATCH (p:Plan {plan_id: 'PLAN-INF'})-[:INCLUYE]->(m:Materia)
OPTIONAL MATCH (m)-[r:REQUIERE {plan_id: 'PLAN-INF'}]->(x:Materia)
RETURN p, m, r, x
```

### Consultas de ejemplo

**Cassandra** (dentro de `cqlsh`; cada consulta termina en `;`)

```sql
USE universidad;
DESCRIBE TABLES;
SELECT materia_id, tipo, nota, estado FROM calificaciones_por_alumno WHERE alumno_id = 'A-DEMO-14';
SELECT alumno_id FROM inscripciones_por_comision WHERE comision_id = 'COM-015-2026-2-2';
SELECT COUNT(*) FROM inscripciones_por_comision WHERE comision_id = 'COM-015-2026-2-1';
```

Toda consulta lleva la partition key (`alumno_id`, `comision_id` o `mesa_id`); el modelo no usa `ALLOW FILTERING`.

**MongoDB** (dentro de `mongosh universidad`)

```js
show collections
db.estudiantes.findOne({ _id: "A-DEMO-14" })
db.materias.findOne({ _id: "MAT-015" }, { nombre: 1, comisiones: 1 })
db.mesas.findOne({ _id: "MESA-015-2026-12-10" })
db.saga_log.find().sort({ creado_en: -1 }).limit(1)
```

**Redis** (dentro de `redis-cli`)

```
GET cupo:comision:COM-015-2026-2-1
SMEMBERS reservas:comision:COM-015-2026-2-2
GET cupo:mesa:MESA-015-2026-12-10
```

**Neo4j** (Cypher)

```cypher
MATCH (:Materia {materia_id: 'MAT-015'})-[r:REQUIERE {plan_id: 'PLAN-INF'}]->(req)
RETURN req.materia_id, r.tipo;
```

**Importante:** los motores no se sincronizan entre sí cuando se cambia un dato a mano. La coherencia entre motores la mantiene la aplicación con las sagas. Para volver todo al estado inicial: `npm run seed`.

---

## 5. Estructura del proyecto

```
docker-compose.yml     4 contenedores: mongo, redis, neo4j, cassandra
.env.example           conexión a los motores (copiar a .env)
scripts/check.js       verificación de conexión (npm run check)
src/
  cli.js               menú y comandos (npm run cli)
  config.js, contexto.js, ids.js
  db/                  conexión a cada motor
  init/                schema.cql (Cassandra), init-mongo.js, init-neo4j.js, init.js
  repos/               acceso a datos de cada motor (cassandra, mongo, neo4j, redis)
  saga/                runner de sagas, failpoints, errores
  servicios/cupos.js   reserva y liberación de cupo (scripts Lua en Redis)
  dominio/estados.js   reglas de negocio puras (regular / libre / aprobada)
  problemas/           p1.js … p8.js: un archivo por problema del enunciado
  seed/                generador de datos de prueba y plan de ejemplo
```

---

## 6. Problemas frecuentes

| Síntoma | Solución |
|---|---|
| `npm run check` falla en Cassandra | Todavía está arrancando. Esperar a `(healthy)` en `docker compose ps` y reintentar. |
| `port is already allocated` al levantar Docker | Otro programa usa ese puerto (por ejemplo, un MongoDB instalado localmente). Cerrarlo o detener el servicio. |
| Falta `.env` / error de conexión con `undefined` | No se hizo el Paso 2: copiar `.env.example` a `.env`. |
| Cassandra se cierra sola | Darle más memoria a Docker Desktop (Settings → Resources). |
| Los datos quedaron modificados por pruebas | `npm run seed` vuelve todo al estado inicial. |

### Apagar y limpiar

```bash
docker compose stop        # apaga los contenedores, conserva los datos
docker compose down        # elimina los contenedores, conserva los datos (volúmenes)
docker compose down -v     # elimina también los datos (después hay que volver a correr npm run seed)
```
