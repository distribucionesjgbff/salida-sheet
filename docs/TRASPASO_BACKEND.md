# Traspaso técnico: salida-sheet

Estado verificado el 15 de septiembre de 2026. Documento para continuar el desarrollo o construir una interfaz/implementación alternativa en paralelo. No contiene contraseñas, claves API, tokens ni códigos OAuth. Los identificadores y URLs de proyecto aquí incluidos no otorgan acceso por sí solos.

## 1. Qué estamos construyendo

Un reemplazo del motor de sincronización de stock de un vendedor de Mercado Libre Argentina (sitio MLA). El sistema anterior corre en Google Apps Script y administra más de 2.600 publicaciones, muchas con variaciones. El motivo de la migración es dejar de depender de la cuota diaria de UrlFetchApp.

La carga inicial toma el catálogo de Mercado Libre. Después, Supabase conserva tanto el último snapshot remoto como las cantidades deseadas editadas localmente. El motor envía cambios pendientes a ML y actualiza los datos remotos que hayan cambiado. La planilla nueva será solo un espejo.

```text
                        IMPLEMENTACIÓN ACTUAL / PREVISTA

Mercado Libre API <----> Node.js 24 (jobs) <----> Supabase / PostgreSQL
                              |                         |
                     Railway: pendiente                 |
                                                        v
                                           Job Node.js de espejo
                                                        |
                                                        v
                                             Google Sheets nuevo
                                            (espejo, no entrada)

                          EXTENSIÓN POSIBLE, NO EXISTE AÚN

Navegador <----> Panel privado + API autenticada <----> Supabase
                  Sin secretos en el navegador
```

El backend actual es un conjunto de procesos por tarea que terminan al completar su trabajo. **No existe aún un sitio web, login, dashboard ni API HTTP de administración.** `npm start` corre un job; no levanta una web. El único servidor HTTP incluido es un receptor temporal para completar OAuth, no una interfaz de gestión.

No se implementaron promociones, ventas, Telegram, movimientos de inventario ni stock unificado por SKU. El usuario acordó explícitamente cantidades por ID de variación y dejar la separación por SKU para después.

## 2. Ubicaciones y estado real

| Recurso | Ubicación / estado |
| --- | --- |
| GitHub | https://github.com/distribucionesjgbff/salida-sheet |
| Rama | `main` |
| Commit de código base de este documento | `879186a` — helper OAuth PKCE incluido |
| Workspace original | `C:\Users\fede3\Documents\ChatGPT\Fase 1 alternativa` |
| Supabase project ref | `ygqyrsheofrpopuyfxkm` |
| Panel Supabase | https://supabase.com/dashboard/project/ygqyrsheofrpopuyfxkm |
| URL de API Supabase | https://ygqyrsheofrpopuyfxkm.supabase.co |
| Base | PostgreSQL en Supabase, región East US / Northern Virginia |
| PostgreSQL para migrar | Session pooler: `aws-0-us-east-1.pooler.supabase.com:5432`, base `postgres`, usuario `postgres.ygqyrsheofrpopuyfxkm` |
| Railway | Configuración en Git; no se ha desplegado ni hay URL de aplicación |
| Apps Script anterior | No modificado en este proyecto; su estado operativo actual no se inspeccionó |

Verificación de Supabase más reciente:

- `items`: 0 filas.
- `sync_runs`: 0 filas.
- `ml_auth`: 1 fila singleton, sin autorización ML guardada.
- Migración aplicada exitosamente el 11/09/2026.
- RLS habilitado en las tres tablas, sin políticas públicas.
- Acceso `anon` y `authenticated` denegado a las tablas.
- Acceso con `service_role` y RPC de adquirir/liberar bloqueo probado correctamente.
- ID y secreto de la app ML configurados localmente; aún no se validaron mediante un canje OAuth exitoso.
- `PUSH_ENABLED=false` en el entorno local: no se envían cambios de stock a ML.
- Google Service Account y documento espejo aún no configurados.
- No se realizó la importación inicial ni una corrida real de sincronización.

La suite más reciente pasó **28 pruebas**, incluidas migraciones y triggers en PostgreSQL/PGlite, más APIs simuladas. No equivale a validación end-to-end contra Mercado Libre o Google.

## 3. Stack y estructura

