-- Réinitialisation complète des incidents depuis l'interface d'administration.
--
-- Cette fonction :
-- - est réservée aux administrateurs ;
-- - supprime les incidents et leurs données associées ;
-- - supprime l'historique des e-mails ;
-- - supprime les travaux de notification ;
-- - remet les compteurs techniques à zéro ;
-- - conserve comptes, salles, catégories et configuration.

create or replace function public.reinitialiser_incidents()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_nombre bigint;
begin
  if not public.est_admin() then
    raise exception 'Action réservée aux administrateurs.';
  end if;

  -- Évite deux réinitialisations simultanées.
  perform pg_advisory_xact_lock(9281403);

  select count(*) into v_nombre
  from public.tickets;

  -- Les anciens journaux n'ont plus de sens après une remise à zéro.
  delete from public.email_log;

  -- Les jobs liés aux incidents et les récapitulatifs programmés
  -- doivent également disparaître.
  delete from public.notifications_jobs;

  -- ticket_categories est supprimé automatiquement grâce au
  -- ON DELETE CASCADE.
  delete from public.tickets;

  -- Le prochain incident redeviendra le numéro 1.
  alter sequence public.tickets_id_seq restart with 1;

  -- Remise à zéro des compteurs purement techniques.
  alter sequence public.email_log_id_seq restart with 1;
  alter sequence public.notifications_jobs_id_seq restart with 1;

  -- Le prochain récapitulatif repart à compter de maintenant.
  insert into public.configuration(cle, valeur)
  values ('notifications_activation', now()::text)
  on conflict (cle)
  do update set valeur = excluded.valeur;

  return v_nombre;
end;
$$;

revoke all on function public.reinitialiser_incidents() from public, anon;
grant execute on function public.reinitialiser_incidents() to authenticated;

notify pgrst, 'reload schema';
