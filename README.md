# CIUDADAN MEDIA PLAYER — Reproducción de YouTube con libVLC en Electron

Reproductor de escritorio para Windows 11 que reproduce **YouTube** dentro de una app **Electron**
usando **libVLC** como motor de reproducción (no IFrame, no sitio web embebido).

Cadena verificada de extremo a extremo:

```
URL de YouTube
   │  yt-dlp (resuelve URL directa + cabeceras; clientes: android → tv_embedded → web_embedded → mweb → ios)
   ▼
Proxy HTTP local en 127.0.0.1  (reenvía Range → respuesta 206 → libVLC puede hacer SEEK)
   │  streaming por chunks (NO se descarga el video completo)
   ▼
libVLC 3.0.23 (koffi/FFI)  →  libvlc_media_player_set_hwnd()  →  HWND de la ventana Electron
```

- Motor de vídeo: **libVLC** (`libvlc.dll` win64 portable dentro del proyecto).
- Puente Node.js ↔ libVLC: **koffi** (FFI), `src/vlc.js`.
- **Controles estilo YouTube sobre el vídeo**: una ventana propia, transparente y siempre encima
  (`renderer/yt-controls.html` / `yt-controls.js`) dibuja la barra flotante — scrim, progreso rojo,
  tiempo actual/duración, vista previa del tiempo al pasar el ratón, **anterior / play-pausa /
  detener / siguiente**, volumen con silenciador, **buscar (lupa)**, **lista** y pantalla completa —
  y **se auto-oculta a los 3 s** sin movimiento del ratón.
  Clic en el vídeo = play/pausa · doble clic = pantalla completa.
- **No hay segunda ventana de controles**: todo vive en la barra flotante (la ventana inferior
  se eliminó porque se solapaba con la barra de título y no se cerraba con la app).
- **Panel lateral con las listas REALES del usuario** (Favoritos, Ver más tarde y las que crees):
  se abre desde el botón *lista* de la barra y permite abrir una lista y reproducir sus vídeos.
  La lista fija de 8 vídeos (`src/playlist.js`) se conserva **sólo como respaldo** de los botones
  ⏮/⏭ cuando no hay cola ni elementos reales.
- **Botón de buscar (lupa)**: abre el **explorador multimedia** (`renderer/search/explorer.js`):
  buscador de YouTube con resultados reales, ficha de detalle, menú contextual por vídeo
  (reproducir, cola, reproducir a continuación, ver más tarde, guardar en lista, favoritos,
  compartir), **cola de reproducción** con arrastrar y soltar y **listas personales**
  persistentes. El componente es reutilizable tal cual en la futura página de inicio.
  - **Clic en una tarjeta = reproducir directamente** (ya no abre la ficha).
  - **Debajo de cada tarjeta**: *Cola*, *Favoritos*, *Más tarde* y *Más* (el resto de acciones).
  - **Pegar una URL válida de YouTube en el buscador carga y reproduce ese vídeo directamente**
    (no muestra una lista de resultados).
- **Cola y listas persistentes** (`src/store.js` + `src/queue.js`, un único JSON en `data/`):
  cola real (añadir, quitar, reordenar, vaciar, actual, autoavance al terminar) y listas
  (crear, renombrar, borrar, añadir/quitar/reordenar vídeos, reproducir, volcar a la cola),
  con **Favoritos** y **Ver más tarde** creadas automáticamente. Son locales de Ciudadan
  (no son las "Me gusta" de una cuenta de YouTube) y no tocan las colas del TTS.
- **Control desde Node.js**: API local autenticada en `127.0.0.1` con estado real del motor y eventos
  SSE (ver §6). El reproductor **no** decide ducking ni prioridades: sólo ejecuta y informa.
- **Volumen siempre a la vista y real**: al crear el reproductor se fija el volumen pedido (100 por
  defecto) con `libvlc_audio_set_volume`, y el sondeo **relee el volumen real del motor** cada
  segundo (la interfaz nunca muestra un valor optimista que difiera del que suena).
- Acceso directo del Escritorio: `Ciudadan Media Player - YouTube (libVLC).lnk` → lanzador firmado
  `%LOCALAPPDATA%\CiudadanMediaPlayer\CiudadanMediaPlayer.exe` (icono morado embebido).
  El lanzador **vive fuera de la carpeta del proyecto** porque Windows marcaba esa ruta como
  "adjunta" (Attachment Manager) y mostraba el aviso *"Advertencia de seguridad de Abrir archivo"*
  aunque el binario estuviera firmado y sin Mark of the Web; en `%LOCALAPPDATA%` (ruta nunca
  adjunta) arranca limpio. Junto al lanzador hay un `app-root.txt` con la ruta del proyecto.
  La ruta de arranque completa está firmada: lanzador **y** `node_modules/electron/dist/electron.exe`
  (Electron distribuye sus binarios sin firmar) con el certificado local, que está en
  `CurrentUser\Root` y `CurrentUser\TrustedPublisher` (`tools/sign-launcher.ps1`).
- **Una sola ventana en la barra de tareas**: la ventana de vídeo (`winVideo`) es la única con
  entrada en la barra de tareas; la barra flotante usa `setSkipTaskbar(true)` y comparte título con
  la ventana principal (se agrupan). El menú de la ventana (`File`, `Edit`, …) **sólo aparece al
  pulsar Alt** (`autoHideMenuBar: true`).
- **Recarga de URL** (`↻ Recargar`): vuelve a resolver la URL con yt-dlp — necesario porque las URLs
  de YouTube caducan (~6 h) y están ligadas a la IP.
- **Atajos de teclado**: espacio = play/pausa · ←/→ = ±10 s (Shift ±60 s) · ↑/↓ = volumen ±5 ·
  `F` = pantalla completa · `R` = recargar · `L` = foco en el campo URL.
  Como el vídeo lo pinta libVLC sobre un HWND nativo (que se queda con el foco del teclado), las
  teclas **con la ventana de vídeo enfocada** se atienden con atajos globales de Electron que se
  registran al enfocar y se sueltan al perder el foco (`registerVideoShortcuts()`), de modo que
  espacio/←/→/↑/↓/M/F funcionan mirando el vídeo, igual que en YouTube.
- **Diagnóstico en vivo** en la barra inferior: versiones de yt-dlp, FFmpeg, Deno y libVLC.
- Anti-bot de YouTube: se prueban varios `player_client`; `web_embedded`/`mweb` resuelven los retos
  JS de YouTube usando **Deno** (`jsc:deno`), que es el papel histórico de Deno en el sistema.
- **FFmpeg** 8.0 (`C:\ffmpeg\bin\ffmpeg.exe`) se usa para fusionar audio+vídeo cuando el formato
  elegido no viene muxado (modo *pipe*).

---

## 1. Rutas y archivos modificados / creados

Proyecto: `C:\yii\ciudadan-media-player`

