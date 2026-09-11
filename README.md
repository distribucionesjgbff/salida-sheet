# Sincronización de stock · Mercado Libre MLA

Backend Node.js 24 para Railway, con Supabase como base operativa y Google Sheets como espejo. Incluye importación inicial, refresh selectivo, incremental, push, OAuth persistente, migración SQL y pruebas. Promociones, ventas y agrupación por SKU quedan fuera de esta fase.

**Estado de entrega:** código y configuración preparados; ninguna cuenta remota fue modificada. Aplicar la migración, autorizar ML, compartir la hoja y crear los dos servicios Railway requiere los accesos del proyecto. Las pruebas locales usan PostgreSQL mediante PGlite y dobles de las APIs; no acreditan una prueba contra el catálogo real.

## Puesta en marcha

1. Instalar Node.js 24. Ejecutar `npm ci` y copiar `.env.example` a `.env`.
2. Crear un proyecto Supabase dedicado. Completar `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` desde el proyecto. Es una clave exclusivamente de backend.
3. Copiar la conexión Postgres del panel **Connect** a `DATABASE_URL`, con SSL (`sslmode=verify-full`; configurar el certificado CA si lo exige el entorno). Usar conexión directa o Session pooler si se necesita IPv4. Ejecutar `npm run migrate`. El script aplica `migrations/001_init.sql` en una transacción y se detiene si ya existen tablas: nunca borra ni reemplaza una base existente. Esta variable se utiliza solamente para migrar, no en los cron.
4. Completar `ML_CLIENT_ID`, `ML_CLIENT_SECRET` y un `ML_REFRESH_TOKEN` nuevo para este backend, obtenido mediante OAuth de la misma app. Revisar la sección OAuth antes de hacerlo en paralelo con Apps Script.
5. Ejecutar `npm run import` manualmente. Verificar `sync_runs`, el número de ítems y algunos ejemplos con variaciones. Se puede repetir tras un fallo: hace upsert y conserva cambios locales pendientes. Nunca programar `full_import` como cron.
6. Ejecutar `npm run sync` dos veces con `PUSH_ENABLED=false` para verificar autenticación persistida y caché. El segundo run debe omitir detalles sin cambios. También probar una renovación real tras vencer el access token.
7. Configurar la hoja y ejecutar `npm run mirror` según la sección siguiente.
8. Crear los dos servicios Railway de la sección despliegue. Mantener `PUSH_ENABLED=false` durante la comparación. Para activar la escritura autorizada hacia ML, definir `PUSH_ENABLED=true` en el servicio sync y ejecutar una prueba controlada con una publicación.

Comandos disponibles:

```sh
npm run import
npm run sync
npm start -- refresh_selected MLA123456789 MLA987654321
npm run mirror
npm test
npm run check
```

`refresh_selected` actualiza detalles seleccionados mediante la misma caché; no envía cambios pendientes. `TASK` puede sustituir el argumento de CLI; el argumento tiene prioridad. Cada proceso termina al completar su trabajo. No hay servidor HTTP ni Apps Script nuevo.

## Esquema y cambios locales

La migración crea únicamente `items`, `sync_runs` y `ml_auth`, con RLS habilitado y sin políticas públicas. Revoca acceso a `anon`/`authenticated` y ejecución pública de las RPC. El backend opera con `@supabase/supabase-js` y `service_role`; no necesita conexión Postgres persistente.

`items` contiene todos los campos solicitados. Se agregan tres campos para distinguir la intención local del snapshot de ML:

| Campo | Uso |
| --- | --- |
| `stock_by_variation` | Objeto JSON: ID de variación → cantidad deseada. No es un mapa por SKU. |
| `stock_revision` | Versión creciente de la edición local para confirmar un PUT sin borrar una edición posterior. |
| `push_pending` | Indica una intención aún no confirmada, incluso si el último intento quedó en error. |

`available_quantity` de publicaciones con variaciones es la suma de sus cantidades. `variations_raw` conserva el array recibido, con todos sus atributos. El trigger rechaza su edición directa: se edita `stock_by_variation`. Los imports usan RPC para evitar generar un push por cada lectura de ML.

Ejemplo de edición de un ítem simple, desde una sesión administrativa de la base o un futuro panel con backend:

