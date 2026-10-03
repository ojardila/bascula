# Contrato de encargo del tratamiento de datos personales

> **ESTO ES UN BORRADOR TÉCNICO.** Está construido sobre la Ley 1581 de
> 2012 y el Decreto 1377 de 2013, pero no es asesoría legal y no
> reemplaza la revisión de un abogado colombiano. Antes de que una
> finca firme este contrato, un abogado habilitado debe revisarlo
> contra la situación concreta del operador de Báscula y las partes
> contratantes.

## Partes

Entre:

- **El Responsable del Tratamiento** (en adelante, la **Finca**): la
  persona natural o jurídica que se identifica en la cuenta creada en
  la plataforma Báscula, titular de los datos de los trabajadores que
  registra, con los datos de contacto declarados en el momento del
  registro; y

- **El Encargado del Tratamiento** (en adelante, el **Operador**):
  [RAZÓN SOCIAL], identificada con NIT [NIT], con domicilio en [CIUDAD,
  DEPARTAMENTO, COLOMBIA], que presta el servicio Báscula a través del
  dominio `*.bascula.engp.io`,

se celebra el presente contrato de encargo del tratamiento de datos
personales, en los términos de los artículos 25 y 50 del Decreto 1377
de 2013, reglamentario de la Ley 1581 de 2012.

## 1. Objeto

El Operador se obliga a tratar los datos personales que la Finca
recolecte sobre sus trabajadores y sobre sus propios representantes y
colaboradores, exclusivamente para prestar el servicio Báscula en los
términos del contrato principal entre las partes, y nunca por cuenta
propia ni con finalidad distinta.

## 2. Datos objeto del tratamiento

El Operador trata, por cuenta de la Finca, las siguientes categorías
de datos (el detalle técnico está en
[`docs/data-protection.md`](../data-protection.md)):

- Identificación del trabajador: nombres, apellidos, tipo y número de
  documento, etiqueta de la finca.
- Contacto del trabajador: teléfono, dirección, ciudad, municipio,
  país.
- Fotografía del trabajador, cuando la Finca la cargue.
- Historial laboral dentro de la Finca: días trabajados, lotes,
  actividades, productividad.
- Movimientos económicos del trabajador en la Finca: liquidaciones,
  anticipos, devengos y pagos.
- Notas internas que la Finca registre sobre el trabajador, que nacen
  privadas y así permanecen.
- Datos de los usuarios de la Finca con acceso a la plataforma: correo,
  nombre, teléfono y credenciales (siempre almacenadas con hash).

Los datos cumplen el principio de **limitación** (artículo 4 literal c
de la Ley 1581): el Operador no solicita a la Finca datos adicionales
a los necesarios para prestar el servicio.

## 3. Finalidades del tratamiento

El Operador trata los datos únicamente para:

a. Operar la plataforma Báscula: registrar jornales, pagos y
   liquidaciones; sincronizar los dispositivos de la Finca.
b. Permitir a la Finca cumplir sus obligaciones laborales, contables y
   tributarias.
c. Facilitar al trabajador, a través de la Finca, el ejercicio de los
   derechos del artículo 8 de la Ley 1581.
d. Operar el registro cruzado opcional entre fincas, con las
   limitaciones del numeral 7 de este contrato.
e. Prestar soporte y mantener la seguridad y continuidad del servicio.

Cualquier finalidad adicional requiere autorización escrita y
específica de la Finca.

## 4. Obligaciones del Operador (Encargado)

Conforme al artículo 18 de la Ley 1581, el Operador se obliga a:

a. Garantizar al Titular, por intermedio de la Finca, el pleno y
   efectivo ejercicio del derecho de hábeas data.
b. Conservar la información bajo las condiciones de seguridad
   descritas en [`docs/data-protection.md`](../data-protection.md) y
   en [`docs/audits.md`](../audits.md): aislamiento por finca con
   seguridad a nivel de fila (RLS) forzada en toda tabla con
   `farm_id`, credenciales con hash argon2id, canal de reporte
   privado en [`SECURITY.md`](../../SECURITY.md) y proceso de
   respuesta a incidentes en
   [`docs/incident-response.md`](../incident-response.md).
