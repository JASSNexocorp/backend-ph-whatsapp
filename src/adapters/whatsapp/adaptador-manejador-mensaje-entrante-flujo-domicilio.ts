import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { MenuClienteJwtService } from "src/infrastructure/auth/menu-cliente-jwt.service";
import { PuertoManejadorMensajeEntrante } from "src/core/ports/puerto-manejador-mensaje-entrante";
import { TOKEN_PUERTO_INFORMACION_TIENDA_WHATSAPP } from "src/core/ports/puerto-informacion-tienda.whatsapp";
import type { PuertoInformacionTiendaWhatsapp } from "src/core/ports/puerto-informacion-tienda.whatsapp";
import { TOKEN_PUERTO_WHATSAPP_GRAPH_API } from "src/core/ports/puerto-whatsapp-graph-api";
import type { PuertoWhatsappGraphApi } from "src/core/ports/puerto-whatsapp-graph-api";
import { IDS_BOTONES_CARRITO_WEB } from "src/core/use-cases/notificar-carrito-web-whatsapp.caso-uso";
import { MensajeEntranteWhatsappNormalizado } from "src/core/whatsapp/mensaje-entrante-whatsapp-normalizado";
import { CoberturaDomicilioUtilidad, WhatsappSucursalConDistanciaKm } from "src/core/whatsapp/cobertura-domicilio.utilidad";
import { WhatsappSucursalMenuItem, WhatsappTurnoSucursal } from "src/core/whatsapp/informacion-tienda-whatsapp.types";
import { WhatsAppClienteEntity } from "src/infrastructure/database/schemas/cliente-whatsapp.entity";
import { WhatsAppConversacionEntity } from "src/infrastructure/database/schemas/whatsapp-conversation.entity";
import { Repository } from "typeorm";
import { HorarioAtencionBotWhatsappService } from "src/infrastructure/whatsapp/horario-atencion-bot-whatsapp.service";
import { ShopifyClienteSincronizacionService } from "src/infrastructure/shopify/shopify-cliente-sincronizacion.service";

// Número de teléfono del agente humano que atiende consultas especiales.
const TELEFONO_AGENTE = '+591 78452415';

// Nombres de los días de la semana (índice 1 = Lunes, 7 = Domingo).
const NOMBRES_DIAS: Record<number, string> = {
    1: 'Lun',
    2: 'Mar',
    3: 'Mié',
    4: 'Jue',
    5: 'Vie',
    6: 'Sáb',
    7: 'Dom',
};

type NodoConversacion =
    | 'inicio'
    | 'menu_principal'
    | 'seleccionar_tipo_pedido'
    | 'esperando_ubicacion_domicilio'
    | 'esperando_indicaciones_repartidor'
    | 'confirmar_indicaciones'
    | 'otras_opciones'
    | 'esperando_confirmacion_sucursal';

/**
 * Handler de flujo: interpreta el mensaje entrante según el nodo_actual y responde.
 * Implementa el subflujo completo de pedido a domicilio:
 * Menú principal → Tipo pedido → Ubicación (con validación de cobertura) →
 * Indicaciones → Confirmación → Asignación de sucursal → Link de catálogo.
 * También maneja el subflujo "Otras opciones" con listado de restaurantes.
 */
@Injectable()
export class AdaptadorManejadorMensajeEntranteFlujoDomicilio implements PuertoManejadorMensajeEntrante {

    private readonly logger = new Logger(AdaptadorManejadorMensajeEntranteFlujoDomicilio.name);

    // Almacena el ID del mensaje entrante actual para usarlo en el indicador de escritura.
    // Se reasigna al inicio de cada llamada a manejar(), antes de cualquier envío.
    private idMensajeActual: string = '';

    constructor(
        @Inject(TOKEN_PUERTO_WHATSAPP_GRAPH_API)
        private readonly whatsapp: PuertoWhatsappGraphApi,
        private readonly config: ConfigService,
        @Inject(TOKEN_PUERTO_INFORMACION_TIENDA_WHATSAPP)
        private readonly tiendaInfo: PuertoInformacionTiendaWhatsapp,
        private readonly menuClienteJwt: MenuClienteJwtService,
        @InjectRepository(WhatsAppClienteEntity)
        private readonly repoCliente: Repository<WhatsAppClienteEntity>,
        @InjectRepository(WhatsAppConversacionEntity)
        private readonly repoConversacion: Repository<WhatsAppConversacionEntity>,
        private readonly horarioAtencion: HorarioAtencionBotWhatsappService,
        private readonly shopifyClienteSync: ShopifyClienteSincronizacionService,
    ) { }

    // Punto de entrada principal: lee el nodo actual y enruta al bloque correspondiente.
    async manejar(mensaje: MensajeEntranteWhatsappNormalizado): Promise<void> {
        // FASE 1: Asegurar cliente + conversación (memoria del bot).
        const { cliente, conversacion } = await this.asegurarClienteYConversacion(mensaje.numeroWhatsappOrigen);

        // FASE 2: Renovar expiración y persistir antes de responder.
        this.renovarConversacion(conversacion);
        await this.repoConversacion.save(conversacion);

        // FASE 3: Marcar como leído y guardar el ID del mensaje para las façades de envío.
        await this.whatsapp.marcarComoLeido(mensaje.idMensajeWhatsapp);
        this.idMensajeActual = mensaje.idMensajeWhatsapp;

        // FASE 3.1: Horario de atencion (sucursal pivote en cache); si cerrado, avisamos y salimos.
        if (!this.horarioAtencion.botPuedeAtenderEnEsteMomento()) {
            await this.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                this.horarioAtencion.obtenerTextoMensajeFueraDeHorario(),
            );
            await this.repoConversacion.save(conversacion);
            return;
        }

