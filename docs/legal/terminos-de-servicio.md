# Términos de servicio

> **ESTO ES UN BORRADOR TÉCNICO.** Son los términos de uso de la
> plataforma Báscula entre el Operador y la Finca contratante. Es una
> plantilla y no constituye asesoría legal; no reemplaza la revisión de
> un abogado colombiano antes de ponerla en producción.
>
> Cada afirmación sobre el producto describe lo que hace el código en
> `master` hoy (ver [`docs/data-protection.md`](../data-protection.md)).
> Lo que todavía no está construido va marcado como
> **[PENDIENTE: …]**; hasta que exista, esa obligación la cumple el
> Operador de forma manual o no se puede prometer.

## 1. Partes y objeto

Estos términos regulan la relación entre:

- **El Operador:** [RAZÓN SOCIAL], NIT [NIT], con domicilio en
  [CIUDAD, COLOMBIA], que presta el servicio Báscula a través del
  dominio `*.bascula.engp.io`.

- **La Finca:** la persona natural o jurídica que registra una cuenta
  en la plataforma, declara sus datos de contacto y acepta estos
  términos (ver numeral 14 sobre cómo se registra hoy esa aceptación).

El Operador le concede a la Finca el derecho de usar la plataforma
Báscula para registrar la operación agrícola de la finca: pesadas,
jornales, pagos, liquidaciones, recibos y la información que la
plataforma soporta. El servicio se presta a través de una aplicación
web instalable (PWA) y, si la Finca lo habilita, de un conector MCP
que permite consultar y registrar datos desde asistentes de IA
(ChatGPT, Claude) con la cuenta de un usuario de la Finca; en ese
conector toda operación de dinero exige confirmación en dos pasos
antes de registrarse. El asistente de IA es un servicio de un tercero
que la Finca elige y contrata por su cuenta.

## 2. Registro y cuenta

El registro se realiza por auto-inscripción en la plataforma. Cuando
el envío de correo está habilitado, la Finca debe confirmar su
dirección de correo desde el enlace que recibe; sólo entonces se crea
el entorno propio de la Finca. El Operador también puede crear una
cuenta desde su consola de administración.

Quien registra la Finca queda como usuario propietario (`owner`). La
Finca puede invitar a otros usuarios con los roles de propietario
(`owner`), administrador (`admin`) o pesador (`weigher`); la cuenta
conserva siempre al menos un propietario, y el pesador no tiene acceso
a dinero ni a datos personales. La Finca es responsable de las
acciones realizadas con las credenciales de sus usuarios y debe
mantenerlas en reserva.

El Operador puede, por su parte:

- Suspender la cuenta de la Finca por falta de pago, por uso que
  contravenga estos términos, o por orden de autoridad competente.
  La suspensión se registra en el sistema (`farms.suspended_at`) y
  bloquea todo acceso de los usuarios de la Finca, incluida la
  consulta y la exportación de datos, mientras dure.
- Suspender un registro cuando existan indicios razonables de fraude.
  La plataforma no tiene hoy un paso de revisión previa de los
  registros: la cuenta se crea y, si corresponde, se suspende
  después.

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

La plataforma no tiene hoy módulo de cobro, facturación ni pasarela de
pagos: el cobro y la factura los gestiona el Operador por fuera de
Báscula, y la suspensión por mora la aplica manualmente desde su
consola de administración.

La mora en el pago faculta al Operador a suspender la cuenta tras
notificación previa con al menos siete (7) días calendario de
anticipación.

## 5. Niveles de servicio

- **Disponibilidad objetivo.** [DEFINIR POR EL OPERADOR.] Hoy el
  servicio corre en un único clúster Kubernetes propio del Operador,
  sin redundancia geográfica; no hay base técnica para garantizar un
  porcentaje de disponibilidad. Mientras eso no cambie, el servicio
  se presta en la modalidad de mejor esfuerzo, sin porcentaje de
  disponibilidad garantizado.
- **Ventanas de mantenimiento.** [DEFINIR POR EL OPERADOR.] Las
  nuevas versiones se despliegan de forma continua y pueden causar
  interrupciones breves sin aviso previo; sólo los mantenimientos
  planificados de mayor duración se anuncian con antelación, en lo
  posible fuera del horario laboral de las fincas.
- **Soporte.** [DEFINIR POR EL OPERADOR: canal, horario, tiempos de
  respuesta por severidad.]
- **Modo sin conexión.** El registro de pesadas en la aplicación web
  funciona sin conexión en los dispositivos que la Finca usa para
  pesar; las pesadas se sincronizan al reconectar. El resto de la
  aplicación requiere conexión. El Operador recomienda sincronizar
  antes de ciento ochenta (180) días para conservar la sincronización
  incremental.

## 6. Seguridad

El Operador adopta las medidas descritas en
[`docs/data-protection.md`](../data-protection.md) y
[`docs/audits.md`](../audits.md):

- Aislamiento entre fincas por seguridad a nivel de fila (RLS)
  forzada en toda tabla con `farm_id`.
- Credenciales almacenadas con hash `argon2id`.
- Cifrado del canal (TLS).
- Respaldo de la base de datos principal del servicio (copia base
  semanal más archivo continuo de transacciones, conservados treinta
  (30) días, en almacenamiento externo al clúster) y respaldo diario
  de los archivos cargados (fotos), conservado catorce (14) días.
  **[PENDIENTE: respaldo de la base de datos del entorno propio de
  cada Finca; hoy esas bases de datos no tienen copia fuera del
  clúster.]**
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
desde la plataforma. Lo que existe hoy es la exportación en archivos
CSV, disponible para los roles propietario y administrador, de tres
conjuntos: pesadas, movimientos de dinero y saldos por trabajador;
los recibos se pueden descargar uno a uno.
**[PENDIENTE: exportación completa de los datos de la Finca
(trabajadores, lotes, notas, liquidaciones, fotos) y exportación de
los datos de un trabajador para atender su solicitud.]** Mientras no
exista, el Operador entrega esos datos a solicitud de la Finca.

Al terminar el contrato, el Operador mantiene la posibilidad de
exportación durante **treinta (30) días calendario**, tras los cuales
suprime los datos de los sistemas de producción en los términos del
numeral 10 del contrato de encargo. Como la suspensión bloquea todo
acceso (numeral 2), durante ese plazo la cuenta no se suspende o el
Operador entrega la exportación directamente.
**[PENDIENTE: la plataforma no tiene función de cierre ni de
supresión de una Finca; el Operador la realiza manualmente.]**

## 10. Terminación

Cualquiera de las partes puede terminar el contrato con un preaviso
escrito de **treinta (30) días calendario**. El Operador puede
terminarlo de inmediato por incumplimiento grave de la Finca,
notificándole y preservando la exportación de datos durante los
treinta (30) días siguientes en los términos del numeral 9.

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
con al menos **treinta (30) días calendario** de anticipación por
correo electrónico a los propietarios de la Finca. **[PENDIENTE: la
plataforma no tiene hoy un canal de avisos dentro de la aplicación.]**
Si la Finca
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

**[PENDIENTE: el registro en la plataforma no muestra hoy estos
términos ni el contrato de encargo, no tiene la casilla de aceptación
y no registra la aceptación (ver "What is pending" en
[`docs/data-protection.md`](../data-protection.md)).]** Mientras no
exista, la aceptación se obtiene por fuera de la plataforma (por
ejemplo, firma o aceptación por correo electrónico del propietario) y
el Operador conserva la constancia.
