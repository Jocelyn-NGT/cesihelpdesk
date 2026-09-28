-- Destinataire unique, file durable et horaire Europe/Paris.
begin;
alter table public.utilisateurs add column if not exists notifications_email boolean not null default false;
create unique index if not exists un_destinataire_notifications on public.utilisateurs (notifications_email) where notifications_email;

create or replace function public.choisir_destinataire_notifications(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.est_admin() then raise exception 'Action réservée aux administrateurs.'; end if;
  perform pg_advisory_xact_lock(9281400);
  if p_id is not null and not exists(select 1 from public.utilisateurs where id=p_id and actif) then
    raise exception 'Choisissez un compte actif.';
  end if;
  update public.utilisateurs set notifications_email=false where notifications_email;
  if p_id is not null then update public.utilisateurs set notifications_email=true where id=p_id; end if;
end $$;
revoke all on function public.choisir_destinataire_notifications(uuid) from public, anon;
grant execute on function public.choisir_destinataire_notifications(uuid) to authenticated;
-- Le navigateur ne reçoit aucun droit d'écriture directe sur cette colonne.

create or replace function public.proteger_dernier_admin()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform pg_advisory_xact_lock(9281400);
  if old.role='admin' and old.actif then
    if tg_op='DELETE' or not (new.role='admin' and new.actif) then
      if not exists(select 1 from public.utilisateurs where role='admin' and actif and id<>old.id) then
        raise exception 'Impossible de retirer le dernier administrateur actif.';
      end if;
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  if not new.actif then new.notifications_email=false; end if;
  return new;
end $$;
drop trigger if exists trg_proteger_dernier_admin on public.utilisateurs;
create trigger trg_proteger_dernier_admin before update or delete on public.utilisateurs
for each row execute function public.proteger_dernier_admin();
-- auth.users -> utilisateurs ON DELETE CASCADE -> tickets.assigne_a_id ON DELETE SET NULL.
comment on column public.utilisateurs.actif is 'Compte désactivé : accès et réception des notifications suspendus.';

create table public.notifications_jobs (
  id bigint generated always as identity primary key,
  cle text not null unique,
  mode text not null check(mode in ('urgent','recap')),
  ticket_id bigint references public.tickets(id) on delete cascade,
  debut timestamptz,
  fin timestamptz,
  etat text not null default 'attente' check(etat in ('attente','en_cours','envoye','simule','annule')),
  tentatives integer not null default 0,
  prochain_essai timestamptz not null default now(),
  verrou uuid,
  verrouille_le timestamptz,
  erreur text,
  created_at timestamptz not null default now()
);
alter table public.notifications_jobs enable row level security;
revoke all on public.notifications_jobs from anon, authenticated;
grant all on public.notifications_jobs to service_role;
grant usage, select on sequence public.notifications_jobs_id_seq to service_role;
create index notifications_a_envoyer on public.notifications_jobs(prochain_essai) where etat in ('attente','en_cours');
insert into public.configuration(cle,valeur) values('notifications_activation',now()::text) on conflict(cle) do nothing;

create or replace function public.appeler_notifications(charge jsonb)
returns void language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare v_url text; v_secret text;
begin
  select valeur into v_url from public.configuration where cle='url_fonction_notifications';
  select valeur into v_secret from public.configuration where cle='secret_notifications';
  if coalesce(v_url,'')='' or coalesce(v_secret,'')='' then return; end if;
  perform net.http_post(url:=v_url,headers:=jsonb_build_object('Content-Type','application/json','x-secret-notifications',v_secret),body:=charge,timeout_milliseconds:=60000);
exception when others then
  raise warning 'Notification en attente : %',SQLERRM;
end $$;
revoke all on function public.appeler_notifications(jsonb) from public,anon,authenticated;
grant execute on function public.appeler_notifications(jsonb) to service_role;

create or replace function public.notifier_incident_urgent()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id bigint;
begin
  insert into public.notifications_jobs(cle,mode,ticket_id) values('urgent:'||new.id,'urgent',new.id)
  on conflict(cle) do nothing returning id into v_id;
  if v_id is not null then perform public.appeler_notifications(jsonb_build_object('job_id',v_id)); end if;
  return new;
end $$;
revoke all on function public.notifier_incident_urgent() from public,anon,authenticated;

-- Appel toutes les minutes : envoi du vendredi à 08:00 en heure locale,
-- rattrapage après interruption du serveur et reprise des échecs réseau/SMTP.
create or replace function public.planifier_notifications()
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_local timestamp := now() at time zone 'Europe/Paris';
  v_vendredi timestamp;
  v_fin timestamptz;
  v_activation timestamptz;
  v_job record;
begin
  perform pg_advisory_xact_lock(9281401);
  v_vendredi := date_trunc('week',v_local) + interval '4 days 8 hours';
  if v_local < v_vendredi then v_vendredi := v_vendredi - interval '7 days'; end if;
  v_fin := v_vendredi at time zone 'Europe/Paris';
  select valeur::timestamptz into v_activation from public.configuration where cle='notifications_activation';
  if v_fin >= v_activation then
    insert into public.notifications_jobs(cle,mode,debut,fin)
    values('recap:'||to_char(v_vendredi,'YYYY-MM-DD'),'recap',
      (v_vendredi-interval '7 days') at time zone 'Europe/Paris',v_fin)
    on conflict(cle) do nothing;
  end if;
  for v_job in select id from public.notifications_jobs
    where (etat='attente' and prochain_essai<=now())
      or (etat='en_cours' and verrouille_le < now()-interval '10 minutes')
    order by id limit 20
  loop
    perform public.appeler_notifications(jsonb_build_object('job_id',v_job.id));
  end loop;
end $$;
revoke all on function public.planifier_notifications() from public,anon,authenticated;
grant execute on function public.planifier_notifications() to service_role;

-- Un seul worker par message ; un seul récapitulatif en cours à la fois.
create or replace function public.prendre_notification(p_id bigint)
returns setof public.notifications_jobs language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.notifications_jobs; v_debut timestamptz;
begin
  perform pg_advisory_xact_lock(9281402);
  select * into j from public.notifications_jobs where id=p_id for update;
  if not found or j.etat in ('envoye','simule','annule') then return; end if;
  if j.etat='en_cours' and j.verrouille_le>now()-interval '10 minutes' then return; end if;
  if j.etat='attente' and j.prochain_essai>now() then return; end if;
  if j.mode='recap' then
    if exists(select 1 from public.notifications_jobs where mode='recap' and id<>p_id and etat='en_cours' and verrouille_le>now()-interval '10 minutes') then return; end if;
    select max(fin) into v_debut from public.notifications_jobs where mode='recap' and etat='envoye';
    if v_debut is null then select min(debut) into v_debut from public.notifications_jobs where mode='recap'; end if;
    if v_debut>=j.fin then update public.notifications_jobs set etat='annule' where id=p_id; return; end if;
    j.debut:=v_debut;
  end if;
  return query update public.notifications_jobs set etat='en_cours',tentatives=tentatives+1,
    verrou=gen_random_uuid(),verrouille_le=now(),debut=j.debut
    where id=p_id returning *;
end $$;
revoke all on function public.prendre_notification(bigint) from public,anon,authenticated;
grant execute on function public.prendre_notification(bigint) to service_role;

create or replace function public.terminer_notification(p_id bigint,p_verrou uuid,p_statut text,p_erreur text,p_destinataires text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.notifications_jobs;
begin
  if p_statut not in ('envoye','simule','echec') then raise exception 'Statut invalide'; end if;
  select * into j from public.notifications_jobs where id=p_id and verrou=p_verrou and etat='en_cours' for update;
  if not found then return; end if;
  insert into public.email_log(type,ticket_id,destinataires,statut,erreur)
    values(j.mode,j.ticket_id,coalesce(nullif(p_destinataires,''),'(aucun)'),p_statut,p_erreur);
  update public.notifications_jobs set etat=case when p_statut='echec' then 'attente' else p_statut end,
    erreur=p_erreur,prochain_essai=now()+case when tentatives<12 then interval '5 minutes' else interval '1 hour' end,
    verrou=null where id=p_id;
end $$;
revoke all on function public.terminer_notification(bigint,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.terminer_notification(bigint,uuid,text,text,text) to service_role;

do $$ begin
  if exists(select 1 from cron.job where jobname='recap-hebdomadaire') then perform cron.unschedule('recap-hebdomadaire'); end if;
end $$;
select cron.schedule('notifications-incidents','* * * * *',$$select public.planifier_notifications()$$);
notify pgrst, 'reload schema';
commit;