| Archivo | Función |
|---|---|
| `src/main.js` | Proceso principal Electron: ventanas, IPC, auto-test y **test de UI real**, logging síncrono |
| `src/preload.cjs` | Puente `contextBridge` (`cmp.load/play/pause/stop/seek/setVolume/state/onUpdate`) |
| `src/resolver.js` | yt-dlp → URL directa + cabeceras; fallback a modo *pipe* |
| `src/proxy.js` | Proxy HTTP 127.0.0.1 con reenvío de `Range` (modo *range*) y modo *pipe* (`yt-dlp -o -`) |
| `src/vlc.js` | Enlace koffi a libVLC: `play/pause/stop/setTime/setVolume/getState` + eventos (FFI **asíncrono**, nunca bloquea el hilo principal) |
| `src/vlc-instance.js` | Crea la instancia de libVLC **fuera del hilo principal** (worker) para que la app no se congele al arrancar |
| `src/vlc-instance-worker.js` | Worker: precalienta los plugins de VLC (el antivirus no los analiza durante el escaneo) y crea la instancia |
| `src/paths.js` | Resolución de rutas (VLC portable win64, herramientas) |
| `src/tools-info.js` | Diagnóstico en vivo de yt-dlp / FFmpeg / Deno (mismo patrón de FDs que el resolver) |
| `src/control-api.js` | API local de control para el coordinador: HTTP en `127.0.0.1` + token + SSE de eventos |
| `src/playlist.js` | Lista de reproducción **hardcodeada** (8 vídeos verificados) que recorre la barra flotante |
| `src/store.js` | Almacenamiento persistente del usuario (listas, cola, historial) en un JSON con escritura atómica |
| `src/queue.js` | Cola de reproducción real: añadir, quitar, reordenar, vaciar, elemento actual, autoavance |
| `src/search/provider.js` | Interfaz `SearchProvider` + registro de proveedores (para añadir otros motores de búsqueda) |
| `src/search/ytdlp-provider.js` | Proveedor de búsqueda de YouTube con yt-dlp (búsqueda ligera + metadatos bajo demanda) |
| `renderer/search/explorer.css` | Estilos del explorador (modo oscuro, acento morado eléctrico) — reutilizables en el Home |
| `renderer/search/explorer-utils.js` | Utilidades del explorador: formato de duración/visualizaciones/fecha, iconos SVG, detección de URLs y miniaturas |
| `renderer/search/explorer-results.js` | Tarjetas de resultados, menú contextual por vídeo y ficha de detalle |
| `renderer/search/explorer-lists.js` | Cola y listas personales (con arrastrar y soltar para reordenar) |
| `renderer/search/explorer.js` | Explorador multimedia: buscador, pestañas, filtros, acciones y conexión con el motor (módulo reutilizable) |
| `CiudadanMediaPlayer.exe` | (movido) El lanzador firmado ahora vive en `%LOCALAPPDATA%\CiudadanMediaPlayer\` con un `app-root.txt`: en la carpeta del proyecto Windows lo marcaba como "adjunto" y mostraba el aviso de seguridad |
| `tools/launcher.cs`, `tools/sign-launcher.ps1` | Código fuente del lanzador y script que lo firma con el certificado local |
| `tools/test-control-api.mjs` | 25 comprobaciones de aceptación del API de control (las 12 del contrato) |
| `tools/test-yt-controls.mjs` | 25 comprobaciones de la barra estilo YouTube (overlay, área de contenido, auto-ocultado, clic, stop, anterior/siguiente, lista con scroll, modal, seek, vista previa, captura) |
| `tools/test-search.mjs` | 13 comprobaciones del bloque 3: búsqueda real, metadatos, reproducción desde resultados, cola, reordenación, autoavance, listas, persistencia, API, controles y TTS intacto |
| `tools/check-titlebar.ps1` | Verifica con Win32 que la barra flotante **no** tapa la barra de título (`WindowFromPoint` + rectángulos) |
| `tools/click-bar.ps1` | Clic **real** de ratón sobre un botón de la barra (posición calculada vía CDP) |
| `tools/check-close-all.ps1` | Comprueba que al cerrar la ventana de vídeo se cierra toda la app (sin ventanas huérfanas) |
| `tools/capture-new-ui.ps1` | Capturas de pantalla de la barra, de la lista lateral y del modal de búsqueda |
| `tools/capture-ui-overlay.ps1` | Capturas directas de la barra vía CDP (independientes de lo que haya en pantalla) |
| `renderer/video.html` | Ventana de vídeo 960×540 (destino del HWND de libVLC) |
| `renderer/yt-controls.html`, `renderer/yt-controls.js` | **Barra flotante estilo YouTube** sobre el vídeo: anterior, play/pausa, stop, siguiente, volumen, progreso rojo, buscar (modal), lista lateral con scroll y pantalla completa |
| `tools/test-libvlc.mjs` | Prueba headless de la cadena (resolver → proxy → libVLC) |
| `tools/test-videos.mjs` | Prueba multivideo (6 videos); cada video corre en un **proceso hijo aislado** con timeout |
| `tools/test-video-one.mjs` | Prueba de un video en proceso aislado (evita que un crash de libVLC tumbe la suite) |
| `tools/capture-evidence.ps1` | Captura de pantalla + medición de render/movimiento del vídeo |
| `tools/capture-bar.ps1` | Captura del vídeo con la barra flotante visible (mueve el ratón y captura) |
| `tools/check-desktop-icon.ps1`, `tools/icon-diff.ps1`, `tools/icon-colors.ps1`, `tools/icon-zoom.ps1` | Verificación del icono del Escritorio (resolución por Explorer, diferencia con el acceso directo oculto, color y zoom) |
| `tools/ocr.ps1`, `tools/ocr-boxes.ps1` | OCR nativo de Windows (texto y coordenadas) para inspeccionar capturas |
| `tools/probe-stop.mjs` | Sonda de símbolos de libVLC (`stop`, `set_media`, `stop_async`…) |
| `tools/download-vlc64.mjs` | Descarga del VLC portable win64 |
| `package.json` | `scripts`: `start`, `start:nosandbox`, `test:libvlc`, `test:videos`, `autotest` |
| `.vlc64/vlc-3.0.23/` | **VLC 3.0.23 win64 portable** (`libvlc.dll` + `plugins/plugins.dat`) |
| `assets/favicon-ciudadan-morado.ico` | Favicon/icono de la app (Ciudadan morado, 7 tamaños 16→256 px). Se aplica a las dos ventanas de Electron, al `<link rel="icon">` de las páginas y al acceso directo del Escritorio |
| `logs/` | `app.log`, `auto-test-result.json`, `ui-test-result.json`, `videos-test.json`, capturas |

Herramientas externas usadas (ya instaladas en la máquina, no modificadas):
`yt-dlp` (`C:\Python313\Scripts\yt-dlp.exe`), `Deno` 2.9.6, `FFmpeg` (`C:\ffmpeg\bin\ffmpeg.exe`),
VLC del sistema 32 bits en `C:\Program Files (x86)\VideoLAN\VLC` (**no usable**: Node/Electron son x64),
VLC portable win64 en `.vlc64\vlc-3.0.23` (el que se usa).

---

## 2. Ejecución

```powershell
cd C:\yii\ciudadan-media-player

# EN ESTA MÁQUINA (recomendado): el sandbox de Chromium no arranca en esta sesión
npm run start:nosandbox

# en un equipo normal
npm start

# abrir directamente
node_modules\electron\dist\electron.exe . --no-sandbox --user-data-dir=.electron-userdata
```

Uso: pegar la URL de YouTube en el campo superior y pulsar **▶ Cargar**. El vídeo se reproduce en la
ventana negra superior; la barra inferior controla Play/Pausa/Stop, la posición y el volumen.

> **Importante:** arrancar siempre con `--user-data-dir` propio del proyecto (ya incluido en los
> scripts). Un perfil de Electron corrupto en `%APPDATA%` provoca un crash `0xC0000005` del browser
> process **antes** de `app.whenReady()` (diagnosticado en esta máquina).

Pruebas automatizadas:

```powershell
npm run test:libvlc                       # cadena headless (Node, sin Electron)
npm run test:videos                       # 6 videos distintos + registro de errores

# auto-test dentro de Electron (URL y duración por variables de entorno)
$env:CMP_AUTOTEST_URL='https://www.youtube.com/watch?v=aqz-KE-bpKQ'
$env:CMP_AUTOTEST_SECS='45'
node_modules\electron\dist\electron.exe . --no-sandbox --user-data-dir=.electron-userdata --auto-test
# => logs/auto-test-result.json

# test de UI real (pulsa los botones del renderer)
node_modules\electron\dist\electron.exe . --no-sandbox --user-data-dir=.electron-userdata --ui-test
# => logs/ui-test-result.json

