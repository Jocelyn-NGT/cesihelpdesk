begin;

create or replace function public.planifier_notifications()
returns void
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_local timestamp := now() at time zone 'Europe/Paris';

  -- Configuration : lundi=1 ... dimanche=7
  v_jour integer := coalesce(
    (select valeur::integer
     from public.configuration
     where cle='notifications_jour'),
    5
  );

  v_heure time := coalesce(
    (select valeur::time
     from public.configuration
     where cle='notifications_heure'),
    time '08:00'
  );

  v_echeance timestamp;
  v_fin timestamptz;
  v_activation timestamptz;
  v_job record;
begin
  perform pg_advisory_xact_lock(9281401);

  /*
   * Calcule l'échéance de la semaine courante.
   *
   * date_trunc('week') = lundi 00:00
   * v_jour = 1 pour lundi ... 7 pour dimanche.
   */
  v_echeance :=
    date_trunc('week', v_local)
    + ((v_jour - 1) * interval '1 day')
    + v_heure;

  -- Si l'échéance de cette semaine n'est pas encore arrivée,
  -- on considère celle de la semaine précédente.
  if v_local < v_echeance then
    v_echeance := v_echeance - interval '7 days';
  end if;

  v_fin := v_echeance at time zone 'Europe/Paris';

  select valeur::timestamptz
  into v_activation
  from public.configuration
  where cle='notifications_activation';

  if v_fin >= v_activation then
    insert into public.notifications_jobs(cle,mode,debut,fin)
    values(
      'recap:' || to_char(v_echeance,'YYYY-MM-DD'),
      'recap',
      (v_echeance - interval '7 days') at time zone 'Europe/Paris',
      v_fin
    )
    on conflict(cle) do nothing;
  end if;

  for v_job in
    select id
    from public.notifications_jobs
    where
      (etat='attente' and prochain_essai<=now())
      or
      (etat='en_cours'
       and verrouille_le < now()-interval '10 minutes')
    order by id
    limit 20
  loop
    perform public.appeler_notifications(
      jsonb_build_object('job_id',v_job.id)
    );
  end loop;
end
$$;

revoke all on function public.planifier_notifications()
from public,anon,authenticated;

grant execute on function public.planifier_notifications()
to service_role;

commit;
