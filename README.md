# RNE Panel Dashboard

Centro de control local para una Raspberry Pi 3. Consulta la API del Registro
Nacional de Espera cada 30 segundos, muestra el tráfico de las consultas y
envía texto a controladores `RGB_ETHERNET` mediante UDP.

## Qué hace

- Consulta `GET /api/results`, `GET /api/results/categories`,
  `GET /api/results.json` y `GET /health` cada 30 segundos.
- Muestra todas las solicitudes que este servicio realiza a la API. Mantiene
  en memoria las últimas 400 consultas, envíos UDP y
  cambios de configuración.
- Permite crear, editar, pausar, probar y eliminar rutas hacia paneles.
- Permite consultar NetworkManager, configurar DHCP o una IP estática y
  conectar la Raspberry Pi a una red Wi-Fi protegida.
- Detecta cada 60 segundos los equipos visibles en la LAN, intenta resolver sus
  hostnames y muestra IP, MAC, fabricante e interfaz.
- Puede asignar a cada panel el total, una categoría, la última espera, el
  último testimonio, el mapa de Gran Santiago o una plantilla personalizada.
- Guarda las rutas de paneles en `data/config.json` mediante escritura atómica.
  El archivo no se versiona.
- Envía texto UTF-8 al puerto UDP 5000, compatible con `../RGB_ETHERNET`.

UDP no incluye confirmación del receptor. Por eso «Enviado» significa que el
sistema operativo aceptó el datagrama, no que el panel confirmó su recepción.

## Ejecutar

Requiere Node.js 20 o posterior. No hay dependencias externas.

```sh
npm start
```

Abre `http://IP_DE_LA_RASPBERRY:4173`. Por defecto, se consulta la API pública
fija en `https://registronacionaldeespera.cl`.

El panel de administración no tiene autenticación y está pensado para una red
local confiable. No expongas el puerto 4173 directamente a Internet.

Variables opcionales:

```sh
PORT=4173 HOST=0.0.0.0 RNE_DATA_DIR=./data npm start
```

## Formato de tiempo

El dashboard toma los totales exactos en minutos de `/api/results` y
`/api/results/categories`. Usa `/api/results.json` para las entradas y
testimonios, pero no para sus acumulados redondeados. Internamente normaliza
todo a minutos. Para cada panel se puede elegir minutos, horas, días, meses,
años o conversión automática. La unidad siempre se agrega al final del mensaje.
Para la conversión se consideran 30 días por mes y 365 días por año.

La opción **Contenido** permite elegir entre **Etiqueta + tiempo**, **Solo
tiempo** y **Solo etiqueta**. Por ejemplo, un panel puede recibir `TRÁMITES 8
MESES`, `8 MESES` o solamente `TRÁMITES`. Los mensajes para paneles usan
números enteros sin decimales y un punto pequeño como separador de miles; por
ejemplo, `2.835 MIN`.

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
- crea una clave de administración para proteger los cambios de red.

Para usar otro puerto para el dashboard:

```sh
sudo bash scripts/install-raspbian.sh \
  --port 4173
```

Puedes volver a ejecutar el instalador para actualizar la aplicación. Las rutas
de paneles se conservan.

La clave mostrada al terminar la instalación se solicita solamente al cambiar
la red desde el dashboard. Raspberry Pi OS Bookworm usa NetworkManager por
defecto; si `nmcli` no está disponible, el dashboard muestra la función como no
disponible sin modificar la configuración de red existente.

El servicio puede elevar privilegios únicamente mediante el helper de red
instalado como `root`; el archivo de `sudoers` no autoriza otros comandos.

Comandos útiles:

```sh
sudo systemctl status rne-dashboard
sudo journalctl -u rne-dashboard -f
sudo systemctl restart rne-dashboard
```

## Mapas RGB565

Para un controlador configurado como **18 paneles (3×6 serpentine, 96×96)**,
crea una ruta y selecciona **Mapa Gran Santiago 96×96**. El puerto cambia a
`5001` automáticamente. Cada 30 segundos el dashboard descarga directamente:

```text
/api/results/maps/gran-santiago.rgb565
```

El archivo ya contiene los 18.432 bytes RGB565 big-endian finales. El dashboard
lo divide en 18 datagramas con cabecera `RGBU`, los envía en orden y espera la
confirmación del controlador. Si no recibe confirmación, reintenta el cuadro
completo una vez y registra el envío como error. **Reenviar** descarga y envía
el mapa inmediatamente.

La ruta de texto UDP `5000` continúa disponible para los demás tipos de panel.
El script `send_bitmap_udp.py` puede usarse para pruebas manuales con imágenes
locales, pero el servicio no necesita Python ni Pillow para reenviar el mapa de
la API.

## Identidad visual

El dashboard utiliza el logo oficial y las tipografías Geist Sans/Mono empleadas
por [CHASKI](https://chsk.net). La interfaz es deliberadamente monocromática y
reserva el rojo de marca para la línea superior. Los recursos se guardan
localmente en `public/assets` para funcionar sin depender de Internet después de
instalarla.
