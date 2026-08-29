# Auditorías adversarias

Dos auditores externos al equipo atacaron el sistema con el encargo de romperlo:
uno la API, otro la consola web. No leyeron código buscando teorías — ejecutaron
ataques y dejaron los guiones que los reproducen.

Este documento es el marcador. Cada hallazgo se da por cerrado solo cuando **el
guion que lo encontró falla**, no cuando alguien dice que lo arregló.

## Lo que aguantó, que es lo que más tranquiliza

Vale la pena leerlo antes que la lista de fallos, porque es la parte del sistema
en la que se puede confiar.

**El aislamiento entre fincas.** 67 combinaciones de ruta y verbo cruzando
identificadores de una finca contra otra: ni un solo acceso. Y —esto importa
tanto como lo anterior— **cero rutas donde «no es tuyo» se distinga de «no
existe»**: mismos códigos, mismos mensajes. Las 32 tablas con `farm_id` tienen
seguridad a nivel de fila habilitada, forzada y con política; ninguna de las
migraciones nuevas se quedó fuera.

**El candado anti doble pago.** 16 liquidaciones simultáneas del mismo trabajador
y periodo, diez veces seguidas: siempre una sola aceptada. Liquidar contra anular
en paralelo: las cuentas cuadran en las diez.

**La idempotencia del dinero.** El mismo identificador con otro importe, otro
trabajador u otro tipo: rechazado. Ocho reintentos simultáneos del mismo pago:
un solo movimiento.

**Los roles, en la API y en la consola.** El pesador recibe 403 en todas las
puertas de dinero y datos personales. Ocho vías de ataque desde el navegador
—URL directa, historial, sesión guardada, falsificar el rol dentro del token—:
ninguna cedió. En las rutas denegadas no se dispara ni una petición, así que no
llega al navegador un dato que luego se esconda.

**Inyección SQL.** Ninguna.

## API — 14 hallazgos

| # | Qué | Estado |
|---|---|---|
| 1 | Un refresh token reenviado bloquea la petición; diez apagan la API para todas las fincas | **Cerrado** |
| 2 | La guarda de sobrepago no existe bajo concurrencia; también en existencias y ventas | **Cerrado** |
| 3 | La importación no reconcilia: crédito inventado, pesadas de una persona pagadas a otra, pesadas atrapadas sin salida, fechas de 1900 | **Cerrado** |
| 4 | El décimo caso de oro: el redondeo en coma flotante hace discrepar teléfono y servidor en el 31 % de las liquidaciones | **Cerrado** |
| 5 | El pesador escribe trabajadores por sincronización, y enumera cédulas | **Cerrado** |
| 6 | Borrar un trabajador esconde su deuda de la lista de saldos | **Cerrado** |
| 7 | El pull del pesador lleva el precio del kilo y todos los precios semanales | **Cerrado** |
| 8 | El tope de fincas por correo nunca se aplica | **Cerrado** |
| 10 | El push rompe su contrato: identificador reusado devuelve el id ajeno y el teléfono pierde la pesada | **Cerrado** |
| 13 | Cantidades con más decimales de los que caben se redondean en silencio | **Cerrado** |
| 9 | Lo saltado por rol no vuelve nunca: un teléfono que cambia de manos se queda con el libro incompleto | Abierto — necesita diseño, no parche |
| 12 | El registro público es un oráculo de cuentas y contraseñas | Abierto — el arreglo honesto exige mover la creación de una segunda finca detrás de sesión |
| 14 | Suspender una finca no corta las sesiones vivas (hasta 15 minutos) | Abierto |
| 11 | Informes: una semana sin cosecha desaparece y la curva se lee empalmada sobre el hueco; una ventana truncada se presenta como semana completa | Abierto |

Deuda que abrió el propio arreglo de la 3: la importación ya no **crea**
liquidaciones anuladas con línea viva, pero **no hay ruta que libere las que ya
existan**.

## Consola web — 12 hallazgos

| # | Qué | Estado |
|---|---|---|
| A1 | **Un doble clic paga dos veces.** Verificado: $20.000 entregados donde se aprobaron $10.000 | **Cerrado** |
| A2 | Al pesador se le escapa el valor por la única ruta sin guarda, y con él el precio por kilo que el servidor le oculta | **Cerrado** |
| A3 | La planilla firmada imprime el resultado de una búsqueda: una nómina de $2.220.080 sale como $335.280 | **Cerrado** |
| A4 | Las cifras de cabecera de liquidaciones son sumas del filtro, sin decirlo | **Cerrado** |
| A5 | El perfil del empleado dice «$0» cuando la petición falló | **Cerrado** |
| A6 | El tablero: dos casillas honestas y dos que mienten con la misma petición fallida | **Cerrado** |
| A7 | Estimaciones sumadas y presentadas como firmes; `amountIsEstimate` no se pinta en ningún sitio | **Cerrado** |
| A8 | «Nunca ha entrado», mostrado al dueño que estaba usando la aplicación | **Cerrado** |
| A9 | La invitación promete un correo que nadie envía y tira la contraseña: el invitado no puede entrar nunca | **Cerrado** |
| A10 | «Líneas: 0» en todas las liquidaciones: el servidor manda el conteo y la web cuenta un array vacío | **Cerrado** |
| A11 | La columna «Periodo» siempre muestra una semana; el papel lo imprime bien y la pantalla no | **Cerrado** |
| A12 | Menores: un pie que dice «0 ventas» bajo una alerta de error, un estado inventado en inglés | **Cerrado** salvo el formulario que se pierde al recargar, que es una función nueva y no una mentira |

Cuatro de las siete sospechas del auditor resultaron ciertas y están cerradas:
un área desconocida que se convertía en «0,00 ha» y se sumaba al total de la
finca; un total que sumaba bultos con kilos y lo rotulaba con la primera unidad
que encontraba; unas existencias caídas que se pintaban como bodega vacía y
**empujaban a desactivar la guarda del servidor**; y un reparto de peticiones que
convertía un fallo en «todavía no se ha liquidado nada en esta finca».

## Lo que estas dos auditorías enseñan

Casi todos los hallazgos de la consola son **la misma familia**: una cifra que se
muestra cuando en realidad no se sabe. El equipo la resolvió bien —muy bien— en
el módulo de cosecha, con una unión de cuatro estados que no tiene miembro
numérico para el caso desconocido. Y no volvió a las pantallas viejas.

La lección no es «cuidado con los ceros». Es que **un patrón resuelto en un sitio
no se propaga solo**, y que la única forma de saber dónde falta es que alguien
ajeno lo busque.

### Y una lección sobre las propias pruebas

El doble pago no salía en la suite por dos razones que conviene recordar:

`fireEvent` y `userEvent` envuelven en `act()`, y con eso le regalan a React el
re-renderizado que un doble clic de verdad **no** le da. La prueba era más
amable que el mundo.

Y el simulacro del servidor **no era idempotente por identificador**, aunque su
propia cabecera prometía que sí. Era más permisivo que producción, así que el
fallo no podía reproducirse contra él. Un simulacro que se aparta del servidor
en la dirección de dejar pasar más cosas no es una red: es una venda.
