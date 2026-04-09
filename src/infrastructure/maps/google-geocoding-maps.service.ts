import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

/**
 * Respuesta resumida de Geocoding API (solo lo necesario para reverse geocode).
 */
interface GoogleGeocodeResult {
    formatted_address?: string;
    address_components?: Array<{ types: string[] }>;
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
     * Devuelve una dirección legible en español a partir de coordenadas.
     */
    async obtenerDireccionDesdeCoordenadas(lat: number, lng: number): Promise<string> {
        const key = this.config.get<string>('GOOGLE_MAPS_API_KEY')?.trim();
        if (!key) {
            this.logger.warn('GOOGLE_MAPS_API_KEY no configurada; se usa texto de respaldo.');
            return this.textoRespaldo(lat, lng);
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
                return this.textoRespaldo(lat, lng);
            }
            let direccionFinal = '';
            let calleEncontrada = false;
            for (const result of data.results) {
                const tieneRuta = (result.address_components ?? []).some(
                    (c) => c.types.includes('route') || c.types.includes('street_address'),
                );
                if (tieneRuta && result.formatted_address) {
                    direccionFinal = result.formatted_address;
                    calleEncontrada = true;
                    break;
                }
            }
            if (!calleEncontrada && data.results[0]?.formatted_address) {
                direccionFinal = data.results[0].formatted_address;
            }
            direccionFinal = direccionFinal
                .replace(/\b[0-9A-Z]{4}\+[0-9A-Z]{2,3}\b,?/g, '')
                .trim();
            if (/, Bolivia$/i.test(direccionFinal)) {
                direccionFinal = direccionFinal.replace(/, Bolivia$/i, '').trim();
            }
            return direccionFinal || this.textoRespaldo(lat, lng);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.logger.warn(`Geocoding error: ${msg}`);
            return this.textoRespaldo(lat, lng);
        }
    }

    private textoRespaldo(lat: number, lng: number): string {
        return `Ubicación ${lat}, ${lng}`;
    }
}
