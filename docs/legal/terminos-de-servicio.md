# Términos de servicio

> **ESTO ES UN BORRADOR TÉCNICO.** Son los términos de uso de la
> plataforma Báscula entre el Operador y la Finca contratante. No
> reemplazan la revisión de un abogado colombiano antes de ponerlos
> en producción.

## 1. Partes y objeto

Estos términos regulan la relación entre:

- **El Operador:** [RAZÓN SOCIAL], NIT [NIT], con domicilio en
  [CIUDAD, COLOMBIA], que presta el servicio Báscula a través del
  dominio `*.bascula.engp.io`.

- **La Finca:** la persona natural o jurídica que registra una cuenta
  en la plataforma, declara sus datos de contacto y acepta estos
  términos durante el proceso de registro.

El Operador le concede a la Finca el derecho de usar la plataforma
Báscula para registrar la operación agrícola de la finca: jornales,
pagos, liquidaciones y la información que la plataforma soporta.

## 2. Registro y cuenta

El registro se realiza por auto-inscripción en la plataforma. La
Finca designa un usuario propietario (`farm owner`), que es el único
con privilegios totales sobre la cuenta. La Finca es responsable de
las acciones realizadas con sus credenciales y debe mantenerlas en
reserva.

El Operador puede, por su parte:

- Suspender la cuenta de la Finca por falta de pago, por uso que
  contravenga estos términos, o por orden de autoridad competente.
  La suspensión se registra en el sistema (`farms.suspended_at`) y
  deja la cuenta en modo de lectura.
- Rechazar un registro cuando existan indicios razonables de fraude.

## 3. Datos personales

El tratamiento de los datos personales de los trabajadores y de los
representantes de la Finca se rige por el **contrato de encargo del
tratamiento de datos personales**
([`dpa-encargo-tratamiento.md`](dpa-encargo-tratamiento.md)), que la
Finca acepta junto con estos términos y que es parte integral del
contrato principal.

En resumen operativo (el detalle técnico está en
[`docs/data-protection.md`](../data-protection.md)):

- La Finca es `Responsable del Tratamiento`; el Operador es
  `Encargado del Tratamiento`.
- El Operador no accede a los datos de los trabajadores salvo para
  tareas de operación o soporte expresamente solicitadas por la
  Finca.
- Los datos están aislados por finca mediante seguridad a nivel de
  fila (RLS) forzada en toda tabla con `farm_id`.

## 4. Pago

[DEFINIR POR EL OPERADOR: modelo de cobro (mensual por finca, por
trabajador activo, etc.), montos, impuestos, forma de facturación,
plazos de pago, consecuencias de la mora, moneda.]

La mora en el pago faculta al Operador a suspender la cuenta tras
notificación previa con al menos siete (7) días calendario de
anticipación.

## 5. Niveles de servicio

- **Disponibilidad objetivo.** [DEFINIR POR EL OPERADOR: por ejemplo,
  99,0% medido mensualmente, excluyendo mantenimientos anunciados.]
- **Ventanas de mantenimiento.** Anunciadas con al menos cuarenta y
  ocho (48) horas de anticipación, en lo posible fuera del horario
  laboral de las fincas.
- **Soporte.** [DEFINIR POR EL OPERADOR: canal, horario, tiempos de
  respuesta por severidad.]
- **Modo sin conexión.** La aplicación web funciona sin conexión en
  los dispositivos de los trabajadores de la finca; los datos se
  sincronizan al reconectar. El Operador recomienda ciclos de
  sincronización inferiores a ciento ochenta (180) días para
  conservar la sincronización incremental.

## 6. Seguridad

El Operador adopta las medidas descritas en
[`docs/data-protection.md`](../data-protection.md) y
[`docs/audits.md`](../audits.md):

- Aislamiento entre fincas por seguridad a nivel de fila (RLS)
  forzada en toda tabla con `farm_id`.
- Credenciales almacenadas con hash `argon2id`.
- Cifrado del canal (TLS).
- Respaldo continuo de la base de datos.
- Análisis de vulnerabilidades en el pipeline de integración continua
  (CodeQL, govulncheck, gitleaks).
