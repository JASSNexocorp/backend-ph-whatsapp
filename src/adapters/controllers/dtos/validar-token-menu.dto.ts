import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Cuerpo de POST /tienda/validar-token: el front reenvía el JWT recibido en el enlace.
 */
export class ValidarTokenMenuDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(8192)
    token: string;
}
