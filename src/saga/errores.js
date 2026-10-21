// Hay dos clases de "algo salió mal" y la saga las trata distinto:
//
// ErrorNegocio: la operación NO es válida según las reglas (correlativas pendientes, sin
// cupo, plan no habilitado). No es una falla técnica. La saga termina en estado RECHAZADA.
export class ErrorNegocio extends Error {
  constructor(codigo, mensaje, detalle) {
    super(mensaje ?? codigo);
    this.name = 'ErrorNegocio';
    this.codigo = codigo;   // texto corto para identificar el motivo (ej. 'SIN_CUPO')
    this.detalle = detalle; // datos extra (ej. la lista de correlativas que faltan)
  }
}

// ErrorSimulado: lo lanzamos NOSOTROS a propósito para la demo (--fail-at).
// Para la saga es una falla técnica cualquiera: termina en estado COMPENSADA.
export class ErrorSimulado extends Error {
  constructor(punto) {
    super(`Falla simulada en "${punto}"`);
    this.name = 'ErrorSimulado';
    this.punto = punto;
  }
}