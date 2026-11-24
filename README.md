APLICACIÓN MÓVIL DE PARTES DE TRABAJO

EDICIÓN ERDELLA LOGÍSTICA
- Repositorio independiente para la cuenta GitHub goikola.
- Usuario de acceso: Logistica.
- Usuario administrador: iurdana.
- Las listas y los partes se guardan en cada dispositivo y se sincronizan para preparar los informes mensuales.

Contenido
- Aplicación web instalable (PWA) para Android.
- Funciona sin conexión después de instalarse.
- Guarda los partes en el propio teléfono.
- Exporta siempre los registros en un archivo Excel real (.xlsx).
- Envía un Excel separado por móvil con todos los partes del mes anterior el segundo día válido del mes (se excluyen domingos y festivos de Euskadi; se pueden añadir festivos locales).
- Incluye 10 conductores y 6 matrículas tomados de Logistica.xlsx.
- Las tareas disponibles son Varios, Eroski, STEF, Barroso, Integra, Recogidas y Otros.
- Al elegir Varios se pueden añadir tantas líneas de servicio como sean necesarias.

INSTALACIÓN EN ANDROID
1. Publique todos los archivos de esta carpeta en una dirección HTTPS.
   La opción más sencilla es GitHub Pages.
2. Abra esa dirección con Google Chrome en el móvil.
3. Pulse "Instalar" en la cabecera. Si no aparece, use el menú de Chrome
   (tres puntos) > "Añadir a pantalla de inicio" o "Instalar aplicación".
4. La aplicación quedará como un icono normal y funcionará sin conexión.

IMPORTANTE
- Los datos se almacenan únicamente en el navegador del teléfono.
- Antes de borrar datos de Chrome o cambiar de móvil, use "Exportar a Excel".
- Para compartir datos entre varios teléfonos haría falta añadir un servidor
  o una base de datos central.

PRUEBA EN UN ORDENADOR
No abra index.html directamente. Sirva la carpeta con un servidor local HTTPS
o con una plataforma de publicación web. Los service workers no funcionan
desde direcciones file://.
