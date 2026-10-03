# Contrato de encargo del tratamiento de datos personales

> **ESTO ES UN BORRADOR TÉCNICO.** Está construido sobre la Ley 1581 de
> 2012 y el Decreto 1377 de 2013, pero no es asesoría legal y no
> reemplaza la revisión de un abogado colombiano. Antes de que una
> finca firme este contrato, un abogado habilitado debe revisarlo
> contra la situación concreta del operador de Báscula y las partes
> contratantes.
>
> Es una **plantilla**: describe sólo lo que el servicio hace hoy. Lo
> marcado **[pendiente / to be implemented]** no existe todavía en la
> plataforma (ver la sección «What is pending» de
> [`docs/data-protection.md`](../data-protection.md#what-is-pending));
> mientras no exista, el Operador lo cumple manualmente o la cláusula se
> ajusta antes de firmar.

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
personales, en los términos de los artículos 24 y 25 del Decreto 1377
de 2013 (compilado en el Decreto Único 1074 de 2015), reglamentario de
la Ley 1581 de 2012.

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
  actividades, productividad, y la nota de texto libre que quien
  registra la jornada puede escribir en cada registro.
- Movimientos económicos del trabajador en la Finca: liquidaciones,
  devengos, pagos, anticipos, deducciones, ajustes y reversos.
- Notas internas que la Finca registre sobre el trabajador, que nacen
  privadas y así permanecen.
- Datos de los usuarios de la Finca con acceso a la plataforma: correo,
  nombre, teléfono y credenciales. Las contraseñas se guardan con hash
  argon2id y los tokens de verificación, recuperación y sesión sólo como
  hash; las llaves de acceso (passkeys) guardan la llave pública; el
  código de autorización OAuth y el token de acceso que entrega a un
  asistente conectado se guardan en texto claro mientras viven (son de
  corta duración).
- Registros operativos y de seguridad: dirección IP y correo de cada
  ingreso rechazado y de cada intento de registro, y la auditoría de las
  acciones de escritura de asistentes conectados (MCP).

En desarrollo del principio de **finalidad** (artículo 4 literal b de
la Ley 1581) y del artículo 4 del Decreto 1377 de 2013, el Operador no
solicita a la Finca datos adicionales a los necesarios para prestar el
servicio.

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
   de los datos, cuando la Finca así lo instruya. La Finca corrige y
   suprime directamente los datos de sus trabajadores desde la consola
   de administración; la supresión es hoy un borrado lógico
   (`deleted_at`) y la supresión definitiva no existe en la plataforma
   **[pendiente / to be implemented]**: cuando la Finca la instruya, el
   Operador la ejecuta manualmente. Los usuarios no pueden cambiar por
   sí mismos su correo, nombre o teléfono **[pendiente / to be
   implemented]**: el Operador hace ese cambio manualmente a solicitud
   de la Finca.
d. Actualizar la información reportada por la Finca dentro de los
   cinco (5) días hábiles siguientes a su recibo, manualmente en lo que
   la Finca no pueda hacer desde la consola (literal c).
e. Tramitar las consultas y los reclamos formulados por los Titulares
   en los términos de los artículos 14 y 15 de la Ley 1581,
   remitiéndolos a la Finca cuando corresponda. Los trabajadores no
   tienen cuenta en la plataforma y no hay buzón de privacidad dedicado
   ni exportación de los datos de un trabajador **[pendiente / to be
   implemented]**; hoy las solicitudes llegan al Operador por el canal
   privado de [`SECURITY.md`](../../SECURITY.md) y el Operador las
   atiende manualmente (ver [`docs/data-protection.md`, «What is pending»](../data-protection.md#what-is-pending)).
f. Abstenerse de circular información que esté siendo controvertida
   por el Titular y cuyo bloqueo haya ordenado la Superintendencia de
   Industria y Comercio. La plataforma no tiene un mecanismo de bloqueo
   **[pendiente / to be implemented]**; el Operador lo cumple
   manualmente.
g. Permitir el acceso a la información únicamente a quienes puedan
   tener acceso a ella según el modelo de roles de la plataforma.
h. Informar a la Superintendencia de Industria y Comercio y a la
   Finca las violaciones a los códigos de seguridad que afecten los
   datos personales (artículo 18 literal k de la Ley 1581), en los
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
   La plataforma no muestra ni registra hoy ese aviso al crear un
   trabajador **[pendiente / to be implemented]**: la Finca obtiene y
   conserva la autorización por fuera de la plataforma.
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

La base de datos y los archivos adjuntos (fotos) se alojan en un
clúster Kubernetes propio del Operador, ubicado en [CIUDAD], Colombia;
no hay un proveedor externo de almacenamiento de adjuntos. El Operador
se apoya en los siguientes proveedores, cuyo uso la Finca autoriza al
firmar este contrato:

- **Cloudflare, Inc.** (red global; sede en Estados Unidos): DNS, túnel
  de entrada y certificados por finca. Todo el tráfico entre el
  navegador y el servicio pasa por su red.
- **DigitalOcean, LLC** (Spaces, región NYC3, Estados Unidos): copias
  de respaldo de la base de datos de producción
  compartida (30 días, con recuperación a un punto en el tiempo) y de
  las fotos de todas las fincas (14 respaldos diarios). Las bases de
  datos de las fincas con instalación dedicada **no tienen respaldo
  hoy [pendiente / to be implemented]**.
- **Resend** (relay SMTP; [UBICACIÓN DE DATOS — confirmar con el
  proveedor]): correo transaccional (verificación de correo,
  recuperación de contraseña, avisos de seguridad); recibe la dirección
  y el contenido de cada correo.
- **GitHub, Inc.** (Estados Unidos): aloja el código y el canal privado
  de reportes de [`SECURITY.md`](../../SECURITY.md), que hoy es también
  el canal de solicitudes de usuarios al Operador; no aloja la base de
  datos de la Finca.

El Operador mantendrá esta lista actualizada. Un cambio de subencargado se le notifica a la Finca con al
menos quince (15) días de antelación; la Finca podrá oponerse por
escrito, en cuyo caso las partes buscarán una solución alternativa de
buena fe o darán por terminado el contrato principal.

El Operador responde ante la Finca por los subencargados como si
tratara los datos directamente.

## 7. Registro cruzado entre fincas (opcional)

El servicio contempla un registro cruzado entre fincas descrito en
[`docs/data-model.md`](../data-model.md) §D y en
[`docs/data-protection.md`](../data-protection.md) («Cross-farm
registry»). **Hoy el registro está diseñado pero no activo**: existe
como un esquema vacío y no se habilitará mientras no exista la
pantalla con la que el trabajador ve quién lo consultó **[pendiente /
to be implemented]**. Las condiciones siguientes describen el diseño y
rigen cuando se active:

a. **Es opcional.** Cada participación nace con el indicador
   `disclosable = false`; la Finca decide expresamente cuáles publica.
b. **Lo que se publica.** Para una participación marcada como
   `disclosable`, el registro revela únicamente las fechas de inicio y
   fin de la participación y, según el diseño actual, el nombre de la
   finca. Si el nombre de la finca se revela o no es una decisión
   abierta que debe resolverse antes de construir el registro
   **[pendiente]**.
c. **Lo que nunca se publica.** Notas, saldos, deudas, anticipos,
   kilos, productividad, teléfono, dirección, fotografía ni el nombre
   de otras fincas que no hayan publicado la participación.
d. **Identidad hasheada.** El documento del trabajador se almacena en
   el registro cruzado sólo como huella criptográfica (sha256) con un
   secreto del servidor (pepper); una copia del registro no revela
   cédulas.
e. **Trazabilidad.** Toda consulta queda registrada con el usuario y
   finca que consultó, la razón declarada (mínimo diez caracteres), la
   fecha y el número de resultados. El trabajador podrá consultar quién
   lo ha buscado; esa pantalla es la condición para activar el
   registro.
f. **Límite.** Cincuenta consultas por finca por día.
g. **Interruptor.** Hoy ninguna finca puede habilitarlo. Una vez
   activo, cada Finca decide qué participaciones publica (literal a).

## 8. Incidentes de seguridad

Ante un incidente de seguridad que confirmadamente haya expuesto datos
personales de los trabajadores a terceros no autorizados, el Operador
sigue el procedimiento de [`SECURITY.md`](../../SECURITY.md) y
[`docs/incident-response.md`](../incident-response.md). Hoy la Finca
es informada una vez el arreglo está en producción y el aviso de
seguridad se publica, mediante las notas de versión y el aviso
publicado en GitHub. No existe hoy un aviso dentro de la plataforma ni
un aviso a la Finca en un plazo fijo **[pendiente / to be implemented]**
(ver [`docs/data-protection.md`, «What is pending»](../data-protection.md#what-is-pending)). [Si el Operador se compromete a un plazo, p. ej.
veinticuatro (24) horas desde la confirmación, lo cumple manualmente
por correo al propietario de la Finca; completar o eliminar antes de
firmar.] La comunicación describirá:

- la naturaleza del incidente,
- las categorías y volumen aproximado de datos involucrados,
- las medidas que el Operador adoptó para contenerlo,
- las medidas recomendadas a la Finca.

El Operador informará a la Superintendencia de Industria y Comercio
conforme al artículo 18 literal k de la Ley 1581 y apoyará a la Finca
con la información necesaria para la notificación que le corresponde
a ella según el artículo 17 literal n, dentro del plazo que fijen las
instrucciones vigentes de la SIC.

## 9. Transferencia y transmisión internacional

El Operador no transferirá datos personales a países que no ofrezcan
niveles adecuados de protección en los términos del artículo 26 de la
Ley 1581, salvo autorización expresa y escrita de la Finca o
cumplimiento de alguno de los supuestos de los literales del artículo
26. La ubicación de los datos y de cada subencargado se declara en el
numeral 6: hoy los respaldos se guardan en Estados Unidos y el tráfico
pasa por la red de Cloudflare, lo que constituye una transmisión
internacional en los términos de los artículos 24 y 25 del Decreto
1377 de 2013. El abogado que revise esta plantilla debe confirmar el
nivel adecuado de protección de esos países según la lista vigente de
la SIC (Circular Externa 005 de 2017 o la norma que la sustituya).

## 10. Vigencia y terminación

Este contrato está vigente mientras lo esté el contrato principal
entre las partes. Al terminar:

a. El Operador pondrá a disposición de la Finca la exportación de los
   datos durante los **treinta (30) días calendario** siguientes. La
   plataforma no tiene hoy una función de exportación de los datos de
   la Finca **[pendiente / to be implemented]**: el Operador la genera
   manualmente.
b. Vencido ese plazo, el Operador suprimirá los datos personales de
   los sistemas de producción, salvo las obligaciones legales de
   conservación (contabilidad, prevención de fraude), que se
   cumplirán bajo mínimos de acceso. La plataforma sólo permite
   suspender una finca, no eliminarla **[pendiente / to be
   implemented]**: el Operador ejecuta la supresión manualmente.
c. Las copias de respaldo con datos personales expiran según su
   retención (30 días para la base de datos compartida; 14 respaldos
   diarios para las fotos). Los respaldos de una finca eliminada no se
   borran solos: el Operador los elimina manualmente, en un plazo
   máximo de **ciento ochenta (180) días** desde la terminación.

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
