# RNE Panel Dashboard

Centro de control local para una Raspberry Pi 3. Consulta la API del Registro
Nacional de Espera cada 30 segundos, muestra el tráfico de las consultas,
envía texto a controladores `RGB_ETHERNET` mediante UDP y administra una
impresora OKI Microline 320 conectada a un servidor de impresión en la LAN.

## Qué hace

- Consulta `GET /api/results`, `GET /api/results/categories`,
  `GET /api/results.json` y `GET /health` cada 30 segundos.
- Muestra todas las solicitudes que este servicio realiza a la API. Mantiene
  en memoria las últimas 400 consultas, envíos UDP, trabajos de impresión y
  cambios de configuración.
- Permite crear, editar, pausar, probar y eliminar rutas hacia paneles.
- Permite consultar NetworkManager, configurar DHCP o una IP estática y
  conectar la Raspberry Pi a una red Wi-Fi protegida.
- Detecta cada 60 segundos los equipos visibles en la LAN, intenta resolver sus
  hostnames y muestra IP, MAC, fabricante e interfaz.
- Puede asignar a cada panel el total, una categoría, la última espera, el
  último testimonio, los mapas de Gran Santiago o Chile, o una plantilla
  personalizada.
- Guarda las rutas de paneles en `data/config.json` mediante escritura atómica.
  El archivo no se versiona.
- Envía texto UTF-8 al puerto UDP 5000, compatible con `../RGB_ETHERNET`.
- Envía trabajos de texto UTF-8 a la OKI y autoimprime cada registro nuevo una
  sola vez, con los datos del registro primero y el testimonio después.

UDP no incluye confirmación del receptor. Por eso «Enviado» significa que el
sistema operativo aceptó el datagrama, no que el panel confirmó su recepción.

## Ejecutar

Requiere Node.js 20 o posterior. No hay dependencias externas.

```sh
npm start
```

Abre `http://IP_DE_LA_RASPBERRY:4173`. Por defecto, se consulta la API pública
fija en `https://registronacionaldeespera.cl`.

El dashboard está pensado para una red local confiable. Los cambios de red y
los envíos manuales a la impresora requieren la clave administrativa creada por
el instalador. No expongas el puerto 4173 directamente a Internet.

Variables generales opcionales:

```sh
PORT=4173 HOST=0.0.0.0 RNE_DATA_DIR=./data npm start
RNE_BITMAP_CHUNK_DELAY_MS=250 npm start
```

Configuración requerida del servidor de impresión OKI —el instalador la agrega
automáticamente—:

```sh
OKI_PRINTER_HOST=192.168.100.10 \
OKI_PRINTER_PORT=5005 \
OKI_PRINTER_STATUS_URL=http://192.168.100.10:8080/healthz \
npm start
```

`RNE_BITMAP_CHUNK_DELAY_MS` controla la pausa entre fragmentos del mapa y usa
`250` ms por defecto para no saturar el receptor W5100S.

## Formato de tiempo

El dashboard toma los totales exactos en minutos de `/api/results` y
`/api/results/categories`. Usa `/api/results.json` para las entradas y
testimonios, pero no para sus acumulados redondeados. Internamente normaliza
todo a minutos. Para cada panel se puede elegir minutos, horas, días, meses,
años o conversión automática. La unidad siempre se agrega al final del mensaje.
Para la conversión se consideran 30 días por mes y 365 días por año.

La opción **Contenido** permite elegir entre **Etiqueta + tiempo**, **Solo
tiempo** y **Solo etiqueta**. Por ejemplo, un panel puede recibir `TRÁMITES 8
MESES`, `8 MESES` o solamente `TRÁMITES`. Los mensajes para paneles muestran
como máximo una cifra decimal, sin agregar `,0` a los valores enteros, y usan
un punto como separador de miles. Por ejemplo: `47,3 H`, `2 DÍAS` y
`2.835 MIN`.

Para los contenidos de tiempo se pueden activar colores RGB independientes
para la etiqueta y el tiempo. Los colores se envían con el formato que entiende
el firmware y las etiquetas no ocupan espacio visible. Por ejemplo:

```text
[00FF00]TRÁMITES [FF0000]8 MESES
```

En **Solo etiqueta** se usa únicamente el color de etiqueta; en **Solo tiempo**,
únicamente el color del tiempo. Si los colores están desactivados, el mensaje se
envía sin etiquetas RGB, como antes.

## Plantillas personalizadas

Cada ruta acepta estas variables:

- `{total_minutes}` y `{total_hours}`
- `{hospitalario}`, `{tramites}`, `{transporte}`, `{vivienda}`, `{otro}`
- `{latest_minutes}`, `{latest_area}`, `{latest_comuna}`, `{latest_region}`
- `{latest_testimony}`

El mensaje final se normaliza a una línea y se limita a 80 caracteres visibles,
que es el máximo animado del firmware actual. Las etiquetas `[RRGGBB]` válidas
no cuentan para ese límite.

## Instalación fácil en Raspberry Pi OS Lite

Después de copiar o clonar el proyecto en la Raspberry Pi, ejecuta:

```sh
sudo bash scripts/install-raspbian.sh
```

El instalador:

- instala Node.js 22 cuando no hay una versión compatible;
- instala `arp-scan` para el monitor de dispositivos LAN;
- copia la aplicación a `/opt/rne-dashboard`;
- crea un usuario de sistema sin acceso interactivo;
- guarda la configuración en `/var/lib/rne-dashboard`;
- activa el inicio automático y muestra la URL final;
- crea una clave de administración para proteger los cambios de red y los
  envíos manuales a la impresora.

Para usar otro puerto para el dashboard:

```sh
sudo bash scripts/install-raspbian.sh \
  --port 4173
```

