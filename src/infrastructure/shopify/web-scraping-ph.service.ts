import { HttpService } from "@nestjs/axios";
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { firstValueFrom } from "rxjs";
import type { PuertoInformacionTiendaWhatsapp } from "../../core/ports/puerto-informacion-tienda.whatsapp";
import {
    WhatsAppInformacionTienda,
    WhatsappColeccionJsonItem,
    WhatsappColeccionTienda,
    WhatsappCatalogoProducto,
    WhatsappInformacionTiendaCache,
    WhatsappSucursalMenuItem,
} from "../../core/whatsapp/informacion-tienda-whatsapp.types";
import { ShopifyAdminGraphqlService } from "./shopify-admin-graphql.service";
import { ShopifyCatalogCollectionsService } from "./shopify-catalog-collections.service";


/**
 * Sincroniza el JSON Tienda Pizza Hut con Shopify desde WHATSAPP_MENU_URL
 * Corre al iniciar y luego cada 30 minutos guardando en cache de memoria
 */
@Injectable()
export class WebScrapingPhService
    implements OnModuleInit, OnModuleDestroy, PuertoInformacionTiendaWhatsapp
{
    private readonly logger = new Logger(WebScrapingPhService.name);
    private informacionTiendaEnCache: WhatsappInformacionTiendaCache | null = null;
    private intervaloRef: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly config: ConfigService,
        private readonly http: HttpService,
        private readonly shopifyAdmin: ShopifyAdminGraphqlService,
        private readonly catalogoColecciones: ShopifyCatalogCollectionsService,
    ) { }

    /**
     * Ultima copia en RAM del JSON enriquecido; el flujo WhatsApp la lee sin nuevo HTTP.
     */
    obtenerInformacionTiendaEnCache(): WhatsappInformacionTiendaCache | null {
        return this.informacionTiendaEnCache;
    }

    /**
   * Primer fetch al levantar el modulo + temporizador segun WHATSAPP_MENU_CACHE_TTL_MS.
   */
    onModuleInit(): void {
        void this.refrescarInformacionTiendaEnCache();
        const ttlMs = Number.parseInt(this.config.get<string>('WHATSAPP_MENU_CACHE_TTL_MS') ?? '1800000', 10);
        const periodo = Number.isFinite(ttlMs) && ttlMs >= 60_000 ? ttlMs : 1_800_000;
        this.intervaloRef = setInterval(() => void this.refrescarInformacionTiendaEnCache(), periodo);
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
     * GET al JSON publico, validacion, enrichment Shopify y actualizacion de la cache en RAM.
     * Si falla la red se conserva la cache anterior para no dejar el bot sin datos.
     */
    async refrescarInformacionTiendaEnCache(): Promise<void> {
        const url = this.config.get<string>('WHATSAPP_MENU_URL');
        if (!url) {
            this.logger.warn('WHATSAPP_MENU_URL no definida — no se actualiza el menu en memoria');
            return;
        }
        this.logger.log('Refrescando informacion tienda (GET WHATSAPP_MENU_URL + Shopify opcional)...');
        try {
            const urlFetch = this.construirUrlFetchMenu(url);
            const headers = this.headersFetchMenuSinCache();
            const resp = await firstValueFrom(
                this.http.get<unknown>(urlFetch, { timeout: 25_000, headers }),
            );
            this.registrarRespuestaCrudaWhatsappMenuUrl(resp.data, urlFetch);
            const payload = this.validarPayloadMenu(resp.data);
            if (!payload) {
                this.logger.warn('Refresco abortado: JSON de menu invalido (la cache anterior no se modifica).');
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
            let catalogoShopify: WhatsappColeccionTienda[] | null = null;
            if (this.config.get<string>('WHATSAPP_CATALOG_SYNC_ENABLED') !== 'false') {
                catalogoShopify = await this.catalogoColecciones.obtenerCatalogoPorColeccionesEntrada(
                    payload.colecciones,
                );
                if (catalogoShopify === null) {
                    this.logger.warn(
                        'Catalogo Shopify no actualizado; se reutilizan productos de la cache por titulo si existian',
                    );
                } else if (catalogoShopify.length === 0 && payload.colecciones.length > 0) {
                    // Array vacio no es lo mismo que null: sin esto se borraban todos los productos en cache.
                    this.logger.warn(
                        'Catalogo Shopify devolvio 0 colecciones con match; se conservan productos de la cache previa por titulo',
                    );
                    catalogoShopify = null;
                }
            }
            const coleccionesConProductos = this.fusionarProductosEnColecciones(
                payload.colecciones,
                catalogoShopify,
                this.informacionTiendaEnCache?.colecciones,
            );
            this.informacionTiendaEnCache = {
                colecciones: coleccionesConProductos,
                sucursales: sucursalesEnriquecidas,
                configuracion_carrito: {
                    cantidad_minima: payload.configuracion_carrito.cantidad_minima,
                    costo_envio_domicilio: costoEnvio,
                },
            };
            const totalProductos = coleccionesConProductos.reduce((n, c) => n + c.productos.length, 0);
            this.logger.log(
                `Cache tienda lista: ${coleccionesConProductos.length} colecciones (titulo+imagen del JSON), ` +
                    `${totalProductos} productos en total, ${sucursalesEnriquecidas.length} sucursales`,
            );
        } catch (err) {
            const mensaje = err instanceof Error ? err.message : String(err);
            this.logger.warn(`Fallo al refrescar WHATSAPP_MENU_URL: ${mensaje}`);
        }
    }

    /**
     * Si WHATSAPP_MENU_SKIP_HTTP_CACHE=true agrega _ts= en la URL para que CDN/proxy no sirvan respuesta vieja.
     */
    private construirUrlFetchMenu(urlBase: string): string {
        if (this.config.get<string>('WHATSAPP_MENU_SKIP_HTTP_CACHE') !== 'true') {
            return urlBase;
        }
        const separador = urlBase.includes('?') ? '&' : '?';
        return `${urlBase}${separador}_ts=${Date.now()}`;
    }

    /**
     * Pide al origen e intermediarios que revaliden; no sustituye el cache-bust por query si el CDN lo ignora.
     */
    private headersFetchMenuSinCache(): Record<string, string> {
        return {
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
        };
    }

    /**
     * Arma colecciones para la API: cada fila del JSON (titulo+imagen) + productos del ultimo fetch Shopify o, si fallo, los de la cache por titulo.
     */
    private fusionarProductosEnColecciones(
        entradasJson: WhatsappColeccionJsonItem[],
        catalogoShopify: WhatsappColeccionTienda[] | null,
        coleccionesCachePrevia: WhatsappColeccionTienda[] | undefined,
    ): WhatsappColeccionTienda[] {
        const mapaProductos = new Map<string, WhatsappCatalogoProducto[]>();
        const norm = (t: string) => this.catalogoColecciones.normalizarTituloParaMatch(t);
        if (catalogoShopify !== null) {
            for (const c of catalogoShopify) {
                mapaProductos.set(norm(c.titulo), c.productos);
            }
        } else if (coleccionesCachePrevia?.length) {
            for (const c of coleccionesCachePrevia) {
                mapaProductos.set(norm(c.titulo), c.productos);
            }
        }
        return entradasJson.map((e) => ({
            titulo: e.titulo,
            imagen: e.imagen,
            productos: mapaProductos.get(norm(e.titulo)) ?? [],
        }));
    }

    /**
     * Si WHATSAPP_MENU_LOG_RAW_JSON=true escribe en log el cuerpo tal cual llego del GET (desarrollo).
     */
    private registrarRespuestaCrudaWhatsappMenuUrl(cuerpo: unknown, urlUsada: string): void {
        if (this.config.get<string>('WHATSAPP_MENU_LOG_RAW_JSON') !== 'true') {
            return;
        }
        let texto: string;
        try {
            texto = typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo, null, 2);
        } catch {
            texto = String(cuerpo);
        }
        const maxRaw = this.config.get<string>('WHATSAPP_MENU_LOG_RAW_MAX_CHARS');
        const max = maxRaw !== undefined && maxRaw !== '' ? Number.parseInt(maxRaw, 10) : 0;
        if (Number.isFinite(max) && max > 0 && texto.length > max) {
            texto = `${texto.slice(0, max)}\n... [truncado, total ${texto.length} chars; ajusta WHATSAPP_MENU_LOG_RAW_MAX_CHARS]`;
        }
        this.logger.log(`WHATSAPP_MENU_URL respuesta cruda (${urlUsada}):\n${texto}`);
    }

    /**
     * Comprueba colecciones (titulo + imagen), sucursales y configuracion_carrito antes de tipar.
     * En cada fallo registra la razon concreta para depurar sin adivinar (suele ser JSON viejo con "menu" en vez de "colecciones").
     */
    private validarPayloadMenu(data: unknown): WhatsAppInformacionTienda | null {
        if (!data || typeof data !== 'object') {
            this.logger.warn(
                'WHATSAPP_MENU_URL: respuesta no es un objeto JSON (revisa Content-Type y que la URL devuelva JSON).',
            );
            return null;
        }
        const o = data as Record<string, unknown>;
        const claves = Object.keys(o);
        if (!Array.isArray(o.colecciones)) {
            const pistaMenu = o.menu != null ? ' El payload trae "menu" (formato antiguo); hoy se espera raiz "colecciones".' : '';
            this.logger.warn(
                `WHATSAPP_MENU_URL: "colecciones" debe ser un array. Claves en raiz: [${claves.join(', ')}].${pistaMenu}`,
            );
            return null;
        }
        for (let i = 0; i < o.colecciones.length; i++) {
            const item = o.colecciones[i];
            if (!item || typeof item !== 'object') {
                this.logger.warn(`WHATSAPP_MENU_URL: colecciones[${i}] no es un objeto.`);
                return null;
            }
            const c = item as Record<string, unknown>;
            if (typeof c.titulo !== 'string' || typeof c.imagen !== 'string') {
                this.logger.warn(
                    `WHATSAPP_MENU_URL: colecciones[${i}] exige "titulo" e "imagen" como string (titulo=${typeof c.titulo}, imagen=${typeof c.imagen}).`,
                );
                return null;
            }
        }
        if (!Array.isArray(o.sucursales)) {
            this.logger.warn('WHATSAPP_MENU_URL: "sucursales" debe ser un array.');
            return null;
        }
        if (!o.configuracion_carrito || typeof o.configuracion_carrito !== 'object') {
            this.logger.warn('WHATSAPP_MENU_URL: "configuracion_carrito" debe ser un objeto.');
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