c. Realizar oportunamente la actualización, rectificación o supresión
   de los datos, cuando la Finca así lo instruya.
d. Actualizar la información reportada por la Finca dentro de los
   cinco (5) días hábiles siguientes a su recibo.
e. Tramitar las consultas y los reclamos formulados por los Titulares
   en los términos de los artículos 14 y 15 de la Ley 1581,
   remitiéndolos a la Finca cuando corresponda.
f. Abstenerse de circular información que esté siendo controvertida
   por el Titular y cuyo bloqueo haya ordenado la Superintendencia de
   Industria y Comercio.
g. Permitir el acceso a la información únicamente a quienes puedan
   tener acceso a ella según el modelo de roles de la plataforma.
h. Informar a la Superintendencia de Industria y Comercio y a la
   Finca los incidentes que afecten los datos personales, en los
   términos del numeral 8 de este contrato.
i. Cumplir las instrucciones y requerimientos que imparta la
   Superintendencia de Industria y Comercio.

## 5. Obligaciones de la Finca (Responsable)

Son obligaciones de la Finca:

a. Obtener del Titular, antes o al momento de la recolección, la
   autorización previa, expresa e informada para el tratamiento, en
   los términos del artículo 9 de la Ley 1581 y del aviso de
   privacidad modelo del Operador
   ([`aviso-privacidad-trabajador.md`](aviso-privacidad-trabajador.md)).
b. Conservar prueba de la autorización otorgada por el Titular.
c. Suministrar al Operador información veraz, completa, exacta,
   actualizada, comprobable y comprensible.
d. Atender las consultas y reclamos de los Titulares de los datos que
   trata a través de la plataforma.
e. Informar al Operador cualquier novedad sobre los datos previamente
   suministrados.
f. Instruir al Operador sobre la finalidad del tratamiento, en el
   marco de las finalidades autorizadas en el numeral 3.
g. Inscribir sus bases de datos en el Registro Nacional de Bases de
   Datos (RNBD) de la Superintendencia de Industria y Comercio,
   cuando le corresponda conforme a la normatividad vigente. El
   Operador no realiza esta inscripción por cuenta de la Finca.

## 6. Subencargados

El Operador se apoya en los siguientes proveedores de infraestructura
para prestar el servicio, cuyo uso la Finca autoriza al firmar este
contrato:

- Proveedor de almacenamiento de archivos adjuntos (fotos,
  documentos): [PROVEEDOR, UBICACIÓN DE DATOS].
- Proveedor de respaldo de la base de datos: [PROVEEDOR, UBICACIÓN DE
  DATOS].
- Proveedor de correo transaccional (verificación de correo,
  recuperación de contraseña): [PROVEEDOR, UBICACIÓN DE DATOS].

El Operador mantendrá la lista actualizada en el repositorio del
servicio. Un cambio de subencargado se le notifica a la Finca con al
menos quince (15) días de antelación; la Finca podrá oponerse por
escrito, en cuyo caso las partes buscarán una solución alternativa de
buena fe o darán por terminado el contrato principal.

El Operador responde ante la Finca por los subencargados como si
tratara los datos directamente.

## 7. Registro cruzado entre fincas (opcional)

El servicio contempla un registro cruzado entre fincas descrito en
[`docs/data-model.md`](../data-model.md) §D y en
[`docs/data-protection.md`](../data-protection.md) §2. Son condiciones
de este registro:

a. **Es opcional.** Cada participación nace con el indicador
   `disclosable = false`; la Finca decide expresamente cuáles publica.
b. **Lo que se publica.** Para una participación marcada como
   `disclosable`, el registro revela únicamente: nombre de la finca y
   fechas de inicio y fin de la participación.
c. **Lo que nunca se publica.** Notas, saldos, deudas, anticipos,
   kilos, productividad, teléfono, dirección, fotografía ni el nombre
   de otras fincas que no hayan publicado la participación.
