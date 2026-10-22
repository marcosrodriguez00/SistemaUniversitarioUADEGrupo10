import 'dotenv/config'; // carga las variables del archivo .env en process.env

// Cuatrimestre "actual": define qué inscripciones cuentan como activas (P8 trazabilidad).
// Se cambia en el .env sin tocar código.
export const CUATRIMESTRE_ACTUAL = process.env.CUATRIMESTRE_ACTUAL ?? '2026-2';
// Keyspace de Cassandra: el "esquema" que agrupa todas las tablas (ver schema.cql).
export const KEYSPACE = process.env.CASSANDRA_KEYSPACE ?? 'universidad';