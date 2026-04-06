import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type {
    MenuClienteJwtPayload,
    ValidarTokenMenuRespuesta,
} from 'src/core/whatsapp/menu-cliente-jwt.types';

/**
 * Firma y valida JWT de menú cliente (enlace web). Expiración por defecto 2h vía módulo Jwt.
 */
@Injectable()
export class MenuClienteJwtService {
    constructor(private readonly jwt: JwtService) {}

    /**
     * Verifica firma y expiración; exige `sub`, `tipoEntrega` y `sucursalId` en el payload.
     */
    async validarTokenMenu(token: string): Promise<ValidarTokenMenuRespuesta> {
        const texto = token?.trim() ?? '';
        if (!texto) {
            return {
                valido: false,
                motivo: 'TOKEN_INVALIDO',
                detalle: 'El token es obligatorio.',
            };
        }

        try {
            const decoded = await this.jwt.verifyAsync<MenuClienteJwtPayload>(texto);
            const clienteId = decoded.sub?.trim();
            const tipoEntrega = decoded.tipoEntrega?.trim();
            const sucursalId = decoded.sucursalId?.trim();

            if (!clienteId || !tipoEntrega || !sucursalId) {
                return {
                    valido: false,
                    motivo: 'TOKEN_INCOMPLETO',
                    detalle:
                        'El token no incluye sub (cliente), tipoEntrega o sucursalId.',
                };
            }

            const emitidoEn =
                decoded.iat != null
                    ? new Date(decoded.iat * 1000).toISOString()
                    : null;
            const expiraEn =
                decoded.exp != null
                    ? new Date(decoded.exp * 1000).toISOString()
                    : null;

            return {
                valido: true,
                clienteId,
                tipoEntrega,
                sucursalId,
                emitidoEn,
                expiraEn,
            };
        } catch (error: unknown) {
            const nombre = error instanceof Error ? error.name : '';
            if (nombre === 'TokenExpiredError') {
                return {
                    valido: false,
                    motivo: 'TOKEN_EXPIRADO',
                    detalle: 'El token de menú expiró; solicitá un enlace nuevo por WhatsApp.',
                };
            }
            return {
                valido: false,
                motivo: 'TOKEN_INVALIDO',
                detalle:
                    error instanceof Error
                        ? error.message
                        : 'No se pudo validar el token.',
            };
        }
    }

    /**
     * Genera el JWT para adjuntar al query del menú web (misma clave y TTL que la validación).
     */
    async crearTokenMenuCliente(payload: {
        clienteId: string;
        tipoEntrega: string;
        sucursalId: string;
    }): Promise<string> {
        return this.jwt.signAsync({
            sub: payload.clienteId,
            tipoEntrega: payload.tipoEntrega,
            sucursalId: payload.sucursalId,
        });
    }
}