        // FASE 3.2: Enlazar o crear Customer en Shopify si aun no hay shopifyClienteId (no bloquea si falla).
        await this.shopifyClienteSync.enlazarOCrearClienteShopifySiHaceFalta(cliente);

        // FASE 3.5: Botones del resumen de carrito enviado desde el menú web (confirmar / modificar / cancelar).
        if (mensaje.tipo === 'interactivo' && mensaje.idBotonPresionado) {
            const idBtn = mensaje.idBotonPresionado;
            if (
                idBtn === IDS_BOTONES_CARRITO_WEB.confirmar ||
                idBtn === IDS_BOTONES_CARRITO_WEB.modificar ||
                idBtn === IDS_BOTONES_CARRITO_WEB.cancelar
            ) {
                await this.manejarRespuestaCarritoWeb(mensaje, conversacion);
                await this.repoConversacion.save(conversacion);
                return;
            }
        }

        // FASE 4: Atajo global — si el usuario escribe "menu" lo volvemos al menú principal.
        if (mensaje.tipo === 'texto') {
            const texto = (mensaje.textoPlano ?? '').trim().toLowerCase();
            if (texto === 'menu') {
                await this.enviarMenuPrincipal(mensaje.numeroWhatsappOrigen);
                conversacion.nodoActual = 'menu_principal';
                await this.repoConversacion.save(conversacion);
                return;
            }
        }

