import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

/**
 * Detalle de reverse geocode: calle para Tictuk + línea tipo checkout web (Plus Code + ciudad).
 */
export interface DetalleGeocodingEntrega {
    /** Dirección legible priorizando calle (Ofi `formatted`, sin Plus Code redundante). */
    formattedOfi: string;
    /** Línea 1 de envío Shopify: estilo "6RR2+97 Santa Cruz de la Sierra" cuando Google devuelve Plus Code. */
    shopifyAddress1: string;
    /** Ciudad para Shopify (ej. Santa Cruz). */
    shopifyCity: string;
}

interface GoogleAddressComponent {
    long_name: string;
    short_name: string;
    types: string[];
}

interface GoogleGeocodeResult {
    formatted_address?: string;
    address_components?: GoogleAddressComponent[];
    plus_code?: { compound_code?: string; global_code?: string };
}

interface GoogleGeocodeResponse {
    status: string;
    results?: GoogleGeocodeResult[];
}

/**
 * Reverse geocode con Google Maps Geocoding API (equivalente al Geocoder del front).
 * Sin API key devuelve un texto de respaldo con lat/lng.
 */
@Injectable()
export class GoogleGeocodingMapsService {
    private readonly logger = new Logger(GoogleGeocodingMapsService.name);

    constructor(
        private readonly http: HttpService,
        private readonly config: ConfigService,
    ) {}

    /**
     * Devuelve una dirección legible en español a partir de coordenadas (solo texto Ofi / legacy).
     */
    async obtenerDireccionDesdeCoordenadas(lat: number, lng: number): Promise<string> {
        const detalle = await this.obtenerDetalleEntregaDesdeCoordenadas(lat, lng);
        return detalle.formattedOfi;
    }

    /**
     * Un solo request a Geocoding: armamos Ofi + líneas alineadas al checkout web en Shopify.
     */
    async obtenerDetalleEntregaDesdeCoordenadas(lat: number, lng: number): Promise<DetalleGeocodingEntrega> {
        const key = this.config.get<string>('GOOGLE_MAPS_API_KEY')?.trim();
        if (!key) {
            this.logger.warn('GOOGLE_MAPS_API_KEY no configurada; se usa texto de respaldo.');
            return this.detalleRespaldo(lat, lng);
        }
        try {
            const { data } = await firstValueFrom(
                this.http.get<GoogleGeocodeResponse>('https://maps.googleapis.com/maps/api/geocode/json', {
                    params: {
                        latlng: `${lat},${lng}`,
                        language: 'es',
                        key,
                    },
                    timeout: 10000,
                }),
            );
            if (data.status !== 'OK' || !data.results?.length) {
                this.logger.warn(`Geocoding status=${data.status} para ${lat},${lng}`);
                return this.detalleRespaldo(lat, lng);
            }

            let mejorIdx = 0;
            let calleEncontrada = false;
            for (let i = 0; i < data.results.length; i++) {
                const r = data.results[i]!;
                const tieneRuta = (r.address_components ?? []).some(
                    (c) => c.types.includes('route') || c.types.includes('street_address'),
                );
                if (tieneRuta && r.formatted_address) {
                    mejorIdx = i;
                    calleEncontrada = true;
                    break;
                }
            }

            const resultadoMejor = data.results[mejorIdx]!;
            const formattedCrudo = calleEncontrada
                ? resultadoMejor.formatted_address!
                : data.results[0]!.formatted_address ?? '';

            const formattedOfi = this.limpiarFormattedParaOfi(formattedCrudo, lat, lng);

            const shopifyAddress1 = this.armarShopifyAddress1(
                resultadoMejor,
                data.results[0]!,
                formattedOfi,
                lat,
                lng,
            );
            const shopifyCity = this.extraerCiudadShopify(resultadoMejor.address_components ?? []);

            return { formattedOfi, shopifyAddress1, shopifyCity };
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.logger.warn(`Geocoding error: ${msg}`);
            return this.detalleRespaldo(lat, lng);
        }
    }

    // Quita Plus Code y sufijo país del formatted legible (Ofi / referencia en address2).
    private limpiarFormattedParaOfi(formatted: string, lat: number, lng: number): string {
        let s = formatted
            .replace(/\b[0-9A-Z]{4}\+[0-9A-Z]{2,3}\b,?/g, '')
            .trim();
        if (/, Bolivia$/i.test(s)) {
            s = s.replace(/, Bolivia$/i, '').trim();
        }
        return s || this.textoRespaldo(lat, lng);
    }

    // Prioriza compound_code ("CODE Ciudad, País") para la línea 1 del admin Shopify.
    private armarShopifyAddress1(
        resultadoPreferido: GoogleGeocodeResult,
        resultadoFallback: GoogleGeocodeResult,
        formattedOfi: string,
        lat: number,
        lng: number,
    ): string {
        const compound =
            resultadoPreferido.plus_code?.compound_code ?? resultadoFallback.plus_code?.compound_code;
        if (compound?.trim()) {
            // "6RR2+97 Santa Cruz de la Sierra, Bolivia" → primera parte sin país.
            const sinPais = compound.split(',').map((p) => p.trim()).filter(Boolean);
            if (sinPais.length > 0) {
                return sinPais[0]!;
            }
        }
        const global = resultadoPreferido.plus_code?.global_code ?? resultadoFallback.plus_code?.global_code;
        const city = this.extraerCiudadShopify(resultadoPreferido.address_components ?? []);
        const ciudadLarga =
            city === 'Santa Cruz' ? 'Santa Cruz de la Sierra' : city;
        if (global?.trim()) {
            const corto = this.extraerPlusCodeCorto(global, compound);
            if (corto) {
                return `${corto} ${ciudadLarga}`.trim();
            }
            return `${global.trim()} ${ciudadLarga}`.trim();
        }
        return formattedOfi.trim() || this.textoRespaldo(lat, lng);
    }

    // Del global_code largo intenta obtener el fragmento tipo "6RR2+97" si compound lo repite.
    private extraerPlusCodeCorto(globalCode: string, compound?: string): string | null {
        const m = globalCode.match(/[0-9A-Z]{4,}\+[0-9A-Z]{2,3}/);
        if (m) {
            return m[0]!;
        }
        if (compound) {
            const mc = compound.trim().match(/^([0-9A-Z]{4,}\+[0-9A-Z]{2,3})/);
            return mc?.[1] ?? null;
        }
        return null;
    }

    // Ciudad corta tipo "Santa Cruz" cuando la localidad es el área metropolitana completa.
    private extraerCiudadShopify(components: GoogleAddressComponent[]): string {
        const locality = components.find((c) => c.types.includes('locality'))?.long_name;
        if (locality?.trim()) {
            const l = locality.trim();
            if (/santa cruz/i.test(l) && l.length > 12) {
                return 'Santa Cruz';
            }
            return l;
        }
        const adm2 = components.find((c) => c.types.includes('administrative_area_level_2'))?.long_name;
        if (adm2?.trim()) {
            return adm2.trim();
        }
        return 'Santa Cruz de la Sierra';
    }

    private detalleRespaldo(lat: number, lng: number): DetalleGeocodingEntrega {
        const t = this.textoRespaldo(lat, lng);
        return {
            formattedOfi: t,
            shopifyAddress1: t,
            shopifyCity: 'Santa Cruz',
        };
    }

    private textoRespaldo(lat: number, lng: number): string {
        return `Ubicación ${lat}, ${lng}`;
    }
}
