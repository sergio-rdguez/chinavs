/* Viaje a China: datos en Supabase.
   Las filas se guardan tal como las recibe la app; solo se accede por china_leer y china_aplicar,
   que solo admiten las operaciones de la app y las columnas permitidas.
   Se puede volver a ejecutar sin perder datos. */

create table if not exists public.china_filas (
  tabla text not null check (tabla in ('itinerario','alojamiento','transporte','checklist','agenda','lugares','gastos','diario','ajustes')),
  fila integer not null,
  clave text not null,
  datos jsonb not null default '{}'::jsonb,
  actualizado timestamptz not null default now(),
  primary key (tabla, fila)
);
create index if not exists china_filas_clave on public.china_filas (tabla, clave);

-- Sin políticas: la clave pública de la app no puede tocar la tabla directamente
alter table public.china_filas enable row level security;
revoke all on table public.china_filas from public, anon, authenticated;

-- Columnas que la app puede modificar en las tablas fijas
create or replace function public.china_editables(h text) returns text[]
language sql immutable set search_path = '' as $$
  select case h
    when 'itinerario' then array['Actividades Principales']
    when 'alojamiento' then array['Hotel','Precio total','Estado','Notas','Dirección (chino)','Localizador']
    when 'transporte' then array['Salida','Llegada','Nº vuelo/tren','Precio','Estado','Notas','Localizador']
  end
$$;

-- Tablas que gestiona la app. La primera columna es siempre el identificador.
create or replace function public.china_columnas(h text) returns text[]
language sql immutable set search_path = '' as $$
  select case h
    when 'agenda' then array['ID','Fecha','Hora','Fin','Qué','Lugar','Tipo','Notas']
    when 'lugares' then array['ID','Ciudad','Nombre','Chino','Dirección','Horario','Precio','Reserva','Notas','Lat','Lon']
    when 'gastos' then array['ID','Fecha','Ciudad','Concepto','Categoría','Importe','Moneda','EUR','Pagó']
    when 'diario' then array['ID','Fecha','Nota']
    when 'ajustes' then array['ID','Valor']
  end
$$;

-- Deja solo las columnas permitidas
create or replace function public.china_filtra(v jsonb, cols text[]) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
  from jsonb_each(coalesce(v, '{}'::jsonb)) e where e.key = any (cols)
$$;

-- La fila que dice la app si su clave sigue ahí; si no, se busca la clave, pero solo si aparece una vez
create or replace function public.china_fila(h text, n integer, k text) returns integer
language plpgsql stable set search_path = '' as $$
declare
  hay integer[];
begin
  if exists (select 1 from public.china_filas c where c.tabla = h and c.fila = n and c.clave = k) then return n; end if;
  select array_agg(c.fila) into hay from public.china_filas c where c.tabla = h and c.clave = k;
  if coalesce(array_length(hay, 1), 0) = 1 then return hay[1]; end if;
  raise exception 'Los datos han cambiado. Actualiza la app y vuelve a intentarlo.';
end
$$;

-- Fila nueva con todas las columnas de la tabla
create or replace function public.china_nueva(h text, id text, v jsonb, n integer) returns void
language sql set search_path = '' as $$
  insert into public.china_filas (tabla, fila, clave, datos)
  select h, n, id,
    (select jsonb_object_agg(col, '') from unnest(public.china_columnas(h)) col)
    || public.china_filtra(v, public.china_columnas(h))
    || jsonb_build_object('ID', id)
$$;