# evidencia visual (captura + medición de movimiento)
powershell -ExecutionPolicy Bypass -File tools\capture-evidence.ps1
```

---

## 3. Pruebas realizadas y resultados (Windows 11, 7/11/2026)

| # | Prueba | Resultado |
|---|---|---|
| 1 | `node tools\test-libvlc.mjs <url> 20` (headless) | **PASS** — `Playing`, avance 19.4 s, pausa congela, seek a 60 s → 63.7 s, volumen rc=0, 19.53 MB servidos |
| 2 | Electron `--auto-test` (Big Buck Bunny) | **PASS** — `pass:true`, `playingSeen:true`, `maxTime:140803 ms`, `seekOk:true`, `volOk:true`, `bytes:23 366 089`, modo `range`, cliente `android`, formato 18 (640×360), `exit=0` |
| 3 | Electron `--ui-test` (botones reales del renderer) | **PASS** — `loaded/paused/resumed/seekOk/volOk/stopOk/diagOk/reloadOk/fullscreenOk` = `true`; Pausa 701→701 ms (congelado), Play 701→3951 ms, Seek 50 % → 321.9 s, Volumen 40 → `get=40`, Stop → `Stopped`, Recarga → vuelve a reproducir, Diagnóstico → yt-dlp 2026.08.30.232658 / FFmpeg 8.0 / Deno 2.9.6 / libVLC 3.0.23 Vetinari, `exit=0` |
| 4 | Evidencia visual (`tools/capture-evidence.ps1`) | **RENDER CONFIRMADO** — ventana de vídeo 960×540: 95,2 % de píxeles no negros, 21 603 colores distintos, **83,3 % de píxeles cambian en 3 s**; barra de controles 960×92 justo debajo (y=578) con 293 colores y texto visible |
| 5 | `node tools\test-videos.mjs` (6 videos) | **6/6 PASS** — Big Buck Bunny, Me at the zoo (2005), Sintel, Tears of Steel, Rick Astley, Desert (4K). Todos con `modo=range`, `client=android`, `itag 18`, reproducción real, seek correcto y 1.0–27.0 MB transmitidos |
| 6 | Modo *pipe* (fallback `yt-dlp -o -`, con `CMP_FORCE_PIPE=1`) | **PASS** — reprodujo 12.6 s y transmitió 18.3 MB por stdout; sin seek (no hay `Range`), esperado |
| 7 | Salida limpia del proceso | `exit=0` en auto-test y UI-test (tras `vlc.stop()` + `vlc.dispose({safe:true})` antes de `app.exit()`) |
| 8 | **API de control** (`node tools\test-control-api.mjs`) | **25/25 PASS** — estado real del motor, pausa/play por API, volumen externo→slider y slider→volumen externo (vía CDP sobre la interfaz real), forward/rewind, barra de progreso sincronizada, eventos SSE (`stateChanged`, `volumeChanged`, `playbackStarted/Paused`, `positionChanged`), órdenes simultáneas, comando desconocido → 400, volumen fuera de rango → 100, posición negativa → error, id repetido no reejecuta, cierre/reapertura sin conexiones huérfanas, reconexión sin perder sincronía y TTS/DSH intactos (hashes de `AGENTS.md` sin cambios + DSH web accesible). **Latencia del API medida en soak: p50 17–18 ms, p95 24–43 ms, máx 612 ms** |
| 9 | **Barra estilo YouTube** (`node tools\test-yt-controls.mjs`) | **25/25 PASS** — la ventana superpuesta existe y ya **no hay ventana de controles aparte**; cubre sólo el área de contenido (944×531) y **deja libre la barra de título**; refleja el estado real (tiempo `0:03 / 10:34`, progreso, icono de pausa, 7 actualizaciones); **se auto-oculta a los 3 s**; clic en el vídeo = play/pausa; **stop** → `stopped`; **siguiente/anterior** cargan el elemento correspondiente (`aqz-KE-bpKQ ↔ jNQXAC9IVRw`); el **panel lateral muestra las listas reales** (`Favoritos`, `Ver más tarde`) y es navegable; **modal de búsqueda** con el foco en el campo; seek con la barra (1,7 s → 381,4 s) y vista previa del tiempo (`5:17`) |
| 10 | Render real **con la barra superpuesta** (`tools\capture-evidence.ps1`) | **RENDER CONFIRMADO** — ventana de vídeo: 95,2 % de píxeles no negros, 13 305 colores distintos, **85,1 % de píxeles cambian en 3 s**; el vídeo se ve a través de la ventana transparente de la barra. Capturas de la interfaz: `logs\ui-bar.png`, `logs\ui-lista.png`, `logs\ui-modal.png` (via CDP, `tools\capture-ui-overlay.ps1`) |
| 10b | **Prueba de resistencia** (`node tools\soak.mjs 10`) | **OK** — 10 min reproduciendo con sondeo del API cada 2 s (294 muestras): **0 bloqueos, 0 incoherencias, 0 errores**; latencia p50 17 ms / p95 43 ms / máx 612 ms; acciones (pause/play/seek/forward/rewind/volumen) en 16–185 ms. Tras eliminar la E/S síncrona, el watchdog del hilo principal no registra ningún atasco > 400 ms. El proxy corta un stream muerto a los 30 s y la vigilancia recarga el medio automáticamente |
| 11 | **Barra de título utilizable** (`tools\check-titlebar.ps1`) | **PASS** — la barra flotante empieza **57 px por debajo** del borde superior de la ventana de vídeo (deja libre el marco del sistema) y `WindowFromPoint` sobre la barra de título devuelve la **ventana de vídeo**, no la overlay: los clics de minimizar/cerrar/mover llegan al sistema |
| 12 | **Clic real de ratón** en la barra (`tools\click-bar.ps1`) | **PASS** — el ratón se mueve al botón *play* calculado vía CDP (DOM 62,464 → pantalla 195,561) y el clic real cambia el motor de `playing` → `paused` |
| 13 | Icono del Escritorio (`tools\check-desktop-icon.ps1` + `tools\icon-diff.ps1`) | **PASS** — Explorer resuelve el icono del `.lnk` (32×32, centro RGB 38,0,82, esquina transparente) y **lo dibuja en el Escritorio**: al ocultar el acceso directo (`attrib +h`) cambian 1 568 px en x=250–294, y=498–542, con colores de la gama Ciudadan (RGB 55,2,103 / 148,26,224) |
| 14 | **Atajos con teclado real** (`tools\test-shortcuts.ps1`) | **PASS** — con la ventana de vídeo enfocada: `espacio` → `playing → paused` → `playing`; `←` → 281,7 s → 273,1 s (−10 s); `M` → `muted=true`. El atajo se registra al enfocar el vídeo y se suelta al perder el foco |
| 15 | **Cierre completo de la app** (`tools\check-close-all.ps1`) | **PASS** — al enviar `WM_CLOSE` a la ventana de vídeo quedan **0 procesos de Electron** (antes 5): la barra flotante se cierra con la app y no queda ninguna ventana de controles huérfana |
| 16 | **Explorador / bloque 3** (`node tools\test-search.mjs`) | **16/16 PASS** (13 comprobaciones obligatorias + 3 de apoyo) — búsqueda real de *"Pink Floyd"* desde la interfaz (**20 tarjetas reales**: `k9ynZnEBtvw`, `Qr0-7Ds79zo`…), metadatos completos en las 8 primeras (miniatura `i.ytimg.com`, título, canal, duración `42:56`), **reproducción real de un resultado** (`playing`, `pos 0.0→3.0 s`, `url=…/watch?v=k9ynZnEBtvw`, `coincide=true`), **búsqueda mientras suena** (2ª búsqueda = 20 tarjetas y la posición sigue `3.0→16.5 s`), **3 vídeos añadidos a la cola** desde el menú contextual, **reordenación arrastrando y soltando** sobre las filas de la cola, **avance automático real** (`Me at the zoo` 19 s → `ended` → arranca solo `aqz-KE-bpKQ`), **Ver más tarde** (2 vídeos), **lista personalizada** creada y con vídeos, **persistencia tras cerrar y abrir la app** (colas y listas idénticas), **coherencia cola/estado por API**, **controles y volumen intactos** (42→42, seek, pausa/play) y **TTS/DSH intactos** (hashes de `AGENTS.md` sin cambios + DSH web accesible) |
| 17 | **Explorador — estado real del motor** (`tools\probe-explorer.mjs`) | **PASS** — tras pulsar *Reproducir ahora* el motor pasa a `playing` con `título="Pink Floyd - The Dark Side Of The Moon…"` y `url=…/watch?v=k9ynZnEBtvw`; el foco va al campo de búsqueda; el scroll infinito pide más resultados; las 7 acciones del menú contextual están presentes |

### 3.1 Almacenamiento del bloque 3

Un único fichero JSON (sin base de datos nueva), escrito de forma atómica (tmp + `rename`):

```
data/ciudadan-media-store.json
├── version
├── lists[]                 Favoritos (favorites) y Ver más tarde (watch-later) del sistema
│                           + listas creadas por el usuario (create/rename/delete/add/remove/move)
├── queue                   { items[], currentId, autoAdvance }   (orden, actual y autoavance)
└── history[]               reproducciones locales {id, title, url, duration, at}
```

- El `id` canónico de cada vídeo es **el id de YouTube** (no el hash interno del proxy).
- Las listas y la cola son **de Ciudadan** (locales): no son las "Me gusta" de una cuenta de YouTube
  y **no tocan las colas del TTS** (DSH1/DSH2 intactos, verificado por hash).

Evidencia clave en `logs/app.log` (auto-test dentro de Electron):

```
AUTO-TEST resuelto modo=range client=android format=18 res=640x360
                titulo="Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film"
