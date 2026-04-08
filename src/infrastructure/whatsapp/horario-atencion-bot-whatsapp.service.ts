import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    TOKEN_PUERTO_INFORMACION_TIENDA_WHATSAPP,
} from 'src/core/ports/puerto-informacion-tienda.whatsapp';
import type { PuertoInformacionTiendaWhatsapp } from 'src/core/ports/puerto-informacion-tienda.whatsapp';
import {
    estaDentroDeTurnosSucursal,
    normalizarNombreSucursalHorario,
} from 'src/core/whatsapp/horario-atencion-whatsapp.utilidad';
import type { WhatsappSucursalMenuItem, WhatsappTurnoSucursal } from 'src/core/whatsapp/informacion-tienda-whatsapp.types';

/**
 * Resuelve si el bot puede atender usando los turnos de la sucursal pivote (cache JSON).
 */
@Injectable()
export class HorarioAtencionBotWhatsappService {
    private readonly logger = new Logger(HorarioAtencionBotWhatsappService.name);

    private readonly nombresDiasCortos: Record<number, string> = {
        1: 'Lun',
        2: 'Mar',
        3: 'Mié',
        4: 'Jue',
        5: 'Vie',
        6: 'Sáb',
        7: 'Dom',
    };
    constructor(
        private readonly config: ConfigService,
        @Inject(TOKEN_PUERTO_INFORMACION_TIENDA_WHATSAPP)
        private readonly tiendaInfo: PuertoInformacionTiendaWhatsapp,
    ) { }

    /** Si la validacion esta off o faltan datos permite atender (fail-open) */
    botPuedeAtenderEnEsteMomento(ahora: Date = new Date()): boolean {
        const activo =
            (this.config.get<string>('WHATSAPP_BOT_VALIDAR_HORARIO_ATENCION') ?? 'true').toLowerCase() ===
            'true';

        if (!activo) return true;

        const cache = this.tiendaInfo.obtenerInformacionTiendaEnCache();
        if (!cache?.sucursales?.length) {
            this.logger.warn('Horario : cache vacio; se permite atender.');
            return true;
        }

        const nombrePivote = normalizarNombreSucursalHorario(
            this.config.get<string>('WHATSAPP_SUCURSAL_HORARIO_NOMBRE')?.trim() ?? 'SAN MARTIN',
        );

        const sucursal = cache.sucursales.find(
            (s) => s.estado && normalizarNombreSucursalHorario(s.nombre) === nombrePivote,
        );

        if (!sucursal) {
            this.logger.warn(`Horario: sucursal "${nombrePivote}" no encontrada; se permite atender.`);
            return true;
        }

        const zona = this.config.get<string>('WHATSAPP_ATENCION_ZONA_HORARIA')?.trim() ?? 'America/La_Paz';
        if (!sucursal.turnos?.length) {
            this.logger.warn(`Horario: "${sucursal.nombre}" sin turnos; se permite atender.`);
            return true;
        }
        return estaDentroDeTurnosSucursal(ahora, sucursal.turnos, zona);
    }

    /**
     * Mensaje cuando no hay atencion: solo los turnos (la sucursal pivote es interna para leerlos del JSON).
     */
    obtenerTextoMensajeFueraDeHorario(): string {
        const sucursal = this.obtenerSucursalPivote();
        const lineasTurnos = sucursal?.turnos?.length
            ? this.formatearTurnosUnaLinea(sucursal.turnos)
            : 'Consulta nuestro horario en la web.';
        return [
            '🕐 Ahora estamos *fuera de horario de atencion* por este canal.',
            '',
            '*Horario de atencion:*',
            lineasTurnos,
            '',
            'Escribinos de nuevo dentro del horario. Gracias 🍕',
        ].join('\n');
    }

    private obtenerSucursalPivote(): WhatsappSucursalMenuItem | null {
        const cache = this.tiendaInfo.obtenerInformacionTiendaEnCache();
        const nombrePivote = normalizarNombreSucursalHorario(
            this.config.get<string>('WHATSAPP_SUCURSAL_HORARIO_NOMBRE')?.trim() ?? 'SAN MARTIN',
        );
        return (
            cache?.sucursales?.find(
                (s) => s.estado && normalizarNombreSucursalHorario(s.nombre) === nombrePivote,
            ) ?? null
        );
    }

    private formatearTurnosUnaLinea(turnos: WhatsappTurnoSucursal[]): string {
        return turnos
            .map((turno) => {
                const diasOrdenados = [...turno.dias].sort((a, b) => a - b);
                const rangos = this.diasATextoCompacto(diasOrdenados);
                return `${rangos}: ${turno.horaInicial} - ${turno.horaFinal}`;
            })
            .join(' | ');
    }

    private diasATextoCompacto(dias: number[]): string {
        if (!dias.length) {
            return '';
        }
        const grupos: number[][] = [];
        let actual: number[] = [dias[0]!];
        for (let i = 1; i < dias.length; i++) {
            if (dias[i] === dias[i - 1]! + 1) {
                actual.push(dias[i]!);
            } else {
                grupos.push(actual);
                actual = [dias[i]!];
            }
        }
        grupos.push(actual);
        return grupos
            .map((g) => {
                if (g.length === 1) {
                    return this.nombresDiasCortos[g[0]!] ?? `D${g[0]}`;
                }
                const a = this.nombresDiasCortos[g[0]!] ?? '';
                const b = this.nombresDiasCortos[g[g.length - 1]!] ?? '';
                return `${a} - ${b}`;
            })
            .join(' | ');
    }
}
