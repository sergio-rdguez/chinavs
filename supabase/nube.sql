/* Viaje a China: documentos privados y avisos programados. Se ejecuta después de schema.sql y se puede repetir. */

-- Documentos: solo los viajeros, nada público
insert into storage.buckets (id, name, public, file_size_limit)
  values ('documentos', 'documentos', false, 26214400)
  on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists china_documentos on storage.objects;
create policy china_documentos on storage.objects for all to authenticated
  using (bucket_id = 'documentos' and public.china_es_viajero())
  with check (bucket_id = 'documentos' and public.china_es_viajero());

-- Cada 5 minutos se mira si toca avisar. La función no necesita clave: solo manda lo que ya toca, y una vez.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule('china-avisos', '*/5 * * * *', $$
  select net.http_post(url := 'https://epkoicrucqachfavvjnm.supabase.co/functions/v1/avisos', body := '{}'::jsonb)
$$);

-- Copia diaria de los datos (a las 3:00 de China); se guardan las de la última semana
select cron.schedule('china-copia', '0 19 * * *', $$
  insert into public.china_copias (dia, datos) values (current_date, public.china_datos())
    on conflict (dia) do update set datos = excluded.datos, creada = now();
  delete from public.china_copias where dia < current_date - 7;
$$);
