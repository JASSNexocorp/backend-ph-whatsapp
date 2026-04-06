import { Type } from 'class-transformer';
import {
    ArrayMinSize,
    IsArray,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
    ValidateNested,
} from 'class-validator';

/**
 * Opción elegida en el armador web (tamaño, masa, extras, etc.).
 * Los ids de sistema son opcionales: el resumen en WhatsApp usa solo textos legibles.
 */
export class CarritoOpcionNotificarDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(120)
    tituloSeccion: string;

    @IsString()
    @IsNotEmpty()
    @MaxLength(200)
    nombreOpcion: string;

    @IsOptional()
    @IsString()
    @MaxLength(64)
    idOfisistema?: string;
}

/**
 * Una línea del carrito tal como la arma el frontend antes de notificar por WhatsApp.
 */
export class CarritoLineaNotificarDto {
    @IsOptional()
    @IsString()
    @MaxLength(64)
    idOfisistema?: string;

    @IsOptional()
    @IsString()
    @MaxLength(64)
    idShopify?: string;

    @IsString()
    @IsNotEmpty()
    @MaxLength(300)
    nombre: string;

    @IsNumber()
    @Min(1)
    @Max(999)
    @Type(() => Number)
    cantidad: number;

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CarritoOpcionNotificarDto)
    opciones?: CarritoOpcionNotificarDto[];
}

/**
 * Cuerpo de POST /tienda/notificar-carrito: JWT de sesión de menú + totales y líneas del pedido.
 */
export class NotificarCarritoWhatsappDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(8192)
    token: string;

    @IsNumber()
    @Min(0)
    @Type(() => Number)
    subtotalProductos: number;

    @IsOptional()
    @IsNumber()
    @Min(0)
    @Type(() => Number)
    subtotalComparacion?: number;

    @IsNumber()
    @Min(0)
    @Type(() => Number)
    costoEnvio: number;

    @IsNumber()
    @Min(0)
    @Type(() => Number)
    total: number;

    @IsArray()
    @ArrayMinSize(1)
    @ValidateNested({ each: true })
    @Type(() => CarritoLineaNotificarDto)
    lineas: CarritoLineaNotificarDto[];
}
