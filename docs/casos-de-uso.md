# Casos de uso

Escritos por el dueño antes de este trabajo. Son la fuente de verdad del
alcance: la app movil de hoy cubre solo una parte pequena de esto.

Referencias de interfaz que el dueno senalo para el modulo de parcelas:
cropti.com y farmlogs.com.

## Convenciones comunes a todos los casos

- El actor es el **Administrador de Finca**, autenticado y con el privilegio
  correspondiente al modulo.
- Al entrar a cualquier modulo sin privilegios, el sistema notifica la carencia
  y saca al usuario del modulo.
- Al guardar, el sistema valida los campos obligatorios y, si faltan, indica
  **cuales** y **por que**, y deja volver al formulario.
- **Eliminar nunca borra**: marca el registro como inactivo.

---

## 1. Gestion de Parcelas

### RSP-001 Registrar Parcela

Campos:

*Informacion de la parcela*
- Nombre del lote — string(80), obligatorio
- Superficie total en hectareas — double, obligatorio

*Ubicacion*
- Departamento — string(80), obligatorio
- Municipio — string(80), obligatorio
- Mapa — poligono (dato SIG)

*Informacion de los cultivos*
- Tipo de cultivo — string(80), obligatorio (cafe, aguacate, yuca...), con opcion
  de agregar si no existe
- Variedad — string(80), autocompletar con opcion de agregar si no existe
- Boton para agregar otro cultivo

Excepcion: el sistema muestra por defecto un cultivo de cafe disponible para
seleccionar variedad.

### RSP-002 Modificar Parcela
Los mismos campos, precargados con los valores almacenados.

### RSP-003 Eliminar Parcela
Pide confirmacion. Al aceptar, la parcela queda **inactiva**, no borrada.

---

## 2. Gestion de Empleados

### RSP-004 Registrar Empleado

*Datos del empleado*
- Nombre completo — string(80), obligatorio
- Tipo de identificacion — string(80), obligatorio
- Identificacion — string(80), obligatorio
- Foto — archivo, hasta 5 MB

*Datos de contacto*
- Telefono — numerico(30), obligatorio
- Direccion, ciudad — string(80)

**Requiere internet**: antes de guardar, el sistema consulta con la
identificacion el **historial de trabajo en otras fincas** y las **alertas de
seguridad**, y los muestra para que el usuario continue o cancele. Sin internet,
crea una solicitud de analisis que se sincroniza despues.

### RSP-005 Modificar Empleado
Los mismos campos, precargados. Direccion incluye ciudad, municipio y pais.

### RSP-006 Eliminar Empleado
Confirmacion; queda **inactivo**.

### RSP-007 Visualizar perfil de Empleado
Muestra datos del empleado, **saldo pendiente por pagar**, y botones de accion:
pagar empleado, registrar deuda, agregar anotacion. Ademas:
- **Labores**: nombre de actividad, fecha, lotes
- **Historial financiero**: tipo (deuda o pago), concepto, monto, fecha
- **Anotaciones**: texto y fecha

### RSP-008 Pagar Empleado
Redirige al modulo de pagos, que muestra:
- Lista de labores: nombre, fecha, lotes, valor
- Lista de deudas: descripcion del gasto, fecha, valor
- Total a pagar
- Botones: registrar deuda, registrar labor, pago parcial, pago total

En **pago parcial** pide el valor, valida que sea menor al saldo actual y
actualiza el saldo. En **pago total** deja el saldo en cero. El sistema genera
el **recibo de pago**.

### RSP-009 Consultar Historial de Empleado
Busca por tipo y numero de identificacion y muestra los **datos publicos**: las
fincas donde ha trabajado con sus periodos, y las anotaciones realizadas. Si no
hay informacion, lo indica. **Postcondicion: queda registrado que esa finca lo
consulto.**

---

## 3. Gestion de Actividades

### RSP-010 Listar Actividades
Trae del repositorio publico en internet las ultimas categorias y actividades.
Lista agrupando por categoria, mostrando nombre, forma de pago y los datos de
sus unidades. Ejemplo:

- Cosecha → recoleccion por kilos
- Mantenimiento → tala por jornal, fertilizar por jornal

Ofrece buscador y los botones "Agregar Actividad" y "Definir Precios".

### RSP-011 Registrar Actividad
- Nombre — obligatorio
- Categoria — select, obligatorio (siembra, mantenimiento, cosecha...), con
  opcion de crear una nueva
- Pago — select, obligatorio: **contrato**, **tiempo** o **unidad de trabajo**

