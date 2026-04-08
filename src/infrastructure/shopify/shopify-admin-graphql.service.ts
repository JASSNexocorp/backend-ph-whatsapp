import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { firstValueFrom } from "rxjs";

/** 
 * Cliente minimo para GraphQL de Shopify : Locations (paginado) y opcional deliveryProfiles para tarifa
 * Sin logica de negocio de WhatsApp - solo transporte y parseo defensivo
 */
@Injectable()
export class ShopifyAdminGraphqlService {
    private readonly logger = new Logger(ShopifyAdminGraphqlService.name);

    constructor(
        private readonly config: ConfigService,
        private readonly http: HttpService
    ) { }

    /**
     * Resuelve si tenemos credenciales suficientes para llamar a Admin API.
     * Usa get() y no getOrThrow: si falta Shopify el refresco del menu JSON no debe romperse entero.
     */
    private credencialesCompletas(): boolean {
        const shop = this.config.get<string>('SHOPIFY_SHOP_DOMAIN')?.trim() ?? '';
        const token = this.config.get<string>('SHOPIFY_ADMIN_ACCESS_TOKEN')?.trim() ?? '';
        return Boolean(shop && token);
    }

    /**
     * Expone si hay shop + token para que otros servicios no accedan a metodos privados por indice.
     */
    tieneCredencialesShopify(): boolean {
        return this.credencialesCompletas();
    }

    /**
     * URL del endpoint GraphQL Admin segun tienda y version de API configurada.
     * Solo se llama si credencialesCompletas() ya devolvio true.
     */
    private urlGraphql(): string {
        const shop = this.config.get<string>('SHOPIFY_SHOP_DOMAIN')!.trim();
        const version = (this.config.get<string>('SHOPIFY_API_VERSION') ?? '2024-10').trim();
        return `https://${shop}/admin/api/${version}/graphql.json`;
    }

    /**
     * Headers estandar Admin API - Shopify documenta X-Shopify-Access-Token (no Bearer en Admin)
     */
    private headers(): Record<string, string> {
        const token = this.config.get<string>('SHOPIFY_ADMIN_ACCESS_TOKEN')!.trim();
        return {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json',
        };
    }

    /**
     * Expone POST GraphQL para el servicio de catalogo (colecciones por titulo) sin duplicar URL ni token.
     */
    async ejecutarGraphqlAdmin<T>(
        query: string,
        variables?: Record<string, unknown>,
    ): Promise<T | null> {
        return this.postGraphql<T>(query, variables);
    }

    /**
     * Ejecuta una query GraphQL y devuelve el JSON parseado o null si falla red/HTTP
     */
    private async postGraphql<T>(query: string, variables?: Record<string, unknown>): Promise<T | null> {
        if (!this.credencialesCompletas()) {
            return null;
        }

        try {
            const resp = await firstValueFrom(
                this.http.post(this.urlGraphql(), {
                    query,
                    variables,
                }, { headers: this.headers() })
            )
            return resp.data;
        } catch (error) {
            const mensaje = error instanceof Error ? error.message : String(error);
            this.logger.error(`Error GraphQL fallo : ${mensaje}`);
            return null;
        }
    }

    /**
     * Reintenta POST GraphQL ante fallos de red o cuerpo null; útil para crear/buscar clientes.
     */
    async ejecutarGraphqlAdminConReintentos<T>(
        query: string,
        variables?: Record<string, unknown>,
    ): Promise<T | null> {
        const max = Math.max(
            1,
            parseInt(this.config.get<string>('SHOPIFY_GRAPHQL_MAX_RETRIES') ?? '3', 10) || 3,
        );
        const baseMs = parseInt(this.config.get<string>('SHOPIFY_GRAPHQL_RETRY_DELAY_MS') ?? '400', 10) || 400;

        let ultimo: T | null = null;
        for (let intento = 1; intento <= max; intento++) {
            ultimo = await this.ejecutarGraphqlAdmin<T>(query, variables);
            if (ultimo !== null) {
                return ultimo;
            }
            if (intento < max) {
                await new Promise((r) => setTimeout(r, baseMs * intento));
            }
        }
        return ultimo;
    }


    /**
     * Convierte gid://shopify/Location/103470530844 al id numerico 103470530844 para JSON y REST.
     * Si ya viene solo digitos, se devuelve igual; vacio si no hay gid usable.
     */
    extraerIdNumericoLocationDesdeGid(gid: string): string {
        const trimmed = (gid ?? '').trim();
        if (!trimmed) {
            return '';
        }
        const ultimoSegmento = trimmed.split('/').pop();
        return ultimoSegmento ?? trimmed;
    }