- Node.js 24, JavaScript con ES Modules. Sin TypeScript ni framework web.
- `@supabase/supabase-js` para lecturas y RPC del backend.
- `pg` solo para aplicar SQL de migración desde terminal.
- `googleapis` para el espejo.
- `fetch` nativo para ML; runner `node:test` y PGlite para pruebas.
- Dependencias fijadas por `package-lock.json`; instalar con `npm ci`.
- Docker basado en `node:24-bookworm-slim`, ejecución como usuario `node`.

```text
.env.example                    Nombres de variables, sin secretos
Dockerfile                      Imagen de los jobs de producción
railway.sync.json               Cron de sync
railway.mirror.json             Cron de espejo
migrations/001_init.sql         Esquema, triggers, RPC y permisos
scripts/migrate.js              Aplica 001 a una base vacía
scripts/authorize.js            Servidor OAuth temporal + ngrok opcional
scripts/check.js                Comprobación de sintaxis JavaScript
src/config.js                   Configuración y validación de variables
src/log.js                      Logs JSON y redacción de secretos registrados
src/index.js                    Selección de tarea y adquisición de lease
src/run.js                      Orquestación, contadores y sync_runs
src/db/supabase.js              Cliente y Repository
src/db/lease.js                 Bloqueos con vencimiento y renovación
src/ml/auth.js                  Refresh automático y persistencia
src/ml/authorize.js             PKCE, state y canje inicial de authorization code
src/ml/client.js                Fetch autenticado, timeout y reintentos
src/sync/common.js              Scan, concurrencia, validación y errores
src/sync/fullImport.js          Carga inicial desde ML
src/sync/incrementalSync.js     Metadatos cache-first y pull de detalles
src/sync/pushUpdates.js         Envío de intención local y confirmación
src/sheet/mirrorSync.js         Escritura batch de la hoja espejo
test/*.test.js                 Pruebas automatizadas
README.md                      Guía de instalación y operación
```

## 4. Esquema de datos y contrato de edición

El SQL exacto se incluye al final de este documento. El esquema es `public`.

### items

| Campo | Tipo / significado |
| --- | --- |
| `id` | text PK, ID real de ML, por ejemplo `MLA123456789` |
| `title` | text, título remoto |
| `available_quantity` | integer >= 0; cantidad local deseada si hay pendiente, o último stock remoto incorporado |
| `has_variations` | boolean |
| `variations_raw` | jsonb array completo del último detalle incorporado desde ML |
| `last_synced_at` | timestamptz nullable; última incorporación/confirmación, no se actualiza por cada cache hit |
| `last_ml_update_at` | timestamptz nullable, derivado de `last_updated` de ML |
| `sync_status` | text: `ok`, `error`, `pending` |
| `last_error` | text nullable |
| `updated_at` | timestamptz, mantenido por trigger en updates |
| `stock_by_variation` | jsonb objeto nullable: ID de variación → cantidad deseada |
| `stock_revision` | bigint; versión creciente de cambios locales de cantidades |
| `push_pending` | boolean; intención pendiente de confirmación, independiente del error |

Ejemplo ficticio para una UI de pruebas, sin introducirlo en la base compartida:

```json
{
  "id": "MLA123456789",
  "title": "Producto de ejemplo",
  "available_quantity": 12,
  "has_variations": true,
  "variations_raw": [
    {"id": 111, "available_quantity": 3, "attribute_combinations": [{"id": "COLOR", "value_name": "Azul"}]},
    {"id": 222, "available_quantity": 4, "attribute_combinations": [{"id": "COLOR", "value_name": "Rojo"}]}
  ],
  "stock_by_variation": {"111": 4, "222": 8},
  "stock_revision": 1,
  "push_pending": true,
  "sync_status": "pending",
  "last_error": null
}
```

En ese ejemplo el snapshot remoto suma 7, pero la intención local suma 12. Esa diferencia es válida hasta confirmar el envío.

Para un ítem sin variaciones, editar **solo** `available_quantity`. Para uno con variaciones, editar **solo** `stock_by_variation`, con todos los IDs y cantidades enteras no negativas. El trigger suma las cantidades, incrementa `stock_revision`, establece `push_pending=true`, marca `pending` y limpia `last_error`.

No editar `variations_raw`: el trigger lo rechaza. No repartir un cambio del total proporcionalmente ni asignarlo arbitrariamente a una variación. No utilizar `sync_status` como única señal de envío: un error puede seguir teniendo `push_pending=true`.