```sql
update public.items
set available_quantity = 12
where id = 'MLA123456789';
```

Ejemplo con variaciones: incluir **todos los IDs reales** de esa publicación. El trigger calcula el total automáticamente:

```sql
update public.items
set stock_by_variation = '{"11111111111": 4, "22222222222": 8}'::jsonb
where id = 'MLA123456789';
```

No se inventa una distribución del total. Si se cambia solo `available_quantity` y no coincide con las cantidades por variación, el push registra un error y conserva el pendiente. Esta es la regla acordada; el modelo por SKU vendrá después. Una edición idéntica al valor actual no crea una nueva intención.

`sync_runs` incluye los modos requeridos y un campo `task` para distinguir sync de espejo. Las corridas mirror se registran como `mode=incremental, task=mirror`. `items_processed` cuenta IDs únicos intentados, `items_failed` los IDs con error y `notes` incluye los ítems omitidos por caché. Cualquier error por ítem produce estado final `failed`, después de procesar el resto, y salida de proceso 1. Los contadores se guardan por lote o después de cada push.

`ml_auth` admite una sola fila (`id=1`) y guarda access token, refresh token, vencimiento, vendedor, marca de refresh inconcluso y leases por tarea. Nunca exponer esta tabla ni sus RPC a clientes públicos.

## Cómo funciona el incremental

1. Adquiere un lease `sync` compartido por import, refresh selectivo e incremental. Se renueva cada 30 segundos y antes de operar, con vencimiento a cinco minutos. Si se pierde, se abortan las solicitudes y las RPC rechazan confirmaciones del dueño antiguo. Un proceso posterior marca como fallidos los runs huérfanos de su tarea.
2. Envía pendientes primero, secuencialmente y con pausa configurable. Antes del PUT relee el ítem para comprobar vendedor y conjunto de variaciones. Si ya tiene las cantidades deseadas, confirma sin repetir el PUT. Después del envío verifica el resultado con GET.
3. Enumera todos los IDs mediante `search_type=scan`, agotando la paginación antes de descargar detalles para no consumir el cursor durante miles de GET. Incluye también los IDs ya conocidos: una publicación desaparecida queda visible como error, no se borra de la base silenciosamente.
4. Consulta `id,last_updated` por multiget de hasta 20 IDs. Si coincide con `last_ml_update_at` y el ítem está `ok`, omite el GET completo. Si es nuevo, cambió o tiene error, consulta el detalle. Los ítems pendientes nunca se sobrescriben con el pull.
5. Un PUT se confirma con comparación de `stock_revision`. Si alguien editó durante el envío, la nueva intención permanece pendiente para la próxima corrida.

