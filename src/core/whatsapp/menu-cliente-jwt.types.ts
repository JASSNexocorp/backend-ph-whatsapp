/**
 * Contrato del JWT de sesión de menú web: mismo secreto firma y valida.
 * `sub` = identificador del cliente en base de datos (estándar JWT).
 */

/** Claims emitidos al armar el enlace al menú (deben coincidir con lo que valida el backend). */
export interface MenuClienteJwtPayload {
    /** Identificador del cliente en BD (claim estándar `sub`). */
    sub: string;
    /** Tipo de entrega acordado en el flujo (ej. domicilio, retiro). */
    tipoEntrega: string;
    /** Nombre visible de la sucursal asignada en el flujo WhatsApp. */
    nombreSucursal: string;
    iat?: number;
    exp?: number;
}

/** Respuesta uniforme de POST /tienda/validar-token para que el front no adivine por código HTTP. */
export type ValidarTokenMenuRespuesta =
    | {
          valido: true;
          clienteId: string;
          tipoEntrega: string;
          nombreSucursal: string;
          /** ISO 8601 desde claim `iat`. */
          emitidoEn: string | null;
          /** ISO 8601 desde claim `exp`. */
          expiraEn: string | null;
      }
    | {
          valido: false;
          /** Código estable para ramificar en UI (expirado vs mal formado vs incompleto). */
          motivo: 'TOKEN_EXPIRADO' | 'TOKEN_INVALIDO' | 'TOKEN_INCOMPLETO';
          detalle: string;
      };