La validación de que el mapa tiene todos los IDs se hace actualmente antes del PUT. Un futuro panel debe validarlo también al guardar para dar una respuesta inmediata. Actualizar con el mismo valor no genera una nueva revisión.

### sync_runs

| Campo | Tipo / valores |
| --- | --- |
| `id` | uuid PK, `gen_random_uuid()` |
| `started_at`, `finished_at` | timestamptz; finished nullable |
| `mode` | `full_import`, `refresh_selected`, `incremental` |
| `items_processed`, `items_failed` | integer >= 0 |
| `status` | `running`, `completed`, `failed` |
| `notes` | text nullable |
| `task` | `sync` o `mirror` |

El espejo usa `mode=incremental, task=mirror`. `items_processed` cuenta IDs únicos intentados; los omitidos por caché se informan en notas/logs. Un error individual no corta el lote, pero la corrida termina `failed` si hubo algún ítem fallido. Errores globales de autenticación/base/bloqueo sí detienen la ejecución.

### ml_auth

Singleton `id=1`. Campos: `refresh_token`, `access_token`, `expires_at`, `seller_id`, `refresh_in_progress`, `updated_at`, `locks` (jsonb).

No mostrar esta tabla ni tokens en un panel. El diseño soporta un único vendedor por base/instancia; no es multiempresa ni multivendedor.

### RPC existentes

| Función | Propósito |
| --- | --- |
| `job_lock(p_task,p_owner,p_action)` | acquire/renew/release de un lease |
| `assert_sync_lock(p_owner)` | Verifica dueño y vigencia del bloqueo |
| `save_ml_auth(p_owner,p_data)` | Persiste OAuth bajo bloqueo |
| `apply_ml_snapshot(p_owner,p_item,p_revision)` | Incorpora detalle remoto o confirma PUT con comparación de revisión |
| `mark_item_error(p_owner,p_id,p_error,p_revision)` | Registra error sin sobrescribir una intención posterior |

Son funciones privilegiadas, restringidas a `service_role`; las escrituras del motor pasan por ellas. Un panel no debe usar `apply_ml_snapshot` para editar cantidades porque omite deliberadamente el trigger de intención local.

## 5. Flujos del motor

**Full import:** obtiene `/users/me`, verifica MLA, enumera IDs con `/users/{seller}/items/search?search_type=scan&limit=100` y sigue `scroll_id` hasta una página vacía. Agota el scan antes de pedir detalles. Descarga detalles con concurrencia máxima 20 y conserva `variations_raw`. Hace upsert, sin pisar pendientes locales. Se ejecuta manualmente, nunca por cron.

**Incremental:** push de pendientes primero; después vuelve a enumerar catálogo y agrega IDs ya conocidos. Consulta `/items?ids=...&attributes=id,last_updated` en lotes de hasta 20. Si coincide el timestamp y el ítem está `ok`, omite detalle. Si cambió/es nuevo/tiene error, pide `/items/{id}?include_attributes=all`. No existe un filtro `updated_since` implementado: siempre hay GET de metadatos. Los pendientes quedan fuera del pull.

**Push:** secuencial con pausa de 350 ms por defecto. Obtiene detalle fresco, comprueba vendedor y conjunto de variaciones, construye cantidades absolutas y envía PUT solo si ML aún no las tiene. Para variaciones manda todos los IDs del snapshot, con `{id, available_quantity}`; no reenvía atributos ajenos al stock. Si cambió el conjunto de IDs, registra conflicto. Confirma mediante GET y aplica el resultado solo si la revisión local sigue siendo la leída. Si hubo otra edición, conserva la nueva intención para la próxima corrida.

**Concurrencia:** lease `sync` compartido por import/refresh/incremental/OAuth; lease `mirror` independiente. Caducidad de 5 minutos, renovación cada 30 segundos y antes de operaciones. El siguiente dueño marca como fallidas las corridas huérfanas de esa tarea. Las tareas en vuelo se esperan antes de liberar el bloqueo cuando hay un fallo global.

**Reintentos:** intento inicial + hasta 3 reintentos ante red o 5xx, pausas 1/4/16 segundos. También 429, con Retry-After limitado a 60 segundos. Timeout de request 30 segundos. Un 401 permite una renovación. Los errores por entrada del multiget se resuelven con GET individual.

