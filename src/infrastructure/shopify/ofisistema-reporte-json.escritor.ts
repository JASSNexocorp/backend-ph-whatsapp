import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Persiste un reporte JSON de llamadas a OfiSistema bajo REPORTE/ en la raíz del proceso.
 * Fallas de escritura no deben interrumpir el flujo del bot.
 */
export function escribirReporteOfisistemaJson(contenido: Record<string, unknown>): void {
    try {
        const dir = join(process.cwd(), 'REPORTE');
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const ruta = join(dir, `ofisistema-${stamp}.json`);
        writeFileSync(ruta, JSON.stringify(contenido, null, 2), 'utf-8');
    } catch {
        // Sin throw: el reporte es diagnóstico, no crítico.
    }
}
