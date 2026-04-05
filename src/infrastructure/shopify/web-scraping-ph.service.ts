import { HttpService } from "@nestjs/axios";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { WhatsAppInformacionTienda, WhatsappMenuSnapshot, WhatsappSucursalMenuItem } from "../../core/whatsapp/informacion-tienda-whatsapp.types";
import { ShopifyAdminGraphqlService } from "./shopify-admin-graphql.service";
import { firstValueFrom } from "rxjs";


/**
 * Sincroniza el JSON Tienda Pizza Hut con Shopify desde WHATSAPP_MENU_URL
 * Corre al iniciar y luego cada 30 minutos guardando en cache de memoria
 */
@Injectable()
export class WebScrapingPhService implements OnModuleInit {
    private readonly logger = new Logger(WebScrapingPhService.name);
    private snapshot: WhatsappMenuSnapshot | null = null;
    private intervaloRef: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly config: ConfigService,
        private readonly http: HttpService,
        private readonly shopifyAdmin: ShopifyAdminGraphqlService
    ) { }

    /**
     * Expone el ultimo snapshot para el adaptador de flujo sin await ni llamadas HTTP.
     */
    obtenerSnapshotActual(): WhatsappMenuSnapshot | null {
        return this.snapshot;
    }

    /**
   * Primer fetch al levantar el modulo + temporizador segun WHATSAPP_MENU_CACHE_TTL_MS.
   */
    onModuleInit(): void {
        void this.refrescarSnapshot();
        const ttlMs = Number.parseInt(this.config.get<string>('WHATSAPP_MENU_CACHE_TTL_MS') ?? '1800000', 10);
        const periodo = Number.isFinite(ttlMs) && ttlMs >= 60_000 ? ttlMs : 1_800_000;
        this.intervaloRef = setInterval(() => void this.refrescarSnapshot(), periodo);
    }

    /**
     * Evita fugas de temporizador al apagar Nest en desarrollo o despliegues.
     */
    onModuleDestroy(): void {
        if (this.intervaloRef) {
            clearInterval(this.intervaloRef);
            this.intervaloRef = null;
        }
    }

       /**
     * GET al JSON publico, validacion minima, enrichment Shopify y armado del snapshot.
     * Si falla la red se conserva el snapshot anterior para no dejar el bot sin datos.
     */
       async refrescarSnapshot(): Promise<void> {
        const url = this.config.get<string>('WHATSAPP_MENU_URL');
        if (!url) {
            this.logger.warn('WHATSAPP_MENU_URL no definida — no se actualiza el menu en memoria');
            return;
        }
        try {
            const resp = await firstValueFrom(this.http.get<unknown>(url, { timeout: 25_000 }));
            const payload = this.validarPayloadMenu(resp.data);
            if (!payload) {
                this.logger.warn('WHATSAPP_MENU_URL devolvio JSON con forma inesperada');
                return;
            }
            const mapaLocations = await this.shopifyAdmin.obtenerMapaNombreNormalizadoAIdLocation();
            const sucursalesEnriquecidas = this.enriquecerSucursales(payload.sucursales, mapaLocations);
            let costoEnvio = payload.configuracion_carrito.costo_envio_domicilio;
            const usarShopify = this.config.get<string>('WHATSAPP_MENU_USE_SHOPIFY_SHIPPING') === 'true';
            if (usarShopify) {
                const desdeShopify = await this.shopifyAdmin.obtenerPrimerPrecioEnvioDomicilioActivo();
                if (desdeShopify !== null) {
                    costoEnvio = desdeShopify;
                }
            }
            // Un solo objeto consumible por HTTP y por el flujo WhatsApp — sin payload duplicado.
            this.snapshot = {
                menu: payload.menu,
                sucursales: sucursalesEnriquecidas,
                configuracion_carrito: {
                    cantidad_minima: payload.configuracion_carrito.cantidad_minima,
                    costo_envio_domicilio: costoEnvio,
                },
            };
            this.logger.log(`Menu tienda actualizado (${sucursalesEnriquecidas.length} sucursales)`);
        } catch (err) {
            const mensaje = err instanceof Error ? err.message : String(err);
            this.logger.warn(`Fallo al refrescar WHATSAPP_MENU_URL: ${mensaje}`);
        }
    }

    /**
     * Comprueba que el cuerpo tenga menu, sucursales y configuracion_carrito antes de tipar.
     */
    private validarPayloadMenu(data: unknown): WhatsAppInformacionTienda | null {
        if (!data || typeof data !== 'object') {
            return null;
        }
        const o = data as Record<string, unknown>;
        if (!o.menu || !Array.isArray((o.menu as { links?: unknown }).links)) {
            return null;
        }
        if (!Array.isArray(o.sucursales)) {
            return null;
        }
        if (!o.configuracion_carrito || typeof o.configuracion_carrito !== 'object') {
            return null;
        }
        return data as WhatsAppInformacionTienda;
    }

        /**
     * Rellena id_shopify por match de nombre; siempre deja solo el id numerico (nunca el gid completo).
     */
        private enriquecerSucursales(
            sucursales: WhatsappSucursalMenuItem[],
            mapa: Map<string, string>,
        ): WhatsappSucursalMenuItem[] {
            return sucursales.map((s) => {
                const clave = this.shopifyAdmin.normalizarNombreUbicacion(s.nombre);
                const idDesdeMapa = mapa.get(clave);
                const idNumerico = idDesdeMapa
                    ? idDesdeMapa
                    : this.shopifyAdmin.extraerIdNumericoLocationDesdeGid(s.id_shopify);
                if (!idDesdeMapa && !s.id_shopify) {
                    this.logger.debug(`Sucursal sin match Shopify por nombre: "${s.nombre}"`);
                }
                return { ...s, id_shopify: idNumerico };
            });
        }
}