ML search devuelve IDs, no una lista fiable de timestamps por ítem. Por eso **cache-first no significa cero GET**: hay consultas de metadatos en cada corrida. Para 2.600 ítems sin cambios son aproximadamente 27 páginas scan, 130 multiget y `/users/me`, más las operaciones OAuth que correspondan. No hay un filtro `updated_since` inventado ni un watermark que pueda omitir cambios. El polling tarda hasta la siguiente corrida en detectar novedades. Referencia: [ML: ítems, búsquedas y multiget](https://developers.mercadolibre.com.ar/es_ar/publica-productos/items-y-busquedas).

Para stock con variaciones, el PUT incluye **todas las variaciones existentes** de `variations_raw`, proyectadas a `{id, available_quantity}`. Se conserva el snapshot íntegro en Postgres, pero no se reenvían atributos ajenos al stock. Es el contrato documentado por ML: omitir IDs puede borrar variaciones. Si el conjunto remoto difiere del snapshot, se registra un conflicto y no se envía ese PUT. Referencia: [ML: variaciones](https://developers.mercadolibre.com.ar/es_ar/api-prediccion-categorias/variaciones).

ML no ofrece aquí una transacción compartida con Postgres ni un bloqueo contra otros escritores. La comprobación anterior al PUT reduce el riesgo por snapshots viejos, pero no puede impedir que otro sistema cambie variaciones entre GET y PUT. Evitar editar la estructura de variaciones simultáneamente. Los cambios de stock son valores absolutos; esta fase no lleva movimientos de ventas. Si ML no confirma las cantidades enviadas, queda un error pendiente y se reintenta en otra corrida; revisar `last_error` y desactivar push si otro escritor está compitiendo.

## Reintentos y OAuth

El wrapper de ML hace un intento inicial y hasta tres reintentos ante errores de red o 5xx, con pausas de 1, 4 y 16 segundos. También trata 429 y respeta `Retry-After` con un máximo de 60 segundos. Cada request tiene timeout de 30 segundos. Un 401 permite una única renovación y repetición; un 4xx permanente se registra. En multiget, los errores por entrada se resuelven mediante GET individual para aplicar el mismo manejo por ítem. Fallos globales de autenticación, base o lease terminan el run, porque continuar no sería operativo.

El refresh token de ML es de un solo uso. El backend lee el token vigente de `ml_auth`; `ML_REFRESH_TOKEN` solo se usa si todavía no existe uno en la base. Las corridas comparten el bloqueo de sync y las solicitudes concurrentes comparten una renovación en vuelo. El nuevo refresh token se persiste antes de continuar y se reutiliza el access token hasta dos minutos antes de su vencimiento. Nunca se imprimen tokens.

**Transición con Apps Script:** usar el mismo client ID/secret no implica compartir el mismo refresh token. No copiar el token activo que Apps Script continuará rotando. Obtener una autorización OAuth nueva para el backend y comprobar que ambas autorizaciones siguen funcionando. No revocar la autorización existente. La coexistencia de autorizaciones debe verificarse con la cuenta real; si ML invalida la anterior al reautorizar, mantener el motor nuevo detenido y resolver esa coexistencia antes de continuar. [ML: autenticación y autorización](https://developers.mercadolibre.com.ar/es_ar/saldo-de-la-cuenta/autenticacion-y-autorizacion).

Para generar un token nuevo, usar el flujo OAuth de la app existente con su `redirect_uri` registrado, permisos de lectura/escritura y acceso offline; intercambiar el authorization code una sola vez contra `/oauth/token` desde un entorno privado. Si la app exige PKCE, conservar y enviar el `code_verifier` de ese flujo. Cargar el refresh recibido en las variables privadas, nunca en Git ni en el chat. El bootstrap no necesita copiar la planilla anterior.

No existe atomicidad entre el POST OAuth de ML y una escritura en Postgres. Antes de renovar se persiste `refresh_in_progress=true`. Un timeout, caída del proceso o respuesta ambigua deja esa marca para evitar reutilizar a ciegas un token consumido. Se reintenta la persistencia de la misma respuesta hasta tres veces; **no se reintenta el POST OAuth rotativo**. Esto es una excepción deliberada al wrapper de reintentos de ítems.

Recuperación de OAuth inconcluso: detener el cron sync, obtener una autorización nueva y reemplazar de forma privada la fila `ml_auth` con el refresh nuevo, `access_token=null`, `expires_at=null`, `refresh_in_progress=false`. Conservar `seller_id` del vendedor original. No basta cambiar la variable Railway si ya existe un token en la base. Esperar a que no haya un lease activo y reactivar el cron. No modificar Apps Script durante este procedimiento.

## Google Sheets espejo

1. Crear una cuenta de servicio para este proyecto en Google Cloud y habilitar Sheets API.
2. Crear un documento nuevo de espejo y una pestaña dedicada `Stock (solo lectura)`. Compartir **solo ese documento** con el email de la cuenta de servicio como Editor. Dar a Fede acceso de Lector cuando la propiedad/administración del documento lo permita; si Fede es propietario, conserva sus privilegios y sus ediciones se sobrescriben.
3. Guardar el JSON de la cuenta en `GOOGLE_SERVICE_ACCOUNT_JSON` como un string JSON completo. No hace falta delegación de dominio ni Apps Script.
4. Definir `MIRROR_SHEET_ID` con el ID del documento y `MIRROR_TAB_ID` con el `gid` numérico de la pestaña. Es necesario para escribir un único batch sin una lectura previa para resolver el nombre.

Cada corrida lee todos los ítems de Supabase con paginación y hace **una llamada Sheets `spreadsheets.batchUpdate`**. Esa llamada ajusta la grilla de la pestaña dedicada y sustituye las cinco columnas; la fila 1 contiene el aviso y una nota, la fila 2 los encabezados. Los títulos se escriben como strings, no fórmulas. Se eliminan filas sobrantes si el catálogo se achica. No apuntar a una pestaña con contenido ajeno al espejo: se reemplaza su grilla. El encabezado `MLB` se conserva como fue pedido, pero los identificadores reales de Argentina son `MLA…` y se guardan sin transformar.

La cuenta de servicio puede necesitar además el intercambio de autenticación con Google; “una llamada” se refiere a la API de Sheets, no al total de solicitudes OAuth. El espejo tiene su propio lease y puede leer mientras el sync avanza; no promete una foto transaccional única de un catálogo que cambia durante la paginación. No copia secretos ni accede a la planilla vieja. [Google: batchUpdate y limpieza de rangos](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request).

## Despliegue en Railway

Publicar este repositorio en el Git remoto elegido y conectar **dos servicios al mismo repo, en el mismo proyecto Railway**:

| Servicio | Archivo Config as Code | Comando | Cron UTC |
| --- | --- | --- | --- |
| stock-sync | `/railway.sync.json` | `node src/index.js incremental` | `*/15 * * * *` |
| stock-mirror | `/railway.mirror.json` | `node src/index.js mirror` | `2,17,32,47 * * * *` |

Seleccionar el archivo de configuración correspondiente en Settings de cada servicio. Los archivos usan Dockerfile, no tienen healthcheck web y desactivan el reinicio automático. La importación inicial se ejecuta desde una terminal con las variables privadas del proyecto; no crear un tercer cron para importarla.

Variables compartidas por ambos: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Solo sync necesita las variables ML y `PUSH_ENABLED`. Solo mirror necesita las variables Google y de la hoja. `DATABASE_URL` no es requerida en Railway. `ML_GET_CONCURRENCY` admite 1–20 (default 20); `ML_PUT_DELAY_MS` vale 350 por defecto.

Railway omite el siguiente disparo si la ejecución anterior del mismo servicio sigue activa. Los cron se programan en UTC y no garantizan orden exacto: los dos minutos de desfase son una aproximación; si sync dura más, el espejo puede mostrar progreso parcial y converger en el siguiente ciclo. Revisar los eventos JSON `run.started`, `item.pull`, `item.push`, `item.error`, `ml.retry`, `oauth.refreshed` y `run.finished` en logs. [Railway: cron jobs](https://docs.railway.com/cron-jobs), [configuración como código](https://docs.railway.com/config-as-code/reference).

## Operación y comprobación real pendiente

Consultar estado desde una sesión administrativa:

```sql
select id, task, mode, started_at, finished_at, status,
       items_processed, items_failed, notes
from public.sync_runs order by started_at desc limit 20;

select id, available_quantity, stock_by_variation, push_pending, last_error
from public.items where sync_status = 'error' order by updated_at desc;
```

Un error no descarta intención local. Corregir cantidades por variación o el motivo de ML y el siguiente cron reintenta. Si cambió la estructura de variaciones y se decide **descartar la edición local** para volver a cargar ML, detener sync, guardar esa edición fuera de la tabla, establecer `push_pending=false, sync_status='pending'` para ese ID y correr `refresh_selected`. El pull restaurará el snapshot y las cantidades remotas; después reaplicar la intención sobre los IDs vigentes. No hacer esto para errores transitorios: esos se recuperan solos.

Antes de considerar activo el reemplazo, verificar con accesos reales:

- Migración aplicada en Supabase y acceso público denegado.
- Conteo de catálogo completo, incluyendo publicaciones con variaciones.
- Dos corridas consecutivas con tokens persistidos y otra después de su vencimiento.
- Cambio de stock simple y por variación confirmado por ML, conservando IDs de variaciones.
- Error controlado por ítem que no corte el resto y quede en `items`/`sync_runs`.
- Actualización de la hoja por cron y dos servicios finalizando correctamente.
- Comparación manual con Apps Script en modo `PUSH_ENABLED=false`; acordar el corte antes de dejar dos motores escribiendo el mismo stock.

Las pruebas automatizadas ejecutan la migración y los triggers en PostgreSQL/PGlite, y cubren caché, catálogo de 2.603 IDs, paginación de Supabase, preservación de intención local, concurrencia, variaciones, reintentos, rotación de tokens y espejo. No requieren credenciales. El archivo `package-lock.json` fija las dependencias utilizadas.