- Canal privado de reporte de vulnerabilidades
  ([`SECURITY.md`](../../SECURITY.md)).

El Operador no garantiza la ausencia absoluta de incidentes de
seguridad. En caso de incidente, aplica el procedimiento de respuesta
descrito en [`docs/incident-response.md`](../incident-response.md) y
la obligación de notificación del numeral 8 del contrato de encargo.

## 7. Uso aceptable

La Finca se obliga a usar la plataforma de buena fe. No está
permitido:

- Usar la plataforma para fines ilícitos o contrarios al orden
  público.
- Introducir en la plataforma datos personales de personas distintas
  a sus trabajadores y a sus propios colaboradores, sin fundamento
  en la relación laboral o comercial correspondiente.
- Intentar vulnerar los controles de seguridad, salvo bajo los
  términos del canal de reporte de vulnerabilidades regulado en
  [`SECURITY.md`](../../SECURITY.md).
- Revender el servicio a terceros sin autorización escrita del
  Operador.
- Usar la plataforma para construir, directa o indirectamente, un
  servicio competitivo con Báscula.

## 8. Propiedad intelectual

El código fuente del servicio pertenece al Operador, bajo la licencia
declarada en el repositorio público. Los datos operativos y personales
de la Finca y de sus trabajadores pertenecen a la Finca; el Operador
sólo los procesa en calidad de `Encargado del Tratamiento`.

Las marcas, logotipos y signos distintivos de "Báscula" y del
Operador son propiedad del Operador. La Finca no adquiere derechos
sobre ellos por el solo hecho de usar la plataforma.

## 9. Exportación y portabilidad de datos

La Finca puede, en cualquier momento, exportar sus datos operativos
desde la plataforma. Al terminar el contrato, el Operador mantiene la
posibilidad de exportación durante **treinta (30) días calendario**,
tras los cuales suprime los datos de los sistemas de producción en
los términos del numeral 10 del contrato de encargo.

## 10. Terminación

Cualquiera de las partes puede terminar el contrato con un preaviso
escrito de **treinta (30) días calendario**. El Operador puede
terminarlo de inmediato por incumplimiento grave de la Finca,
notificándole y preservando el acceso de exportación durante los
treinta (30) días siguientes.

## 11. Limitación de responsabilidad

En la máxima medida permitida por la ley colombiana, el Operador no
responde por lucro cesante, daño emergente consecuencial, pérdida de
oportunidades de negocio, ni por decisiones operativas que la Finca
adopte con base en los datos de la plataforma. La responsabilidad
agregada del Operador por cualquier reclamo relacionado con este
contrato se limita a los valores pagados por la Finca al Operador en
los doce (12) meses anteriores al hecho que origina el reclamo.

Esta limitación **no aplica** a:

- las obligaciones del Operador bajo el contrato de encargo del
  tratamiento de datos personales;
- los incidentes de seguridad que le sean imputables por dolo o
  culpa grave;
- los demás supuestos en que la ley colombiana no permita
  limitación.

## 12. Modificación de los términos

El Operador puede modificar estos términos notificando a la Finca
con al menos **treinta (30) días calendario** de anticipación por el
canal interno de la plataforma y por correo electrónico. Si la Finca
no está de acuerdo con la modificación, puede terminar el contrato
en los términos del numeral 10, con exportación de datos durante los
treinta (30) días siguientes.

## 13. Ley aplicable y jurisdicción

Este contrato se rige por las leyes de la República de Colombia. Las
diferencias que surjan y no se resuelvan de común acuerdo serán
sometidas a los jueces de la ciudad de [CIUDAD].

## 14. Aceptación

La Finca acepta estos términos al marcar la casilla correspondiente
durante el registro en la plataforma. La aceptación queda registrada
con fecha, hora y la dirección IP desde la que se realizó, en los
términos del principio de demostración del artículo 4 literal g de
la Ley 1581 de 2012.
