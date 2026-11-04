# Apuntes — tus notas en el PC y el celular, sincronizadas y gratis

App web instalable (PWA) inspirada en el funcionamiento de UpNote, con código, nombre y diseño propios.

- **Dónde vive la app:** GitHub Pages (gratis, con HTTPS).
- **Dónde viven tus notas:** Supabase (base de datos Postgres + imágenes; plan gratis).
- **En cada dispositivo:** una copia local, así abre al instante y funciona **sin internet**; al volver la conexión se sincroniza sola.

## Qué hace

| Función | Detalle |
|---|---|
| Notas con formato | Títulos, negrita, cursiva, subrayado, tachado, resaltado, viñetas, numeradas, **listas de tareas**, citas, código, enlaces, separadores, imágenes (pegar, arrastrar o elegir) |
| Organización | Libretas y sublibretas, etiquetas, favoritos, anclar arriba, papelera |
| Búsqueda | Instantánea, sin importar tildes ni mayúsculas (Ctrl+K) |
| Sincronización | Automática al editar, cada 60 s, al volver a la app y en tiempo real entre dispositivos |
| Conflictos | Si editas la misma nota en dos lados, gana la edición más reciente |
| Respaldo | Descargar copia completa (.json) y restaurarla; exportar una nota a Markdown |
| Migración | Importa el respaldo `.upnx` de UpNote (libretas, sublibretas, etiquetas, favoritos, anclados, papelera e imágenes) |
| Seguridad | Cada cuenta solo ve sus notas (reglas RLS en la base); imágenes en almacenamiento privado |

Atajos: **Alt+N** nueva nota · **Ctrl+K** buscar · **Tab / Shift+Tab** sangría en listas.

---

## Puesta en marcha (una sola vez, ~20 minutos)

### 1. Crear la base de datos en Supabase
1. Entra a <https://supabase.com> → **Start your project** (puedes entrar con tu cuenta de GitHub).
2. **New project**: nombre `apuntes`, una contraseña de base de datos (guárdala), región **South America (São Paulo)**.
3. Cuando termine de crearse: menú **SQL Editor** → **New query** → pega todo el contenido de `supabase/schema.sql` → **Run**. Debe decir *Success*.
4. Menú **Project Settings → API** (o **API Keys**): copia
   - **Project URL** (ej. `https://abcd1234.supabase.co`)
   - la clave **anon / publishable** (pública). **No uses** la `service_role` / `secret`.

### 2. Publicar la app en GitHub Pages
1. En GitHub: **New repository** → nombre `apuntes` → **Public** → *Create*.
   (Las notas NO quedan en el repositorio; ahí solo va el programa.)
2. Abre `config.js` y pega tus datos:
   ```js
   export const CONFIG = {
     supabaseUrl: 'https://abcd1234.supabase.co',
     supabaseAnonKey: 'pega-aquí-la-clave-anon',
   };
   ```
3. En el repositorio: **Add file → Upload files** → arrastra **todo el contenido** de esta carpeta (incluida la carpeta `.github`) → *Commit*.
   - Si la carpeta `.github` no se sube arrastrando, créala a mano: **Add file → Create new file** con nombre `.github/workflows/mantener-supabase.yml` y pega su contenido.
4. **Settings → Pages** → *Source: Deploy from a branch* → Branch `main` / `(root)` → **Save**.
   En 1–2 minutos queda en `https://TU-USUARIO.github.io/apuntes/`.

### 3. Crear tu cuenta y cerrar el registro
1. Abre la dirección de tu app → escribe correo y contraseña → **Crear cuenta**.
   Si pide confirmar el correo, revisa tu bandeja y luego **Entrar**.
2. **Importante:** en Supabase → **Authentication → Sign In / Providers** (o *Settings*) → desactiva **Allow new users to sign up**.
   Así nadie más puede crear cuentas en tu app.

### 4. Evitar que Supabase se pause (plan gratis)
Supabase pausa proyectos gratis tras ~7 días sin uso. El archivo `.github/workflows/mantener-supabase.yml` lo evita con una consulta cada 3 días:
1. No requiere configuración: toma la URL y la clave publicable de `config.js`.
2. Pestaña **Actions** → *Mantener Supabase activo* → **Run workflow** para probarlo (debe quedar en verde).

Si igual se pausara, se reactiva con un clic en el panel de Supabase; tus notas no se pierden.

### 5. Instalarla
- **PC (Chrome o Edge):** abre la dirección → ícono **Instalar** en la barra de direcciones. Queda como programa con su propio ícono.
- **iPhone (Safari):** abre la dirección → **Compartir → Agregar a pantalla de inicio**.
- **Android (Chrome):** menú **⋮ → Instalar app** (o *Agregar a la pantalla principal*).

### 6. Traer tus notas de UpNote
1. En UpNote del PC: **Settings → Backup** → activa **Backup attachments** → elige carpeta → **Backup now**.
2. En Apuntes (en el PC): **Ajustes (⚙) → Importar desde UpNote…**
   - *Respaldo (.upnx)*: el archivo generado.
   - *Imágenes*: la carpeta **files** que quedó junto al respaldo.
3. **Importar**. Verás un resumen; las notas se suben solas y aparecen en el celular.
   Se puede repetir sin duplicar (usa los mismos identificadores de UpNote).

---

## Límites y riesgos a conocer

- **Plan gratis Supabase:** 500 MB de base de datos y 1 GB de archivos. Miles de notas de texto ocupan pocos MB; lo que más pesa son las imágenes (la app reduce fotos grandes a ~1800 px).
- **Conflictos:** gana la última edición *completa* de la nota; no mezcla cambios de dos dispositivos dentro de la misma nota. Si editas lo mismo en dos lados sin conexión, se queda la versión guardada más tarde.
- **iPhone:** Safari puede borrar la copia local de una app web que no abres en semanas. No se pierde nada (está en Supabase): se vuelve a bajar al entrar.
- **Editor:** usa el motor de edición del navegador. No hay tablas editables, recordatorios, cifrado de extremo a extremo ni bloqueo con clave (UpNote premium sí los tiene).
- **Cerrar sesión** borra la copia local del dispositivo (no la de la nube).
- Respaldo propio: de vez en cuando usa **Ajustes → Descargar copia de seguridad**.

## Actualizar la app más adelante
Sube los archivos cambiados al repositorio y aumenta `VERSION` en `sw.js` (ej. `apuntes-v1.0.1`). Los dispositivos toman la versión nueva al abrir la app (a veces hace falta abrirla dos veces).

## Estructura

```
index.html, app.css          Interfaz
js/app.js                    Lógica de pantallas, editor y ajustes
js/editor.js                 Formato, listas de tareas, imágenes, limpieza de HTML, Markdown
js/db.js                     Copia local (IndexedDB)
js/sync.js                   Sincronización con Supabase (subir/bajar cambios, imágenes)
js/importer.js               Importador de respaldos .upnx de UpNote
sw.js, manifest.webmanifest  Instalación y uso sin conexión
supabase/schema.sql          Tablas, seguridad, regla de conflictos, almacenamiento
config.js                    Tu URL y clave pública de Supabase
```