AUTO-TEST hwnd: 980d760000000000
evento: Buffering → evento: Playing → LengthChanged (len=634.6s)
AUTO-TEST FIN: playing=true maxTime=631.4s seekOk=true volOk=true bytesProxy=23930708 -> PASS
```

Y del test de UI:

```
UI-TEST: reproducción tras Cargar = true estado= Playing t= 450
UI-TEST: Pausa -> estado=Paused t0=450 t1=450 pausedOk=true
UI-TEST: Play -> estado=Playing t=3701 resumedOk=true
UI-TEST: Seek 50% (317s) -> t=321.9s seekOk=true
UI-TEST: Volumen 40 -> get=40 volOk=true
UI-TEST: Stop -> estado=Stopped stopOk=true
```

---

## 4. Errores encontrados y cómo se resolvieron

| Error | Causa | Solución |
|---|---|---|
| `electron.exe` crash `0xC0000005` antes de `app.whenReady()` | perfil de usuario de Electron corrupto en `%APPDATA%` | `--user-data-dir=.electron-userdata` (propio del proyecto) |
| `npm start` no abre ventana en esta máquina (sí funciona con `--no-sandbox`) | el sandbox de Chromium no se puede inicializar en esta sesión | `npm run start:nosandbox` (deja el flag en el script y documentado) |
| La barra de controles quedaba **tapada** por otras ventanas | `setAlwaysOnTop(true,'screen-saver')` degrada el nivel en Windows | `setAlwaysOnTop(true)` con nivel por defecto; además la ventana de vídeo ya no se solapa con los controles |
| La captura de evidencia salía "negra" con el vídeo reproduciéndose | la ventana de vídeo estaba **tapada** por otra ventana y la captura del escritorio tomaba esa otra | el script ahora trae la ventana al frente (`SetForegroundWindow`) antes de medir |
| `Remove-Item .electron-userdata` fallaba con "archivo en uso" | el proceso anterior seguía terminando y con el perfil abierto | se mata Electron y se espera antes de limpiar; el perfil se puede reutilizar sin problema |
| La app muere al arrancar solo si se le pasa la URL como argumento posicional | Chromium interpreta el argumento (`?v=...`) y aborta | auto-test lee URL/duración de `CMP_AUTOTEST_URL` / `CMP_AUTOTEST_SECS` |
| `EPERM ... mkdtemp 'C:\Users\...\Temp\cmp-XXXXXX'` | el sandbox de Electron impide crear temporales en `%TEMP%` | temporal del proyecto: `.tmp/` (`CMP_TMPDIR` configurable) |
| `HTTP 409 Conflict` del proxy | el resolver caía a modo `pipe` (yt-dlp fallaba) y el proxy no lo servía | implementado modo *pipe* real (`yt-dlp -o -` → respuesta chunked) |
| yt-dlp: `HTTP 429 / Sign in to confirm you're not a bot` | anti-bot de YouTube | cadena de clientes `android → tv_embedded → web_embedded → mweb → ios` |
| `libvlc.dll` no carga desde `C:\Program Files (x86)\VideoLAN\VLC` | VLC del sistema es 32 bits y Node/Electron son x64 | VLC 3.0.23 **win64 portable** en `.vlc64\vlc-3.0.23` |
| `libvlc_new` tardaba 44 s | sin `plugins.dat` (escaneo de plugins en cada inicio) | generado `plugins.dat` con `vlc-cache-gen.exe plugins` |
| Crash `0xC0000005` al **salir** de la app | teardown de libVLC con el player pegado al HWND | `vlc.stop()` + `vlc.dispose({safe:true})` + 1 s antes de `app.exit()` → salida limpia (`exit=0`) |
| Crash `0xC0000005` en `libvlc_media_player_stop()/release()` con vídeos cortos (p. ej. "Me at the zoo", 19 s) | libVLC destruye el vout mientras el player sigue activo; el `stop`/`release` native no es recuperable desde JS | `dispose({safe:true})` no libera el player activo; en la suite headless cada video corre en un proceso hijo y termina sin liberar (el sistema operativo recupera los recursos) |
| `libvlc_media_player_stop()` se queda **bloqueado** (llamada FFI síncrona) | stop nativo puede no retornar con el vout `dummy` | nunca se llama `stop()` en estado `EndReached`; entre videos se deja que `play()` cambie el media (`libvlc_media_player_set_media`) en vez de liberar/recrear el player |
| `EPERM` al hacer `spawn` de yt-dlp con `stdio:'pipe'` | named pipes bloqueados en el sandbox | yt-dlp escribe a FDs de archivo real (`fs.openSync`) y se lee después |
| Windows SmartScreen/Defender avisaba de "aplicación no reconocida" al abrir el acceso directo | el aviso "**Advertencia de seguridad de Abrir archivo**" lo dispara el *Attachment Manager* cuando el binario conserva el estado "adjunto" (no depende del *Mark of the Web*: verificado que el `.exe` no lo tiene). Medido: **el mismo binario byte a byte** en `C:\yii\ciudadan-media-player\` se queda bloqueado con el aviso y en `%LOCALAPPDATA%\CiudadanMediaPlayer\` arranca limpio | el lanzador se **mueve a `%LOCALAPPDATA%\CiudadanMediaPlayer\`** (con `app-root.txt` → ruta del proyecto) y el acceso directo apunta allí. Además: lanzador **y** `electron.exe` firmados (Electron los distribuye sin firmar) con el certificado local en `CurrentUser\Root` y `CurrentUser\TrustedPublisher` (`Get-AuthenticodeSignature` = `Valid`) + reescritura con copia limpia (paso 6 de `tools/sign-launcher.ps1`). **Verificado**: la app arranca desde el acceso directo sin diálogos y el API queda vivo |
| El icono del acceso directo "no se veía" | Explorer ignora `IconLocation` si apunta a otro `.exe` y/o conserva la caché de iconos obsoleta del `.lnk` | `IconLocation` → `CiudadanMediaPlayer.exe,0` (icono embebido), `ie4uinit -ClearIconCache` + `-show`, y **verificación objetiva**: `SHGetFileInfo` devuelve el morado (38,0,82) y la diferencia de capturas con el acceso directo oculto demuestra que Explorer lo dibuja (1.568 px, x=250–294, y=498–542) |
| La app se cerraba al reanudar tras una pausa | `libvlc_media_player_pause()` **alterna** el estado y `play()` sobre un medio pausado reinicia el medio (ráfaga de eventos y caída nativa) | se usa `libvlc_media_player_set_pause()` (idempotente): reanudar = `set_pause(0)`, pausar = `set_pause(1)`, y se espera la confirmación del motor antes de responder |
| El API de control no arrancaba al reiniciar la app deprisa | el puerto lo tenía todavía la instancia anterior y `this.port` se comprobaba **antes** de asignarlo | `ControlApi.start()` reintenta el puerto con espera (12 intentos) y asigna `this.port` sólo cuando el servidor escucha de verdad |
| Los eventos del motor llegaban desordenados (`playbackPaused` después de `playbackStarted`) | libVLC postea los eventos de forma asíncrona | `scheduleEngineSync()` relee el estado **real** de libVLC y sólo emite si hay transición: sin eventos duplicados ni contradictorios |
| **La app se quedaba "congelada" (la UI no respondía y el API tardaba segundos)** | causa raíz medida: lecturas/escrituras **síncronas** de ficheros recién creados (`fs.readFileSync` del JSON de yt-dlp en el resolver y el buscador, `writeFileSync` del almacén al tocar la cola, `appendFileSync` del log en cada evento) — el antivirus analiza cada fichero nuevo en el primer acceso y esa E/S bloqueaba el hilo principal de Electron | todo pasado a **asíncrono** (`fs/promises`, escrituras del almacén encadenadas, log en buffer con volcado cada 500 ms y volcado síncrono al salir). Resultado medido (soak de 8 min, 237 muestras): latencia del API **p50 18 ms / p95 24 ms / máx 42 ms** (antes p95 615 ms, máx 2267 ms); acciones pause/play/seek/volumen en **16–20 ms** (antes hasta 2917 ms); cero bloqueos detectados por el watchdog. También: FFI siempre asíncrono (koffi `fn.async`, 0,117 ms/llamada medido), instancia de libVLC creada en worker con precalentado de plugins, mutex en `loadUrl` (todas las cargas en serie), watchdog del hilo principal que registra cada atasco en el log |
| **El vídeo se quedaba en negro / congelado** | dos causas: (a) el stream del proxy se quedaba colgado sin datos y libVLC esperaba para siempre; (b) al morir el stream, libVLC quedaba en estado *Paused*/*Stopped*, indistinguible de una pausa pedida por el usuario | (a) el proxy corta cualquier stream sin datos durante 30 s (ventana rodante) y registra el evento; (b) la vigilancia del medio distingue pausa/stop pedidos (`intentionalPause`/`intentionalStop`) de los provocados por el motor: si la posición no avanza 20 s en un estado que debería avanzar, recarga la URL actual (re-resuelve con yt-dlp, porque las URLs caducan). Tope LRU de 60 entradas en el proxy para no crecer en memoria |
| La barra de progreso iba a saltos con el sondeo a 1 s | el renderer escribía el valor tal cual le llegaba | el renderer **interpola** la posición con el reloj local (100 ms) a partir del último estado real |

---

## 5. Notas de diseño

- **No se descarga el vídeo completo**: el proxy sirve chunks y reenvía `Range`; en las pruebas se
  transmitieron 23.7 MB de un medio de 634 s (~60-100 MB) mientras se reproducía y saltaba.
- **Sin IFrame**: el motor es libVLC; el `renderer/video.html` sólo es el contenedor (negro) del HWND.
- **Barra estilo YouTube en una ventana propia**: libVLC pinta sobre un HWND nativo hijo, que queda
  **por encima del DOM** de la ventana de Electron; por eso el HTML no puede superponerse al vídeo.
  Solución: una `BrowserWindow` **transparente, frameless y always-on-top** con exactamente los
  límites del **área de contenido** de la ventana de vídeo (`positionOverlay()` en cada
  `move`/`resize`/pantalla completa).
  - **La barra se posiciona con `getContentBounds()`**, no con `getBounds()`: así la overlay empieza
    **57 px por debajo** del borde superior y **no tapa la barra de título** del sistema — se puede
    minimizar, mover y cerrar (verificado con `WindowFromPoint`, §3 fila 11).
  - El fondo es transparente salvo el scrim y la barra, así que **el vídeo se ve a través** (medido:
    95,2 % de píxeles no negros y 85,1 % en movimiento durante la captura con la barra puesta).
  - Auto-ocultado: el proceso principal sondea `screen.getCursorScreenPoint()` cada 150 ms; si el
    ratón está sobre el vídeo y se mueve, la barra aparece; tras 3 s sin movimiento se oculta
    (`cmp:overlay` → `body.hidden`). Al ocultarse **no** se pierde el clic en el vídeo.
  - La barra refleja el estado **real** del motor (mismo `cmp:update` que el panel) y todas sus
    acciones pasan por el mismo dispatcher que el API externo (`origin:"user"`), así que el
    coordinador ve los cambios manuales del usuario.
  - **Una sola superficie de control**: la ventana inferior se eliminó (se solapaba con el título y
    no se cerraba con la app). Todo —stop, anterior/siguiente, listas, búsqueda— vive en la barra.
  - **Una sola entrada en la barra de tareas**: la barra flotante usa `setSkipTaskbar(true)` y su
    `<title>` es el mismo que el de la ventana principal, de modo que Windows las agrupa y no
    aparece una segunda ventana "Controles" en la barra de tareas.
  - **El menú del sistema (File, Edit, …) sólo aparece al pulsar Alt** (`autoHideMenuBar: true`).
- **Lista de reproducción hardcodeada** (`src/playlist.js`): 8 vídeos verificados con `yt-dlp`
  (`logs/videos-test.json`, todos `ok:true`, modo `range`, `seekOk:true`). Se usa **sólo como
  respaldo** de ⏮/⏭ cuando la cola está vacía o el vídeo actual no está en ella. El panel lateral
  muestra **las listas reales** del usuario (Favoritos, Ver más tarde y las propias), con botón
  *atrás* para volver al listado de listas.
- **Buscador sobre yt-dlp, sin tocar el motor**: la búsqueda usa `ytsearchN:<consulta>
  --flat-playlist --dump-single-json` (búsqueda *ligera*: no resuelve formatos ni descarga nada);
  los metadatos completos se piden **bajo demanda** y con cliente (`mweb`/`android`) porque el
  cliente web de YouTube exige verificación. El texto del usuario viaja siempre como argumento
  de `spawn` (**nunca** interpolado en un shell) y la búsqueda corre en un proceso hijo, así que
  **el hilo de interfaz no se bloquea** y la reproducción actual no se congela. Una búsqueda
  nueva cancela la anterior (se mata el proceso hijo) y hay caché temporal de 60 s.
- **Cola y listas**: un único JSON en `data/ciudadan-media-store.json` con escritura atómica
  (tmp + rename). La cola guarda **referencias** (id canónico + metadatos): al añadir un vídeo
  **no se resuelve ni se descarga** su flujo; sólo se resuelve cuando toca reproducirlo.
  `next`/`previous` usan la cola cuando el vídeo actual está en ella **y la cola tiene elemento
  siguiente/anterior**; si no, conservan el comportamiento de la lista hardcodeada (así el botón
  *siguiente* de la barra nunca se queda sin hacer nada).
- **El cambio de medio no cuelga el motor**: al cambiar de vídeo se **corta el stream anterior del
  proxy** (`proxy.abortAll()`) antes de tocar libVLC. Sin esto, el `stop()` interno de libVLC
  esperaba al hilo de entrada (que seguía leyendo del socket) y **el proceso principal dejaba de
  responder** (la API moría durante el cambio). Además, durante el cambio se ignoran los errores
  del medio anterior, que son provocados por nosotros. Verificado: el motor sigue respondiendo y
  reproduciendo tras varios cambios seguidos.
- **El explorador es un componente, no una página**: `window.CMPExplorer.create({container, cmp,
  onClose})` monta toda la interfaz dentro del contenedor que se le pase y **no toca la barra**.
  Está partido en cuatro ficheros (`explorer-utils.js`, `explorer-results.js`, `explorer-lists.js`,
  `explorer.js`) para poder reutilizarlo tal cual en la futura página de inicio de Ciudadan Media.
  La cola, las listas y el historial viven en el **proceso principal**; el renderer sólo pinta.
- **Sin navegación, recomendaciones ni buscador de cuenta**: la app sólo busca en YouTube por
  texto y acepta URLs; no hay autenticación de YouTube ni recomendaciones personalizadas.
- **URLs con caducidad (~6 h) y ligadas a la IP**: el resolver se ejecuta en cada carga.
- **Deno** interviene de forma indirecta: `yt-dlp` lo usa como runtime JS para los retos de los
  clientes `web_embedded`/`mweb` cuando el cliente directo no basta.
- No se ha modificado TTS ni DSH1/DSH2.

---

## 6. API de control para el coordinador Node.js

El reproductor expone una **API local** (HTTP en `127.0.0.1`, con token) para que el
**Ciudadan Audio Coordinator** pueda consultarlo y mandarle órdenes. **El reproductor no decide
nada**: no aplica ducking, ni prioridades TTS, ni restaura volumen. Solo ejecuta órdenes y
comunica el estado real de libVLC.

### 6.1 Cómo se conecta el coordinador

Al arrancar, la app escribe `runtime/control-api.json`:

```json
{
  "service": "ciudadan-media-player",
  "playerId": "ciudadan-media-main",
  "host": "127.0.0.1",
  "port": 17890,
  "token": "…",
  "pid": 12345,
  "startedAt": "2026-11-08T16:00:00.000Z",
  "commands": ["play", "pause", "…"]
}
```

- Puerto por defecto `17890`; se puede fijar con `CMP_API_PORT` (si está ocupado se prueban los
  siguientes). Token por defecto aleatorio; se puede fijar con `CMP_API_TOKEN`.
- Todas las peticiones exigen `Authorization: Bearer <token>` (también vale `X-CMP-Token` o `?token=`).
  Sin token → **401**.
- `GET /health` es la única ruta sin token: sirve para saber si el reproductor está vivo.
  Si está cerrado, el coordinador recibe un error de conexión y debe tratarlo como "no disponible".

```js
// Cliente mínimo del coordinador
const fs = require('node:fs');
const { port, token, playerId } = JSON.parse(fs.readFileSync('C:/yii/ciudadan-media-player/runtime/control-api.json', 'utf8'));
const base = `http://127.0.0.1:${port}`;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const state = await (await fetch(`${base}/state`, { headers })).json();     // estado real
const r = await (await fetch(`${base}/cmd`, { method: 'POST', headers, body: JSON.stringify({ id: 'c1', command: 'setVolume', args: { value: 20 } }) })).json();
// r = { ok: true, id: 'c1', command: 'setVolume', result: { volume: 20 }, state: { … } }
```

### 6.2 Comandos

| Comando | Args | Efecto |
|---|---|---|
| `play` | — | Reproduce/reanuda (comprueba el `rc` de libVLC) |
| `pause` | — | Pausa (espera a que el motor confirme) |
| `stop` | — | Detiene |
| `togglePlay` | — | Alterna play/pausa según el estado real |
| `setVolume` | `{value}` 0–100 | Fija el volumen (recorta fuera de rango) |
| `getVolume` | — | Devuelve `{volume, muted}` |
| `volumeUp` / `volumeDown` | `{delta}` (5 por defecto) | Sube/baja el volumen |
| `mute` / `unmute` | — | Silencia / restaura (silencio real de libVLC) |
| `seek` | `{seconds}` | Va a una posición (recorta a la duración) |
| `forward` / `rewind` | `{seconds}` (10 por defecto) | Adelanta / retrocede |
| `getState` | — | Estado completo (sin efectos secundarios) |
| `fullscreen` | `{on?}` | Entra/sale de pantalla completa |
| `load` / `reload` | `{url}` | Carga o vuelve a resolver una URL de YouTube |
| `playlist` | — | Devuelve `{items:[…], index}` de la lista hardcodeada |
| `playIndex` | `{index}` | Carga y reproduce el elemento `index` de la lista |
| `next` / `previous` | — | Avanza/retrocede: en la **cola** si el vídeo actual está en ella; si no, en la lista hardcodeada |
| `search` | `{query, limit, offset}` | Búsqueda real vía el proveedor (`result.items`, `result.hasMore`) |
| `searchDetails` | `{id}` | Metadatos completos de un vídeo (bajo demanda) |
| `searchProviders` | — | Proveedores disponibles y sus capacidades reales |
| `getQueue` | — | Cola: `{items:[{id,title,position,current}], length, currentIndex, autoAdvance}` |
| `addToQueue` | `{item, position:'end'|'next'}` | Añade a la cola **sin resolver el vídeo** |
| `removeFromQueue` / `moveInQueue` / `clearQueue` | `{index}` / `{from,to}` / — | Quitar, reordenar y vaciar la cola |
| `setAutoAdvance` | `{on}` | Continuar con el siguiente al terminar el actual |
| `playQueueIndex` | `{index}` | Reproduce un elemento de la cola (resuelve entonces) |
| `getLists` / `getList` | `{id}` | Listas personales y su contenido |
| `createList` / `renameList` / `deleteList` | `{name}` / `{id,name}` / `{id}` | Gestión de listas (Favoritos y Ver más tarde son del sistema) |
| `addToList` / `removeFromList` / `moveInList` | `{listId,item}` / `{listId,itemId}` / `{listId,from,to}` | Vídeos de una lista |
| `playList` / `addListToQueue` | `{listId}` | Reproducir una lista (pasa a ser la cola) o volcarla a la cola |
| `getHistory` | `{limit}` | Historial local de reproducciones |

Cada orden se confirma con el estado resultante: `ok:false` + `error` si el motor la rechaza
(por ejemplo `posicion invalida: -5`). Un `id` repetido **no vuelve a ejecutarse** (se devuelve
el resultado anterior con `duplicate:true`).

### 6.3 Estado (forma del contrato)

```json
{
  "playerId": "ciudadan-media-main",
  "status": "playing",          // idle|opening|buffering|playing|paused|stopped|ended|error
  "volume": 65,
  "muted": false,
  "position": 125.4,            // segundos
  "duration": 635.2,            // segundos
  "seekable": true,
  "fullscreen": false,
  "videoId": "aqz-KE-bpKQ",
  "title": "Big Buck Bunny …",
  "url": "https://www.youtube.com/watch?v=…",
  "mode": "range",
  "connected": true,
  "stateVersion": 148,
  "error": null,
  "libvlcState": "Playing",
  "playlistIndex": 0,             // elemento actual de la lista hardcodeada
  "playlistLength": 8
}
```

Los valores salen del **motor** (`libvlc_media_player_get_state/get_time/get_length`,
`libvlc_audio_get_volume/get_mute`), no de variables de la interfaz.

### 6.4 Eventos en tiempo real (SSE)

`GET /events` mantiene un flujo `text/event-stream` con estos eventos:
`stateChanged`, `volumeChanged`, `playbackStarted`, `playbackPaused`, `playbackStopped`,
`positionChanged`, `mediaChanged`, `playbackEnded`, `playerError`, `playerDisconnected`.

Cada trama incluye `type`, `playerId`, `stateVersion`, `origin` (`api` | `user` | `system`),
`at` y el estado o payload correspondiente:

```
event: volumeChanged
id: 58
data: {"type":"volumeChanged","playerId":"ciudadan-media-main","stateVersion":58,
       "origin":"api","at":"…","volume":20,"muted":false,"state":{…}}
