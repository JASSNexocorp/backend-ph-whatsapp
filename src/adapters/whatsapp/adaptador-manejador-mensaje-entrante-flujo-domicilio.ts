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
import { ShopifyCrearOrdenService } from "src/infrastructure/shopify/shopify-crear-orden.service";
import { OfisistemaCrearOrdenService } from "src/infrastructure/shopify/ofisistema-crear-orden.service";

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
    | 'esperando_confirmacion_sucursal'
    // Recolección de datos del cliente (primer pedido o edición desde Otras opciones).
    | 'esperando_nombre_cliente'
    | 'esperando_email_cliente'
    | 'esperando_razon_social'
    | 'esperando_nit'
    // Confirmación de datos existentes (clientes con pedidos anteriores).
    | 'confirmando_datos_cliente'
    // Selección de pago y confirmación final antes de crear la orden.
    | 'seleccionando_metodo_pago'
    | 'confirmando_pedido_final';

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
        private readonly shopifyCrearOrden: ShopifyCrearOrdenService,
        private readonly ofisistemaCrearOrden: OfisistemaCrearOrdenService,
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
        // El nodo inicio envía imagen de bienvenida (primer contacto del usuario).
        if (nodo === 'inicio') {
            await this.enviarBienvenidaConMenu(mensaje.numeroWhatsappOrigen);
            conversacion.nodoActual = 'menu_principal';
            await this.repoConversacion.save(conversacion);
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

        // Nodos del flujo de recolección de datos y confirmación de orden.
        if (nodo === 'esperando_nombre_cliente') {
            await this.manejarEsperandoNombreCliente(mensaje, conversacion);
            return;
        }
        if (nodo === 'esperando_email_cliente') {
            await this.manejarEsperandoEmailCliente(mensaje, conversacion);
            return;
        }
        if (nodo === 'esperando_razon_social') {
            await this.manejarEsperandoRazonSocial(mensaje, conversacion);
            return;
        }
        if (nodo === 'esperando_nit') {
            await this.manejarEsperandoNit(mensaje, conversacion);
            return;
        }
        if (nodo === 'confirmando_datos_cliente') {
            await this.manejarConfirmandoDatosCliente(mensaje, conversacion);
            return;
        }
        if (nodo === 'seleccionando_metodo_pago') {
            await this.manejarSeleccionandoMetodoPago(mensaje, conversacion);
            return;
        }
        if (nodo === 'confirmando_pedido_final') {
            await this.manejarConfirmandoPedidoFinal(mensaje, conversacion);
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
            // Arrancamos el flujo de datos: pide email o muestra datos existentes.
            await this.iniciarFlujoConfirmacion(numero, conversacion);
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
            await this.enviarMenuPrincipal(mensaje.numeroWhatsappOrigen);
            conversacion.nodoActual = 'menu_principal';
            await this.repoConversacion.save(conversacion);
            return;
        }

        if (mensaje.idBotonPresionado === 'modificar_datos') {
            // Flujo de edición de datos desde Otras opciones: empezamos por el nombre.
            const cliente = await this.repoCliente.findOne({
                where: { numeroWhatsapp: mensaje.numeroWhatsappOrigen },
            });
            await this.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                [
                    '📝 Vamos a actualizar tus datos.',
                    '',
                    `Tu nombre actual es: *${cliente?.nombre ?? 'No registrado'}*`,
                    '',
                    'Escribe tu *nombre completo* para actualizarlo, o escribe *menu* para cancelar.',
                ].join('\n'),
            );
            const carrito: any[] = Array.isArray(conversacion.carrito) ? [...(conversacion.carrito as any[])] : [];
            const sinContexto = carrito.filter((x) => x?._contexto !== 'origen_recoleccion');
            // Guardamos el origen para que después del NIT volvamos al menú (no al pedido).
            sinContexto.push({ _contexto: 'origen_recoleccion', valor: 'editar_datos' });
            conversacion.carrito = sinContexto as any;
            conversacion.nodoActual = 'esperando_nombre_cliente';
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
            // Si el cliente nunca dio su nombre, lo pedimos antes de la ubicación.
            const cliente = await this.repoCliente.findOne({
                where: { numeroWhatsapp: mensaje.numeroWhatsappOrigen },
            });
            if (!cliente?.nombre) {
                await this.enviarTexto(
                    mensaje.numeroWhatsappOrigen,
                    [
                        'Te solicitaremos 3 datos para la toma de tu pedido.',
                        '',
                        'Para poder tomar tu orden escribe únicamente tu *nombre completo*.',
                        '',
                        'Ejemplo: _José Sahonero_',
                    ].join('\n'),
                );
                // Guardamos el origen para saber que después del nombre vamos a la ubicación.
                const carrito: any[] = Array.isArray(conversacion.carrito) ? [...(conversacion.carrito as any[])] : [];
                const sinContexto = carrito.filter((x) => x?._contexto !== 'origen_recoleccion');
                sinContexto.push({ _contexto: 'origen_recoleccion', valor: 'pre_pedido' });
                conversacion.carrito = sinContexto as any;
                conversacion.nodoActual = 'esperando_nombre_cliente';
                await this.repoConversacion.save(conversacion);
                return;
            }
            await this.solicitarUbicacionDomicilio(mensaje.numeroWhatsappOrigen, conversacion);
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

    // Envía el submenú "Otras opciones": restaurantes y edición de datos personales.
    private async enviarOtrasOpciones(numeroDestino: string): Promise<void> {
        await this.enviarBotones(
            numeroDestino,
            'Selecciona una de las siguientes opciones extras 👇🏼',
            'En cualquier momento puedes regresar al menú enviando *menu*',
            [
                { id: 'ver_restaurantes', texto: 'Restaurantes' },
                { id: 'modificar_datos', texto: 'Mis datos' },
            ],
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

        // ─── NUEVOS MÉTODOS: BIENVENIDA CON IMAGEN ────────────────────────────────────

    // Envía la imagen de bienvenida (si está configurada) seguida del menú principal.
    // Se usa en el primer contacto (nodo inicio) y cuando el usuario escribe "menu".
    private async enviarBienvenidaConMenu(numeroDestino: string): Promise<void> {
        const urlImagen = this.config.get<string>('URL_IMAGEN_BIENVENIDA')?.trim() ?? '';
        if (urlImagen) {
            await this.whatsapp.mostrarIndicadorEscritura(this.idMensajeActual);
            await this.whatsapp.enviarImagenPorURL(
                numeroDestino,
                urlImagen,
                '¡Hola! Bienvenid@ a pedidos Pizza Hut 🍕',
            );
        }
        await this.enviarMenuPrincipal(numeroDestino);
    }

    // ─── HELPER: SOLICITAR UBICACIÓN DOMICILIO ────────────────────────────────────

    // Envía el mensaje de solicitud de ubicación y avanza el nodo a esperando_ubicacion_domicilio.
    // Extraído como método para reutilizarlo desde la selección de tipo pedido y desde el nombre.
    private async solicitarUbicacionDomicilio(
        numeroDestino: string,
        conversacion: WhatsAppConversacionEntity,
    ): Promise<void> {
        await this.enviarUbicacion(
            numeroDestino,
            [
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
    }

    // ─── NUEVOS NODOS: RECOLECCIÓN DE DATOS ──────────────────────────────────────

    // Inicia el flujo de confirmación cuando el cliente presiona "Confirmar" en el carrito web.
    // Primera vez (sin email): recolecta email → razón social → NIT → pago.
    // Retorno (con email): muestra datos actuales con botones SI/NO.
    private async iniciarFlujoConfirmacion(
        numeroDestino: string,
        conversacion: WhatsAppConversacionEntity,
    ): Promise<void> {
        const cliente = await this.repoCliente.findOne({
            where: { numeroWhatsapp: numeroDestino },
        });

        if (!cliente) {
            await this.enviarTexto(
                numeroDestino,
                '❌ No pudimos encontrar tu perfil. Escribe *menu* para reintentar.',
            );
            return;
        }

        // Marcamos el origen como pre_pedido para que los handlers sepan adónde ir luego del NIT.
        const carrito: any[] = Array.isArray(conversacion.carrito) ? [...(conversacion.carrito as any[])] : [];
        const sinContexto = carrito.filter((x) => x?._contexto !== 'origen_recoleccion');
        sinContexto.push({ _contexto: 'origen_recoleccion', valor: 'pre_pedido' });
        conversacion.carrito = sinContexto as any;

        if (!cliente.email) {
            // Primera vez: pedimos email (el nombre ya fue recolectado al elegir domicilio).
            await this.enviarTexto(
                numeroDestino,
                [
                    '📧 Necesitamos algunos datos para tu factura.',
                    '',
                    'Escribe tu *correo electrónico*:',
                    '',
                    'Ejemplo: _tuemail@gmail.com_',
                ].join('\n'),
            );
            conversacion.nodoActual = 'esperando_email_cliente';
            await this.repoConversacion.save(conversacion);
            return;
        }

        // Segunda vez o más: mostramos sus últimos datos con botones para confirmar o editar.
        await this.enviarBotones(
            numeroDestino,
            [
                '📋 Estos son tus últimos datos de facturación:',
                '',
                `📧 *Email:* ${cliente.email}`,
                `🏢 *Razón Social:* ${cliente.razonSocial ?? 'No especificada'}`,
                `🔢 *NIT:* ${cliente.nit ?? '0'}`,
                '',
                '¿Continuar con estos datos?',
            ].join('\n'),
            'Podés editarlos seleccionando NO.',
            [
                { id: 'datos_cliente_si', texto: 'Sí, continuar' },
                { id: 'datos_cliente_no', texto: 'No, editar' },
            ],
        );
        conversacion.nodoActual = 'confirmando_datos_cliente';
        await this.repoConversacion.save(conversacion);
    }

    // Captura el nombre del cliente, lo guarda en BD y avanza según el origen del flujo.
    private async manejarEsperandoNombreCliente(
        mensaje: MensajeEntranteWhatsappNormalizado,
        conversacion: WhatsAppConversacionEntity,
    ): Promise<void> {
        if (mensaje.tipo !== 'texto') {
            await this.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                'Por favor escribe tu nombre como texto. 📝',
            );
            return;
        }

        const nombre = (mensaje.textoPlano ?? '').trim();
        if (!nombre || nombre.length < 2 || nombre.length > 100) {
            await this.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                'Por favor escribe un nombre válido (entre 2 y 100 caracteres). 📝',
            );
            return;
        }

        // Persistimos el nombre en la entidad del cliente en base de datos.
        const cliente = await this.repoCliente.findOne({
            where: { numeroWhatsapp: mensaje.numeroWhatsappOrigen },
        });
        if (cliente) {
            cliente.nombre = nombre;
            await this.repoCliente.save(cliente);
        }

        const origen = this.obtenerOrigenRecoleccion(conversacion.carrito as any[]);

        if (origen === 'editar_datos') {
            // Flujo de edición desde Otras opciones: continuamos con email.
            await this.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                [
                    `✅ Nombre actualizado a: *${nombre}*`,
                    '',
                    '📧 Ahora escribe tu *correo electrónico*:',
                ].join('\n'),
            );
            conversacion.nodoActual = 'esperando_email_cliente';
            await this.repoConversacion.save(conversacion);
            return;
        }

        // Flujo pre-pedido: el nombre ya está guardado, pedimos la ubicación.
        await this.enviarTexto(
            mensaje.numeroWhatsappOrigen,
            `✅ Gracias, *${nombre}*. Ahora compartinos tu ubicación.`,
        );
        await this.solicitarUbicacionDomicilio(mensaje.numeroWhatsappOrigen, conversacion);
    }

    // Captura y valida el email del cliente, lo guarda en BD y pide la razón social.
    private async manejarEsperandoEmailCliente(
        mensaje: MensajeEntranteWhatsappNormalizado,
        conversacion: WhatsAppConversacionEntity,
    ): Promise<void> {
        if (mensaje.tipo !== 'texto') {
            await this.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                'Por favor escribe tu correo electrónico como texto. 📧',
            );
            return;
        }

        const email = (mensaje.textoPlano ?? '').trim().toLowerCase();
        // Validación de formato de email con regex estándar.
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            await this.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                [
                    '❌ El correo que escribiste no parece válido.',
                    '',
                    'Por favor escríbelo nuevamente.',
                    'Ejemplo: _tuemail@gmail.com_',
                ].join('\n'),
            );
            return;
        }

        const cliente = await this.repoCliente.findOne({
            where: { numeroWhatsapp: mensaje.numeroWhatsappOrigen },
        });
        if (cliente) {
            cliente.email = email;
            await this.repoCliente.save(cliente);
        }

        await this.enviarTexto(
            mensaje.numeroWhatsappOrigen,
            [
                '✅ Email registrado.',
                '',
                '🏢 Ahora escribe tu *razón social* (o escribe *0* si no tenés):',
            ].join('\n'),
        );
        conversacion.nodoActual = 'esperando_razon_social';
        await this.repoConversacion.save(conversacion);
    }

    // Captura la razón social del cliente, la guarda en BD y pide el NIT.
    private async manejarEsperandoRazonSocial(
        mensaje: MensajeEntranteWhatsappNormalizado,
        conversacion: WhatsAppConversacionEntity,
    ): Promise<void> {
        if (mensaje.tipo !== 'texto') {
            await this.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                'Por favor escribe tu razón social como texto. 🏢',
            );
            return;
        }

        const entrada = (mensaje.textoPlano ?? '').trim();
        // '0' significa "sin razón social"; guardamos null en ese caso.
        const razonSocial = entrada === '0' ? null : entrada.slice(0, 255);

        const cliente = await this.repoCliente.findOne({
            where: { numeroWhatsapp: mensaje.numeroWhatsappOrigen },
        });
        if (cliente) {
            cliente.razonSocial = razonSocial;
            await this.repoCliente.save(cliente);
        }

        await this.enviarTexto(
            mensaje.numeroWhatsappOrigen,
            [
                '✅ Razón social registrada.',
                '',
                '🔢 Finalmente, escribe tu *NIT* (o escribe *0* si no tenés):',
            ].join('\n'),
        );
        conversacion.nodoActual = 'esperando_nit';
        await this.repoConversacion.save(conversacion);
    }

    // Captura el NIT del cliente, lo guarda en BD y avanza según el origen del flujo.
    private async manejarEsperandoNit(
        mensaje: MensajeEntranteWhatsappNormalizado,
        conversacion: WhatsAppConversacionEntity,
    ): Promise<void> {
        if (mensaje.tipo !== 'texto') {
            await this.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                'Por favor escribe tu NIT como texto. 🔢',
            );
            return;
        }

        const entrada = (mensaje.textoPlano ?? '').trim();
        const cliente = await this.repoCliente.findOne({
            where: { numeroWhatsapp: mensaje.numeroWhatsappOrigen },
        });
        if (cliente) {
            // '0' significa sin NIT; guardamos null para no confundir con un NIT real.
            cliente.nit = entrada === '0' ? null : entrada.slice(0, 50);
            await this.repoCliente.save(cliente);
        }

        const origen = this.obtenerOrigenRecoleccion(conversacion.carrito as any[]);

        if (origen === 'editar_datos') {
            // Flujo de edición terminó: informamos y volvemos al menú.
            await this.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                '✅ ¡Datos actualizados correctamente!',
            );
            await this.enviarMenuPrincipal(mensaje.numeroWhatsappOrigen);
            conversacion.nodoActual = 'menu_principal';
        } else {
            // Flujo pre-pedido: avanzamos a la selección de método de pago.
            await this.enviarMetodosPago(mensaje.numeroWhatsappOrigen);
            conversacion.nodoActual = 'seleccionando_metodo_pago';
        }

        await this.repoConversacion.save(conversacion);
    }

    // Procesa la respuesta del cliente sobre si sus datos de facturación son correctos.
    private async manejarConfirmandoDatosCliente(
        mensaje: MensajeEntranteWhatsappNormalizado,
        conversacion: WhatsAppConversacionEntity,
    ): Promise<void> {
        if (mensaje.idBotonPresionado === 'datos_cliente_si') {
            await this.enviarMetodosPago(mensaje.numeroWhatsappOrigen);
            conversacion.nodoActual = 'seleccionando_metodo_pago';
            await this.repoConversacion.save(conversacion);
            return;
        }

        if (mensaje.idBotonPresionado === 'datos_cliente_no') {
            // El cliente quiere cambiar sus datos: empezamos de nuevo por el email.
            await this.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                [
                    '📧 Escribe tu *correo electrónico* actualizado:',
                    '',
                    'Ejemplo: _tuemail@gmail.com_',
                ].join('\n'),
            );
            conversacion.nodoActual = 'esperando_email_cliente';
            await this.repoConversacion.save(conversacion);
            return;
        }

        await this.enviarTexto(
            mensaje.numeroWhatsappOrigen,
            'Por favor selecciona una de las opciones. 😊',
        );
    }

    // Registra el método de pago elegido y muestra el resumen final con totales para confirmar.
    private async manejarSeleccionandoMetodoPago(
        mensaje: MensajeEntranteWhatsappNormalizado,
        conversacion: WhatsAppConversacionEntity,
    ): Promise<void> {
        // Construimos los métodos válidos desde el cache para rechazar IDs de métodos deshabilitados.
        const cacheMetodos = this.tiendaInfo.obtenerInformacionTiendaEnCache()?.metodos_pago;
        const metodosValidos: string[] = [];
        if (!cacheMetodos || cacheMetodos.efectivo) metodosValidos.push('pago_efectivo');
        if (!cacheMetodos || cacheMetodos.tarjeta_credito) metodosValidos.push('pago_tarjeta');
        if (!cacheMetodos || cacheMetodos.qr) metodosValidos.push('pago_qr');
        // Fallback defensivo: si el cache está vacío y la lista queda en cero, aceptamos todos.
        const validos = metodosValidos.length > 0 ? metodosValidos : ['pago_efectivo', 'pago_tarjeta', 'pago_qr'];

        if (!mensaje.idBotonPresionado || !validos.includes(mensaje.idBotonPresionado)) {
            await this.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                'Por favor seleccioná un método de pago de las opciones. 💳',
            );
            await this.enviarMetodosPago(mensaje.numeroWhatsappOrigen);
            return;
        }

        const metodoPagoMap: Record<string, string> = {
            pago_efectivo: 'efectivo',
            pago_tarjeta: 'tarjeta',
            pago_qr: 'qr',
        };
        const metodoPago = metodoPagoMap[mensaje.idBotonPresionado]!;

        // Persistimos el método de pago en el carrito para leerlo al crear la orden.
        const carrito: any[] = Array.isArray(conversacion.carrito) ? [...(conversacion.carrito as any[])] : [];
        const sinMetodo = carrito.filter((x) => x?._contexto !== 'metodo_pago');
        sinMetodo.push({ _contexto: 'metodo_pago', metodo: metodoPago });
        conversacion.carrito = sinMetodo as any;

        // Leemos los montos guardados cuando el web notificó el carrito.
        const contextoPedido = this.obtenerContextoMenuWebCompleto(conversacion.carrito as any[]);
        const subtotal = contextoPedido?.resumenMontos?.subtotalProductos ?? 0;
        const costoEnvio = contextoPedido?.resumenMontos?.costoEnvio ?? 0;
        const total = contextoPedido?.resumenMontos?.total ?? 0;
        const etiquetaPago = metodoPago === 'efectivo' ? '💵 Efectivo' : metodoPago === 'tarjeta' ? '💳 Tarjeta' : '📱 QR';

        const lineas = [
            '🧾 *Resumen de tu pedido:*',
            '',
            `Subtotal: Bs ${subtotal.toFixed(2)}`,
            costoEnvio > 0 ? `Envío: Bs ${costoEnvio.toFixed(2)}` : null,
            `*Total: Bs ${total.toFixed(2)}*`,
            '',
            `Método de pago: ${etiquetaPago}`,
            '',
            '¿Confirmás tu pedido?',
        ].filter((l): l is string => l !== null);

        await this.enviarBotones(
            mensaje.numeroWhatsappOrigen,
            lineas.join('\n'),
            'Esta acción creará tu orden en el sistema.',
            [
                { id: 'pedido_confirmar_si', texto: 'Sí, confirmar' },
                { id: 'pedido_confirmar_no', texto: 'No, cancelar' },
            ],
        );

        conversacion.nodoActual = 'confirmando_pedido_final';
        await this.repoConversacion.save(conversacion);
    }

    // Procesa la confirmación final: SI → crea la orden, NO → vuelve al menú principal.
    private async manejarConfirmandoPedidoFinal(
        mensaje: MensajeEntranteWhatsappNormalizado,
        conversacion: WhatsAppConversacionEntity,
    ): Promise<void> {
        if (mensaje.idBotonPresionado === 'pedido_confirmar_si') {
            await this.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                '⏳ Procesando tu pedido, dame un momento...',
            );
            await this.ejecutarCreacionOrden(mensaje.numeroWhatsappOrigen, conversacion);
            return;
        }

        if (mensaje.idBotonPresionado === 'pedido_confirmar_no') {
            await this.enviarMenuPrincipal(mensaje.numeroWhatsappOrigen);
            conversacion.nodoActual = 'menu_principal';
            await this.repoConversacion.save(conversacion);
            return;
        }

        await this.enviarTexto(
            mensaje.numeroWhatsappOrigen,
            'Por favor seleccioná una de las opciones. 😊',
        );
    }

    // ─── CREACIÓN DE ORDEN ────────────────────────────────────────────────────────

    // Orquesta Shopify → fulfillment → OfiSistema → mensaje de éxito.
    // Solo Shopify es crítico: si falla, informa al cliente. Fulfillment y OfiSistema no bloquean.
    private async ejecutarCreacionOrden(
        numeroDestino: string,
        conversacion: WhatsAppConversacionEntity,
    ): Promise<void> {
        const cliente = await this.repoCliente.findOne({
            where: { numeroWhatsapp: numeroDestino },
        });
        if (!cliente) {
            await this.enviarTexto(
                numeroDestino,
                '❌ Error al procesar: no encontramos tu perfil. Escribe *menu* para reintentar.',
            );
            return;
        }

        const carritoActual = conversacion.carrito as any[];
        const contextoPedido = this.obtenerContextoMenuWebCompleto(carritoActual);
        const metodoPago = carritoActual.find((x: any) => x?._contexto === 'metodo_pago')?.metodo ?? 'efectivo';

        if (!contextoPedido?.datosOrden?.items?.length) {
            await this.enviarTexto(
                numeroDestino,
                '❌ No encontramos los productos de tu pedido. Escribe *menu* e intentá de nuevo.',
            );
            return;
        }

        // Derivamos el tipo de entrega: primero leemos el campo explícito, sino lo inferimos desde tipoEntrega del carrito.
        const tipoEntregaRaw = contextoPedido.tipoEntregaOrden ?? contextoPedido.tipoEntrega ?? 'domicilio';
        const tipoEntrega: 'DELIVERY' | 'PICKUP' =
            tipoEntregaRaw === 'PICKUP' || tipoEntregaRaw === 'retiro' || tipoEntregaRaw === 'retiro_local'
                ? 'PICKUP'
                : 'DELIVERY';

        // Si el frontend no envió los IDs de sucursal, los buscamos en la cache por nombre.
        // Esto evita que el frontend deba enviar datos que ya tenemos en el servidor.
        let locationId: string | null = contextoPedido.sucursalShopifyLocationId ?? null;
        let ofisistemaId: string | null = contextoPedido.sucursalOfisistemaId ?? null;

        if (!locationId || !ofisistemaId) {
            const nombreSucursal = (contextoPedido.nombreSucursal ?? '').toLowerCase();
            const cacheInfoTienda = this.tiendaInfo.obtenerInformacionTiendaEnCache();
            const sucursalEnCache = cacheInfoTienda?.sucursales.find(
                (s) => s.nombre.toLowerCase() === nombreSucursal,
            );
            if (sucursalEnCache) {
                // Solo sobreescribimos si el valor no vino del frontend.
                locationId = locationId ?? sucursalEnCache.id_shopify ?? null;
                ofisistemaId = ofisistemaId ?? sucursalEnCache.id_ofisistema ?? null;
            } else {
                this.logger.warn(
                    `Sucursal "${contextoPedido.nombreSucursal}" no encontrada en cache — se crea orden sin location/ofisistema ID`,
                );
            }
        }

        // FASE 1: Crear la orden en Shopify (operación crítica).
        const resultadoShopify = await this.shopifyCrearOrden.crearOrden({
            shopifyClienteId: cliente.shopifyClienteId ?? '',
            nombreCliente: cliente.nombre ?? 'Cliente',
            telefonoCliente: cliente.numeroWhatsapp,
            emailCliente: cliente.email ?? undefined,
            notaPedido: `${tipoEntrega === 'DELIVERY' ? 'Domicilio' : 'Retiro'} | Pago: ${metodoPago}`,
            costoEnvio: contextoPedido.resumenMontos?.costoEnvio ?? 0,
            tipoEntrega,
            metodoPago,
            datos: contextoPedido.datosOrden,
        });

        if (!resultadoShopify.exito) {
            this.logger.error(`Fallo al crear orden Shopify para ${numeroDestino}: ${resultadoShopify.error}`);
            await this.enviarTexto(
                numeroDestino,
                '❌ Hubo un problema al registrar tu pedido. Por favor intentá de nuevo o escribí *menu*.',
            );
            return;
        }

        // FASE 2: Mover el fulfillment a la sucursal correcta (no crítico).
        if (resultadoShopify.ordenId && locationId) {
            await this.shopifyCrearOrden.moverFulfillmentASucursal(
                resultadoShopify.ordenId,
                locationId,
            );
        }

        // FASE 3: Crear la orden en OfiSistema (no crítico).
        const resultadoOfisistema = await this.ofisistemaCrearOrden.crearOrden({
            shopifyOrdenNombre: resultadoShopify.ordenNombre ?? '',
            sucursalOfisistemaId: ofisistemaId ?? '0',
            tipoEntrega,
            metodoPago: metodoPago as 'efectivo' | 'tarjeta' | 'qr',
            nombreCliente: cliente.nombre ?? 'Cliente',
            apellidoCliente: '',
            telefonoCliente: cliente.numeroWhatsapp,
            emailCliente: cliente.email,
            nitCliente: cliente.nit,
            razonSocialCliente: cliente.razonSocial,
            precioTotal: contextoPedido.resumenMontos?.total ?? 0,
            costoEnvio: contextoPedido.resumenMontos?.costoEnvio ?? 0,
            datos: contextoPedido.datosOrden,
        });

        // FASE 4: Limpiar el carrito y volver al menú principal.
        const contextosPersistir = ['domicilio', 'repartidor', 'sucursal_asignada'];
        conversacion.carrito = (carritoActual.filter(
            (x: any) => contextosPersistir.includes(x?._contexto ?? ''),
        )) as any;
        conversacion.nodoActual = 'menu_principal';
        await this.repoConversacion.save(conversacion);

        // FASE 5: Enviar el mensaje de éxito con número de orden y link de OfiSistema.
        await this.enviarMensajeExitoPedido(
            numeroDestino,
            resultadoShopify.ordenNombre ?? '',
            resultadoOfisistema.linkSeguimiento,
        );
    }

    // Envía el mensaje final de confirmación exitosa con el número de orden y el link de seguimiento.
    private async enviarMensajeExitoPedido(
        numeroDestino: string,
        ordenNombre: string,
        linkSeguimiento?: string,
    ): Promise<void> {
        const cuerpo = [
            '🎉 *¡GRACIAS POR TU PREFERENCIA!*',
            '',
            'Tu pedido fue registrado exitosamente. 🍕',
            '',
            `📋 *Número de pedido:* ${ordenNombre}`,
            '',
            linkSeguimiento
                ? 'Podés rastrear el estado de tu pedido en el siguiente enlace 👇🏼'
                : 'En breve recibirás confirmación de tu pedido.',
        ].join('\n');

        const footer = 'Si deseás algo más, escribí *menu*.';

        if (linkSeguimiento) {
            // Si OfiSistema retornó un link, lo enviamos como botón CTA para mejor experiencia.
            await this.enviarCtaUrl(
                numeroDestino,
                cuerpo,
                footer,
                'Ver estado de tu pedido',
                linkSeguimiento,
            );
        } else {
            // Sin link: enviamos texto con botón Menú para continuar.
            await this.enviarBotones(
                numeroDestino,
                cuerpo,
                footer,
                [{ id: 'hacer_pedido', texto: 'Menú' }],
            );
        }
    }

    // Envía el mensaje de selección de método de pago mostrando solo los métodos habilitados en el JSON de configuración.
    private async enviarMetodosPago(numeroDestino: string): Promise<void> {
        // Leemos del cache para mostrar solo los métodos que están habilitados en el JSON de la tienda.
        const metodosConfig = this.tiendaInfo.obtenerInformacionTiendaEnCache()?.metodos_pago;

        const botones: Array<{ id: string; texto: string }> = [];
        // Solo se agrega cada botón si el método está habilitado (o si el campo no existe en el JSON).
        if (!metodosConfig || metodosConfig.efectivo) {
            botones.push({ id: 'pago_efectivo', texto: '💵 Efectivo' });
        }
        if (!metodosConfig || metodosConfig.tarjeta_credito) {
            botones.push({ id: 'pago_tarjeta', texto: '💳 Tarjeta' });
        }
        if (!metodosConfig || metodosConfig.qr) {
            botones.push({ id: 'pago_qr', texto: '📱 QR' });
        }

        // Fallback: si por error de configuración no quedó ningún método, mostramos los tres.
        if (botones.length === 0) {
            botones.push(
                { id: 'pago_efectivo', texto: '💵 Efectivo' },
                { id: 'pago_tarjeta', texto: '💳 Tarjeta' },
                { id: 'pago_qr', texto: '📱 QR' },
            );
        }

        await this.enviarBotones(
            numeroDestino,
            [
                '💳 Ya casi terminamos.',
                '',
                '¿Cuál es tu método de pago?',
            ].join('\n'),
            'Seleccioná una opción.',
            botones,
        );
    }

    // ─── HELPERS ADICIONALES DE CONTEXTO ─────────────────────────────────────────

    // Lee el contexto 'menu_web_activo' completo del carrito JSONB (con datosOrden y montos).
    private obtenerContextoMenuWebCompleto(carrito: any[]): any | null {
        if (!Array.isArray(carrito)) return null;
        return carrito.find((x) => x?._contexto === 'menu_web_activo') ?? null;
    }

    // Lee el origen del flujo de recolección de datos: 'pre_pedido' (orden) o 'editar_datos' (otras opciones).
    private obtenerOrigenRecoleccion(carrito: any[]): 'pre_pedido' | 'editar_datos' {
        if (!Array.isArray(carrito)) return 'pre_pedido';
        const ctx = carrito.find((x) => x?._contexto === 'origen_recoleccion');
        return ctx?.valor === 'editar_datos' ? 'editar_datos' : 'pre_pedido';
    }
}