create or replace function public.china_op(p jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  accion text := p->>'action';
  h text := lower(p->>'tabla');
  id text := btrim(coalesce(p->>'id', ''));
  texto text := btrim(coalesce(p->>'text', ''));
  n integer;
  r record;
begin
  if accion = 'update' then
    if public.china_editables(h) is null then raise exception 'Tabla no editable: %', p->>'tabla'; end if;
    n := public.china_fila(h, (p->>'row')::integer, p->>'key');
    update public.china_filas c
      set datos = c.datos || public.china_filtra(p->'values', public.china_editables(h)), actualizado = now()
      where c.tabla = h and c.fila = n;

  elsif accion = 'check' then
    n := public.china_fila('checklist', (p->>'row')::integer, p->>'key');
    update public.china_filas c
      set datos = c.datos || jsonb_build_object('Hecho', coalesce((p->>'done')::boolean, false)), actualizado = now()
      where c.tabla = 'checklist' and c.fila = n;

  elsif accion = 'addTask' then
    if texto = '' then raise exception 'Tarea vacía'; end if;
    if not exists (select 1 from public.china_filas c where c.tabla = 'checklist' and c.clave = texto) then   -- no duplica si el envío se repite
      insert into public.china_filas (tabla, fila, clave, datos)
      select 'checklist', coalesce(max(c.fila), 1) + 1, texto, jsonb_build_object('Tarea', texto, 'Hecho', false)
      from public.china_filas c where c.tabla = 'checklist';
    end if;

  elsif accion = 'upsert' then
    if public.china_columnas(h) is null then raise exception 'Tabla no válida: %', p->>'tabla'; end if;
    if id = '' then raise exception 'Falta el identificador'; end if;
    select min(c.fila) into n from public.china_filas c where c.tabla = h and c.clave = id;
    if n is not null then
      update public.china_filas c
        set datos = c.datos || (public.china_filtra(p->'values', public.china_columnas(h)) - 'ID'), actualizado = now()
        where c.tabla = h and c.fila = n;
    else
      select coalesce(max(c.fila), 1) + 1 into n from public.china_filas c where c.tabla = h;
      perform public.china_nueva(h, id, p->'values', n);
    end if;

  elsif accion = 'remove' then
    if public.china_columnas(h) is null then raise exception 'Tabla no válida: %', p->>'tabla'; end if;
    delete from public.china_filas c where c.tabla = h and c.fila = (select min(x.fila) from public.china_filas x where x.tabla = h and x.clave = id);

  elsif accion = 'seed' then
    if h not in ('agenda', 'lugares') then raise exception 'Tabla no válida: %', p->>'tabla'; end if;
    if not exists (select 1 from public.china_filas c where c.tabla = h) then   -- solo si la tabla está vacía
      for r in select e.value as fila, e.ordinality as i from jsonb_array_elements(coalesce(p->'rows', '[]'::jsonb)) with ordinality e loop
        perform public.china_nueva(h, r.fila->>'ID', r.fila, r.i::integer + 1);
      end loop;
    end if;

  else
    raise exception 'Acción desconocida';
  end if;
end
$$;

-- Quién puede entrar: una cuenta creada en Supabase no sirve de nada si no está aquí.
-- Los correos, en minúsculas, se añaden a mano en la base de datos: este fichero es público.
create table if not exists public.china_viajeros (email text primary key);
alter table public.china_viajeros enable row level security;
revoke all on table public.china_viajeros from public, anon, authenticated;

create or replace function public.china_es_viajero() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.china_viajeros v where v.email = lower(auth.jwt()->>'email'))
$$;

create or replace function public.china_exige_viajero() returns void
language plpgsql stable set search_path = '' as $$
begin
  if not public.china_es_viajero() then raise exception 'Esta cuenta no tiene acceso' using errcode = '42501'; end if;
end
$$;

-- Cambia con cada escritura o borrado: basta comparar esto para saber si hay algo nuevo que descargar
create or replace function public.china_revision() returns text
language sql stable set search_path = '' as $$
  select count(*) || '-' || coalesce(extract(epoch from max(c.actualizado))::text, '0') from public.china_filas c
$$;

-- Todos los datos, con la forma que espera la app.
create or replace function public.china_datos() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('version', 3, 'rev', public.china_revision()) || jsonb_object_agg(h.tabla, coalesce(f.filas, '[]'::jsonb))
  from unnest(array['itinerario','alojamiento','transporte','checklist','agenda','lugares','gastos','diario','ajustes']) h(tabla)
  left join lateral (
    select jsonb_agg(jsonb_build_object('_row', c.fila, '_k', c.clave) || c.datos order by c.fila) as filas
    from public.china_filas c where c.tabla = h.tabla
  ) f on true
$$;

create or replace function public.china_leer() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.china_exige_viajero();
  return public.china_datos();
