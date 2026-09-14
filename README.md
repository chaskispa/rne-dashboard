# RNE Panel Dashboard

Centro de control local para una Raspberry Pi 3. Consulta la API del Registro
Nacional de Espera cada 30 segundos, muestra el tráfico de las consultas y
envía texto a controladores `RGB_ETHERNET` mediante UDP.

## Qué hace

- Consulta `GET /api/results.json` y `GET /health` cada 30 segundos.
- Muestra todas las solicitudes que este servicio realiza a la API. Mantiene
  en memoria las últimas 400 consultas, envíos UDP y
  cambios de configuración.
- Permite crear, editar, pausar, probar y eliminar rutas hacia paneles.
- Permite consultar NetworkManager, configurar DHCP o una IP estática y
  conectar la Raspberry Pi a una red Wi-Fi protegida.
- Detecta cada 60 segundos los equipos visibles en la LAN, intenta resolver sus
  hostnames y muestra IP, MAC, fabricante e interfaz.
- Puede asignar a cada panel el total, una categoría, la última espera, el
  último testimonio o una plantilla personalizada.
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

La API entrega todos los valores en minutos (`unidad_tiempo: "minutos"`). Para
cada panel se puede elegir minutos, horas, días, meses, años o conversión
automática. La unidad siempre se agrega al final del mensaje. Para la conversión
se consideran 30 días por mes y 365 días por año.

La opción **Mostrar etiqueta o área** permite elegir entre, por ejemplo,
`TRÁMITES 8,4 MESES` y solamente `8,4 MESES`.

## Plantillas personalizadas

Cada ruta acepta estas variables:

- `{total_minutes}` y `{total_hours}`
- `{hospitalario}`, `{tramites}`, `{transporte}`, `{vivienda}`, `{otro}`
- `{latest_minutes}`, `{latest_area}`, `{latest_comuna}`, `{latest_region}`
- `{latest_testimony}`

El mensaje final se normaliza a una línea y se limita a 80 caracteres, que es
el máximo animado del firmware actual.

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

La API RNE también publica mapas RGB565, pero el firmware `RGB_ETHERNET` recibe
por UDP solamente texto. Su endpoint HTTP `/bitmap` exige exactamente el tamaño
horizontal del controlador (`96×16`, `192×16`, etc.), mientras los mapas RNE
son `16×96` y `96×96`. Por eso esta versión no los reenvía automáticamente: se
necesita definir primero una transformación visual (rotación, recorte o
segmentación) y enviarla por HTTP, no por UDP.

## Identidad visual

El dashboard utiliza el logo oficial y las tipografías Geist Sans/Mono empleadas
por [CHASKI](https://chsk.net). La interfaz es deliberadamente monocromática y
reserva el rojo de marca para la línea superior. Los recursos se guardan
localmente en `public/assets` para funcionar sin depender de Internet después de
instalarla.