**Limitaciones a preservar/entender:** no hay transacción distribuida Postgres–ML, webhook de cambios, registro de ventas ni garantía de exclusión frente a Apps Script u otro escritor externo. La comprobación de variaciones antes del PUT no evita cambios externos ocurridos entre GET y PUT. Un stock confirmado diferente deja el pendiente para reintentar; otro escritor puede producir conflictos recurrentes. No borrar publicaciones desaparecidas automáticamente: permanecen como error para revisar.

## 6. OAuth: estado y continuación

- Se usa la app OAuth existente, con PKCE activado.
- Redirect registrado: `https://skimming-savor-manger.ngrok-free.dev/mercadolibre/callback`.
- Ngrok está instalado y su configuración local resultó válida en la sesión del 11/09.
- Se creó un helper temporal; el túnel respondió correctamente entonces. **El enlace de autorización de aquella sesión venció**, no reutilizarlo.
- El 15/09 la fila `ml_auth` seguía sin refresh token; la autorización no está completada.

Para continuar en el equipo original:

```sh
npm run authorize -- --ngrok
```

El helper abre `127.0.0.1:8787`, publica el dominio configurado y guarda un enlace en `.local/ml-authorization-url.txt`. Abrir ese enlace con la cuenta vendedora principal. Usa un verifier aleatorio, PKCE S256, state y vencimiento de 20 minutos. El callback canjea el código una sola vez y persiste tokens en Supabase bajo lease; cierra el servidor y el túnel al finalizar. No necesita que el usuario copie tokens. Se niega a reemplazar tokens existentes.

En los jobs normales, `src/ml/auth.js` toma el token de Supabase, comparte el refresh entre GET concurrentes y renueva antes de vencer. `ML_REFRESH_TOKEN` es solo una alternativa de bootstrap si no hay token en la base. La rotación marca `refresh_in_progress=true` antes del POST; una respuesta ambigua exige recuperación manual, no reutilizar a ciegas el token. Los POST de canje/refresh OAuth no usan el retry general de ítems.

La coexistencia de una autorización nueva con Apps Script aún debe probarse. No copiar ni rotar desde dos proyectos el refresh token que consume el script anterior. Una instancia nueva con otra base no queda protegida por los leases de esta base.

## 7. Configuración y secretos

| Variable | Uso / estado en el equipo original |
| --- | --- |
| `SUPABASE_URL` | Configurada |
| `SUPABASE_SERVICE_ROLE_KEY` | Configurada; acceso probado |
| `DATABASE_URL` | Configurada; solo migraciones, con SSL verify-full |
| `SUPABASE_DB_PASSWORD` | Configurada aparte; el script la codifica para la URI |
| `ML_CLIENT_ID`, `ML_CLIENT_SECRET` | Cargadas; canje OAuth pendiente |
| `ML_REFRESH_TOKEN` | Vacía; helper persiste directamente en DB |
| `ML_REDIRECT_URI` | Configurada para el callback ngrok indicado |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Pendiente |
| `MIRROR_SHEET_ID` | Pendiente |
| `MIRROR_TAB_ID` | gid numérico de la pestaña; completar cuando exista el espejo |
| `TASK` | Default `incremental`; argumento CLI tiene prioridad |
| `ML_GET_CONCURRENCY` | Default 20, rango 1–20 |
| `ML_PUT_DELAY_MS` | Default 350 |
| `PUSH_ENABLED` | `false` durante comparación/desarrollo |

Los valores privados están en `.env` del equipo original, excluido de Git. `.local/` también está excluido y contiene el certificado CA, logs temporales y enlaces de autorización vencidos. No copiar estos archivos a un repositorio ni a un prompt. El certificado CA local se configuró mediante `sslrootcert=.local/supabase-ca.crt`; no se deshabilitó la validación TLS. Para otro equipo, instalar/configurar el CA según las instrucciones de Supabase.

### Ubicación exacta de las credenciales y accesos

Archivo privado existente en la computadora de Fede:

```text
C:\Users\fede3\Documents\ChatGPT\Fase 1 alternativa\.env
```

Certificado CA utilizado por la conexión Postgres:

```text
C:\Users\fede3\Documents\ChatGPT\Fase 1 alternativa\.local\supabase-ca.crt
```

La otra conversación, si trabaja en esta misma computadora y tiene acceso a sus archivos, puede cargar las variables desde esa ruta absoluta para las operaciones autorizadas. No debe imprimir el contenido del archivo ni sus valores en logs, respuestas, capturas o commits. El `.env` contiene las credenciales configuradas de Supabase y el ID/secreto de ML; no contiene todavía una autorización OAuth ML válida ni las credenciales de Google.