Segun el pago:
- *Unidad de trabajo*: unidad (kilos, arrobas, canastas) y precio por unidad
- *Unidad de tiempo*: diario (jornal), semanal, quincenal, mensual o
  personalizado (cantidad + unidad: dia, mes, ano), y precio

### RSP-012 Modificar Actividad · RSP-013 Eliminar Actividad
Mismos campos; eliminar deja la actividad **inactiva**.

### Definir precio de actividades
Pendiente de especificar por el dueno.

---

## 4. Gestion de Labores

### RSP-014 Listar Labores
Muestra actividad, forma de pago, fecha de realizacion, lotes y cultivos, con
buscador y boton "Registrar labor".

### RSP-015 Registrar Labor
El usuario elige categoria y luego actividad; el sistema muestra:
- Nombre de la actividad y forma de pago (solo lectura)
- Empleado — obligatorio
- Unidades de tiempo o de trabajo — obligatorio
- Precio — por defecto el de la actividad
- Rango de fechas — por defecto el dia actual, obligatorio
- Lotes — obligatorio
- Cultivos — obligatorio

### RSP-016 Modificar Labor · RSP-017 Eliminar Labor
Eliminar deja la labor **inactiva**.

---

## 5. Gestion de Productos e Inventarios

### RSP-018 Listar Productos
Trae categorias y productos del repositorio publico. Agrupa por categoria
mostrando nombre y unidades existentes, con opciones de modificar, eliminar y
actualizar inventario.

### RSP-019 Registrar Producto
- Nombre — obligatorio
- Categoria — select (materia prima, producto procesado...), con opcion de crear
- Unidades de almacenamiento — select, con opcion de crear

### RSP-020 Modificar Producto · RSP-021 Eliminar Producto
Eliminar deja el producto **inactivo**.

### RSP-025 Registrar inventario de producto
- Nombre del producto (no editable), unidades, lote, bodega (opcional), cultivo
- Al guardar, **el sistema imprime los stickers de identificacion del producto**

---

## 6. Gestion de Ventas

### RSP-026 Listar Ventas · RSP-027 Registrar Venta
- Producto — select, obligatorio
- Cantidad — double, obligatorio
- Valor — double, obligatorio
- Cliente — select (ej. cooperativa)
- Foto del comprobante de venta

### RSP-028 Modificar Venta · RSP-029 Eliminar Venta
Eliminar deja la venta **inactiva**.

---

## 7. Gestion de Gastos

### RSP-030 Listar Gastos · RSP-031 Registrar Gasto
- Valor — double
- Tipo de gasto — select: **actividad** o **lote/cultivo**
  - Si es actividad: se elige de la lista de actividades existentes
  - Si es lote/cultivo: el lote pasa a obligatorio y el sistema muestra los
    cultivos asociados a ese lote
- Lote y cultivos — opcionales segun el tipo

### RSP-032 Modificar Gasto · RSP-033 Eliminar Gasto
Eliminar deja el gasto **inactivo**.

---

## 8. Configuracion

### Modificar datos de la finca
- Nombre, telefono, dimension en hectareas — obligatorios
- Pais (select), ciudad, direccion — obligatorios

### Modificar precios de trabajo
Pendiente de especificar por el dueno.

### Gestion de usuarios
Listar y agregar usuarios. Pendiente de detallar.

---

## 9. Autenticacion y registro

### Autenticar usuario · Registrar finca
Pendientes de especificar por el dueno.

---

## Tensiones que este documento abre

Anotadas por el equipo al recibirlo, para resolverlas antes de construir.

1. **La recoleccion deja de ser especial.** La app movil trata la pesada por
   kilos como entidad de primera clase. Aqui es *una actividad* pagada por
   unidad de trabajo, junto a tala por jornal o fertilizacion por contrato.
   Generalizar el modelo afecta al ledger, a las liquidaciones y a la migracion
   de los datos que ya existen.

2. **Parcela y cultivo no son lo mismo.** Hoy `crops` mezcla ambos; aqui una
   parcela tiene varios cultivos, cada uno con tipo y variedad.

3. **RSP-004 y RSP-009 cruzan fincas.** Consultar el historial de un trabajador
   en otras fincas y sus "alertas de seguridad" rompe el aislamiento entre
   inquilinos y tiene implicaciones serias de privacidad: mal disenado, es una
   lista negra de trabajadores. Que se comparte, quien lo ve y como se corrige
   un dato injusto son decisiones del dueno, no del equipo.

4. **Poligonos SIG** (RSP-001) implican PostGIS o GeoJSON en jsonb.

5. **Repositorio publico de actividades y productos** (RSP-010, RSP-018): un
   catalogo compartido entre fincas que hoy no existe en ninguna parte.
