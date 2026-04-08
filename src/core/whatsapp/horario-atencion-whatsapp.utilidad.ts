import { WhatsappTurnoSucursal } from "./informacion-tienda-whatsapp.types";

const WEEKDAY_SHORT_A_ISO: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
};

/** Comparar nombres de sucursal sin tildes y con espacio colapsados (ej. "San Martin" = "SAN MARTIN"). */
export function normalizarNombreSucursalHorario(nombre: string): string {
    const sinDiacriticos = nombre.normalize('NFD').replace(/\p{M}/gu, '');
    return sinDiacriticos.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Dia ISO 1=Lunes _ 7=Domingo segun reloj en la zona IANA */
export function obtenerDiaIsoEnZonaHoraria(fecha: Date, zonaHoraria: string): number {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: zonaHoraria,
        weekday: 'short',
    });
    const etiqueta = dtf.format(fecha);
    return WEEKDAY_SHORT_A_ISO[etiqueta] ?? 1;
}

/** Minutos desde medianoche en la zona indicada. */
export function obtenerMinutosDesdeMedianocheEnZona(fecha: Date, zonaHoraria: string): number {
    const partes = new Intl.DateTimeFormat('en-GB', {
        timeZone: zonaHoraria,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(fecha);
    const hora = parseInt(partes.find((p) => p.type === 'hour')?.value ?? '0', 10);
    const minuto = parseInt(partes.find((p) => p.type === 'minute')?.value ?? '0', 10);
    return hora * 60 + minuto;
}

/** Parsea "HH:mm" del JSON a minutos desde medianoche. */
export function parseHoraMinutos(horaTexto: string): number | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec(horaTexto.trim());
    if (!m) return null;
    const h = parseInt(m[1]!, 10);
    const min = parseInt(m[2]!, 10);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
}

/**
* Indica si `fecha` cae en algún turno del día local.
* Si horaFinal < horaInicial, trata el tramo como cruce de medianoche.
*/
export function estaDentroDeTurnosSucursal(
    fecha: Date,
    turnos: WhatsappTurnoSucursal[],
    zonaHoraria: string,
): boolean {
    if (!turnos.length) return false;
    const diaIso = obtenerDiaIsoEnZonaHoraria(fecha, zonaHoraria);
    const ahoraMin = obtenerMinutosDesdeMedianocheEnZona(fecha, zonaHoraria);
    for (const turno of turnos) {
        if (!turno.dias.includes(diaIso)) continue;
        const ini = parseHoraMinutos(turno.horaInicial);
        const fin = parseHoraMinutos(turno.horaFinal);
        if (ini === null || fin === null) continue;
        if (fin >= ini) {
            if (ahoraMin >= ini && ahoraMin <= fin) return true;
        } else {
            if (ahoraMin >= ini || ahoraMin <= fin) return true;
        }
    }
    return false;
}