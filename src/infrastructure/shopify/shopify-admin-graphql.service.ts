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
     * Resuelve si tenemos credenciales suficientes para llamar a Admin API
     * Si falta algo preferimos omitir enrichment antes que tirar el arranque del backend
     */
    private credencialesCompletas(): boolean {
        const shop = this.config.getOrThrow<string>('SHOPIFY_SHOP_DOMAIN');
        const token = this.config.getOrThrow<string>('SHOPIFY_ADMIN_ACCESS_TOKEN');
        return Boolean(shop && token);
    }

    /**
     * URL del endpoint GraphQL Admin segun tienda y version de API configurada
     */
    private urlGraphql(): string {
        const shop = this.config.getOrThrow<string>('SHOPIFY_SHOP_DOMAIN');
        const version = this.config.getOrThrow<string>('SHOPIFY_API_VERSION');
        return `https://${shop}/admin/api/${version}/graphql.json`;
    }

    /**
     * Headers estandar Admin API - Shopify documenta X-Shopify-Access-Token (no Bearer en Admin)
     */
    private headers(): Record<string, string> {
        const token = this.config.getOrThrow<string>('SHOPIFY_ADMIN_ACCESS_TOKEN');
        return {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json',
        }
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