        // FASE 5: Enrutar según el nodo actual.
        const nodo = (conversacion.nodoActual as NodoConversacion) ?? 'inicio';
        await this.enrutarNodo(nodo, mensaje, conversacion);
    }

    // Delega la lógica de cada nodo para mantener el método principal limpio.
    private async enrutarNodo(
        nodo: NodoConversacion,
        mensaje: MensajeEntranteWhatsappNormalizado,
        conversacion: WhatsAppConversacionEntity,
    ): Promise<void> {
        if (nodo === 'inicio' || nodo === 'menu_principal') {
            await this.manejarMenuPrincipal(mensaje, conversacion);
            return;
        }
        if (nodo === 'otras_opciones') {
            await this.manejarOtrasOpciones(mensaje, conversacion);
            return;
        }
        if (nodo === 'seleccionar_tipo_pedido') {
            await this.manejarSeleccionTipoPedido(mensaje, conversacion);
            return;
        }
        if (nodo === 'esperando_ubicacion_domicilio') {
            await this.manejarUbicacionDomicilio(mensaje, conversacion);
            return;
        }
        if (nodo === 'esperando_indicaciones_repartidor') {
            await this.manejarIndicacionesRepartidor(mensaje, conversacion);
            return;
        }
        if (nodo === 'confirmar_indicaciones') {
            await this.manejarConfirmarIndicaciones(mensaje, conversacion);
            return;
        }
        if (nodo === 'esperando_confirmacion_sucursal') {
            await this.manejarConfirmacionSucursalSinServicio(mensaje, conversacion);
            return;
        }
    }

    // ─── RESUMEN CARRITO WEB (BOTONES) ───────────────────────────────────────────

    /**
     * Atiende los tres botones del mensaje interactivo disparado por POST /tienda/notificar-carrito.
     * Cancelar vuelve al menú principal; Modificar reabre el enlace JWT; Confirmar solo acusa recibo.
     */
    private async manejarRespuestaCarritoWeb(
        mensaje: MensajeEntranteWhatsappNormalizado,
        conversacion: WhatsAppConversacionEntity,
    ): Promise<void> {
        const id = mensaje.idBotonPresionado;
        const numero = mensaje.numeroWhatsappOrigen;

        if (id === IDS_BOTONES_CARRITO_WEB.cancelar) {
            await this.enviarMenuPrincipal(numero);
            conversacion.nodoActual = 'menu_principal';
            return;
        }

        if (id === IDS_BOTONES_CARRITO_WEB.modificar) {
            const ctx = this.obtenerContextoMenuWebDelCarrito(conversacion.carrito as unknown[]);
            if (ctx) {
                await this.enviarEnlaceMenuConJwt(numero, ctx.nombreSucursal, ctx.tipoEntrega);
                return;
            }
            const sucursalGuardada = this.obtenerSucursalGuardadaDelCarrito(conversacion.carrito as any[]);
            if (sucursalGuardada) {
                await this.enviarLinkCatalogo(numero, sucursalGuardada);
                return;
            }
            await this.enviarTexto(
                numero,
                'No encontramos tu sesión del menú web. Escribí *menu* para empezar de nuevo.',
            );
            return;
        }

        if (id === IDS_BOTONES_CARRITO_WEB.confirmar) {
            await this.enviarTexto(
                numero,
                '¡Listo! Registramos tu *confirmación*. En breve seguimos con el siguiente paso por aquí. 🍕',
            );
        }
    }

    // ─── NODOS ───────────────────────────────────────────────────────────────────

    // Menú principal: el usuario puede hacer un pedido o ver otras opciones.
    private async manejarMenuPrincipal(
        mensaje: MensajeEntranteWhatsappNormalizado,
        conversacion: WhatsAppConversacionEntity,
    ): Promise<void> {
        if (mensaje.idBotonPresionado === 'hacer_pedido') {
            await this.enviarMenuTipoPedido(mensaje.numeroWhatsappOrigen);
            conversacion.nodoActual = 'seleccionar_tipo_pedido';
            await this.repoConversacion.save(conversacion);
            return;
        }

        if (mensaje.idBotonPresionado === 'otras_opciones') {
            await this.enviarOtrasOpciones(mensaje.numeroWhatsappOrigen);
            conversacion.nodoActual = 'otras_opciones';
            await this.repoConversacion.save(conversacion);
            return;
        }

        // Guardrail: cualquier entrada fuera del flujo reenvía el menú principal.
        await this.enviarTexto(
            mensaje.numeroWhatsappOrigen,
            'Por favor sigue el flujo para continuar con tu compra. 👨‍🍳🍕',
        );
        await this.enviarMenuPrincipal(mensaje.numeroWhatsappOrigen);
        conversacion.nodoActual = 'menu_principal';
        await this.repoConversacion.save(conversacion);
    }

    // Otras opciones: submenú con restaurantes y posibles opciones futuras.
    private async manejarOtrasOpciones(
        mensaje: MensajeEntranteWhatsappNormalizado,
        conversacion: WhatsAppConversacionEntity,
    ): Promise<void> {
        if (mensaje.idBotonPresionado === 'ver_restaurantes') {
            const cache = this.tiendaInfo.obtenerInformacionTiendaEnCache();
            const sucursales = cache?.sucursales ?? [];
            await this.enviarSucursalesConMapa(mensaje.numeroWhatsappOrigen, sucursales);
            // El nodo permanece en otras_opciones para que el botón Menú del listado funcione.
            conversacion.nodoActual = 'otras_opciones';
            await this.repoConversacion.save(conversacion);
            return;
        }

        if (mensaje.idBotonPresionado === 'volver_otras_opciones') {
            // El usuario presionó "Menú" desde el listado de sucursales:
            // lo llevamos al menú principal (Hacer pedido / Otras opciones), no al submenú.
            await this.enviarMenuPrincipal(mensaje.numeroWhatsappOrigen);
            conversacion.nodoActual = 'menu_principal';
            await this.repoConversacion.save(conversacion);
            return;
        }

        // Guardrail: entrada inesperada en este nodo.
        await this.enviarTexto(
            mensaje.numeroWhatsappOrigen,
            'Selecciona una de las opciones disponibles para continuar. 😊',
        );
        await this.enviarOtrasOpciones(mensaje.numeroWhatsappOrigen);
    }

    // Selección del tipo de pedido: domicilio o retiro en local.
    private async manejarSeleccionTipoPedido(
        mensaje: MensajeEntranteWhatsappNormalizado,
        conversacion: WhatsAppConversacionEntity,
    ): Promise<void> {
        if (mensaje.idBotonPresionado === 'a_domicilio') {
            await this.enviarUbicacion(
                mensaje.numeroWhatsappOrigen,
                [
                    'Te solicitaremos 2 datos para la toma de tu pedido.',
                    '',
                    'Compárteme la *ubicación* en la que quieres tu pedido 📝📌',
                    '_(la ubicación que envíes será donde entregaremos tu pedido)_',
                    '',
                    'Si quieres seleccionar un lugar *distinto* al de tu ubicación actual, debes ingresar la *dirección completa* en el mapa 📍',
                    '',
                    'Ejemplo: _Av. Banzer, Edif. Cristóbal_',
                ].join('\n'),
            );
            conversacion.nodoActual = 'esperando_ubicacion_domicilio';
            await this.repoConversacion.save(conversacion);
            return;
        }

        if (mensaje.idBotonPresionado === 'retiro_local') {
            // Por el momento solo atendemos domicilio; informamos y volvemos al menú de tipo.
            await this.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                'Por el momento solo estamos atendiendo pedidos A Domicilio. 🛵',
            );
            await this.enviarMenuTipoPedido(mensaje.numeroWhatsappOrigen);
            return;
        }

        await this.enviarTexto(
            mensaje.numeroWhatsappOrigen,
            'Por favor sigue el flujo para continuar con tu compra. 👨‍🍳🍕',
        );
        await this.enviarMenuTipoPedido(mensaje.numeroWhatsappOrigen);
    }

    // Recepción de ubicación: valida cobertura antes de avanzar al siguiente paso.
    private async manejarUbicacionDomicilio(
        mensaje: MensajeEntranteWhatsappNormalizado,
        conversacion: WhatsAppConversacionEntity,
    ): Promise<void> {
        if (mensaje.tipo !== 'ubicacion' || !mensaje.ubicacion) {
            await this.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                'Por favor compártenos tu *ubicación* usando el botón del mapa 📌',
            );
            return;
        }

        // El tipo normalizado usa latitude/longitude según el contrato del webhook de Meta.
        const lat = mensaje.ubicacion.latitude;
        const lng = mensaje.ubicacion.longitude;

        // Mensaje inmediato de espera para que el usuario no quede sin respuesta.
        await this.enviarTexto(
            mensaje.numeroWhatsappOrigen,
            '⏳ Dame un momento, estoy verificando tu ubicación dentro de nuestra zona de cobertura...',
        );

        const dentroDeCobertua = CoberturaDomicilioUtilidad.estaDentroCobertura(lat, lng);

        if (!dentroDeCobertua) {
            // La ubicación cae fuera del polígono de cobertura; pedimos una nueva.
            await this.enviarUbicacion(
                mensaje.numeroWhatsappOrigen,
                [
                    '😔 Lo sentimos, tu ubicación está *fuera de nuestra zona de cobertura* por el momento.',
                    '',
                    'Compártenos la ubicación *donde deseas recibir tu pedido* 📌',
                    '_(puede ser una dirección diferente a la tuya)_',
                    '',
                    'Si tienes dudas, escribe *menu* para volver al inicio.',
                ].join('\n'),
            );
            // El nodo permanece en esperando_ubicacion_domicilio para un reintento.
            return;
        }

        // Ubicación válida: la guardamos en el carrito como contexto temporal.
        const carrito: any[] = Array.isArray(conversacion.carrito) ? (conversacion.carrito as any[]) : [];
        const sinContexto = carrito.filter((x) => x?._contexto !== 'domicilio');
        // Normalizamos a lat/lng internamente para mantener consistencia con CoberturaDomicilioUtilidad.
        sinContexto.push({ _contexto: 'domicilio', ubicacion: { lat, lng } });
        conversacion.carrito = sinContexto as any;

        await this.enviarTexto(
            mensaje.numeroWhatsappOrigen,
            [
                '✅ ¡Ubicación verificada! Tu dirección está dentro de nuestra zona de atención.',
                '',
                'Finalmente, envíanos tu *dirección escrita* para el repartidor 🏠',
                '',
                'Por ejemplo: color del portón, timbre, piso, referencia cercana, número de contacto, etc.',
                '',
                '📝 _(Máximo 128 caracteres)_',
            ].join('\n'),
        );

        conversacion.nodoActual = 'esperando_indicaciones_repartidor';
        await this.repoConversacion.save(conversacion);
    }

    // Indicaciones escritas para el repartidor: valida largo y pide confirmación.
    private async manejarIndicacionesRepartidor(
        mensaje: MensajeEntranteWhatsappNormalizado,
        conversacion: WhatsAppConversacionEntity,
    ): Promise<void> {
        if (mensaje.tipo !== 'texto') {
            await this.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                'Por favor envíanos tu dirección como *texto* (máximo 128 caracteres). 📝',
            );
            return;
        }

        const indicaciones = (mensaje.textoPlano ?? '').trim();

        if (!indicaciones || indicaciones.length > 128) {
            await this.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                'Por favor envía una indicación válida (máximo 128 caracteres). 📝',
            );
            return;
        }

        // Guardamos las indicaciones en el carrito como contexto temporal.
        const carrito: any[] = Array.isArray(conversacion.carrito) ? (conversacion.carrito as any[]) : [];
        const sinContexto = carrito.filter((x) => x?._contexto !== 'repartidor');
        sinContexto.push({ _contexto: 'repartidor', indicaciones });
        conversacion.carrito = sinContexto as any;

        await this.enviarBotones(
            mensaje.numeroWhatsappOrigen,
            [
                '¡Perfecto! 🛵 Estas son las indicaciones que nos diste para el repartidor:',
                '',
                `📝 *${indicaciones}*`,
                '',
                '¿Confirmas que son correctas?',
            ].join('\n'),
            'Selecciona la opción que necesitas',
            [
                { id: 'confirmar_indicaciones_si', texto: 'Sí, confirmar' },
                { id: 'confirmar_indicaciones_no', texto: 'No, corregir' },
                { id: 'cambiar_tipo_pedido', texto: 'Cambiar tipo pedido' },
            ],
        );

        conversacion.nodoActual = 'confirmar_indicaciones';
        await this.repoConversacion.save(conversacion);
    }

    // Confirmación de indicaciones: SI busca sucursal, NO reintenta, cambiar_tipo vuelve atrás.
    private async manejarConfirmarIndicaciones(
        mensaje: MensajeEntranteWhatsappNormalizado,
        conversacion: WhatsAppConversacionEntity,
    ): Promise<void> {
        if (mensaje.idBotonPresionado === 'confirmar_indicaciones_si') {
            await this.iniciarAsignacionSucursal(mensaje.numeroWhatsappOrigen, conversacion);
            return;
        }

        if (mensaje.idBotonPresionado === 'confirmar_indicaciones_no') {
            await this.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                'Entendido 😊 Envíanos nuevamente tu dirección escrita (máximo 128 caracteres).',
            );
            conversacion.nodoActual = 'esperando_indicaciones_repartidor';
            await this.repoConversacion.save(conversacion);
            return;
        }

        if (mensaje.idBotonPresionado === 'cambiar_tipo_pedido') {
            await this.enviarMenuTipoPedido(mensaje.numeroWhatsappOrigen);
            conversacion.nodoActual = 'seleccionar_tipo_pedido';
            await this.repoConversacion.save(conversacion);
            return;
        }

        await this.enviarTexto(
            mensaje.numeroWhatsappOrigen,
            'Por favor sigue el flujo para continuar con tu compra. 👨‍🍳🍕',
        );
    }

    // Nodo de espera cuando la sucursal más cercana no tiene servicio a domicilio.
    private async manejarConfirmacionSucursalSinServicio(
        mensaje: MensajeEntranteWhatsappNormalizado,
        conversacion: WhatsAppConversacionEntity,
    ): Promise<void> {
        if (mensaje.idBotonPresionado === 'continuar_igual') {
            // El cliente acepta continuar aunque la sucursal no tenga domicilio habilitado.
            const sucursal = this.obtenerSucursalGuardadaDelCarrito(conversacion.carrito as any[]);
            if (sucursal) {
                await this.enviarResumenSucursalAsignada(
                    mensaje.numeroWhatsappOrigen,
                    sucursal,
                    'continua_sin_domicilio',
                );
                await this.enviarLinkCatalogo(mensaje.numeroWhatsappOrigen, sucursal);
            } else {
                // Caso defensivo: si no hay sucursal en carrito por algún motivo, reiniciamos búsqueda.
                await this.iniciarAsignacionSucursal(mensaje.numeroWhatsappOrigen, conversacion);
            }
            return;
        }

        if (mensaje.idBotonPresionado === 'hablar_agente') {
            await this.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                [
                    '¡Con gusto! 🙌 Uno de nuestros representantes te atenderá enseguida.',
                    '',
                    `📞 Puedes comunicarte directamente al: *${TELEFONO_AGENTE}*`,
                    '',
                    'También puedes escribir *menu* para volver al inicio cuando quieras. 😊',
                ].join('\n'),
            );
            return;
        }

        if (mensaje.idBotonPresionado === 'cambiar_tipo_pedido') {
            await this.enviarMenuTipoPedido(mensaje.numeroWhatsappOrigen);
            conversacion.nodoActual = 'seleccionar_tipo_pedido';
            await this.repoConversacion.save(conversacion);
            return;
        }

        await this.enviarTexto(
            mensaje.numeroWhatsappOrigen,
            'Por favor selecciona una de las opciones disponibles. 😊',
        );
    }

    // ─── LÓGICA DE ASIGNACIÓN DE SUCURSAL ────────────────────────────────────────

    // Orquesta la búsqueda de sucursal más cercana y verifica el servicio de domicilio.
    private async iniciarAsignacionSucursal(
        numeroDestino: string,
        conversacion: WhatsAppConversacionEntity,
    ): Promise<void> {
        await this.enviarTexto(
            numeroDestino,
            '⏳ Dame un momento, te asignaremos la sucursal más cercana...',
        );

        // Extraemos las coordenadas guardadas cuando el cliente compartió su ubicación.
        const coordenadas = this.obtenerUbicacionDelCarrito(conversacion.carrito as any[]);

        if (!coordenadas) {
            // Si no hay coordenadas, algo salió mal en el flujo; volvemos a pedirlas.
            await this.enviarUbicacion(
                numeroDestino,
                'Necesitamos tu ubicación para asignarte una sucursal. Compártela nuevamente 📌',
            );
            conversacion.nodoActual = 'esperando_ubicacion_domicilio';
            await this.repoConversacion.save(conversacion);
            return;
        }

        const cache = this.tiendaInfo.obtenerInformacionTiendaEnCache();
        const sucursales = cache?.sucursales ?? [];

        const sucursalMasCercana = CoberturaDomicilioUtilidad.obtenerSucursalMasCercana(
            coordenadas.lat,
            coordenadas.lng,
            sucursales,
        );

        if (!sucursalMasCercana) {
            // No se encontró ninguna sucursal activa en el sistema.
            await this.enviarTexto(
                numeroDestino,
                [
                    '😔 Por el momento no tenemos sucursales disponibles para atenderte.',
                    '',
                    `Si necesitas ayuda, comunícate con nosotros al *${TELEFONO_AGENTE}* 📞`,
                ].join('\n'),
            );
            return;
        }

        // Verificamos si la sucursal más cercana ofrece servicio a domicilio.
        const tieneServicioDomicilio = sucursalMasCercana.servicios.some(
            (s) => s.toLowerCase().includes('domicilio'),
        );

        if (tieneServicioDomicilio) {
            // Mensaje de sucursal + horarios (formato clásico); luego CTA del menú con token JWT.
            await this.enviarResumenSucursalAsignada(
                numeroDestino,
                sucursalMasCercana,
                'domicilio_validado',
            );
            await this.enviarLinkCatalogo(numeroDestino, sucursalMasCercana);
            return;
        }

        // La sucursal existe pero no tiene servicio a domicilio; preguntamos al cliente qué hacer.
        // Guardamos la sucursal en el carrito para recuperarla si el cliente decide continuar.
        const carrito: any[] = Array.isArray(conversacion.carrito) ? (conversacion.carrito as any[]) : [];
        const sinContexto = carrito.filter((x) => x?._contexto !== 'sucursal_asignada');
        sinContexto.push({
            _contexto: 'sucursal_asignada',
            sucursalId: sucursalMasCercana.id_ofisistema,
            nombre: sucursalMasCercana.nombre,
            sucursal: sucursalMasCercana,
        });
        conversacion.carrito = sinContexto as any;

        await this.enviarBotones(
            numeroDestino,
            [
                `😔 Lo sentimos, la sucursal más cercana a tu ubicación es *${sucursalMasCercana.nombre}*,`,
                'pero actualmente *no ofrece servicio a domicilio* en tu zona.',
                '',
                '¿Qué deseas hacer?',
            ].join('\n'),
            'Selecciona una opción para continuar.',
            [
                { id: 'continuar_igual', texto: 'Continuar de todas formas' },
                { id: 'hablar_agente', texto: 'Hablar con alguien' },
                { id: 'cambiar_tipo_pedido', texto: 'Cambiar tipo de pedido' },
            ],
        );

        conversacion.nodoActual = 'esperando_confirmacion_sucursal';
        await this.repoConversacion.save(conversacion);
    }

    // ─── HELPERS DE ENVÍO ─────────────────────────────────────────────────────────

    // Envía el menú principal con las opciones raíz del bot.
    private async enviarMenuPrincipal(numeroDestino: string): Promise<void> {
        await this.enviarBotones(
            numeroDestino,
            'Selecciona una de las siguientes opciones 👇🏼',
            'En cualquier momento puedes regresar al menú enviando *menu*',
            [
                { id: 'hacer_pedido', texto: 'Hacer pedido' },
                { id: 'otras_opciones', texto: 'Otras opciones' },
            ],
        );
    }

    // Envía el submenú "Otras opciones" con las opciones extras disponibles.
    private async enviarOtrasOpciones(numeroDestino: string): Promise<void> {
        await this.enviarBotones(
            numeroDestino,
            'Selecciona una de las siguientes opciones extras 👇🏼',
            'En cualquier momento puedes regresar al menú enviando *menu*',
            [{ id: 'ver_restaurantes', texto: 'Restaurantes' }],
        );
    }

    // Envía el menú de selección de tipo de pedido (domicilio o retiro).
    private async enviarMenuTipoPedido(numeroDestino: string): Promise<void> {
        await this.enviarBotones(
            numeroDestino,
            [
                'Elige tu tipo de pedido y su forma de pago aceptada.',
                '',
                '      - *A Domicilio* : efectivo 🛵',
                '',
                '      - *Retiro Local* : efectivo 🚶🏻‍♂️',
            ].join('\n'),
            'Selecciona una opción',
            [
                { id: 'a_domicilio', texto: 'A Domicilio' },
                { id: 'retiro_local', texto: 'Retiro Local' },
            ],
        );
    }

    // Consolida todas las sucursales activas en un único mensaje interactivo con botón Menú.
    // La URL de Google Maps va en el body como texto plano para que WhatsApp la convierta en hipervínculo.
    // Meta limita el body a 1024 caracteres; si el listado excede ese límite se trunca con aviso.
    private async enviarSucursalesConMapa(
        numeroDestino: string,
        sucursales: WhatsappSucursalMenuItem[],
    ): Promise<void> {
        const activas = sucursales.filter((s) => s.estado);

        if (!activas.length) {
            await this.enviarTexto(
                numeroDestino,
                '😔 Por el momento no tenemos sucursales disponibles. Intenta más tarde.',
            );
            return;
        }

        const LIMITE_BODY = 1024;
        const SEPARADOR = '\n\n━━━━━━━━━━━━\n\n';

        const bloques = activas.map((sucursal) => {
            const horarios = this.formatearTurnos(sucursal.turnos);
            return [
                `🏪 *${sucursal.nombre}*`,
                `🕐 ${horarios}`,
                sucursal.localizacion,
            ].join('\n');
        });

        let body = bloques.join(SEPARADOR);

        if (body.length > LIMITE_BODY) {
            // Truncamos al último bloque completo que quepa dentro del límite de Meta.
            body = body.slice(0, LIMITE_BODY - 30) + '\n\n_(Ver más sucursales en tienda)_';
        }

        await this.enviarBotones(
            numeroDestino,
            body,
            // Footer limitado a 60 chars por la doc de Meta.
            'Si deseas algo más, puedes seleccionar Menú',
            [{ id: 'volver_otras_opciones', texto: 'Menú' }],
        );
    }

    /**
     * Texto de sucursal asignada: título "¡Listo!", nombre y bloque Horarios en líneas separadas (como en el flujo original).
     */
    private async enviarResumenSucursalAsignada(
        numeroDestino: string,
        sucursal: WhatsappSucursalConDistanciaKm,
        variante: 'domicilio_validado' | 'continua_sin_domicilio',
    ): Promise<void> {
        const horarios = this.formatearTurnos(sucursal.turnos);

        if (variante === 'domicilio_validado') {
            await this.enviarTexto(
                numeroDestino,
                [
                    '🎉 ¡Listo! La sucursal que te atenderá es:',
                    '',
                    `🏪 *${sucursal.nombre}*`,
                    '',
                    '🕐 *Horarios:*',
                    horarios,
                ].join('\n'),
            );
            return;
        }

        await this.enviarTexto(
            numeroDestino,
            [
                '⚠️ Seguimos con tu pedido.',
                '',
                `🏪 *${sucursal.nombre}*`,
                'Esta sucursal no tiene domicilio; acordaste continuar igual.',
                '',
                '🕐 *Horarios:*',
                horarios,
            ].join('\n'),
        );
    }

    /**
     * Abre URL_MENU_CLIENTE con query `token` (JWT: cliente, tipo entrega domicilio, sucursal).
     */
    private async enviarLinkCatalogo(
        numeroDestino: string,
        sucursal: WhatsappSucursalConDistanciaKm,
    ): Promise<void> {
        await this.enviarEnlaceMenuConJwt(numeroDestino, sucursal.nombre.trim(), 'domicilio');
    }

    /**
     * Genera JWT de menú y envía el CTA "Nuestro Menú" (misma UX que el flujo de asignación de sucursal).
     */
    private async enviarEnlaceMenuConJwt(
        numeroDestino: string,
        nombreSucursal: string,
        tipoEntrega: string,
    ): Promise<void> {
        const cliente = await this.repoCliente.findOne({
            where: { numeroWhatsapp: numeroDestino },
        });
        if (!cliente) {
            this.logger.warn(`enviarEnlaceMenuConJwt: sin cliente para ${numeroDestino}`);
            await this.enviarTexto(
                numeroDestino,
                'No pudimos generar tu enlace al menú. Escribe *menu* para reintentar.',
            );
            return;
        }

        let token: string;
        try {
            token = await this.menuClienteJwt.crearTokenMenuCliente({
                clienteId: String(cliente.idCliente),
                tipoEntrega: tipoEntrega.trim(),
                nombreSucursal: nombreSucursal.trim(),
            });
        } catch (err) {
            this.logger.error(
                `Fallo al firmar JWT de menú: ${err instanceof Error ? err.message : err}`,
            );
            await this.enviarTexto(
                numeroDestino,
                'No pudimos generar tu enlace al menú en este momento. Escribe *menu* más tarde.',
            );
            return;
        }

        const base = this.config.getOrThrow<string>('URL_MENU_CLIENTE').trim().replace(/\/+$/, '');
        const urlMenu = `${base}?token=${encodeURIComponent(token)}`;

        await this.enviarCtaUrl(
            numeroDestino,
            [
                '🍕 ¡Explora nuestro menú y elige tus combos favoritos al mejor precio!',
                '',
                'Toca el botón para ver todas nuestras opciones 👇🏼',
            ].join('\n'),
            'Recuerda regresar a la conversación.',
            'Nuestro Menú',
            urlMenu,
        );
    }

    // ─── HELPERS DE FORMATO ───────────────────────────────────────────────────────

    // Convierte los turnos de una sucursal en texto de una sola línea compacta.
    // Ej: [{ dias:[1,2,3], horaInicial:"10:00", horaFinal:"22:00" }] → "Lun - Mié: 10:00 - 22:00"
    private formatearTurnos(turnos: WhatsappTurnoSucursal[]): string {
        if (!turnos.length) return 'Horario no disponible';

        return turnos
            .map((turno) => {
                const diasOrdenados = [...turno.dias].sort((a, b) => a - b);
                const rangosDias = this.diasATexto(diasOrdenados);
                return `${rangosDias}: ${turno.horaInicial} - ${turno.horaFinal}`;
            })
            .join(' | ');
    }

    // Convierte un array de números de día a texto con rangos compactos.
    // Ej: [1,2,3,5] → "Lun - Mié, Vie"
    private diasATexto(dias: number[]): string {
        if (!dias.length) return '';

        const grupos: number[][] = [];
        let grupoActual: number[] = [dias[0]!];

        for (let i = 1; i < dias.length; i++) {
            // Si el día siguiente es consecutivo, lo añadimos al grupo actual.
            if (dias[i] === dias[i - 1]! + 1) {
                grupoActual.push(dias[i]!);
            } else {
                grupos.push(grupoActual);
                grupoActual = [dias[i]!];
            }
        }
        grupos.push(grupoActual);

        return grupos
            .map((grupo) => {
                if (grupo.length === 1) return NOMBRES_DIAS[grupo[0]!] ?? `D${grupo[0]}`;
                const primero = NOMBRES_DIAS[grupo[0]!] ?? `D${grupo[0]}`;
                const ultimo = NOMBRES_DIAS[grupo[grupo.length - 1]!] ?? `D${grupo[grupo.length - 1]}`;
                return `${primero} - ${ultimo}`;
            })
            .join(' | ');
    }

    // ─── HELPERS DE CARRITO ───────────────────────────────────────────────────────

    // Extrae las coordenadas de domicilio guardadas en el carrito al compartir la ubicación.
    private obtenerUbicacionDelCarrito(carrito: any[]): { lat: number; lng: number } | null {
        if (!Array.isArray(carrito)) return null;
        const item = carrito.find((x) => x?._contexto === 'domicilio');
        const ubicacion = item?.ubicacion;
        if (!ubicacion || !Number.isFinite(ubicacion.lat) || !Number.isFinite(ubicacion.lng)) {
            return null;
        }
        return { lat: ubicacion.lat, lng: ubicacion.lng };
    }

    // Extrae la sucursal guardada en el carrito cuando la sucursal más cercana no tiene domicilio.
    private obtenerSucursalGuardadaDelCarrito(carrito: any[]): WhatsappSucursalConDistanciaKm | null {
        if (!Array.isArray(carrito)) return null;
        const item = carrito.find((x) => x?._contexto === 'sucursal_asignada');
        return item?.sucursal ?? null;
    }

    // Contexto guardado cuando el front llama a notificar-carrito: permite reemitir el JWT al tocar "Modificar".
    private obtenerContextoMenuWebDelCarrito(
        carrito: unknown[],
    ): { nombreSucursal: string; tipoEntrega: string } | null {
        if (!Array.isArray(carrito)) {
            return null;
        }
        const item = carrito.find((x: any) => x?._contexto === 'menu_web_activo') as
            | { nombreSucursal?: string; tipoEntrega?: string }
            | undefined;
        const nombre = item?.nombreSucursal?.trim() ?? '';
        const tipo = item?.tipoEntrega?.trim() ?? '';
        if (!nombre || !tipo) {
            return null;
        }
        return { nombreSucursal: nombre, tipoEntrega: tipo };
    }

    // ─── HELPERS DE PERSISTENCIA ─────────────────────────────────────────────────

    // Busca o crea el cliente y su conversación activa en base de datos.
    private async asegurarClienteYConversacion(numeroWhatsapp: string): Promise<{
        cliente: WhatsAppClienteEntity;
        conversacion: WhatsAppConversacionEntity;
    }> {
        let cliente = await this.repoCliente.findOne({ where: { numeroWhatsapp } });
        if (!cliente) {
            cliente = await this.repoCliente.save(
                this.repoCliente.create({
                    numeroWhatsapp,
                    nombre: null,
                    shopifyClienteId: null,
                    activo: true,
                }),
            );
        }

        let conversacion = await this.repoConversacion.findOne({
            where: { cliente: { idCliente: cliente.idCliente } } as any,
            relations: { cliente: true } as any,
        });

        if (!conversacion) {
            const creada = await this.repoConversacion.save(
                this.repoConversacion.create({
                    cliente,
                    tipoFlujo: cliente.shopifyClienteId ? 'segunda_compra' : 'primera_compra',
                    nodoActual: 'menu_principal',
                    carrito: [],
                    activo: true,
                } as any),
            );
            conversacion = Array.isArray(creada) ? creada[0]! : creada;
        }

        if (!conversacion) {
            throw new Error('No se pudo crear u obtener la conversación de WhatsApp');
        }

        return { cliente, conversacion };
    }

    // Renueva la expiración de la conversación (ventana de 2 horas).
    // Si la conversación ya expiró, reinicia el carrito y vuelve al menú principal.
    // Es sincrónica porque solo muta el objeto en memoria; el .save() lo hace el llamador.
    private renovarConversacion(conversacion: WhatsAppConversacionEntity): void {
        const ahora = new Date();
        const expira = new Date(conversacion.expiraEn);

        if (ahora.getTime() > expira.getTime()) {
            // Conversación expirada: limpiamos estado para una experiencia fresca.
            conversacion.carrito = [] as any;
            conversacion.nodoActual = 'menu_principal';
        }

        conversacion.ultimaActividad = ahora;
        conversacion.expiraEn = new Date(ahora.getTime() + 2 * 60 * 60 * 1000);
    }

    // ─── FAÇADES DE ENVÍO CON INDICADOR DE ESCRITURA ─────────────────────────────

    // Muestra el indicador de escritura antes de enviar un mensaje de texto.
    // Esto da sensación de respuesta humana entre mensajes consecutivos.
    private async enviarTexto(numeroDestino: string, texto: string): Promise<void> {
        await this.whatsapp.mostrarIndicadorEscritura(this.idMensajeActual);
        await this.whatsapp.enviarTexto(numeroDestino, texto);
    }

    // Muestra el indicador de escritura antes de enviar un mensaje con botones.
    private async enviarBotones(
        numeroDestino: string,
        body: string,
        footer: string,
        botones: Array<{ id: string; texto: string }>,
    ): Promise<void> {
        await this.whatsapp.mostrarIndicadorEscritura(this.idMensajeActual);
        await this.whatsapp.enviarMensajeBotones(numeroDestino, body, footer, botones);
    }

    // Muestra el indicador de escritura antes de enviar un mensaje CTA URL.
    private async enviarCtaUrl(
        numeroDestino: string,
        body: string,
        footer: string,
        textoBoton: string,
        urlBoton: string,
    ): Promise<void> {
        await this.whatsapp.mostrarIndicadorEscritura(this.idMensajeActual);
        await this.whatsapp.enviarMensajeCtaUrl(numeroDestino, body, footer, textoBoton, urlBoton);
    }

    // Muestra el indicador de escritura antes de enviar una solicitud de ubicación.
    private async enviarUbicacion(numeroDestino: string, textoCuerpo: string): Promise<void> {
        await this.whatsapp.mostrarIndicadorEscritura(this.idMensajeActual);
        await this.whatsapp.enviarSolicitudUbicacion(numeroDestino, textoCuerpo);
    }
}