d. **Identidad hasheada.** El documento del trabajador se almacena en
   el registro cruzado sólo como huella criptográfica con una sal de
   servidor; una copia del registro no revela cédulas.
e. **Trazabilidad.** Toda consulta queda registrada con el usuario y
   finca que consultó, la razón declarada (mínimo diez caracteres), la
   fecha y el número de resultados. El trabajador podrá, cuando la
   funcionalidad esté habilitada, consultar quién lo ha buscado.
f. **Límite.** Cincuenta consultas por finca por día.
g. **Interruptor.** El registro cruzado se habilita por finca,
   solicitándolo expresamente al Operador.

## 8. Incidentes de seguridad

El Operador le notificará a la Finca cualquier incidente de seguridad
que confirmadamente haya expuesto datos personales de los trabajadores
a terceros no autorizados, dentro de las **veinticuatro (24) horas**
siguientes a la confirmación, por el canal interno de notificaciones
del servicio y por el hilo privado de asesoría regulado en
[`SECURITY.md`](../../SECURITY.md). La notificación describirá:

- la naturaleza del incidente,
- las categorías y volumen aproximado de datos involucrados,
- las medidas que el Operador adoptó para contenerlo,
- las medidas recomendadas a la Finca.

El Operador apoyará a la Finca con la información necesaria para la
notificación a la Superintendencia de Industria y Comercio prevista
en el artículo 17 literal n de la Ley 1581 y la Circular Externa 005
de 2017 (o la norma que la sustituya).

## 9. Transferencia y transmisión internacional

El Operador no transferirá datos personales a países que no ofrezcan
niveles adecuados de protección en los términos del artículo 26 de la
Ley 1581, salvo autorización expresa y escrita de la Finca o
cumplimiento de alguno de los supuestos del parágrafo del artículo
26. La ubicación de los datos y de cada subencargado se declara en el
numeral 6.

## 10. Vigencia y terminación

Este contrato está vigente mientras lo esté el contrato principal
entre las partes. Al terminar:

a. El Operador pondrá a disposición de la Finca la exportación de los
   datos durante los **treinta (30) días calendario** siguientes.
b. Vencido ese plazo, el Operador suprimirá los datos personales de
   los sistemas de producción, salvo las obligaciones legales de
   conservación (contabilidad, prevención de fraude), que se
   cumplirán bajo mínimos de acceso.
c. Las copias de respaldo con datos personales serán sobreescritas en
   el ciclo normal de rotación, en un plazo máximo de **ciento
   ochenta (180) días** desde la terminación.

## 11. Confidencialidad

El Operador y su personal guardarán confidencialidad sobre los datos
personales que traten, obligación que se extiende después de
terminada la relación contractual.

## 12. Auditoría

La Finca, directamente o por intermedio de un tercero habilitado,
podrá verificar el cumplimiento de este contrato, con solicitud
escrita y con una antelación mínima de treinta (30) días. El Operador
atenderá razonablemente la auditoría y pondrá a disposición la
documentación pública del repositorio del servicio
([`docs/data-protection.md`](../data-protection.md),
[`docs/audits.md`](../audits.md),
[`docs/incident-response.md`](../incident-response.md)), así como las
evidencias adicionales que resulten razonables.

## 13. Responsabilidad

Cada parte responde por el cumplimiento de las obligaciones a su
cargo en este contrato y por los daños que ocasione a la otra por su
acción u omisión dolosa o gravemente culposa.

## 14. Ley aplicable y jurisdicción

Este contrato se rige por las leyes de la República de Colombia. Las
diferencias que surjan serán resueltas por los jueces de la ciudad de
[CIUDAD].

## 15. Firmas

Por la Finca (Responsable):

Nombre: ____________________________________________________________

Cargo: _____________________________________________________________

Documento: _________________________________________________________

Fecha: _____________________________________________________________

Firma: _____________________________________________________________


Por el Operador (Encargado):

Nombre: ____________________________________________________________

Cargo: _____________________________________________________________

Documento: _________________________________________________________

Fecha: _____________________________________________________________

Firma: _____________________________________________________________