```

- `origin:"user"` = lo cambió el usuario en la ventana de controles; `"api"` = lo mandó el
  coordinador; `"system"` = transición detectada en el motor.
- `stateVersion` es monótono: sirve para descartar respuestas viejas.
- Los eventos `playback*` se derivan del **estado real** del motor (se relee libVLC y sólo se
  emite si hay transición), así que no llegan duplicados ni contradictorios.
- Al reconectar, el coordinador llama a `getState()` y queda sincronizado **sin alterar la
  reproducción** (una consulta de estado nunca arranca el vídeo).

### 6.5 Seguridad

- Escucha **sólo en `127.0.0.1`** (nunca en `0.0.0.0`), token obligatorio, comparación en tiempo
  constante, límite de 64 KB por petición y sin CORS.
- Una consulta de estado **no** inicia la reproducción.
- Si el reproductor está cerrado, el puerto deja de responder (el coordinador lo detecta con
  `GET /health` o por error de conexión).

---

## 7. Explorador multimedia (bloque 3): alcance y límites

**Lo que hace**

- Buscador de YouTube por texto (o pegando una URL) con resultados **reales** y paginación por
  scroll; una búsqueda nueva **cancela** la anterior y el render no se congela.
  - **URL pegada = reproducción directa**: si lo que se escribe en el buscador es una URL válida de
    YouTube, se resuelve y **reproduce ese vídeo** sin mostrar resultados.
- Tarjeta por resultado con miniatura, título, canal, visualizaciones, fecha (si existe),
  duración y descripción; distintivo **EN DIRECTO** para los vídeos en vivo.
  - **Clic en la tarjeta = reproducir ahora**; debajo hay una fila de acciones rápidas
    (*Cola*, *Favoritos*, *Más tarde*, *Más*).
- **Menú contextual** por vídeo: *Reproducir ahora*, *Agregar a la cola*, *Reproducir a continuación*,
  *Ver más tarde*, *Guardar en lista*, *Favoritos*, *Compartir* (copia el enlace), *Ver detalles*.
- **Ficha de detalle** con los metadatos disponibles y enrichment bajo demanda.
- **Cola** con reordenación **arrastrando y soltar**, quitar, reproducir, vaciar y
  **avance automático** al terminar el vídeo actual.
- **Listas personales** (crear/renombrar/borrar/añadir/quitar/reordenar/reproducir/volcar a la cola),
  con **Favoritos** y **Ver más tarde** creadas de fábrica y no editables.
- Todo **persistente** en `data/ciudadan-media-store.json` y sobrevive al cierre de la app.

**Límites reales (no se disimulan)**

- **Filtros**: sólo se ofrece el de **duración**, porque es el único que el proveedor puede aplicar
  sobre datos reales. La búsqueda ligera de `yt-dlp` **no devuelve fecha de publicación**
  (se comprobó con el cliente por defecto y con `mweb`), así que **no se ofrece un filtro de fecha**
  inventado; la fecha sí aparece en la ficha cuando los metadatos bajo demanda la traen.
- La búsqueda tarda **~7–90 s** y la resolución de un vídeo **~20–90 s** (depende de YouTube y del
  cliente): la interfaz muestra el estado de carga y nunca se bloquea el hilo de la UI. Cuando
  YouTube ralentiza las peticiones, el proveedor reintenta con otros clientes (`mweb`, `android`)
  dentro de un **plazo global de ~3,5 min** y distingue el mensaje *"tiempo de espera agotado"* de
  una cancelación real.
- La **paginación no cancela la búsqueda en curso** (`cancelPrevious:false`): pedir la página 2
  mientras se carga la 1 no invalida los resultados ya obtenidos.
- YouTube puede pedir verificación ("Sign in to confirm you're not a bot") con el cliente web: el
  proveedor prueba automáticamente con otros clientes (`mweb`, `android`).
- No hay cuenta de YouTube: **Favoritos** y **Ver más tarde** son locales de Ciudadan, no las "Me
  gusta" de YouTube.
- La cola y las listas son **de Ciudadan**: no se sincronizan con ningún servicio externo ni con las
  colas del TTS (DSH1/DSH2 siguen intactos, verificado por hash en las pruebas).
- No se ha implementado todavía la **página de inicio** de Ciudadan Media: los componentes del
  explorador están ya separados (`explorer-utils.js`, `explorer-results.js`, `explorer-lists.js`,
  `explorer.js`) para montarlos allí sin duplicar interfaz.

---

## 8. Sprint: reproducción inteligente, subtítulos, búsqueda avanzada e historial persistente

Añadido sobre lo existente **sin eliminar ni degradar nada** (las suites anteriores siguen en verde:
`test-control-api` 25/25, `test-yt-controls` 25/25, `test-search` 16/16). Un único reproductor
libVLC; todo persiste en `data/ciudadan-media-store.json` (migración automática de esquema v1→v2,
sin pérdida de datos; nunca `localStorage` como almacén principal).

### 8.1 Qué se añadió

- **Modos de contenido** en el explorador: `[Música] [Temas] [Personalizado]`.
  - *Personalizado*: slider 0–100 % de música con % complementario automático, cantidades
    opcionales por ciclo (2 música / 1 tema ≈ 67/33 coherente con el slider), vista previa,
    presets 50/50 · 70/30 · 30/70, aplicar/restablecer. La mezcla usa **Bresenham ponderado**
    (`src/mix.js`): 70/30 produce exactamente el 70,00 % a 1000 selecciones, sin rachas largas
    del mismo tipo (máx. 3 seguidas a 70/30), con saldo acumulado y recuperación progresiva
    cuando falta una categoría. La **cola manual siempre gana**.
  - Clasificación por categorías/metadatos de yt-dlp (`src/classifier.js`), sin IA.
- **Continuidad** (`[Solo este] [Continuo]` en la barra): al terminar, prioridad
  cola manual → cola automática preparada (≤3 candidatos desde metadatos) → descubrimiento
  (fuente: Mi búsqueda / Mismo canal / Explorar tema / Descubrimiento; el tema sale de
  metadatos/palabras clave, **no** de `relatedToVideoId`). Los errores nunca detienen la
  reproducción y no hay transiciones END duplicadas. Verificado en real: `solo` no avanza;
  `continuo` avanza solo al terminar (zoo → siguiente vídeo, `playing`).
  - **Sigue reproduciendo aunque no haya ninguna búsqueda activa** (el caso de pegar una URL
    directa): si la fuente configurada no devuelve candidatos, la continuidad degrada a
    *relacionados por metadatos* (tema del título, canal, categoría) y, si tampoco, prueba las
    demás fuentes antes de detenerse. Además se **preparan ≤3 candidatos al cargar** cada medio
    (en segundo plano, sólo metadatos) para que el siguiente arranque sin espera.
- **Subtítulos reales (CC)** con libVLC, no IFrame: botón `[CC]` + selector de idioma en la
  barra; descarga la pista preferida (es → en) de los metadatos de yt-dlp a `.vtt` local y la
  engancha con `:input-slave=file:///...` (con streams HTTP `sub-file=` **no** engancha;
  verificado con sonda), selecciona la pista SPU real tras el parse con
  `libvlc_video_set_spu` y permite desactivarla (-1). Preferencias persistentes.
  Verificado en la app real: `getSubtitleTracks` → pista real `id=2` seleccionable y
  `setSubtitleTrack(-1)` → `selected=-1` en `/state`.