Puedes volver a ejecutar el instalador para actualizar la aplicación. Las rutas
de paneles se conservan.

La clave mostrada al terminar la instalación se solicita al cambiar la red o
enviar una impresión manual desde el dashboard. Raspberry Pi OS Bookworm usa
NetworkManager por defecto; si `nmcli` no está disponible, el dashboard muestra
la función como no disponible sin modificar la configuración de red existente.

El servicio puede elevar privilegios únicamente mediante el helper de red
instalado como `root`; el archivo de `sudoers` no autoriza otros comandos.

Comandos útiles:

```sh
sudo systemctl status rne-dashboard
sudo journalctl -u rne-dashboard -f
sudo systemctl restart rne-dashboard
```

## Impresora OKI

La integración usa esta configuración del servidor de impresión:

```text
Raspberry Pi / host UDP: 192.168.100.10
Puerto UDP:               5005
Estado:                   http://192.168.100.10:8080/healthz
Panel de control:         http://192.168.100.10:8080/
Codificación:             UTF-8
Tamaño máximo:            8.192 bytes
```

El servicio systemd instalado incluye las variables requeridas
`OKI_PRINTER_HOST`, `OKI_PRINTER_PORT` y `OKI_PRINTER_STATUS_URL`. El navegador
consulta el estado mediante `/api/printer/status`; nunca hace la consulta de
salud directamente al servidor OKI.

Cada datagrama UDP es un trabajo completo de texto plano. No se genera HTML,
PDF ni una imagen. El dashboard rechaza trabajos vacíos o mayores a 8.192 bytes
UTF-8, conserva saltos de línea y espacios, y cierra el socket después del
envío. La API manual protegida es:

```text
POST /api/printer/print
{ "text": "Texto para imprimir" }
```

Antes de cada envío, el trabajo se guarda atómicamente en
`printer-queue.json`. Si la Raspberry Pi de la impresora está apagada, el
endpoint de salud no responde, el dispositivo está desconectado o no se puede
escribir, el trabajo permanece en esa cola. El dashboard vuelve a comprobar el
servidor cada 8 segundos y vacía la cola en orden FIFO cuando está disponible,
sin superar la capacidad que informa el servidor OKI. La cola sobrevive tanto
a reinicios como a cortes de energía del dashboard.

La API RNE se revisa cada 30 segundos. En la primera ejecución se guardan los
IDs que ya existen como línea base y no se imprime el historial. Después, cada
entrada nueva se formatea en una sola página con todos los campos públicos
primero (`id`, fecha, área, tiempo, comuna y región) y el testimonio después. Un ID se
guarda en `printed-submissions.json` solamente después de que el sistema
operativo acepta el envío UDP. Los IDs que ya están en la cola persistente se
consideran pendientes y no se vuelven a agregar.

Para revisar el servidor y abrir su control:

```sh
curl http://192.168.100.10:8080/healthz
```

Abre `http://192.168.100.10:8080/` en un navegador. Para una prueba UDP manual:

```sh
printf 'RNE UDP TEST\nPrinter: OKI Microline 320\n' | nc -u -w 1 192.168.100.10 5005
```

UDP no tiene confirmación de entrega. **Enviado** significa que el datagrama
completo fue entregado por el dashboard a la pila de red rumbo a la Raspberry
Pi; no garantiza que el servidor lo haya encolado ni que la impresora haya
producido físicamente la página.

Si el panel muestra **Servidor offline**, comprueba alimentación, cable de red,
la IP `192.168.100.10`, el puerto `8080` y el servicio `oki-print-server` en esa
Raspberry Pi. Si muestra **Impresora desconectada**, revisa el cable USB y que
exista `/dev/usb/lp0`. Para **Error de permisos**, revisa el propietario y los
permisos de ese dispositivo y reinicia el servicio de impresión. La profundidad
de la cola, el trabajo actual, los reintentos y trabajos descartados aparecen
en el panel OKI del dashboard.

## Mapas RGB565

El dashboard incluye una ruta para **Mapa Gran Santiago 96×96** en
`192.168.100.23:5001` y otra para el panel **Mapa de Chile 16×96** en
`192.168.100.28:5001`. También pueden crearse o editarse desde la interfaz; al
seleccionar cualquiera de esas fuentes, el puerto cambia a `5001`
automáticamente. Cada 30 segundos el dashboard descarga directamente:

```text
/api/results/maps/gran-santiago.rgb565
/api/results/maps/chile.rgb565
```

Gran Santiago contiene 18.432 bytes RGB565 big-endian y Chile contiene 3.072
bytes. Ambos archivos se transmiten sin cambios: no se escalan, rotan,
transponen ni reordenan los píxeles. El Pico se encarga del mapeo físico.

El dashboard divide Gran Santiago en 18 datagramas y Chile en 3, todos con
cabecera `RGBU`. Espera 250 ms entre ellos, los envía en orden y espera la
confirmación exacta del controlador. Si no la recibe, reintenta el cuadro
completo con el mismo ID y registra el envío como error. **Reenviar** descarga
y envía el mapa inmediatamente.

La ruta de texto UDP `5000` continúa disponible para los demás tipos de panel.
El script `send_bitmap_udp.py` puede usarse para pruebas manuales con un archivo
RGB565 ya preparado:

```sh
python3 send_bitmap_udp.py gran-santiago.rgb565
```

El servicio principal implementa el protocolo directamente y no necesita
Python ni Pillow para reenviar el mapa de la API.

## Identidad visual

El dashboard utiliza el logo oficial y las tipografías Geist Sans/Mono empleadas
por [CHASKI](https://chsk.net). La interfaz es deliberadamente monocromática y
reserva el rojo de marca para la línea superior. Los recursos se guardan
localmente en `public/assets` para funcionar sin depender de Internet después de
instalarla.