    /**
     * Trae todas las locations paginando — el ejemplo del front usaba first: 10 y perdia sucursales.
     * Valores del mapa: id numerico de Location (no el gid completo).
     */
    async obtenerMapaNombreNormalizadoAIdLocation(): Promise<Map<string, string>> {
        const mapa = new Map<string, string>();
        if (!this.credencialesCompletas()) {
            return mapa;
        }
        const query = `
      query LocationsPage($first: Int!, $after: String) {
        locations(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges { node { id name } }
        }
      }
    `;
        let after: string | null = null;
        const pageSize = 50;
        let hasNext = true;
        while (hasNext) {
            const datos = await this.postGraphql<{
                data?: { locations?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; edges?: Array<{ node?: { id?: string; name?: string } }> } };
                errors?: unknown;
            }>(query, { first: pageSize, after });
            if (datos?.errors) {
                this.logger.warn(`GraphQL locations errors: ${JSON.stringify(datos.errors)}`);
                break;
            }
            const edges = datos?.data?.locations?.edges ?? [];
            for (const edge of edges) {
                const nombre = edge?.node?.name;
                const id = edge?.node?.id;
                if (nombre && id) {
                    const idNumerico = this.extraerIdNumericoLocationDesdeGid(id);
                    if (idNumerico) {
                        mapa.set(this.normalizarNombreUbicacion(nombre), idNumerico);
                    }
                }
            }
            hasNext = Boolean(datos?.data?.locations?.pageInfo?.hasNextPage);
            after = datos?.data?.locations?.pageInfo?.endCursor ?? null;
            if (!hasNext) {
                break;
            }
        }
        return mapa;
    }

    /**
     * Igual que en el front: comparar nombres sin depender de mayusculas ni espacios dobles.
     * Sin diacriticos para acercar "San Martín" a "SAN MARTIN" del JSON.
     */
    normalizarNombreUbicacion(nombre: string): string {
        const sinDiacriticos = nombre.normalize('NFD').replace(/\p{M}/gu, '');
        return sinDiacriticos.toLowerCase().replace(/\s+/g, ' ').trim();
    }

    /**
    * Recorre deliveryProfiles como en el snippet del navegador y devuelve el primer precio activo o null.
    * Es fragil si cambian perfiles en Shopify — por eso el costo por defecto sigue siendo el JSON.
    */
    async obtenerPrimerPrecioEnvioDomicilioActivo(): Promise<number | null> {
        if (!this.credencialesCompletas()) {
            return null;
        }
        const query = `
      query DeliveryProfiles {
        deliveryProfiles(first: 10) {
          edges {
            node {
              profileLocationGroups {
                locationGroupZones(first: 20) {
                  edges {
                    node {
                      methodDefinitions(first: 10) {
                        edges {
                          node {
                            active
                            rateProvider {
                              ... on DeliveryRateDefinition {
                                price { amount currencyCode }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;
        const datos = await this.postGraphql<{
            data?: {
                deliveryProfiles?: {
                    edges?: Array<{
                        node?: {
                            profileLocationGroups?: Array<{
                                locationGroupZones?: {
                                    edges?: Array<{
                                        node?: {
                                            methodDefinitions?: {
                                                edges?: Array<{
                                                    node?: {
                                                        active?: boolean;
                                                        rateProvider?: { price?: { amount?: string } };
                                                    };
                                                }>;
                                            };
                                        };
                                    }>;
                                };
                            }>;
                        };
                    }>;
                };
            };
            errors?: unknown;
        }>(query);
        if (datos?.errors) {
            this.logger.warn(`GraphQL deliveryProfiles errors: ${JSON.stringify(datos.errors)}`);
            return null;
        }
        const perfiles = datos?.data?.deliveryProfiles?.edges ?? [];
        for (const perfil of perfiles) {
            const grupos = perfil?.node?.profileLocationGroups ?? [];
            for (const grupo of grupos) {
                const zonas = grupo?.locationGroupZones?.edges ?? [];
                for (const zona of zonas) {
                    const metodos = zona?.node?.methodDefinitions?.edges ?? [];
                    for (const metodo of metodos) {
                        const nodo = metodo?.node;
                        const monto = nodo?.rateProvider?.price?.amount;
                        if (nodo?.active && monto !== undefined && monto !== null) {
                            const valor = Number.parseFloat(String(monto));
                            if (!Number.isNaN(valor)) {
                                return valor;
                            }
                        }
                    }
                }
            }
        }
        return null;
    }
}