- **Búsqueda avanzada** (`[Filtros]`): popover construido desde las `capabilities` reales del
  proveedor — tipo (los shorts se marcan como filtro **local**), fecha (incl. rango
  personalizado vía `--dateafter/--datebefore`), duración, características (CC/HD/SD/licencia/
  en vivo), orden, canal/idioma/región/embeddable; cada control etiqueta si es del **proveedor**
  (parámetro `sp` de YouTube) o **local**; debounce, badge con nº de activos, restablecer,
  persistencia, navegación por teclado y cierre con clic fuera/Escape.
- **Historial persistente** (`[Historial]`): esquema rico por reproducción
  (`provider:sourceId`, título, canal, miniatura, url, duración, firstPlayedAt/lastPlayedAt,
  playCount, positionMs, estado started/partial/finished, clasificación, contexto de búsqueda).
  Guardado con throttle (mín. 4 s) + forzado en pausa/stop/seek/cierre; **reanuda desde la
  última posición**; panel con pestañas Todos/Música/Temas/Pendientes/Terminados, búsqueda
  **100 % local** en vivo, filtros, orden, paginación (30/vista, límite 200 en API), acciones
  (▶ reproducir, ⏩ continuar, ➕ cola, 🔍 relacionados, 🔁 repetir, 🗑 borrar), limpiar por
  período, limpiar todo con confirmación y **exportar JSON**. Historial de búsquedas aparte
  (consulta/fecha/filtros/modo/resultados, recientes, repetir, deduplicado, local).
