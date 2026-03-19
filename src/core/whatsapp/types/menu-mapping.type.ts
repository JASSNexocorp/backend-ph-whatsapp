export type WhatsAppMenuMapping = {
  menu: {
    title: string;
    links: Array<{
      title: string;
      image: string;
    }>;
  };
  sucursales: Array<{
    id_publico: string;
    id: string;
    lat: number;
    lng: number;
    nombre: string;
    estado: boolean;
    servicios: string[];
    turnos: Array<{
      dias: number[];
      horaInicial: string;
      horaFinal: string;
    }>;
    telefono: string;
    backend: string;
    localizacion: string;
  }>;
  configuracion_carrito: {
    cantidad_minima: number;
    costo_envio_domicilio: number;
  };
};