end
$$;

create or replace function public.china_rev() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.china_exige_viajero();
  return to_jsonb(public.china_revision());
end
$$;

-- Aplica un cambio o un lote y devuelve los datos actualizados. Un error en un lote no frena a los demás.
-- La falta de acceso queda fuera del bloque de errores: es un 403 y los cambios siguen en la cola del móvil.
create or replace function public.china_aplicar(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  errores jsonb := '[]'::jsonb;
  r record;
  datos jsonb;
begin
  perform public.china_exige_viajero();
  begin
    perform pg_advisory_xact_lock(hashtext('china_filas'));     -- de uno en uno
    if p->>'action' = 'batch' then
      for r in select e.value as op, e.ordinality - 1 as i from jsonb_array_elements(coalesce(p->'ops', '[]'::jsonb)) with ordinality e loop
        begin
          perform public.china_op(r.op);
        exception when others then
          errores := errores || jsonb_build_object('i', r.i, 'error', sqlerrm);
        end;
      end loop;
    else
      perform public.china_op(p);
    end if;
    datos := public.china_datos();
    if jsonb_array_length(errores) > 0 then datos := datos || jsonb_build_object('errores', errores); end if;
    return datos;
  exception when others then
    return jsonb_build_object('error', sqlerrm);
  end;
end
$$;

-- Copia diaria de todo, por si algo se borra o se pisa sin querer (ver nube.sql)
create table if not exists public.china_copias (dia date primary key, datos jsonb not null, creada timestamptz not null default now());
alter table public.china_copias enable row level security;
revoke all on table public.china_copias from public, anon, authenticated;

/* ---------- Avisos: suscripciones de cada móvil y lo ya enviado ---------- */
create table if not exists public.china_suscripciones (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  email text,
  bienvenida boolean not null default true,      -- falta el aviso de prueba de cuando se activa
  creada timestamptz not null default now()
);
create table if not exists public.china_avisos_enviados (clave text primary key, enviado timestamptz not null default now());
create table if not exists public.china_config (clave text primary key, valor jsonb not null);
alter table public.china_suscripciones enable row level security;
alter table public.china_avisos_enviados enable row level security;
alter table public.china_config enable row level security;
revoke all on table public.china_suscripciones, public.china_avisos_enviados, public.china_config from public, anon, authenticated;

create or replace function public.china_suscribir(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform public.china_exige_viajero();
  if coalesce(p->>'endpoint', '') !~ '^https://' or coalesce(p->>'p256dh', '') = '' or coalesce(p->>'auth', '') = '' then
    raise exception 'Suscripción no válida';
  end if;
  insert into public.china_suscripciones (endpoint, p256dh, auth, email)
    values (p->>'endpoint', p->>'p256dh', p->>'auth', lower(auth.jwt()->>'email'))
    on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, email = excluded.email;
  return jsonb_build_object('ok', true);
end
$$;

create or replace function public.china_desuscribir(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform public.china_exige_viajero();
  delete from public.china_suscripciones s where s.endpoint = p->>'endpoint';
  return jsonb_build_object('ok', true);
end
$$;

-- Clave pública para suscribirse; la privada no sale nunca de la función de avisos
create or replace function public.china_vapid() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  pub jsonb;
begin
  perform public.china_exige_viajero();
  select c.valor->'publica' into pub from public.china_config c where c.clave = 'vapid';
  if pub is null then raise exception 'Los avisos aún no están preparados'; end if;
  return pub;
end
$$;

/* Cuándo avisar a cada persona. Lo elige en la app y se guarda en Ajustes como avi:<correo>; si no ha elegido nada, o está mal, valen estos:
   {"vuelo":{"vispera":"20:00","antes":[180]},"tren":{"vispera":"20:00","antes":[90]},"agenda":30,"noche":true}
   vispera: hora del aviso del día anterior, "" para ninguno. antes: minutos antes de salir, tantos como quiera.
   agenda: minutos antes de visitas y traslados, 0 para ninguno. noche: a las 21:00, a qué hora empieza el día siguiente.
   Todo en hora de China (UTC+8, también Hong Kong). Si el aviso tenía que salir hace más de 20 min ya no se manda. */
create or replace function public.china_avisos_prefs(correo text) returns jsonb
language plpgsql stable set search_path = '' as $$
begin
  return coalesce((select (f.datos->>'Valor')::jsonb from public.china_filas f where f.tabla = 'ajustes' and f.clave = 'avi:' || correo limit 1), '{}'::jsonb);
exception when others then
  return '{}'::jsonb;
end
$$;

create or replace function public.china_duracion(minutos integer) returns text
language sql immutable set search_path = '' as $$
  select case
    when minutos < 60 then minutos || ' min'
    when minutos % 60 = 0 then minutos / 60 || ' h'
    else minutos / 60 || ' h ' || minutos % 60 || ' min'
  end
$$;

drop function if exists public.china_avisos_debidos(timestamp);
create or replace function public.china_avisos_debidos(ahora timestamp, prefs jsonb default '{}'::jsonb) returns table (clave text, titulo text, cuerpo text)
language sql stable set search_path = '' as $$
  with hora as (
    select c.tabla, c.clave as id, c.datos,
      ((c.datos->>'Fecha') || ' ' || (case when c.tabla = 'transporte' then c.datos->>'Salida' else c.datos->>'Hora' end))::timestamp as t
    from public.china_filas c
    where c.tabla in ('transporte', 'agenda')
      and coalesce(c.datos->>'Fecha', '') ~ '^\d{4}-\d{2}-\d{2}$'
      and coalesce(case when c.tabla = 'transporte' then c.datos->>'Salida' else c.datos->>'Hora' end, '') ~ '^([01]?\d|2[0-3]):[0-5]\d$'
  ),
  transporte as (
    select h.*, h.datos->>'Tipo' ~* 'vuelo' as vuelo,
      case when h.datos->>'Tipo' ~* 'vuelo' then prefs->'vuelo' else prefs->'tren' end as conf,
      (case when h.datos->>'Tipo' ~* 'vuelo' then 'Vuelo ' else 'Tren ' end) || coalesce(h.datos->>'Nº vuelo/tren', '') as nombre,
      to_char(h.t, 'HH24:MI') as sale,
      (h.datos->>'Origen') || ' → ' || (h.datos->>'Destino')
        || case when coalesce(h.datos->>'Localizador', '') <> '' then '. Localizador: ' || (h.datos->>'Localizador') else '' end as ruta
    from hora h where h.tabla = 'transporte'
  ),
  dias as (
    select distinct on (h.t::date) h.t::date as dia, to_char(h.t, 'HH24:MI') as empieza, h.datos->>'Qué' as que
    from hora h where h.tabla = 'agenda' order by h.t::date, h.t
  ),
  todos as (
    select 'tr:' || tr.id || ':' || tr.t || ':antes:' || m.minutos as clave,
      tr.t - m.minutos * interval '1 minute' as momento,
      tr.nombre || ' a las ' || tr.sale as titulo,
      'Sale en ' || public.china_duracion(m.minutos) || ': ' || tr.ruta as cuerpo
    from transporte tr
    cross join lateral (
      select e::integer as minutos
      from jsonb_array_elements_text(case
        when jsonb_typeof(tr.conf->'antes') = 'array' then tr.conf->'antes'
        when tr.vuelo then '[180]'::jsonb
        else '[90]'::jsonb
      end) e
      where e ~ '^\d{1,4}$' and e::integer > 0
    ) m
    union all
    select 'tr:' || tr.id || ':' || tr.t || ':vispera',
      tr.t::date - 1 + coalesce(tr.conf->>'vispera', '20:00')::time,
      'Mañana: ' || lower(left(tr.nombre, 1)) || substr(tr.nombre, 2) || ' a las ' || tr.sale,
      tr.ruta
    from transporte tr
    where coalesce(tr.conf->>'vispera', '20:00') ~ '^([01]\d|2[0-3]):[0-5]\d$'
    union all
    select 'ag:' || h.id || ':' || h.t || ':' || a.minutos,
      h.t - a.minutos * interval '1 minute',
      'A las ' || to_char(h.t, 'HH24:MI') || ': ' || (h.datos->>'Qué'),
      coalesce(nullif(h.datos->>'Lugar', ''), nullif(left(h.datos->>'Notas', 140), ''), 'En ' || public.china_duracion(a.minutos))
    from hora h
    cross join (select case when coalesce(prefs->>'agenda', '') ~ '^\d{1,4}$' then (prefs->>'agenda')::integer else 30 end as minutos) a
    where h.tabla = 'agenda' and h.datos->>'Tipo' in ('visita', 'traslado') and a.minutos > 0
    union all
    select 'dia:' || d.dia || ':' || d.empieza,
      d.dia - 1 + time '21:00',
      'Mañana empezáis a las ' || d.empieza,
      d.que
    from dias d
    where coalesce(prefs->>'noche', 'true') <> 'false'
  )
  select t.clave, t.titulo, t.cuerpo from todos t
  where t.momento <= ahora and t.momento > ahora - interval '20 minutes'
$$;

-- Lo que la función de avisos tiene que enviar ahora a cada móvil. Cada aviso se marca aquí, así no sale dos veces.
create or replace function public.china_avisos_tomar(ahora timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s record;
  subs jsonb := '[]'::jsonb;
  avisos jsonb;
  china timestamp := (ahora at time zone 'Asia/Shanghai')::timestamp;
begin
  for s in select * from public.china_suscripciones loop
    with debidos as (
      select * from public.china_avisos_debidos(china, public.china_avisos_prefs(s.email))
    ), nuevos as (
      insert into public.china_avisos_enviados (clave)
      select md5(s.endpoint) || ':' || d.clave from debidos d
      on conflict do nothing returning clave
    )
    select coalesce(jsonb_agg(jsonb_build_object('clave', d.clave, 'titulo', d.titulo, 'cuerpo', d.cuerpo)), '[]'::jsonb)
      into avisos
      from debidos d join nuevos n on n.clave = md5(s.endpoint) || ':' || d.clave;
    subs := subs || jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth, 'bienvenida', s.bienvenida, 'avisos', avisos);
  end loop;
  update public.china_suscripciones x set bienvenida = false where x.bienvenida;
  return jsonb_build_object('subs', subs, 'vapid', (select c.valor from public.china_config c where c.clave = 'vapid'));
end
$$;

-- La primera ejecución crea las claves; si dos coinciden, gana la primera y ambas usan esa
create or replace function public.china_vapid_guardar(p jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  insert into public.china_config (clave, valor) values ('vapid', p) on conflict (clave) do nothing;
  select c.valor from public.china_config c where c.clave = 'vapid';
$$;

create or replace function public.china_avisos_quitar(p jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  delete from public.china_suscripciones s where s.endpoint in (select jsonb_array_elements_text(p));
  select jsonb_build_object('ok', true);
$$;

-- La app solo puede llamar a estas, y solo con sesión; la función de avisos entra con su clave de servidor
revoke all on function public.china_editables(text), public.china_columnas(text), public.china_filtra(jsonb, text[]),
  public.china_fila(text, integer, text), public.china_nueva(text, text, jsonb, integer), public.china_op(jsonb),
  public.china_es_viajero(), public.china_exige_viajero(), public.china_revision(), public.china_datos(), public.china_rev(), public.china_leer(), public.china_aplicar(jsonb),
  public.china_suscribir(jsonb), public.china_desuscribir(jsonb), public.china_vapid(), public.china_avisos_prefs(text), public.china_duracion(integer), public.china_avisos_debidos(timestamp, jsonb),
  public.china_avisos_tomar(timestamptz), public.china_vapid_guardar(jsonb), public.china_avisos_quitar(jsonb)
  from public, anon, authenticated;
grant execute on function public.china_es_viajero(), public.china_rev(), public.china_leer(), public.china_aplicar(jsonb),
  public.china_suscribir(jsonb), public.china_desuscribir(jsonb), public.china_vapid() to authenticated;
grant execute on function public.china_avisos_tomar(timestamptz), public.china_vapid_guardar(jsonb), public.china_avisos_quitar(jsonb) to service_role;

notify pgrst, 'reload schema';