Si se ejecuta desde otro checkout, `sslrootcert=.local/supabase-ca.crt` dentro de `DATABASE_URL` es relativo al directorio de ejecución. Resolverlo en memoria contra el directorio original o usar una copia privada del certificado en el checkout nuevo; no editar el `.env` original para adaptar otro desarrollo. Mantener `PUSH_ENABLED=false`. Usar fixtures o una base separada para pruebas que modifiquen datos.

La ruta local **no es un enlace de descarga**: una conversación en la nube u otra computadora no puede acceder a ella por recibir este documento. En ese caso, el propietario debe configurar las variables mediante el mecanismo privado del nuevo entorno. No enviar el contenido del `.env` en el prompt.

Accesos web para el propietario:

- Repositorio: https://github.com/distribucionesjgbff/salida-sheet
- Panel Supabase: https://supabase.com/dashboard/project/ygqyrsheofrpopuyfxkm
- API Keys Supabase: https://supabase.com/dashboard/project/ygqyrsheofrpopuyfxkm/settings/api-keys
- Railway: no hay proyecto desplegado ni URL de panel propia registrados en esta implementación.

Estas direcciones requieren iniciar sesión con una cuenta con permisos. Las credenciales del `.env` son de servicios/API; no son una cuenta de usuario para entrar a un panel web, que todavía no existe.

El backend usa una clave privilegiada de servidor. Nunca ponerla en variables públicas de Vite/Next ni entregarla al navegador. El nombre actual de la variable corresponde a la clave legacy `service_role`; cualquier modernización a secret keys debe validarse aparte, sin abrir políticas públicas por comodidad.

## 8. Comandos, despliegue y espejo

```sh
npm ci
npm test
npm run check
npm run authorize -- --ngrok
npm run import
npm run sync
npm start -- refresh_selected MLA123456789
npm run mirror
```

`npm run migrate` solo aplica 001 a una base nueva y se detiene si existen las tablas. **No ejecutarlo contra el proyecto actual para recrear nada.** Nuevas funcionalidades requieren migraciones numeradas adicionales; el runner actual no tiene historial ni ejecuta automáticamente una 002. Se debe ampliar antes de usarlo como migrador incremental.

Railway previsto, todavía no desplegado:

| Servicio | Archivo | Inicio | Cron UTC |
| --- | --- | --- | --- |
| sync | `railway.sync.json` | `node src/index.js incremental` | `*/15 * * * *` |
| mirror | `railway.mirror.json` | `node src/index.js mirror` | `2,17,32,47 * * * *` |

Dos servicios del mismo repo/proyecto. Reinicio automático desactivado. La imagen Docker incluye `src` y dependencias de producción; los helpers de migración/OAuth se ejecutan fuera de esa imagen. No hay servidor para atender un dominio público. Los dos minutos de desfase no garantizan que sync haya terminado; el espejo puede mostrar resultados parciales hasta la siguiente corrida.

El espejo usa una cuenta de servicio Google con permiso Editor solo en el documento nuevo. Lee la base paginada de 500 en 500; escribe una llamada `spreadsheets.batchUpdate`. Pestaña `Stock (solo lectura)`, aviso en fila 1, encabezados en fila 2, filas de datos después. Columnas actuales: MLB, título, stock, estado de sync, última actualización. El texto MLB se conservó del pedido original, pero los IDs reales son MLA. Escribe texto literal, limpia sobrantes y ajusta la grilla a cinco columnas; no apuntar a una pestaña con otros datos.

## 9. Cómo construir en paralelo

Si el segundo desarrollo es **un panel para este motor**, puede usar la misma estructura de datos sin implementar otro sincronizador:

```text
UI privada → API del panel que autentica al usuario → Supabase
                                                     ↑
                                            motor actual de sync
```

La API del panel mantiene la clave privilegiada en el servidor y permite únicamente leer catálogo/runs y editar cantidades autorizadas. Un usuario logueado no tiene acceso directo a las tablas con el esquema RLS actual: hay que implementar autenticación y autorización del panel, no solo una pantalla de login.

Contrato HTTP sugerido para el otro desarrollo, **no existente en este repositorio**:

| Método/ruta propuesta | Función |
| --- | --- |
| `GET /api/items` | Buscar/paginar catálogo y filtrar errores/pendientes |
| `GET /api/items/:id` | Detalle y variaciones |
| `PATCH /api/items/:id/stock` | Cantidad simple o mapa completo por variación, con revisión esperada |
| `GET /api/sync-runs` | Historial y contadores |

En PATCH, validar en servidor y actualizar con `id` + `stock_revision` esperada. Si ninguna fila coincide, responder conflicto y pedir recargar, evitando que dos editores se pisen. No aceptar un objeto arbitrario de columnas: permitir únicamente los campos de cantidad previstos. Las escrituras HTTP generan pendientes; el cron los envía, no el navegador.

Funciones de UI posibles: listado con buscador, editor de cantidades por variación, total calculado, estado de sincronización, error visible e historial de corridas. No existe todavía una cola HTTP para “sincronizar ahora”; ese botón requeriría un mecanismo autenticado adicional y los mismos leases, no arrancar procesos arbitrarios desde parámetros de usuario.

Como la base real está vacía, arrancar el panel con fixtures sintéticos o una base de desarrollo. Identificar los datos de demostración y no sembrarlos en el catálogo compartido. Para validar integración, usar luego una cuenta/base de prueba o datos reales tras la importación autorizada.

Si se busca **otro motor alternativo**, usar checkout y base de desarrollo separados. No iniciar dos motores con push activo sobre el mismo catálogo ni compartir tokens rotativos entre bases independientes. No modificar simultáneamente archivos del workspace original: usar otro clon, worktree o repositorio y coordinar las migraciones compartidas.

## 10. Pendientes de esta implementación

1. Completar OAuth con un enlace PKCE nuevo y verificar la cuenta vendedora MLA.
2. Confirmar que Apps Script conserva su autorización durante la transición.
3. Ejecutar importación real y comparar cantidades/variaciones y conteo del catálogo.
4. Probar dos corridas y posteriormente una renovación real del access token.
5. Probar cambios de stock simples y por variación, error aislado y concurrencia con ediciones.
6. Configurar Google Service Account y hoja nueva; validar el batch real.
7. Crear los dos servicios Railway y verificar ejecuciones/logs/terminación.
8. Mantener comparación con push desactivado hasta decidir el corte de escrituras.
9. Construir panel privado si se elige esa extensión; no está incluido en el código actual.

## 11. Texto breve para iniciar otra conversación

> Estoy desarrollando un sistema de stock para Mercado Libre Argentina. El motor existente está en https://github.com/distribucionesjgbff/salida-sheet, rama main. Es Node.js 24 con Supabase/PostgreSQL, jobs previstos en Railway y Google Sheets como espejo. Todavía no existe panel, login ni API HTTP administrativa. La migración ya está aplicada, la base tiene cero ítems y OAuth ML está pendiente. Quiero trabajar una implementación complementaria o alternativa en paralelo. Leé este documento completo y el SQL antes de proponer cambios. Si construimos un panel, debe respetar las cantidades por ID de variación, el trigger de pendientes y stock_revision; mantener las credenciales en servidor y nunca exponer ml_auth. No implementar promociones, ventas ni agrupación por SKU en esta etapa. No modificar Apps Script, no recrear la base existente y no activar otro escritor de stock. Separá claramente lo que ya existe de lo que vas a crear. Trabajá en un checkout separado.

> En esta computadora, el documento completo está en `C:\Users\fede3\Documents\ChatGPT\Fase 1 alternativa\docs\TRASPASO_BACKEND.md` y las variables privadas en `C:\Users\fede3\Documents\ChatGPT\Fase 1 alternativa\.env`. Podés cargar esas variables localmente para las operaciones de integración autorizadas, sin mostrar ni publicar su contenido y sin modificar el archivo original. El certificado está en `C:\Users\fede3\Documents\ChatGPT\Fase 1 alternativa\.local\supabase-ca.crt`; resolvé su ruta al trabajar desde otro checkout. Conservá `PUSH_ENABLED=false`. Si no tenés acceso al filesystem de esta computadora, solicitá que configure las variables en el entorno privado correspondiente, no que pegue secretos en el chat.

## 12. Esquema SQL exacto

La siguiente copia corresponde a `migrations/001_init.sql` en el commit de código indicado. Se incluye como referencia del contrato, **no para volver a ejecutar sobre la base existente**.