- **Rendimiento**: un solo player (nunca se recrea al cambiar filtros/prefs), sin red
  periódica durante la reproducción (sólo sondeo local del motor), escrituras de historial
  con throttle, miniaturas lazy, búsquedas con debounce y cancelación de las obsoletas,
  descubrimiento sólo al terminar.

### 8.2 Archivos nuevos / tocados del sprint

| Archivo | Aporte |
|---|---|
| `src/classifier.js` | Clasificación música/tema por metadatos (categoría, título, canal VEVO/Topic/…) |
| `src/mix.js` | Mezcla personalizada Bresenham ponderada (ratio exacto, anti-rachas, recuperación) |
| `src/history.js` | Historial de reproducción + historial de búsquedas (throttle, migración, búsqueda local, export) |
| `src/discovery.js` | Temas desde metadatos y candidatos de descubrimiento por fuente |
| `src/continuity.js` | Motor de continuidad (solo/continuo, prioridades, dedupe de END, tolerante a errores) |
| `src/subtitles.js` | Selección/descarga de pistas .vtt (con "warm read" anti-AV) y limpieza |
| `src/store.js` | Esquema v2: `prefs` (contentMode, mix, continuity, subtitles, filters) + `searchHistory` |
| `src/resolver.js`, `src/search/ytdlp-provider.js` | Metadatos enriquecidos; filtros `sp` de proveedor + filtros locales (duración, shorts, canal) |
| `src/vlc.js` | SPU real: `getSubtitleTracks` (lista enlazada koffi, struct a nivel de módulo), `setSubtitleTrack`, `getSpuCountRaw` |
| `src/main.js`, `src/control-api.js`, `src/preload.cjs` | Nuevos comandos API/IPC (`getPrefs`, `setContentMode`, `setContinuity`, `setSubtitlePrefs`, `getSubtitleTracks`, `setSubtitleTrack`, `queryHistory`, `playHistory`, `classify`, `setFilters`, …); `/state` expone los 5 campos del sprint |
| `renderer/search/explorer-sprint.js` | UI del sprint: modos, popover de mezcla, popover de filtros, panel de historial |
| `renderer/search/explorer.js`, `explorer-utils.js`, `explorer.css` | Integración (botones Filtros/Historial, pestaña Historial, filtros por modo, insignias de clase) |
| `renderer/yt-controls.html`, `yt-controls.js` | Botones `[CC]`+idioma+`[Solo/∞]`+fuente en la barra con sus popovers |
| `tools/test-services.mjs` | **65/65 PASS** — unitarias de classifier, mix (70/30 exacto, maxRun, fallback/recuperación), history, continuity (incl. "sin búsqueda activa → continúa con relacionados" y degradación de fuentes), discovery (relacionados por metadatos), filtros sp/local |
| `tools/test-sprint-ui.mjs` | **41/41 PASS** — integración real con app viva: reproducción verificada, caso del usuario (URL directa sin búsqueda → sigue con un relacionado), solo/continuo, CC SPU real, historial/playHistory, filtros persistentes, UI vía CDP |
| `tools/probe-spu.mjs` | Sonda aislada de libVLC (file:// vs HTTP; demostró `input-slave` y el fix de `koffi.address`/decode) |
| `tools/final-check.mjs` | Verificación final: `playing` con posición avanzando (0→4200 ms) y volumen 100 vía API |
| `tools/verify-continuity.mjs` | Verificación **en vivo** de la continuidad en la app real (sin autotest): carga una URL directa sin ninguna búsqueda previa y comprueba que al terminar **sigue con otro vídeo** |

### 8.3 Resultados de pruebas reales (12/11/2026)

| Suite | Resultado |
|---|---|
| `node tools\test-services.mjs` | **65/65 PASS** |
| `node tools\test-sprint-ui.mjs` | **41/41 PASS** (exit 0) — incluye **el caso reportado por el usuario**: vídeo cargado por URL directa **sin búsqueda previa** → al terminar **sigue con un vídeo relacionado** (`cola automática -> Me at the zoo … @jawed` en el log real); CC SPU real en reproducción (`selected=2` pista real, `-1` desactiva); avance continuo real (zoo → siguiente), modo solo sin avance, historial persistente + búsqueda local + export, `playHistory` sin duplicar (playCount +1), filtros sp persistentes, UI completa vía CDP |
| `node tools\test-control-api.mjs` | **25/25 PASS** (sin regresión) |
| `node tools\test-yt-controls.mjs` | **25/25 PASS** (sin regresión) |
| `node tools\test-search.mjs` | **16/16 PASS** (sin regresión) — incluye la reproducción real desde la tarjeta (`playing`, `pos 0.0→1.0 s`, `coincide=true`) y el avance automático al terminar (`Me at the zoo` → `aqz-KE-bpKQ` en `playing`) |
| `node tools\verify-results.mjs "pink floyd"` | **4/4 PASS** — reproducción de **resultados de búsqueda** uno tras otro, 15 s de observación sostenida por vídeo (posición avanzando) y recuento de atascos del hilo principal |
| `node tools\final-check.mjs` | **PASS** — `playing`, posición 0→4200 ms avanzando, `volumen=100` vía API |

### 8.4 Limitaciones reales de YouTube/yt-dlp/libVLC (no disimuladas)

- Los **shorts** no tienen parámetro `sp` propio en la búsqueda de resultados: se filtran en
  **local** por `/shorts/` en la URL y se marcan como tales en la UI.
- Los filtros de resolución (4K/HDR/360) son aproximados (`sp` de YouTube); la duración se aplica
  siempre en local además del `sp`.
- Con streams HTTP, la opción `:sub-file=` de libVLC **no engancha** la pista externa: hay que
  usar `:input-slave=file:///...` (verificado con `tools/probe-spu.mjs`).
- Las pistas SPU aparecen sólo tras el parse del medio (sondeo con reintentos en la barra).
- El nombre de la pista externa en VLC en español es genérico ("Pista 1"): el idioma se conoce
  por la descarga, no por el nombre de la pista.
- Un `.vtt` recién creado lo escanea el antivirus en el primer acceso; si libVLC lo abre antes,
  el slave no engancha: se "calienta" el fichero con una lectura async tras escribirlo.
- yt-dlp puede tardar >90 s en búsquedas con `sp` en este entorno (reintentos con otros
  clientes); la ruta `sp` está cubierta por pruebas unitarias cuando la red es lenta.
- TTS/STT, DSH1/DSH2 y todas las funciones previas siguen intactos (hash de `AGENTS.md`
  sin cambios en cada suite; sólo se añade al ledger espejo append-only).

### 8.5 Corrección de "no está sirviendo la reproducción de los resultados" (15/11/2026)

Informe del usuario: al pulsar un resultado de búsqueda no se servía la reproducción. No era un
solo fallo, sino cinco encadenados (todos diagnosticados con evidencia del log y medidos):

| # | Causa raíz | Evidencia | Corrección |
|---|---|---|---|
| 1 | **El log bloqueaba el hilo principal**: cada volcado re-abría `app.log` y el antivirus tardaba hasta **5,4 s** por escritura | `ATASCO: … 2310 ms \| escrituraLog=571ms lentas=[478,662,571]` | Log con **handle persistente** (`createWriteStream`): se abre una vez. Atascos: **112 → 8** |
| 2 | **El proxy tomaba el 416 del CDN como error**: libVLC pide `bytes=69744848-` (un byte **tras** el final = fin de stream normal) y el proxy cortaba el vídeo | `proxy: upstream 416 … range=bytes=69744848-` | El 416 de fin de stream se responde **como EOF** (416 + `Content-Range`); si la URL caducó, se reintenta sin `Range` |
| 3 | **El vigilante no recuperaba un medio sin datos**: con libVLC en *Buffering/Opening* reiniciaba su propio contador y jamás disparaba | `MEDIO COLGADO` ausente pese a 30 s sin datos | El vigilante atiende también `opening/buffering` (30 s) |
| 4 | **El resolver no tenía presupuesto**: 90 s por cliente × 7 clientes = hasta **6 min 47 s** esperando y caída a modo *pipe* (sin reproducción) | `avisos del resolver: yt-dlp timeout (android) \|\| … (7)` | `android` + `mweb` **en paralelo**, timeout por cliente, **presupuesto global de 75 s** y **caché de resolución 10 min** |
| 5 | **Llamadas FFI síncronas a libVLC en el hilo principal** (`media_new_location`, `new_from_media`, `set_media`) | `SONDEO LENTO: sync=3202 ms` | Todas las FFI del ciclo de reproducción van al **hilo worker de koffi** |

Además, el proxy limita el **caudal de descarga a 8 MB/s** (el CDN entrega el vídeo entero a toda
velocidad y ese trabajo de red/JS en el hilo principal lo retrasaba ~1 s por ciclo) y el
*discovery* lanza sus consultas **en paralelo con presupuesto de 45 s** (antes iban en serie:
3-4 × 60-120 s).

**Verificación real** (`tools/verify-results.mjs`, app Electron viva, vídeos de YouTube reales):

```
búsqueda "pink floyd": 4 resultados
OK   k9ynZnEBtvw "Pink Floyd - The Dark Side Of The Moon"  estado=playing pos 0.0s -> 13.7s (15 s observados)
OK   84Tq-eAJIk4 "Pink Floyd - Wish You Were Here"         estado=playing pos 0.0s -> 15.0s (15 s observados)
OK   ai_gI0Jbr_E "Pink Floyd - Pulse"                       estado=playing pos 0.0s -> 16.0s (15 s observados)
OK   YZzkonEf6Jg "Pink Floyd Collection #Blues #Rock"       estado=playing pos 0.0s -> 14.0s (15 s observados)
RESULTADOS: 4/4 sirven reproducción real
ATASCOS del hilo principal en esta sesión: 1
```

Suites tras la corrección: **65/65** (`test-services`), **16/16** (`test-search`, incluida la
reproducción desde la tarjeta y el avance automático al terminar), **41/41** (`test-sprint-ui`).
El test de búsqueda ahora fija él mismo el modo de continuidad (antes dependía de las
preferencias que dejaba la ejecución anterior: en modo "solo este" no encadena por diseño).

