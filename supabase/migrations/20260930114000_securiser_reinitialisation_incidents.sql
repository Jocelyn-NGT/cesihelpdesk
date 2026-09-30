-- La vérification de l'administrateur est effectuée par l'Edge Function
-- reinitialisation-incidents avant l'appel de cette RPC.
--
-- La RPC elle-même devient inaccessible aux utilisateurs authentifiés
-- et ne peut être appelée qu'avec le rôle service_role.

create or replace function public.reinitialiser_incidents()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_nombre bigint;
begin
  perform pg_advisory_xact_lock(9281403);

  select count(*)
  into v_nombre
  from public.tickets;

  delete from public.email_log;
  delete from public.notifications_jobs;
  delete from public.tickets;

  alter sequence public.tickets_id_seq restart with 1;
  alter sequence public.email_log_id_seq restart with 1;
  alter sequence public.notifications_jobs_id_seq restart with 1;

  insert into public.configuration(cle, valeur)
  values ('notifications_activation', now()::text)
  on conflict (cle)
  do update set valeur = excluded.valeur;

  return v_nombre;
end;
$$;

revoke all
on function public.reinitialiser_incidents()
from public, anon, authenticated;

grant execute
on function public.reinitialiser_incidents()
to service_role;

notify pgrst, 'reload schema';
