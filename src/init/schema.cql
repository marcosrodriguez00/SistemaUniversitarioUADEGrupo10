-- REGLA DE DISEÑO: una tabla por consulta. Cada tabla se diseña desde la pregunta que
-- tiene que responder, y toda consulta lleva la partition key completa. Por eso no usamos
-- índices secundarios ni ALLOW FILTERING (prohibido en el TP).
--
-- PRIMARY KEY ((particion), clustering...):
--   partition key  = por qué dato se busca; agrupa las filas en el mismo lugar del disco
--   clustering key = orden dentro de la partición Y lo que hace única a cada fila.
--                    Reescribir una clave existente PISA la fila (upsert, no error):
--                    es lo que vuelve idempotente a un reintento de la saga.

CREATE KEYSPACE IF NOT EXISTS universidad
  WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};

-- Historial de inscripciones de UN alumno (P2, P3, P6, P8). Sale ordenado por fecha.
-- comision_id en la clave: una recursada (misma materia, otra comisión) es otra fila.
-- en_revision: P8 la marca cuando una nota rectificada invalida la correlativa;
-- es una columna común (no clave) porque se actualiza, y su compensación la vuelve a false.
CREATE TABLE IF NOT EXISTS universidad.inscripciones_por_alumno (
  alumno_id text,
  fecha_inscripcion timestamp,
  materia_id text,
  comision_id text,
  docente_id text,
  cuatrimestre_id text,
  en_revision boolean,
  PRIMARY KEY ((alumno_id), fecha_inscripcion, materia_id, comision_id)
);

-- Lo MISMO desde el otro lado: quiénes están en una comisión (P4, reconstruir el cupo de Redis).
-- Es una desnormalización deliberada: cada inscripción se escribe en las dos tablas dentro de
-- un LOGGED BATCH, que garantiza que se escriben las dos o ninguna.
CREATE TABLE IF NOT EXISTS universidad.inscripciones_por_comision (
  comision_id text,
  fecha_inscripcion timestamp,
  alumno_id text,
  materia_id text,
  docente_id text,
  cuatrimestre_id text,
  PRIMARY KEY ((comision_id), fecha_inscripcion, alumno_id)
);

-- Notas de UN alumno (P4, P6, P8). Una sola partición trae toda su trayectoria.
-- 'estado' (regular/aprobada/libre) se calcula al cargar la nota y se guarda en la misma
-- fila: una sola escritura, sin estados intermedios (por eso P4 no necesita saga).
-- Rectificar una nota (P8) hace UPDATE de nota+estado sobre esta misma fila.
CREATE TABLE IF NOT EXISTS universidad.calificaciones_por_alumno (
  alumno_id text,
  fecha_evaluacion timestamp,
  materia_id text,
  comision_id text,
  mesa_id text,
  docente_id text,
  tipo text,
  nota double,
  estado text,
  PRIMARY KEY ((alumno_id), fecha_evaluacion, materia_id, comision_id)
);

-- Inscripción a mesas de final (P5): mismo par de tablas, mismo LOGGED BATCH.
CREATE TABLE IF NOT EXISTS universidad.inscripciones_mesa_por_alumno (
  alumno_id text,
  fecha_mesa timestamp,
  materia_id text,
  mesa_id text,
  PRIMARY KEY ((alumno_id), fecha_mesa, materia_id, mesa_id)
);

CREATE TABLE IF NOT EXISTS universidad.inscripciones_mesa_por_mesa (
  mesa_id text,
  alumno_id text,
  materia_id text,
  PRIMARY KEY ((mesa_id), alumno_id)
);