```sql
begin;

create table public.items (
  id text primary key,
  title text not null default '',
  available_quantity integer not null default 0 check (available_quantity >= 0),
  has_variations boolean not null default false,
  variations_raw jsonb not null default '[]' check (jsonb_typeof(variations_raw) = 'array'),
  last_synced_at timestamptz,
  last_ml_update_at timestamptz,
  sync_status text not null default 'pending' check (sync_status in ('ok','error','pending')),
  last_error text,
  updated_at timestamptz not null default now(),
  -- El snapshot remoto y la intención local deben poder coexistir.
  stock_by_variation jsonb check (stock_by_variation is null or jsonb_typeof(stock_by_variation) = 'object'),
  stock_revision bigint not null default 0,
  push_pending boolean not null default false
);

create table public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  mode text not null check (mode in ('full_import','refresh_selected','incremental')),
  items_processed integer not null default 0 check (items_processed >= 0),
  items_failed integer not null default 0 check (items_failed >= 0),
  status text not null default 'running' check (status in ('running','completed','failed')),
  notes text,
  -- Mantiene los modos solicitados; el espejo usa mode=incremental/task=mirror.
  task text not null default 'sync' check (task in ('sync','mirror'))
);

create table public.ml_auth (
  id integer primary key default 1 check (id = 1),
  refresh_token text,
  access_token text,
  expires_at timestamptz,
  seller_id bigint,
  refresh_in_progress boolean not null default false,
  updated_at timestamptz not null default now(),
  -- Leases independientes para sync y espejo; una sola fila de credenciales.
  locks jsonb not null default '{}'
);
insert into public.ml_auth(id) values (1);

alter table public.items enable row level security;
alter table public.sync_runs enable row level security;
alter table public.ml_auth enable row level security;
revoke all on public.items, public.sync_runs, public.ml_auth from anon, authenticated;
grant all on public.items, public.sync_runs, public.ml_auth to service_role;
create index items_pending_idx on public.items(id) where push_pending;
create index sync_runs_started_idx on public.sync_runs(started_at desc);

create function public.items_before_update() returns trigger
language plpgsql set search_path = '' as $$
declare v_total bigint; v_value jsonb;
begin
  new.updated_at := clock_timestamp();
  if coalesce(current_setting('stock_sync.internal', true), '') = 'on' then return new; end if;
  if new.variations_raw is distinct from old.variations_raw then
    raise exception 'variations_raw es un snapshot de ML; editar stock_by_variation';
  end if;
  if new.stock_by_variation is distinct from old.stock_by_variation
     or new.available_quantity is distinct from old.available_quantity then
    if new.stock_by_variation is distinct from old.stock_by_variation and new.stock_by_variation is not null then
      if not new.has_variations then raise exception 'El item no tiene variaciones'; end if;
      v_total := 0;
      for v_value in select value from jsonb_each(new.stock_by_variation) loop
        if jsonb_typeof(v_value) <> 'number' or v_value::text !~ '^[0-9]+$' then
          raise exception 'Stock por variacion debe ser entero no negativo';
        end if;
        v_total := v_total + (v_value::text)::bigint;
      end loop;
      new.available_quantity := v_total;
    end if;
    new.stock_revision := old.stock_revision + 1;
    new.push_pending := true;
    new.sync_status := 'pending';
    new.last_error := null;
  end if;
  return new;
end $$;
create trigger items_updated before update on public.items
for each row execute function public.items_before_update();

-- Todas las RPC se ejecutan solo con service_role. Un lease vencido no puede
-- confirmar resultados ni persistir tokens. La renovación dura cinco minutos.
create function public.job_lock(p_task text, p_owner uuid, p_action text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_locks jsonb; v_lock jsonb;
begin
  if p_task not in ('sync','mirror') then raise exception 'Invalid task'; end if;
  select locks into v_locks from public.ml_auth where id = 1 for update;
  v_lock := v_locks -> p_task;
  if p_action = 'acquire' then
    if (v_lock->>'until')::timestamptz > clock_timestamp() then return false; end if;
  elsif p_action in ('renew','release') then
    if v_lock->>'owner' is distinct from p_owner::text
       or (v_lock->>'until')::timestamptz <= clock_timestamp() then return false; end if;
  else raise exception 'Invalid action'; end if;
  if p_action = 'release' then
    update public.ml_auth set locks = locks - p_task where id = 1;
  else
    update public.ml_auth set locks = jsonb_set(locks, array[p_task],
      jsonb_build_object('owner', p_owner, 'until', clock_timestamp() + interval '5 minutes')) where id = 1;
  end if;
  return true;
end $$;

create function public.assert_sync_lock(p_owner uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_lock jsonb;
begin
  select locks->'sync' into v_lock from public.ml_auth where id = 1 for update;
  if v_lock->>'owner' is distinct from p_owner::text
     or coalesce((v_lock->>'until')::timestamptz, '-infinity') <= clock_timestamp() then
    raise exception 'Sync lease lost';
  end if;
end $$;

create function public.save_ml_auth(p_owner uuid, p_data jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_sync_lock(p_owner);
  update public.ml_auth set
    refresh_token = coalesce(p_data->>'refresh_token', refresh_token),
    access_token = case when p_data ? 'access_token' then p_data->>'access_token' else access_token end,
    expires_at = case when p_data ? 'expires_at' then (p_data->>'expires_at')::timestamptz else expires_at end,
    seller_id = coalesce((p_data->>'seller_id')::bigint, seller_id),
    refresh_in_progress = coalesce((p_data->>'refresh_in_progress')::boolean, refresh_in_progress),
    updated_at = clock_timestamp()
  where id = 1;
end $$;

create function public.apply_ml_snapshot(p_owner uuid, p_item jsonb, p_revision bigint default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_old public.items; v_variations jsonb; v_qty integer; v_desired jsonb;
begin
  perform public.assert_sync_lock(p_owner);
  perform set_config('stock_sync.internal', 'on', true);
  select * into v_old from public.items where id = p_item->>'id' for update;
  -- Import/refresh nunca pisa intención local. Confirmación de PUT usa CAS.
  if found and (v_old.push_pending and p_revision is null
      or p_revision is not null and v_old.stock_revision <> p_revision) then return false; end if;
  v_variations := coalesce(p_item->'variations', '[]');
  if jsonb_array_length(v_variations) > 0 then
    select coalesce(sum((v->>'available_quantity')::integer),0),
      jsonb_object_agg(v->>'id', v->'available_quantity') into v_qty, v_desired
      from jsonb_array_elements(v_variations) v;
  else
    v_qty := (p_item->>'available_quantity')::integer;
    v_desired := null;
  end if;
  insert into public.items(id,title,available_quantity,has_variations,variations_raw,
    last_synced_at,last_ml_update_at,sync_status,last_error,stock_by_variation,push_pending)
  values(p_item->>'id',p_item->>'title',v_qty,jsonb_array_length(v_variations)>0,v_variations,
    clock_timestamp(),(p_item->>'last_updated')::timestamptz,'ok',null,v_desired,false)
  on conflict(id) do update set title=excluded.title,available_quantity=excluded.available_quantity,
    has_variations=excluded.has_variations,variations_raw=excluded.variations_raw,
    last_synced_at=excluded.last_synced_at,last_ml_update_at=excluded.last_ml_update_at,
    sync_status='ok',last_error=null,stock_by_variation=excluded.stock_by_variation,push_pending=false;
  return true;
end $$;

create function public.mark_item_error(p_owner uuid, p_id text, p_error text, p_revision bigint default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_sync_lock(p_owner);
  insert into public.items(id,sync_status,last_error) values(p_id,'error',left(p_error,2000))
  on conflict(id) do update set sync_status='error',last_error=excluded.last_error
    where (p_revision is null and not public.items.push_pending)
       or public.items.stock_revision = p_revision;
end $$;

revoke execute on function public.items_before_update() from public, anon, authenticated;
revoke execute on function public.job_lock(text,uuid,text) from public, anon, authenticated;
revoke execute on function public.assert_sync_lock(uuid) from public, anon, authenticated;
revoke execute on function public.save_ml_auth(uuid,jsonb) from public, anon, authenticated;
revoke execute on function public.apply_ml_snapshot(uuid,jsonb,bigint) from public, anon, authenticated;
revoke execute on function public.mark_item_error(uuid,text,text,bigint) from public, anon, authenticated;
grant execute on function public.job_lock(text,uuid,text), public.assert_sync_lock(uuid),
  public.save_ml_auth(uuid,jsonb), public.apply_ml_snapshot(uuid,jsonb,bigint),
  public.mark_item_error(uuid,text,text,bigint) to service_role;

commit;

```
